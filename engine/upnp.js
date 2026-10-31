'use strict';
// escucharrr — salida de red UPnP/DLNA (p. ej. Eversolo DMP). Sin dependencias.
//
// Descubre MediaRenderers por SSDP (UDP multicast), lee su description.xml y controla
// AVTransport (SetAVTransportURI + Play/Pause/Stop/Seek, SetNextAVTransportURI = gapless)
// y RenderingControl (volumen). El dispositivo DESCARGA la música de nuestro /api/stream
// (que ya hace Range), así que no reencodeamos nada. Ver docs/dispositivos-de-red-y-roon.md.

const http = require('node:http');
const dgram = require('node:dgram');
const os = require('node:os');

const UA = 'escucharrr/0.1 UPnP/1.0';
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const xesc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// ── IP LAN del equipo que el dispositivo puede alcanzar (misma subred si se sabe) ──
function ipToInt(ip) { const p = ip.split('.').map(Number); return p.length === 4 ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : 0; }
function lanIp(forDeviceIp) {
  const ifs = os.networkInterfaces();
  const cands = [];
  for (const name of Object.keys(ifs)) for (const a of ifs[name] || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    if (/^169\.254\./.test(a.address)) continue;               // link-local (p. ej. Tailscale)
    cands.push(a);
  }
  if (forDeviceIp) {                                           // prioriza la interfaz de la misma subred
    const d = ipToInt(forDeviceIp);
    for (const a of cands) { const m = ipToInt(a.netmask || '255.255.255.0'); if ((ipToInt(a.address) & m) === (d & m)) return a.address; }
  }
  const priv = cands.find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return (priv || cands[0] || { address: '127.0.0.1' }).address;
}

// ── HTTP simple (los dispositivos UPnP son http plano) ──
function httpReq(url, { method = 'GET', headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// ── descubrimiento SSDP de MediaRenderers ──
function discover({ timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    const iface = lanIp();
    const byLoc = {};
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const search = st => Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' + st + '\r\n\r\n');
    s.on('message', buf => {
      const t = buf.toString('utf8');
      const loc = (/\r\nLOCATION:\s*(\S+)/i.exec(t) || [])[1];
      const st = (/\r\n(?:ST|NT):\s*(\S+)/i.exec(t) || [])[1] || '';
      if (loc && (/MediaRenderer/i.test(t) || /MediaRenderer/i.test(st))) byLoc[loc] = true;
    });
    s.bind(0, iface, () => {
      try { s.setMulticastInterface(iface); } catch (e) {}
      const sts = ['urn:schemas-upnp-org:device:MediaRenderer:1', 'ssdp:all'];
      for (let i = 0; i < 2; i++) for (const st of sts) setTimeout(() => { try { const m = search(st); s.send(m, 0, m.length, 1900, '239.255.255.250'); } catch (e) {} }, i * 350);
    });
    setTimeout(async () => {
      try { s.close(); } catch (e) {}
      const out = [];
      for (const loc of Object.keys(byLoc)) { try { const d = await describe(loc); if (d && d.avControl) out.push(d); } catch (e) {} }
      // dedup por UDN
      const seen = {}, uniq = [];
      for (const d of out) { if (seen[d.id]) continue; seen[d.id] = 1; uniq.push(d); }
      resolve(uniq);
    }, timeoutMs);
  });
}

// ── lee description.xml → {id(UDN), name, ip, base, avControl, rcControl} ──
async function describe(location) {
  const r = await httpReq(location, { timeout: 6000 });
  if (r.status !== 200 || !r.body) return null;
  const xml = r.body;
  const base = new URL(location);
  const abs = u => { try { return new URL(u, base).toString(); } catch (e) { return null; } };
  const g = re => { const m = re.exec(xml); return m ? m[1].trim() : ''; };
  const dev = { id: g(/<UDN>\s*([^<]+)<\/UDN>/i) || location, name: g(/<friendlyName>\s*([^<]+)<\/friendlyName>/i) || base.hostname, manufacturer: g(/<manufacturer>\s*([^<]+)<\/manufacturer>/i), model: g(/<modelName>\s*([^<]+)<\/modelName>/i), ip: base.hostname, location };
  for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const blk = m[1];
    const st = (/<serviceType>\s*([^<]+)<\/serviceType>/i.exec(blk) || [])[1] || '';
    const cu = (/<controlURL>\s*([^<]+)<\/controlURL>/i.exec(blk) || [])[1] || '';
    if (!cu) continue;
    if (/:AVTransport:/i.test(st)) dev.avControl = abs(cu);
    else if (/:RenderingControl:/i.test(st)) dev.rcControl = abs(cu);
  }
  return dev;
}

