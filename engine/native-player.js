'use strict';
// Bridge Node ↔ motor nativo (escucharrr-engine.exe), con CONTROL EN VIVO.
//
// El motor es un renderizador WASAPI float32 que ahora recibe el PCM por un
// NAMED PIPE y acepta comandos por stdin (gain/pause/resume/flush/stop). Así el
// motor y el dispositivo quedan VIVOS durante toda la reproducción: cambiar el
// volumen o pausar es inmediato (no se relanza ffmpeg ni se reinicia la salida),
// y un seek solo descarta el buffer (flush) y reposiciona ffmpeg sobre el mismo
// pipe, sin cortar el dispositivo. La DECODIFICACIÓN la pone ffmpeg (ranura de
// decoder; libFLAC/dr_flac en el futuro) a la tasa NATIVA del fichero, y el
// RESAMPLE lo hace el motor (nodo DSP sinc Kaiser) igualándola a la del dispositivo,
// para que WASAPI no vuelva a remuestrear. El TRANSPORTE lo lleva este bridge.
//
// Cambiar de dispositivo/exclusivo sí reinicia el motor (el formato de salida es
// fijo por sesión WASAPI); el cambio de pista también arranca un motor nuevo.

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');

const ENGINE = path.join(__dirname, 'escucharrr-engine.exe');
let pipeSeq = 0;

