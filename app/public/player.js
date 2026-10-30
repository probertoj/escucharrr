// escucharrr — reproductor real: <audio> + grafo Web Audio (ganancia / punto de DSP).
// Hace streaming del fichero local vía /api/stream?track=ID (con Range -> seek real).
// Cola persistente (localStorage) + barra fija de "ahora suena" en todas las páginas.
// Al empezar una pista registra la escucha vía POST /api/play.
window.player = (function () {
  const KEY = 'escucharrr.queue', VKEY = 'escucharrr.volume', ZKEY = 'escucharrr.zone';
  const PAIRS = [['#0F6E56', '#1D9E75'], ['#534AB7', '#7F77DD'], ['#185FA5', '#378ADD'], ['#854F0B', '#BA7517'], ['#72243E', '#D4537E'], ['#5F5E5A', '#888780'], ['#3B6D11', '#639922'], ['#993C1D', '#D85A30']];
  let q = [], idx = -1, playing = false, loadedIdx = -1, loggedIdx = -1, bar = null;
  let vol = 1; try { const v = parseFloat(localStorage.getItem(VKEY)); if (v >= 0 && v <= 1) vol = v; } catch (e) {}
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) { q = s.q || []; idx = (s.idx == null ? -1 : s.idx); } } catch (e) {}
  // zona de salida: nombre + dispositivo (base para multi-sala al estilo Roon; hoy = salida de este equipo)
  let zone = { name: 'Este equipo', deviceId: '', label: '' };
  try { const z = JSON.parse(localStorage.getItem(ZKEY)); if (z && typeof z === 'object') zone = Object.assign(zone, z); } catch (e) {}
  const persistZone = () => { try { localStorage.setItem(ZKEY, JSON.stringify(zone)); } catch (e) {} };

  // ── elemento de audio + grafo Web Audio (se crea tras el primer gesto del usuario) ──
  const audio = new Audio(); audio.preload = 'metadata'; audio.volume = vol;
  let ctx = null, gainNode = null;
  function ensureGraph() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;   // sin Web Audio: usamos audio.volume
    try {
      ctx = new AC();
      const src = ctx.createMediaElementSource(audio);
      gainNode = ctx.createGain(); gainNode.gain.value = vol;                        // punto de DSP (ganancia / ReplayGain / EQ futuro)
      src.connect(gainNode); gainNode.connect(ctx.destination);
      audio.volume = 1;                                                              // el volumen pasa ahora por la ganancia
      applySink();                                                                   // enruta a la salida/zona elegida
    } catch (e) { ctx = null; }
  }
  // enruta el audio al dispositivo de la zona. Con Web Audio el que manda es el AudioContext
  // (setSinkId del <audio> queda anulado al conectarlo al grafo), por eso priorizamos ctx.setSinkId.
  function applySink() {
    const id = zone.deviceId || '';
    try {
      if (ctx && typeof ctx.setSinkId === 'function') return ctx.setSinkId(id).catch(() => {});
      if (typeof audio.setSinkId === 'function') return audio.setSinkId(id).catch(() => {});
    } catch (e) {}
  }
  function sinkSupported() { return (window.AudioContext && 'setSinkId' in AudioContext.prototype) || typeof audio.setSinkId === 'function'; }
  // ReplayGain: ganancia lineal de la pista actual, limitada por el pico para no saturar
  function rgLinear(c) { if (!c || c.gain_db == null) return 1; let g = c.gain_db; if (c.peak_dbfs != null) { const ceil = -1 - c.peak_dbfs; if (g > ceil) g = ceil; } return Math.pow(10, g / 20); }
  function applyVol() { const g = vol * rgLinear(cur()); if (gainNode) gainNode.gain.value = g; else audio.volume = Math.min(1, g); try { localStorage.setItem(VKEY, String(vol)); } catch (e) {} }

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ q, idx })); } catch (e) {} };
  const cur = () => q[idx] || null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const mmss = ms => { ms = ms || 0; if (!isFinite(ms)) ms = 0; return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0'); };
  const lenMs = () => { const c = cur(); const d = audio.duration; return (loadedIdx === idx && isFinite(d) && d > 0) ? d * 1000 : (c && c.length_ms) || 0; };
  const posMs = () => (loadedIdx === idx ? audio.currentTime * 1000 : 0);
  function cover(id, s) { const p = PAIRS[(id || 0) % PAIRS.length]; return `<svg width="${s}" height="${s}" viewBox="0 0 46 46" style="border-radius:7px;display:block"><rect width="46" height="46" fill="${p[0]}"/><rect y="30" width="46" height="16" fill="${p[1]}"/><circle cx="33" cy="16" r="10" fill="#FAC775"/></svg>`; }
  function logPlay() { const c = cur(); if (c && c.trackId && loggedIdx !== idx) { loggedIdx = idx; fetch('/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track_id: c.trackId, zone: zone.name }) }).catch(() => {}); } }

  function ensureBar() { if (bar) return; bar = document.createElement('div'); bar.id = 'nowbar'; bar.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--surface);border-top:1px solid var(--border);padding:8px 16px;display:none;align-items:center;gap:14px'); document.body.appendChild(bar); }
  const volIcon = () => vol === 0 ? '🔇' : vol < 0.5 ? '🔉' : '🔊';
  function render() {
    ensureBar(); const c = cur();
    if (!c) { bar.style.display = 'none'; emit(); return; }
    const len = lenMs(), p = posMs(), noAudio = c.playable === false;
    bar.style.display = 'flex';
    bar.innerHTML =
      `<a href="album.html?id=${c.albumId}" style="flex:none">${cover(c.albumId, 46)}</a>
       <div style="min-width:110px"><div style="font-size:14px;font-weight:600">${esc(c.title)}</div><div style="font-size:12px;color:var(--text-2)">${esc(c.artist)}${noAudio ? ' · sin audio local' : ''}</div></div>
       <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
         <div style="display:flex;align-items:center;gap:20px;font-size:15px;color:var(--text)">
           <span data-act="prev" style="cursor:pointer" title="Anterior">⏮</span>
           <span data-act="toggle" style="cursor:pointer;font-size:20px" title="Play/Pausa">${playing ? '⏸' : '▶'}</span>
           <span data-act="next" style="cursor:pointer" title="Siguiente">⏭</span>
         </div>
         <div style="display:flex;align-items:center;gap:8px;width:100%;max-width:380px">
           <span id="npel" style="font-size:11px;color:var(--muted);width:34px;text-align:right">${mmss(p)}</span>
           <div data-act="seek" title="Buscar" style="flex:1;height:8px;display:flex;align-items:center;cursor:${noAudio ? 'default' : 'pointer'}"><div style="width:100%;height:4px;background:var(--surface-2);border-radius:999px;overflow:hidden"><div id="npprog" style="width:${len ? Math.min(100, p / len * 100) : 0}%;height:100%;background:var(--accent)"></div></div></div>
           <span style="font-size:11px;color:var(--muted);width:34px">${mmss(len)}</span>
         </div>
       </div>
       <span data-act="mute" style="cursor:pointer;font-size:15px" title="Silenciar">${volIcon()}</span>
       <input data-act="vol" type="range" min="0" max="1" step="0.01" value="${vol}" title="Volumen" style="width:72px;accent-color:var(--accent)">
       <span data-act="zone" title="Salida / zona" style="cursor:pointer;font-size:12px;color:var(--text-2);display:inline-flex;align-items:center;gap:4px;max-width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">🔈 ${esc(zone.name || 'Este equipo')}</span>
       <a href="queue.html" title="Cola" style="font-size:16px;color:var(--text-2);text-decoration:none">☰ ${idx + 1}/${q.length}</a>`;
    emit();
  }
  function progress() { const c = cur(); if (!c) return; const len = lenMs(), p = posMs(); const pr = document.getElementById('npprog'), el = document.getElementById('npel'); if (pr && len) pr.style.width = Math.min(100, p / len * 100) + '%'; if (el) el.textContent = mmss(p); }
  const emit = () => document.dispatchEvent(new Event('player:change'));

  // ── selector de salida / zona (popover anclado a la barra) ──
  let zpanel = null;
  function updateZoneBtn() { const b = document.querySelector('#nowbar [data-act="zone"]'); if (b) b.innerHTML = '🔈 ' + esc(zone.name || 'Este equipo'); }
  function ensureZPanel() {
    if (zpanel) return;
    zpanel = document.createElement('div'); zpanel.id = 'zonepanel';
    zpanel.setAttribute('style', 'position:fixed;right:16px;bottom:62px;z-index:60;width:280px;max-width:calc(100vw - 32px);background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px 14px;display:none;font-size:13px');
    document.body.appendChild(zpanel);
    document.addEventListener('click', e => { if (zpanel.style.display === 'block' && !e.target.closest('#zonepanel') && !e.target.closest('[data-act="zone"]')) zpanel.style.display = 'none'; });
  }
  function toggleZPanel() { ensureZPanel(); if (zpanel.style.display === 'block') { zpanel.style.display = 'none'; return; } zpanel.style.display = 'block'; renderZPanel(); }
  async function enumOutputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { list: [], labeled: false };
    let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return { list: [], labeled: false }; }
    const outs = devs.filter(d => d.kind === 'audiooutput');
    return { list: outs, labeled: outs.some(d => d.label) };
  }
  async function unlockLabels() {   // los nombres de salida requieren permiso; getUserMedia los desbloquea (y permite setSinkId)
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch (e) {}
    renderZPanel();
  }
  function setZoneDevice(id, label) { zone.deviceId = id || ''; zone.label = label || ''; persistZone(); ensureGraph(); applySink(); renderZPanel(); }
  async function renderZPanel() {
    ensureZPanel();
    let h = '<div style="font-weight:600;margin-bottom:8px">Salida y zona</div>';
    h += '<label style="display:block;font-size:11px;color:var(--text-2);margin-bottom:3px">Nombre de la zona</label>';
    h += `<input id="zname" value="${esc(zone.name)}" style="width:100%;margin-bottom:10px">`;
    if (!sinkSupported()) {
      h += '<div style="color:var(--text-2)">Tu navegador no permite elegir el dispositivo de salida; la zona se guarda igual para el futuro multi-sala.</div>';
    } else {
      const { list, labeled } = await enumOutputs();
      h += '<div style="font-size:11px;color:var(--text-2);margin-bottom:4px">Dispositivo</div>';
      const rows = [{ deviceId: '', label: 'Predeterminado del sistema' }]
        .concat(list.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ deviceId: d.deviceId, label: d.label || ('Dispositivo ' + (i + 1)) })));
      h += rows.map(r => {
        const on = (zone.deviceId || '') === (r.deviceId || '');
        return `<div class="zdev" data-id="${esc(r.deviceId)}" data-label="${esc(r.label)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;${on ? 'background:var(--accent-bg);color:var(--accent)' : ''}"><span>${on ? '◉' : '○'}</span><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(r.label)}</span></div>`;
      }).join('');
      if (!labeled && list.length) h += '<div data-act="unlock" style="margin-top:6px;color:var(--accent);cursor:pointer">Mostrar nombres de los dispositivos…</div>';
      if (!list.length) h += '<div style="color:var(--text-2)">No se detectaron dispositivos de salida.</div>';
    }
    zpanel.innerHTML = h;
  }

  function start(i) {
    idx = i; save(); const c = cur(); if (!c) return;
    if (c.playable === false) { playing = false; loadedIdx = -1; audio.removeAttribute('src'); render(); return; }
    ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume();
    loadedIdx = idx; loggedIdx = -1;
    audio.src = '/api/stream?track=' + c.trackId;
    applyVol();                                  // aplica ReplayGain de esta pista
    audio.play().catch(() => {});
    render();
  }
  function next() { if (idx < q.length - 1) start(idx + 1); else { playing = false; audio.pause(); render(); } }
  function prev() { if (loadedIdx === idx && audio.currentTime > 3) { audio.currentTime = 0; } else if (idx > 0) start(idx - 1); else audio.currentTime = 0; }
  function toggle() { const c = cur(); if (!c || c.playable === false) return; if (loadedIdx !== idx) return start(idx); if (audio.paused) { ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume(); audio.play().catch(() => {}); } else audio.pause(); }
  function seekFrac(f) { const len = lenMs(); if (loadedIdx === idx && len) audio.currentTime = Math.max(0, Math.min(1, f)) * len / 1000; }
  function setVol(v) { vol = Math.max(0, Math.min(1, v)); applyVol(); render(); }

  function playTracks(tracks, i) { if (!tracks || !tracks.length) return; q = tracks; start(i || 0); }
  function playAlbum(id, i) { fetch('/api/album?id=' + id).then(r => r.json()).then(a => { const tr = (a.tracks || []).map(t => ({ trackId: t.trackId, title: t.title, artist: a.artist, albumId: a.id, length_ms: t.length_ms, playable: t.playable !== 0, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs })); if (!tr.length) { alert('Este álbum aún no tiene pistas en tu biblioteca.'); return; } playTracks(tr, i || 0); }); }
  function jumpTo(i) { if (i >= 0 && i < q.length) start(i); }
  function removeAt(i) { const wasCur = i === idx; q.splice(i, 1); if (i < idx) idx--; if (idx >= q.length) idx = q.length - 1; save(); if (wasCur) { if (q.length) start(idx); else { idx = -1; audio.pause(); audio.removeAttribute('src'); loadedIdx = -1; render(); } } else render(); }
  function clearUpcoming() { q = q.slice(0, idx + 1); save(); render(); }
  const getState = () => ({ q: q.slice(), idx, playing });

  // eventos del elemento de audio -> estado real
  audio.addEventListener('play', () => { playing = true; logPlay(); render(); });
  audio.addEventListener('pause', () => { playing = false; render(); });
  audio.addEventListener('ended', () => next());
  audio.addEventListener('timeupdate', progress);
  audio.addEventListener('durationchange', render);
  audio.addEventListener('error', () => { if (cur() && loadedIdx === idx) { playing = false; render(); } });

  // interacción de la barra (delegada: la barra se re-renderiza por innerHTML)
  document.addEventListener('click', e => {
    const zd = e.target.closest('#zonepanel .zdev'); if (zd) { setZoneDevice(zd.dataset.id, zd.dataset.label); return; }
    if (e.target.closest('#zonepanel [data-act="unlock"]')) { unlockLabels(); return; }
    const a = e.target.closest('#nowbar [data-act]'); if (!a) return;
    const k = a.dataset.act;
    if (k === 'prev') prev();
    else if (k === 'next') next();
    else if (k === 'toggle') toggle();
    else if (k === 'zone') toggleZPanel();
    else if (k === 'mute') setVol(vol === 0 ? (parseFloat(localStorage.getItem(VKEY + '.last')) || 0.8) : (localStorage.setItem(VKEY + '.last', vol), 0));
    else if (k === 'seek') { const box = a.getBoundingClientRect(); seekFrac((e.clientX - box.left) / box.width); }
  });
  document.addEventListener('input', e => {
    const a = e.target.closest('#nowbar [data-act="vol"]'); if (a) { setVol(parseFloat(a.value)); return; }
    const zn = e.target.closest('#zonepanel #zname'); if (zn) { zone.name = zn.value; persistZone(); updateZoneBtn(); }
  });

  // biblioteca en vivo: el servidor avisa por SSE cuando reescanea; las vistas se refrescan
  try { const es = new EventSource('/api/events'); es.onmessage = e => { try { if (JSON.parse(e.data).type === 'library') document.dispatchEvent(new CustomEvent('escucharrr:changed')); } catch (x) {} }; } catch (e) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  const getGain = () => (gainNode ? gainNode.gain.value : audio.volume);   // ganancia efectiva (vol × ReplayGain)
  const getZone = () => ({ name: zone.name, deviceId: zone.deviceId, label: zone.label });
  return { playAlbum, playTracks, next, prev, toggle, jumpTo, removeAt, clearUpcoming, getState, setVol, getGain, getZone };
})();
