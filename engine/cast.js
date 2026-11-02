'use strict';
// escucharrr — reproducción en Chromecast / Google Cast SIN dependencias.
// Implementa el protocolo CASTV2 directamente sobre TLS (:8009): framing con prefijo de longitud
// de 4 bytes + un CastMessage de Protocol Buffers que codificamos/parseamos a mano (solo los 6
// primeros campos, que es cuanto necesita el transporte). Lanza el Default Media Receiver
// (appId CC1AD845) y le da de comer la MISMA URL http que ya sirve /api/stream, igual que DLNA.
//
// Namespaces usados:
//   urn:x-cast:com.google.cast.tp.connection   CONNECT / CLOSE
//   urn:x-cast:com.google.cast.tp.heartbeat     PING / PONG
//   urn:x-cast:com.google.cast.receiver         LAUNCH / GET_STATUS / STOP / SET_VOLUME
//   urn:x-cast:com.google.cast.media            LOAD / PLAY / PAUSE / STOP / SEEK / GET_STATUS
const tls = require('tls');

const NS = {
  conn: 'urn:x-cast:com.google.cast.tp.connection',
  beat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  recv: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const DEFAULT_RECEIVER = 'CC1AD845';   // Default Media Receiver (reproductor genérico de Google)

// ── Protocol Buffers mínimo para CastMessage ────────────────────────────────
function varint(n) { const b = []; n = n >>> 0; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); }
function lenField(tag, buf) { return Buffer.concat([Buffer.from([tag]), varint(buf.length), buf]); }
// CastMessage: 1 protocol_version(varint)=0, 2 source_id(str), 3 destination_id(str),
// 4 namespace(str), 5 payload_type(varint)=0 STRING, 6 payload_utf8(str)
function encode(msg) {
  const src = Buffer.from(msg.source || 'sender-0', 'utf8');
  const dst = Buffer.from(msg.destination || 'receiver-0', 'utf8');
  const ns = Buffer.from(msg.namespace, 'utf8');
  const pl = Buffer.from(msg.data, 'utf8');
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]),       // field 1: protocol_version = 0
    lenField(0x12, src),             // field 2: source_id
    lenField(0x1a, dst),             // field 3: destination_id
    lenField(0x22, ns),              // field 4: namespace
    Buffer.from([0x28, 0x00]),       // field 5: payload_type = 0 (STRING)
    lenField(0x32, pl),              // field 6: payload_utf8
  ]);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}