function dbToLinear(db) { return Math.pow(10, (db || 0) / 20); }

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
    this._ff = null;          // proceso ffmpeg (el decoder; se reinicia en seek/pista)
    this._eng = null;         // proceso motor (vivo toda la sesión de reproducción)
    this._server = null;      // servidor del named pipe de PCM
    this._sock = null;        // socket conectado (el motor como cliente)
    this._ffExpectEnd = false;// true = el fin de ffmpeg es esperado (seek/stop), no fin de pista
    this._eq = { on: false, gains: [0, 0, 0, 0, 0, 0, 0] };   // ecualizador gráfico (se reenvía al motor en cada play)
    this._peq = { on: false, bands: [] };     // EQ paramétrico: [{type,freq,q,gain}] (se reenvía en cada play)
    this._conv = { on: false, path: '' };     // convolución: ruta del impulso WAV (se reenvía en cada play)
    this._state = {
      playing: false, paused: false, file: null, deviceId: null,
      exclusive: false, gainDb: 0, baseOffset: 0, startedAt: 0,
      device: null, mode: null, bitPerfect: false, live: false, durationSec: 0,
      rate: 0, channels: 2, inRate: 0, resampling: false, outFormat: null, taps: 0,
    };
  }

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

  _probe(file) {
    try {
      const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,channels', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1', file], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout) {
        const g = k => { const m = new RegExp(k + '=([\\d.]+)').exec(r.stdout); return m ? parseFloat(m[1]) : 0; };
        return { rate: g('sample_rate') || 44100, channels: g('channels') || 2, duration: g('duration') || 0 };
      }
    } catch { /* ffprobe ausente */ }
    return { rate: 44100, channels: 2, duration: 0 };
  }
  // programa el fin REAL de la pista: el audio acaba cuando la posición llega a la duración
  // (ffmpeg termina de DECODIFICAR mucho antes; el motor sigue vaciando su buffer).
  _scheduleEnd() {
    clearTimeout(this._endTimer);
    const s = this._state;
    if (!s.durationSec || s.paused || !s.playing) return;
    const remain = (s.durationSec - this.state.positionSec) * 1000;
    const eng = this._eng;
    this._endTimer = setTimeout(() => {
      if (this._eng !== eng) return;
      this._state.playing = false; this.emit('ended');
      setTimeout(() => { if (this._eng === eng && !this._state.playing) this._teardown(); }, 300);
    }, Math.max(0, remain) + 150);
  }

  get state() {
    const s = this._state;
    let pos = s.baseOffset;
    if (s.playing && !s.paused && s.startedAt) pos += (Date.now() - s.startedAt) / 1000;
    return { ...s, positionSec: Math.max(0, pos) };
  }

  _writeCtl(obj) { try { if (this._eng && this._eng.stdin.writable) this._eng.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) {} }
  _sendEq() { this._writeCtl({ cmd: 'eq', on: !!this._eq.on, g: this._eq.gains }); }
  // formato de banda paramétrica → cuaternas [type,freq,q,gain] (el motor parsea arrays de números)
  _peqWire() { return (this._peq.bands || []).slice(0, 16).map(b => [b.type | 0, +b.freq || 1000, +b.q || 1, +b.gain || 0]); }
  _sendPeq() { this._writeCtl({ cmd: 'peq', on: !!this._peq.on, b: this._peqWire() }); }
  _sendConv() { this._writeCtl({ cmd: 'conv', on: !!this._conv.on, path: this._conv.path || '' }); }
  _sendDsp() { this._sendEq(); this._sendPeq(); this._sendConv(); }
  // ecualizador de 7 bandas en el motor (en vivo si hay motor; se reenvía en cada play)
  setEq(on, gains) { this._eq = { on: !!on, gains: (gains || this._eq.gains).slice(0, 7) }; if (this._eng) this._sendEq(); return this.state; }
  // EQ paramétrico (bandas configurables); en vivo si hay motor
  setPeq(on, bands) { this._peq = { on: !!on, bands: Array.isArray(bands) ? bands.slice(0, 16) : this._peq.bands }; if (this._eng) this._sendPeq(); return this.state; }
  // convolución: cargar/activar un impulso WAV; cargar uno nuevo lo resamplea a la tasa de salida
  setConv(on, convPath) { this._conv = { on: !!on, path: convPath != null ? convPath : this._conv.path }; if (this._eng) this._sendConv(); return this.state; }

  _teardown() {
    clearTimeout(this._endTimer);
    this._writeCtl({ cmd: 'stop' });
    for (const p of [this._ff, this._eng]) { if (p) { try { p.kill(); } catch {} } }
    if (this._server) { try { this._server.close(); } catch {} }
    this._ff = this._eng = this._server = this._sock = null;
  }

  // Arranca ffmpeg decodificando `file` desde `offset` y lo envía al socket del pipe.
  _spawnFfmpeg(file, offset, rate, ch) {
    const args = ['-nostdin', '-v', 'error'];
    if (offset > 0) args.push('-ss', String(offset));
    args.push('-i', file, '-f', 'f32le', '-ar', String(rate), '-ac', String(ch), '-');
    const ff = spawn('ffmpeg', args, { windowsHide: true });
    ff.on('error', e => this.emit('error', e));
    ff.stdout.on('error', () => {});
    if (this._sock) ff.stdout.pipe(this._sock, { end: false });   // end:false: no cerrar el pipe al acabar una pista/seek
    else { ff.stdout.pause(); this._pendingFf = ff; }
    // el cierre de ffmpeg = fin de la DECODIFICACIÓN, no del audio; el fin real lo marca _scheduleEnd
    ff.on('close', () => { if (this._ff === ff) this._ffExpectEnd = false; });
    return ff;
  }

  // Reproduce `file`. Si hay un motor vivo compatible (compartido, mismo dispositivo y formato),
  // lo REUTILIZA (gapless: sin reinicializar WASAPI entre pistas); si no, arranca uno nuevo.
  async play(file, opts = {}) {
    const deviceId = opts.deviceId !== undefined ? (opts.deviceId || null) : this._state.deviceId;
    const exclusive = !!(opts.exclusive !== undefined ? opts.exclusive : this._state.exclusive);
    const gainDb = opts.gainDb != null ? opts.gainDb : this._state.gainDb;
    const offset = opts.seekSec || 0;
    if (opts.eq) this._eq = { on: !!opts.eq.on, gains: (opts.eq.gains || this._eq.gains).slice(0, 7) };
    if (opts.peq) this._peq = { on: !!opts.peq.on, bands: Array.isArray(opts.peq.bands) ? opts.peq.bands.slice(0, 16) : this._peq.bands };
    if (opts.conv) this._conv = { on: !!opts.conv.on, path: opts.conv.path != null ? opts.conv.path : this._conv.path };

    const probe = this._probe(file);               // rate/canales nativos + duración
    const inRate = probe.rate || 48000;            // tasa NATIVA del fichero (ffmpeg solo decodifica a ella)
    let rate = 48000, ch = 2;                       // `rate` = tasa de SALIDA (dispositivo); el motor resamplea inRate→rate
    if (exclusive) { rate = probe.rate; ch = probe.channels; }   // bit-perfect: salida == nativa (sin resample)
    else {
      try { const devs = await this.listDevices(); const dev = deviceId ? devs.find(d => d.id === deviceId) : devs.find(d => d.default); if (dev) { rate = dev.rate || 48000; ch = dev.channels || 2; } }
      catch { rate = 48000; }
    }

    // GAPLESS: motor vivo compatible -> reutilizar (flush + nuevo ffmpeg sobre el mismo pipe y
    // dispositivo), sin el corte/clic de reinicializar WASAPI. Solo en compartido y mismo formato.
    if (this._eng && this._state.live && !exclusive && !this._state.exclusive &&
        (deviceId || null) === (this._state.deviceId || null) && rate === this._state.rate && ch === this._state.channels) {
      this._ffExpectEnd = true;
      if (this._ff) { try { if (this._sock) this._ff.stdout.unpipe(this._sock); this._ff.kill(); } catch {} }
      this._writeCtl({ cmd: 'flush' });
      if (inRate !== this._state.inRate) this._writeCtl({ cmd: 'inrate', v: inRate });   // nueva pista con otra tasa: reconfigura el resampler
      if (opts.eq) this._sendEq();
      if (opts.peq) this._sendPeq();
      if (opts.conv) this._sendConv();
      this._writeCtl({ cmd: 'gain', v: dbToLinear(gainDb) });   // ReplayGain de la nueva pista, en vivo
      this._ff = this._spawnFfmpeg(file, offset, inRate, ch);
      Object.assign(this._state, { playing: true, paused: false, file, gainDb, baseOffset: offset, startedAt: Date.now(), durationSec: probe.duration || 0, inRate, resampling: inRate !== rate });
      clearTimeout(this._endTimer); this._scheduleEnd();
      this.emit('state', this.state);
      return this.state;
    }
    this._teardown();   // arranque completo: motor + pipe + ffmpeg nuevos

    const pipePath = '\\\\.\\pipe\\escucharrr-pcm-' + process.pid + '-' + (++pipeSeq);
    this._pendingFf = null;
    this._server = net.createServer(sock => {
      this._sock = sock;
      sock.on('error', () => {});
      if (this._pendingFf) { this._pendingFf.stdout.pipe(sock, { end: false }); this._pendingFf.stdout.resume(); this._pendingFf = null; }
    });
    await new Promise((res, rej) => { this._server.once('error', rej); this._server.listen(pipePath, res); });

    const engArgs = ['--play', '--rate', String(rate), '--in-rate', String(inRate), '--channels', String(ch), '--pcm-pipe', pipePath];
    if (exclusive) engArgs.push('--exclusive'); else engArgs.push('--gain', String(dbToLinear(gainDb)));
    if (deviceId) engArgs.push('--device-id', deviceId);
    const eng = spawn(ENGINE, engArgs, { windowsHide: true });
    eng.on('error', e => this.emit('error', e));
    eng.stdin.on('error', () => {});
    lineReader(eng.stdout, o => {
      if (o.event === 'started') { Object.assign(this._state, { device: o.device, mode: o.mode, bitPerfect: o.bitPerfect, live: o.live, resampling: !!o.resampling, outFormat: o.outFormat || null, taps: o.taps || 0, inRate: o.inRate || inRate }); this._sendDsp(); }
      else if (o.event === 'error' || o.event === 'notice') this.emit('engine', o);
    });
    eng.on('close', () => { if (this._eng === eng) { this._state.playing = false; this._state.live = false; } });

    this._eng = eng;
    this._ffExpectEnd = false;
    this._ff = this._spawnFfmpeg(file, offset, inRate, ch);
    Object.assign(this._state, { playing: true, paused: false, file, deviceId, exclusive, gainDb, baseOffset: offset, startedAt: Date.now(), rate, channels: ch, inRate, resampling: inRate !== rate, durationSec: probe.duration || 0 });
    this._scheduleEnd();
    this.emit('state', this.state);
    return this.state;
  }

  pause() {
    const s = this._state;
    if (!s.playing || s.paused) return this.state;
    s.baseOffset = this.state.positionSec; s.paused = true; s.playing = false;
    clearTimeout(this._endTimer);
    if (s.live && this._eng) this._writeCtl({ cmd: 'pause' });
    else if (this._ff) { this._ffExpectEnd = true; try { this._ff.kill(); } catch {} }   // sin motor vivo: relanzar al reanudar
    this.emit('state', this.state);
    return this.state;
  }
  resume() {
    const s = this._state;
    if (!s.file) return this.state;
    if (!s.live || !this._eng) return this.play(s.file, { seekSec: s.baseOffset });   // sin motor vivo: relanzar
    s.paused = false; s.playing = true; s.startedAt = Date.now();
    this._writeCtl({ cmd: 'resume' });
    this._scheduleEnd();
    this.emit('state', this.state);
    return this.state;
  }
  // seek en vivo: flush del buffer + reposicionar ffmpeg sobre el mismo pipe (motor sigue sonando)
  seek(sec) {
    const s = this._state;
    if (!s.file) return this.state;
    sec = Math.max(0, sec);
    if (!s.live || !this._eng) return this.play(s.file, { seekSec: sec });
    this._ffExpectEnd = true;
    if (this._ff) { try { if (this._sock) this._ff.stdout.unpipe(this._sock); this._ff.kill(); } catch {} }
    this._writeCtl({ cmd: 'flush' });
    this._ff = this._spawnFfmpeg(s.file, sec, s.inRate || s.rate, s.channels);
    s.baseOffset = sec; s.startedAt = Date.now(); s.paused = false; s.playing = true;
    this._scheduleEnd();
    this.emit('state', this.state);
    return this.state;
  }
  // volumen/ReplayGain en vivo: solo un comando al motor (sin relanzar nada)
  setGainDb(db) {
    const s = this._state; s.gainDb = db;
    if (s.live && this._eng && !s.exclusive) this._writeCtl({ cmd: 'gain', v: dbToLinear(db) });
    else if (s.playing && !s.exclusive) return this.play(s.file, { seekSec: this.state.positionSec, gainDb: db });
    return this.state;
  }
  setExclusive(on) { this._state.exclusive = !!on; }
  setDevice(id) { this._state.deviceId = id || null; }
  stop() {
    this._teardown();
    Object.assign(this._state, { playing: false, paused: false, baseOffset: 0, startedAt: 0, live: false });
    this.emit('state', this.state);
    return this.state;
  }
}

module.exports = { NativePlayer, dbToLinear, ENGINE };
