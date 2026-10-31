'use strict';
// Bridge Node ↔ motor nativo (escucharrr-engine.exe).
//
// El motor es un renderizador WASAPI float32 "tonto pero bueno": recibe PCM
// f32le por stdin y lo saca por un dispositivo, en compartido (con ganancia) o
// exclusivo (bit-perfect). La DECODIFICACIÓN la hace ffmpeg aquí (ranura de
// decoder; mañana libFLAC/dr_flac), y el TRANSPORTE (qué pista, posición, pausa)
// lo lleva este bridge — como el "core" de Roon posee las zonas y la UI es un
// mando. Así la reproducción nativa es una salida del servidor, no del navegador.
//
// Limitación de esqueleto: pausa / seek / cambio de volumen se hacen
// RE-LANZANDO el pipeline en el offset actual (ffmpeg -ss es instantáneo), no
// con control en vivo ni gapless. El protocolo de control en vivo (gain/stop
// por stdin del motor, PCM por named pipe) es el siguiente refinamiento.

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const ENGINE = path.join(__dirname, 'escucharrr-engine.exe');

function dbToLinear(db) { return Math.pow(10, (db || 0) / 20); }

// Lee líneas JSON de un stream y llama cb(obj) por cada una.
function lineReader(stream, cb) {
  let buf = '';
  stream.on('data', d => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { cb(JSON.parse(line)); } catch { /* ruido no-JSON */ }
    }
  });
}

class NativePlayer extends EventEmitter {
  constructor() {
    super();
    this._ff = null;        // proceso ffmpeg
    this._eng = null;       // proceso motor
    this._state = {
      playing: false, paused: false, file: null, deviceId: null,
      exclusive: false, gainDb: 0, baseOffset: 0, startedAt: 0,
      device: null, mode: null, bitPerfect: false, durationSec: 0,
    };
  }

  // Lista dispositivos de salida vía el motor (--list-devices).
  listDevices() {
    return new Promise((resolve, reject) => {
      const p = spawn(ENGINE, ['--list-devices'], { windowsHide: true });
      let items = null, err = '';
      lineReader(p.stdout, o => { if (o.event === 'devices') items = o.items; });
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', () => items ? resolve(items) : reject(new Error('sin dispositivos' + (err ? ': ' + err : ''))));
    });
  }

  // Rate/canales nativos del fichero (para modo exclusivo/bit-perfect).
  _probe(file) {
    try {
      const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', file],
        { encoding: 'utf8' });
      if (r.status === 0 && r.stdout) {
        const [rate, ch] = r.stdout.trim().split(',');
        return { rate: parseInt(rate, 10) || 44100, channels: parseInt(ch, 10) || 2 };
      }
    } catch { /* ffprobe ausente */ }
    return { rate: 44100, channels: 2 };
  }

  get state() {
    const s = this._state;
    let pos = s.baseOffset;
    if (s.playing && !s.paused && s.startedAt) pos += (Date.now() - s.startedAt) / 1000;
    return { ...s, positionSec: Math.max(0, pos) };
  }

  _kill() {
    for (const p of [this._ff, this._eng]) { if (p) { try { p.kill(); } catch {} } }
    this._ff = this._eng = null;
  }

  // Arranca el pipeline ffmpeg → motor en el offset dado.
  async play(file, opts = {}) {
    this._kill();
    const deviceId = opts.deviceId || this._state.deviceId || null;
    const exclusive = !!(opts.exclusive ?? this._state.exclusive);
    const gainDb = opts.gainDb != null ? opts.gainDb : this._state.gainDb;
    const offset = opts.seekSec || 0;

    // Rate/canales de destino: en exclusivo = nativos del fichero (bit-perfect);
    // en compartido = los del formato de mezcla del dispositivo elegido.
    let rate = 44100, ch = 2;
    if (exclusive) {
      const n = this._probe(file); rate = n.rate; ch = n.channels;
    } else {
      try {
        const devs = await this.listDevices();
        const dev = deviceId ? devs.find(d => d.id === deviceId) : devs.find(d => d.default);
        if (dev) { rate = dev.rate || 48000; ch = dev.channels || 2; }
      } catch { rate = 48000; }
    }

    const ffArgs = ['-nostdin', '-v', 'error'];
    if (offset > 0) ffArgs.push('-ss', String(offset));
    ffArgs.push('-i', file, '-f', 'f32le', '-ar', String(rate), '-ac', String(ch), '-');
    const ff = spawn('ffmpeg', ffArgs, { windowsHide: true });

    const engArgs = ['--play', '--rate', String(rate), '--channels', String(ch)];
    if (exclusive) engArgs.push('--exclusive');
    else engArgs.push('--gain', String(dbToLinear(gainDb)));
    if (deviceId) engArgs.push('--device-id', deviceId);
    const eng = spawn(ENGINE, engArgs, { windowsHide: true });

    ff.on('error', e => this.emit('error', e));
    eng.on('error', e => this.emit('error', e));
    ff.stdout.pipe(eng.stdin);
    ff.stdout.on('error', () => {});   // EPIPE si el motor cierra antes
    eng.stdin.on('error', () => {});

    lineReader(eng.stdout, o => {
      if (o.event === 'started') {
        Object.assign(this._state, { device: o.device, mode: o.mode, bitPerfect: o.bitPerfect });
      } else if (o.event === 'ended') {
        if (this._eng === eng) { this._state.playing = false; this.emit('ended'); }
      } else if (o.event === 'error' || o.event === 'notice') {
        this.emit('engine', o);
      }
    });
    eng.on('close', () => { if (this._eng === eng) { this._state.playing = false; this.emit('ended'); } });

    this._ff = ff; this._eng = eng;
    Object.assign(this._state, {
      playing: true, paused: false, file, deviceId, exclusive, gainDb,
      baseOffset: offset, startedAt: Date.now(),
    });
    this.emit('state', this.state);
    return this.state;
  }

  pause() {
    const s = this._state;
    if (!s.playing || s.paused) return this.state;
    s.baseOffset = this.state.positionSec;   // congela la posición
    s.paused = true; s.playing = false;
    this._kill();
    this.emit('state', this.state);
    return this.state;
  }

  resume() {
    const s = this._state;
    if (!s.file) return this.state;
    return this.play(s.file, { seekSec: s.baseOffset });
  }

  seek(sec) {
    const s = this._state;
    if (!s.file) return this.state;
    return this.play(s.file, { seekSec: Math.max(0, sec) });
  }

  // Cambia la ganancia (dB) relanzando en la posición actual (solo compartido).
  setGainDb(db) {
    const s = this._state;
    s.gainDb = db;
    if (s.playing && !s.exclusive) return this.play(s.file, { seekSec: this.state.positionSec, gainDb: db });
    return this.state;
  }

  setExclusive(on) { this._state.exclusive = !!on; }
  setDevice(id) { this._state.deviceId = id || null; }

  stop() {
    this._kill();
    Object.assign(this._state, { playing: false, paused: false, baseOffset: 0, startedAt: 0 });
    this.emit('state', this.state);
    return this.state;
  }
}

module.exports = { NativePlayer, dbToLinear, ENGINE };