function decode(body) {
  const out = { source: '', destination: '', namespace: '', data: '' };
  let off = 0;
  while (off < body.length) {
    const tag = body[off++]; const field = tag >> 3, wire = tag & 7;
    if (wire === 0) { while (body[off] & 0x80) off++; off++; continue; }   // varint: saltar
    if (wire === 2) {
      let len = 0, shift = 0; while (true) { const b = body[off++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
      const s = body.toString('utf8', off, off + len); off += len;
      if (field === 2) out.source = s; else if (field === 3) out.destination = s; else if (field === 4) out.namespace = s; else if (field === 6) out.data = s;
      continue;
    }
    break;   // wire no soportado: cortamos (solo esperamos varint/len-delimited)
  }
  return out;
}

class CastSender {
  constructor(dev) { this.dev = dev; this.ip = dev.ip; this.port = dev.port || 8009; this.sock = null; this.rid = 1; this.pending = new Map(); this.transportId = null; this.sessionId = null; this.mediaSessionId = null; this.buf = Buffer.alloc(0); this.beat = null; this.lastStatus = {}; }

  _send(namespace, data, destination) { if (!this.sock) return; this.sock.write(encode({ namespace, data: typeof data === 'string' ? data : JSON.stringify(data), destination: destination || 'receiver-0' })); }
  _req(namespace, payload, destination) {
    const requestId = ++this.rid; payload.requestId = requestId;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.pending.delete(requestId); reject(new Error('cast timeout')); }, 8000);
      this.pending.set(requestId, { resolve, reject, to });
      this._send(namespace, payload, destination);
    });
  }
  _onFrame(frame) {
    const m = decode(frame);
    let p = {}; try { p = JSON.parse(m.data); } catch (e) {}
    if (m.namespace === NS.beat) { if (p.type === 'PING') this._send(NS.beat, { type: 'PONG' }, m.source || 'receiver-0'); return; }
    if (p.type === 'RECEIVER_STATUS' && p.status) this.lastStatus.receiver = p.status;
    if (p.type === 'MEDIA_STATUS' && p.status && p.status[0]) { this.lastStatus.media = p.status[0]; if (p.status[0].mediaSessionId) this.mediaSessionId = p.status[0].mediaSessionId; }
    if (p.requestId && this.pending.has(p.requestId)) { const w = this.pending.get(p.requestId); clearTimeout(w.to); this.pending.delete(p.requestId); w.resolve(p); }
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0); if (this.buf.length < 4 + len) break;
      const frame = this.buf.slice(4, 4 + len); this.buf = this.buf.slice(4 + len);
      try { this._onFrame(frame); } catch (e) {}
    }
  }
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const to = setTimeout(() => { if (!settled) { settled = true; try { sock.destroy(); } catch (e) {} reject(new Error('cast conexión agotada')); } }, 9000);
      const sock = tls.connect({ host: this.ip, port: this.port, rejectUnauthorized: false }, () => {
        if (settled) return; settled = true; clearTimeout(to);
        this._send(NS.conn, { type: 'CONNECT' });                       // handshake con la plataforma
        this.beat = setInterval(() => { try { this._send(NS.beat, { type: 'PING' }); } catch (e) {} }, 4500);
        resolve();
      });
      sock.on('data', d => this._onData(d));
      sock.on('error', e => { clearTimeout(to); for (const w of this.pending.values()) { clearTimeout(w.to); w.reject(e); } this.pending.clear(); if (!settled) { settled = true; reject(e); } });
      sock.on('close', () => { if (this.beat) clearInterval(this.beat); });
      this.sock = sock;
    });
  }
  // Lanza el receptor por defecto y espera su transportId.
  async _ensureApp() {
    const r = await this._req(NS.recv, { type: 'LAUNCH', appId: DEFAULT_RECEIVER });
    const app = (r.status && r.status.applications || []).find(a => a.appId === DEFAULT_RECEIVER) || (r.status && r.status.applications || [])[0];
    if (!app) throw new Error('el Chromecast no lanzó el receptor');
    this.transportId = app.transportId; this.sessionId = app.sessionId;
    this._send(NS.conn, { type: 'CONNECT' }, this.transportId);         // conectar al canal de la app
  }
  // Equivalente a UpnpRenderer.setUriAndPlay: carga y reproduce una URL.
  async load(meta) {
    if (!this.transportId) await this._ensureApp();
    const media = {
      contentId: meta.url, streamType: 'BUFFERED', contentType: meta.mime || 'audio/flac',
      metadata: { metadataType: 3, title: meta.title || '', artist: meta.artist || '', albumName: meta.album || '', images: meta.coverUrl ? [{ url: meta.coverUrl }] : [] },
    };
    const r = await this._req(NS.media, { type: 'LOAD', media, autoplay: true, currentTime: meta.seekSec || 0 }, this.transportId);
    if (r.status && r.status[0] && r.status[0].mediaSessionId) this.mediaSessionId = r.status[0].mediaSessionId;
    return true;
  }
  _mediaCmd(type, extra) { if (!this.transportId || !this.mediaSessionId) return Promise.resolve(false); return this._req(NS.media, Object.assign({ type, mediaSessionId: this.mediaSessionId }, extra || {}), this.transportId).then(() => true).catch(() => false); }
  play() { return this._mediaCmd('PLAY'); }
  pause() { return this._mediaCmd('PAUSE'); }
  seek(sec) { return this._mediaCmd('SEEK', { currentTime: Number(sec) || 0 }); }
  async stop() { try { await this._mediaCmd('STOP'); } catch (e) {} if (this.sessionId) { try { await this._req(NS.recv, { type: 'STOP', sessionId: this.sessionId }); } catch (e) {} } this.close(); }
  setVolume(pct) { return this._req(NS.recv, { type: 'SET_VOLUME', volume: { level: Math.max(0, Math.min(1, Number(pct) / 100)) } }).then(() => true).catch(() => false); }
  async getState() {
    try { await this._mediaCmd('GET_STATUS'); } catch (e) {}
    const m = this.lastStatus.media || {};
    return { playing: m.playerState === 'PLAYING', paused: m.playerState === 'PAUSED', state: m.playerState || null, positionSec: m.currentTime || 0, durationSec: (m.media && m.media.duration) || 0 };
  }
  close() { if (this.beat) clearInterval(this.beat); this.beat = null; try { if (this.sock) this.sock.destroy(); } catch (e) {} this.sock = null; }
}

module.exports = { CastSender, _codec: { encode, decode } };