// ── SOAP ──
async function soap(controlURL, serviceType, action, args) {
  const body = '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:' + action + ' xmlns:u="' + serviceType + '">' +
    Object.keys(args).map(k => '<' + k + '>' + xesc(args[k]) + '</' + k + '>').join('') +
    '</u:' + action + '></s:Body></s:Envelope>';
  const r = await httpReq(controlURL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPACTION': '"' + serviceType + '#' + action + '"', 'User-Agent': UA, 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' },
    body,
  });
  if (r.status !== 200) { const f = (/<errorDescription>([^<]*)<\/errorDescription>/i.exec(r.body) || [])[1] || ('HTTP ' + r.status); throw new Error(action + ': ' + f); }
  // aísla el cuerpo de la respuesta (<u:XxxResponse>…</u:XxxResponse>) y extrae sus hijos de 1er nivel;
  // si parseáramos el envelope entero, el match perezoso de <s:Body> se tragaría los tags internos.
  const inner = (/<(?:\w+:)?\w+Response[^>]*>([\s\S]*?)<\/(?:\w+:)?\w+Response>/i.exec(r.body) || [, r.body])[1];
  const out = {};
  for (const m of inner.matchAll(/<([A-Za-z][\w.:-]*)>([\s\S]*?)<\/\1>/g)) out[m[1].replace(/^.*:/, '')] = m[2];
  return out;
}

const hms = sec => { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); };
const parseHms = t => { if (!t) return 0; const p = String(t).split(':').map(Number); if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]; if (p.length === 2) return p[0] * 60 + p[1]; return p[0] || 0; };

// DIDL-Lite para la pista (metadatos + recurso con protocolInfo DLNA que anuncia Range)
function didl({ url, mime, title, artist, album, durationSec, coverUrl }) {
  const proto = 'http-get:*:' + (mime || 'audio/flac') + ':DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    '<dc:title>' + xesc(title || 'Pista') + '</dc:title>' +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    (artist ? '<dc:creator>' + xesc(artist) + '</dc:creator><upnp:artist>' + xesc(artist) + '</upnp:artist>' : '') +
    (album ? '<upnp:album>' + xesc(album) + '</upnp:album>' : '') +
    (coverUrl ? '<upnp:albumArtURI>' + xesc(coverUrl) + '</upnp:albumArtURI>' : '') +
    '<res protocolInfo="' + xesc(proto) + '" duration="' + hms(durationSec) + '">' + xesc(url) + '</res>' +
    '</item></DIDL-Lite>';
}

// ── controlador de un renderer ──
class UpnpRenderer {
  constructor(dev) { this.dev = dev; }
  _av(action, args) { return soap(this.dev.avControl, AVT, action, Object.assign({ InstanceID: 0 }, args)); }
  _rc(action, args) { if (!this.dev.rcControl) throw new Error('sin RenderingControl'); return soap(this.dev.rcControl, RC, action, Object.assign({ InstanceID: 0 }, args)); }

  async setUriAndPlay(meta) { await this._av('SetAVTransportURI', { CurrentURI: meta.url, CurrentURIMetaData: didl(meta) }); await this._av('Play', { Speed: 1 }); }
  setNextUri(meta) { return this._av('SetNextAVTransportURI', { NextURI: meta.url, NextURIMetaData: didl(meta) }); }
  play() { return this._av('Play', { Speed: 1 }); }
  pause() { return this._av('Pause', {}); }
  stop() { return this._av('Stop', {}); }
  seek(sec) { return this._av('Seek', { Unit: 'REL_TIME', Target: hms(sec) }); }
  async getState() {
    let pos = {}, tr = {};
    try { pos = await this._av('GetPositionInfo', {}); } catch (e) {}
    try { tr = await this._av('GetTransportInfo', {}); } catch (e) {}
    const st = (tr.CurrentTransportState || '').toUpperCase();
    return { positionSec: parseHms(pos.RelTime), durationSec: parseHms(pos.TrackDuration), trackUri: pos.TrackURI || '', state: st, playing: st === 'PLAYING', paused: st.indexOf('PAUSED') >= 0 };
  }
  async setVolume(pct) { await this._rc('SetVolume', { Channel: 'Master', DesiredVolume: Math.max(0, Math.min(100, Math.round(pct))) }); }
  async getVolume() { try { const r = await this._rc('GetVolume', { Channel: 'Master' }); return parseInt(r.CurrentVolume, 10); } catch (e) { return null; } }
  async setMute(on) { try { await this._rc('SetMute', { Channel: 'Master', DesiredMute: on ? 1 : 0 }); } catch (e) {} }
}

module.exports = { discover, describe, UpnpRenderer, lanIp, didl, hms };
