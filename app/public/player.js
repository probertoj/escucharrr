// escucharrr — reproductor real: doble "deck" + grafo Web Audio con EQ y crossfade.
//   decks[A|B]: <audio> -> source -> gain(ReplayGain × envolvente de fundido) ─┐
//                                                                               ├─ EQ (BiquadFilters) -> gain maestra (volumen) -> salida (setSinkId)
//   el deck inactivo queda en silencio; el crossfade solapa dos decks al cambiar de pista.
// Hace streaming del fichero local vía /api/stream?track=ID (con Range -> seek real).
// Cola persistente (localStorage) + barra fija de "ahora suena" en todas las páginas.
// Al empezar una pista registra la escucha vía POST /api/play (con la zona de salida).
window.player = (function () {
  const KEY = 'escucharrr.queue', VKEY = 'escucharrr.volume', ZKEY = 'escucharrr.zone', EQKEY = 'escucharrr.eq', XKEY = 'escucharrr.xfade';
  const PAIRS = [['#0F6E56', '#1D9E75'], ['#534AB7', '#7F77DD'], ['#185FA5', '#378ADD'], ['#854F0B', '#BA7517'], ['#72243E', '#D4537E'], ['#5F5E5A', '#888780'], ['#3B6D11', '#639922'], ['#993C1D', '#D85A30']];
  const EQF = [60, 150, 400, 1000, 2400, 6000, 15000];                 // bandas del ecualizador (Hz)
  const EQLAB = ['60', '150', '400', '1k', '2.4k', '6k', '15k'];
  const EQPRE = { plano: [0, 0, 0, 0, 0, 0, 0], graves: [6, 4, 1, 0, 0, 0, 1], voz: [-2, -1, 1, 3, 3, 1, 0], brillo: [0, 0, 0, 0, 2, 4, 5], loudness: [5, 3, 0, -1, 0, 3, 5] };
  let q = [], idx = -1, playing = false, loggedIdx = -1, bar = null;
  let vol = 1; try { const v = parseFloat(localStorage.getItem(VKEY)); if (v >= 0 && v <= 1) vol = v; } catch (e) {}
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) { q = s.q || []; idx = (s.idx == null ? -1 : s.idx); } } catch (e) {}
  // zona de salida: nombre + dispositivo (base para multi-sala al estilo Roon; hoy = salida de este equipo)
  let zone = { name: 'Este equipo', deviceId: '', label: '', native: false, nativeDeviceId: '', nativeExclusive: false };
  try { const z = JSON.parse(localStorage.getItem(ZKEY)); if (z && typeof z === 'object') zone = Object.assign(zone, z); } catch (e) {}
  const persistZone = () => { try { localStorage.setItem(ZKEY, JSON.stringify(zone)); } catch (e) {} };
  // ── motor nativo (salida WASAPI del servidor, fuera del navegador) ──
  // Cuando está activo, el transporte va a /api/native/* en vez del audio del navegador,
  // y los decks se silencian para no duplicar el sonido. La posición se sondea del servidor.
  let nativeMode = !!zone.native, nativeDeviceId = zone.nativeDeviceId || '', nativeExclusive = !!zone.nativeExclusive;
  let nativePos = 0, nativeBusy = false, nativeMiss = 0, nativePollTimer = null, nativeVolTimer = null, nativeStartedIdx = -1;
  // ecualizador + crossfade (persistentes)
  let eqOn = false, eqGains = [0, 0, 0, 0, 0, 0, 0];
  try { const e = JSON.parse(localStorage.getItem(EQKEY)); if (e) { eqOn = !!e.on; if (Array.isArray(e.g) && e.g.length === 7) eqGains = e.g.map(Number); } } catch (e) {}
  let xfade = 0; try { const x = parseFloat(localStorage.getItem(XKEY)); if (x >= 0 && x <= 12) xfade = x; } catch (e) {}
  const persistEq = () => { try { localStorage.setItem(EQKEY, JSON.stringify({ on: eqOn, g: eqGains })); } catch (e) {} };
  const persistX = () => { try { localStorage.setItem(XKEY, String(xfade)); } catch (e) {} };

  // ── dos decks de audio + grafo Web Audio (se crea tras el primer gesto del usuario) ──
  const mkEl = () => { const a = new Audio(); a.preload = 'metadata'; a.volume = vol; return a; };
  const decks = [{ el: mkEl(), src: null, gain: null, trackIdx: -1 }, { el: mkEl(), src: null, gain: null, trackIdx: -1 }];
  let cur0 = 0; const active = () => decks[cur0], other = () => decks[1 - cur0];
  let ctx = null, eqBands = [], masterGain = null;
  let fading = false, fadeTimer = null;

  function ensureGraph() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;   // sin Web Audio: usamos el.volume
    try {
      ctx = new AC();
      masterGain = ctx.createGain(); masterGain.gain.value = vol;                    // ganancia maestra = volumen
      eqBands = EQF.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === EQF.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; if (b.type === 'peaking') b.Q.value = 1.1; b.gain.value = eqOn ? eqGains[i] : 0; return b; });
      for (let i = 0; i < eqBands.length - 1; i++) eqBands[i].connect(eqBands[i + 1]);
      eqBands[eqBands.length - 1].connect(masterGain);
      masterGain.connect(ctx.destination);
      decks.forEach(d => { d.src = ctx.createMediaElementSource(d.el); d.gain = ctx.createGain(); d.gain.gain.value = 0.0001; d.src.connect(d.gain); d.gain.connect(eqBands[0]); d.el.volume = 1; });
      applySink();                                                                   // enruta a la salida/zona elegida
    } catch (e) { ctx = null; }
  }
  // enruta el audio al dispositivo de la zona. Con Web Audio el que manda es el AudioContext
  // (setSinkId del <audio> queda anulado al conectarlo al grafo), por eso priorizamos ctx.setSinkId.
  function applySink() {
    const id = zone.deviceId || '';
    try {
      if (ctx && typeof ctx.setSinkId === 'function') return ctx.setSinkId(id).catch(() => {});
      decks.forEach(d => { if (typeof d.el.setSinkId === 'function') d.el.setSinkId(id).catch(() => {}); });
    } catch (e) {}
  }
  function sinkSupported() { return (window.AudioContext && 'setSinkId' in AudioContext.prototype) || typeof (new Audio()).setSinkId === 'function'; }
  function applyEq() { if (ctx) eqBands.forEach((b, i) => { b.gain.value = eqOn ? eqGains[i] : 0; }); }

  // ReplayGain: ganancia lineal de una pista, limitada por el pico para no saturar
  function rgLinear(c) { if (!c || c.gain_db == null) return 1; let g = c.gain_db; if (c.peak_dbfs != null) { const ceil = -1 - c.peak_dbfs; if (g > ceil) g = ceil; } return Math.pow(10, g / 20); }
  function setDeckGain(d, track) { const g = Math.max(0.0001, rgLinear(track)); if (d.gain) { try { d.gain.gain.cancelScheduledValues(ctx.currentTime); } catch (e) {} d.gain.gain.value = g; } }
  function applyVol() { if (ctx) masterGain.gain.value = vol; else { active().el.volume = Math.min(1, vol * rgLinear(cur())); other().el.volume = 0; } try { localStorage.setItem(VKEY, String(vol)); } catch (e) {} }

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ q, idx })); } catch (e) {} };
  const cur = () => q[idx] || null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const mmss = ms => { ms = ms || 0; if (!isFinite(ms)) ms = 0; return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0'); };
  const loadedCur = () => active().trackIdx === idx;
  const lenMs = () => { const c = cur(); if (nativeMode) return (c && c.length_ms) || 0; const d = active().el.duration; return (loadedCur() && isFinite(d) && d > 0) ? d * 1000 : (c && c.length_ms) || 0; };
  const posMs = () => nativeMode ? nativePos * 1000 : (loadedCur() ? active().el.currentTime * 1000 : 0);
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
       <span data-act="eq" title="Ecualizador y crossfade" style="cursor:pointer;font-size:15px;${eqOn || xfade > 0 ? 'color:var(--accent)' : 'color:var(--text-2)'}">🎚</span>
       <span data-act="zone" title="Salida / zona" style="cursor:pointer;font-size:12px;color:${nativeMode ? 'var(--accent)' : 'var(--text-2)'};display:inline-flex;align-items:center;gap:4px;max-width:150px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">🔈 ${zoneLabel()}</span>
       <a href="queue.html" title="Cola" style="font-size:16px;color:var(--text-2);text-decoration:none">☰ ${idx + 1}/${q.length}</a>`;
    emit();
  }
  function progress() { const c = cur(); if (!c) return; const len = lenMs(), p = posMs(); const pr = document.getElementById('npprog'), el = document.getElementById('npel'); if (pr && len) pr.style.width = Math.min(100, p / len * 100) + '%'; if (el) el.textContent = mmss(p); }
  const emit = () => document.dispatchEvent(new Event('player:change'));

  // ── crossfade: al acercarse el final de la pista activa, solapa con la siguiente ──
  function maybeCrossfade() {
    if (!ctx || xfade <= 0 || fading) return;
    const d = active(); if (d.trackIdx !== idx) return;
    const dur = d.el.duration; if (!isFinite(dur) || dur <= 0) return;
    if (idx >= q.length - 1) return;
    const nxt = q[idx + 1]; if (!nxt || nxt.playable === false) return;
    if (dur - d.el.currentTime <= xfade) beginCrossfade();
  }
  function beginCrossfade() {
    const ni = idx + 1, nt = q[ni], nd = other(), od = active();
    fading = true;
    nd.trackIdx = ni; nd.el.src = '/api/stream?track=' + nt.trackId;
    const rgN = Math.max(0.0001, rgLinear(nt)), now = ctx.currentTime;
    nd.gain.gain.cancelScheduledValues(now); nd.gain.gain.setValueAtTime(0.0001, now); nd.gain.gain.linearRampToValueAtTime(rgN, now + xfade);
    od.gain.gain.cancelScheduledValues(now); od.gain.gain.setValueAtTime(Math.max(0.0001, od.gain.gain.value), now); od.gain.gain.linearRampToValueAtTime(0.0001, now + xfade);
    if (ctx.state === 'suspended') ctx.resume();
    nd.el.play().catch(() => {});
    cur0 = 1 - cur0; idx = ni; save(); loggedIdx = -1;                 // la entrante pasa a ser la actual (su 'play' registrará la escucha)
    fadeTimer = setTimeout(() => { od.el.pause(); od.el.removeAttribute('src'); od.trackIdx = -1; fading = false; }, Math.round(xfade * 1000) + 150);
    render();
  }
  function cancelFade() { if (!fading) return; clearTimeout(fadeTimer); fading = false; const o = other(); if (ctx && o.gain) { try { o.gain.gain.cancelScheduledValues(ctx.currentTime); } catch (e) {} o.gain.gain.value = 0.0001; } o.el.pause(); o.el.removeAttribute('src'); o.trackIdx = -1; }

  // ── transporte por el motor nativo (servidor) ──
  function njson(path, body) { return fetch('/api/native/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(r => r.json()); }
  function nativeGainDb(c) { const lin = Math.max(0.0001, vol * rgLinear(c)); return 20 * Math.log10(lin); }   // ReplayGain × volumen (ignorado en bit-perfect)
  function startNativePoll() { stopNativePoll(); nativePollTimer = setInterval(pollNative, 800); }
  function stopNativePoll() { if (nativePollTimer) { clearInterval(nativePollTimer); nativePollTimer = null; } }
  function pollNative() {
    njson('state').then(j => {
      if (!j || !j.ok || !j.state) return;
      nativePos = j.state.positionSec || 0;
      if (j.state.playing) nativeMiss = 0;
      else if (playing && !nativeBusy && ++nativeMiss >= 2) { nativeMiss = 0; onNativeEnded(); return; }
      progress();
    }).catch(() => {});
  }
  function onNativeEnded() { if (idx < q.length - 1) nativePlay(idx + 1); else { playing = false; stopNativePoll(); render(); } }
  function nativePlay(i, opts) {
    idx = i; save(); const c = cur(); if (!c) return;
    if (c.playable === false) { playing = false; nativeStartedIdx = -1; render(); return; }
    nativeBusy = true; playing = true; loggedIdx = idx; nativeMiss = 0; nativeStartedIdx = idx; render();
    const body = { track_id: c.trackId, deviceId: nativeDeviceId || null, exclusive: !!nativeExclusive, gainDb: nativeGainDb(c), zone: zone.name };
    if (opts && opts.seekSec) body.seekSec = opts.seekSec;
    njson('play', body).then(j => {
      nativeBusy = false;
      if (!j || !j.ok) { playing = false; nativeStartedIdx = -1; render(); return; }
      startNativePoll();
    }).catch(() => { nativeBusy = false; playing = false; render(); });
  }
  function nativeToggle() {
    const c = cur(); if (!c || c.playable === false) return;
    if (playing) { nativeBusy = true; playing = false; render(); njson('pause', {}).then(() => { nativeBusy = false; stopNativePoll(); }); }
    else if (nativeStartedIdx === idx) { nativeBusy = true; playing = true; render(); njson('resume', {}).then(() => { nativeBusy = false; startNativePoll(); }); }
    else nativePlay(idx);
  }
  function nativeSeek(f) { const c = cur(); if (!c) return; const lenS = (c.length_ms || 0) / 1000; if (!lenS) return; nativeBusy = true; njson('seek', { sec: Math.max(0, Math.min(1, f)) * lenS }).then(() => nativeBusy = false); }
  function nativeStop() { playing = false; nativeStartedIdx = -1; stopNativePoll(); njson('stop', {}).catch(() => {}); }
  function nativeVolumeApply() { clearTimeout(nativeVolTimer); nativeVolTimer = setTimeout(() => { const c = cur(); if (!c || !playing) return; nativeBusy = true; njson('volume', { db: nativeGainDb(c) }).then(() => nativeBusy = false).catch(() => nativeBusy = false); }, 300); }
  function setNativeMode(on) {
    on = !!on; if (on === nativeMode) return;
    const wasPlaying = playing, posSec = posMs() / 1000;
    if (nativeMode) nativeStop(); else { cancelFade(); decks.forEach(d => d.el.pause()); }
    nativeMode = on; zone.native = on; persistZone(); updateZoneBtn();
    if (cur() && wasPlaying) { if (on) nativePlay(idx, { seekSec: posSec }); else start(idx); }
    else render();
    if (zpanel && zpanel.style.display === 'block') renderZPanel();
  }
  function setNativeDevice(id) { nativeDeviceId = id || ''; zone.nativeDeviceId = nativeDeviceId; persistZone(); if (nativeMode && playing) nativePlay(idx, { seekSec: nativePos }); renderZPanel(); }
  function setNativeExclusive(on) { nativeExclusive = !!on; zone.nativeExclusive = nativeExclusive; persistZone(); if (nativeMode && playing) nativePlay(idx, { seekSec: nativePos }); renderZPanel(); }

  function start(i) {
    if (nativeMode) return nativePlay(i);
    cancelFade();
    idx = i; save(); const c = cur(); if (!c) return;
    const d = active();
    if (c.playable === false) { playing = false; d.trackIdx = -1; d.el.removeAttribute('src'); render(); return; }
    ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume();
    d.trackIdx = idx; loggedIdx = -1;
    setDeckGain(d, c);                           // ReplayGain de esta pista en la ganancia del deck
    const o = other(); if (o.gain) { try { o.gain.gain.cancelScheduledValues(ctx.currentTime); } catch (e) {} o.gain.gain.value = 0.0001; } o.el.pause();
    d.el.src = '/api/stream?track=' + c.trackId;
    applyVol();
    d.el.play().catch(() => {});
    render();
  }
  function onEnded() { if (fading) return; next(); }
  function next() { if (nativeMode) { if (idx < q.length - 1) nativePlay(idx + 1); else { playing = false; stopNativePoll(); render(); } return; } if (idx < q.length - 1) start(idx + 1); else { playing = false; active().el.pause(); render(); } }
  function prev() { if (nativeMode) { if (nativePos > 3 || idx <= 0) nativePlay(idx, { seekSec: 0 }); else nativePlay(idx - 1); return; } const d = active(); if (d.trackIdx === idx && d.el.currentTime > 3) { d.el.currentTime = 0; } else if (idx > 0) start(idx - 1); else d.el.currentTime = 0; }
  function toggle() { if (nativeMode) return nativeToggle(); const c = cur(); if (!c || c.playable === false) return; const d = active(); if (d.trackIdx !== idx) return start(idx); if (d.el.paused) { ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume(); d.el.play().catch(() => {}); } else d.el.pause(); }
  function seekFrac(f) { if (nativeMode) return nativeSeek(f); const len = lenMs(); if (loadedCur() && len) active().el.currentTime = Math.max(0, Math.min(1, f)) * len / 1000; }
  function setVol(v) { vol = Math.max(0, Math.min(1, v)); applyVol(); if (nativeMode) nativeVolumeApply(); render(); }

  function playTracks(tracks, i) { if (!tracks || !tracks.length) return; q = tracks; start(i || 0); }
  function playAlbum(id, i) { fetch('/api/album?id=' + id).then(r => r.json()).then(a => { const tr = (a.tracks || []).map(t => ({ trackId: t.trackId, title: t.title, artist: a.artist, albumId: a.id, length_ms: t.length_ms, playable: t.playable !== 0, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs })); if (!tr.length) { alert('Este álbum aún no tiene pistas en tu biblioteca.'); return; } playTracks(tr, i || 0); }); }
  function jumpTo(i) { if (i >= 0 && i < q.length) start(i); }
  function removeAt(i) { const wasCur = i === idx; q.splice(i, 1); if (i < idx) idx--; if (idx >= q.length) idx = q.length - 1; save(); if (wasCur) { if (q.length) start(idx); else { idx = -1; cancelFade(); active().el.pause(); active().el.removeAttribute('src'); active().trackIdx = -1; render(); } } else render(); }
  function clearUpcoming() { q = q.slice(0, idx + 1); save(); render(); }
  const getState = () => ({ q: q.slice(), idx, playing });

  // eventos de audio -> estado real (ambos decks; sólo cuenta el activo)
  decks.forEach(d => {
    // en modo nativo los decks están en silencio: sus eventos no deben tocar el estado de la UI
    d.el.addEventListener('play', () => { if (nativeMode || active() !== d) return; playing = true; logPlay(); render(); });
    d.el.addEventListener('pause', () => { if (nativeMode || active() !== d) return; playing = false; render(); });
    d.el.addEventListener('ended', () => { if (nativeMode || active() !== d) return; onEnded(); });
    d.el.addEventListener('timeupdate', () => { if (nativeMode || active() !== d) return; progress(); maybeCrossfade(); });
    d.el.addEventListener('durationchange', () => { if (nativeMode || active() !== d) return; render(); });
    d.el.addEventListener('error', () => { if (nativeMode || active() !== d) return; playing = false; render(); });
  });

  // ── selector de salida / zona (popover anclado a la barra) ──
  let zpanel = null;
  const zoneLabel = () => esc(zone.name || 'Este equipo') + (nativeMode ? ' · nativo' : '');
  function updateZoneBtn() { const b = document.querySelector('#nowbar [data-act="zone"]'); if (b) b.innerHTML = '🔈 ' + zoneLabel(); }
  function ensureZPanel() {
    if (zpanel) return;
    zpanel = document.createElement('div'); zpanel.id = 'zonepanel';
    zpanel.setAttribute('style', 'position:fixed;right:16px;bottom:62px;z-index:60;width:280px;max-width:calc(100vw - 32px);background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px 14px;display:none;font-size:13px');
    document.body.appendChild(zpanel);
    document.addEventListener('click', e => { if (zpanel.style.display === 'block' && !e.target.closest('#zonepanel') && !e.target.closest('[data-act="zone"]')) zpanel.style.display = 'none'; });
  }
  function toggleZPanel() { ensureZPanel(); if (zpanel.style.display === 'block') { zpanel.style.display = 'none'; return; } if (eqpanel) eqpanel.style.display = 'none'; zpanel.style.display = 'block'; renderZPanel(); }
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
    // conmutador de motor nativo (salida WASAPI del servidor)
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><span>Motor nativo (este equipo)</span><span data-act="ntoggle" style="cursor:pointer;font-size:12px;padding:2px 10px;border-radius:999px;background:${nativeMode ? 'var(--accent)' : 'var(--surface-2)'};color:${nativeMode ? '#fff' : 'var(--text-2)'}">${nativeMode ? 'Activado' : 'Desactivado'}</span></div>`;
    if (nativeMode) {
      h += '<div style="font-size:11px;color:var(--text-2);margin-bottom:6px">Salida WASAPI fuera del navegador (bit-perfect posible).</div>';
      let nr = null; try { nr = await njson('devices'); } catch (e) {}
      if (!nr || !nr.ok) {
        h += `<div style="color:var(--text-2)">${nr && nr.built === false ? 'El motor no está compilado: ejecuta engine/build.ps1.' : 'Motor nativo no disponible en esta build.'}</div>`;
      } else {
        h += '<div style="font-size:11px;color:var(--text-2);margin-bottom:4px">Dispositivo</div>';
        const rows = [{ id: '', name: 'Predeterminado del sistema' }].concat((nr.items || []).map(d => ({ id: d.id, name: d.name + (d.default ? ' (predeterminado)' : '') })));
        h += rows.map(r => { const on = (nativeDeviceId || '') === (r.id || ''); return `<div class="ndev" data-id="${esc(r.id)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;${on ? 'background:var(--accent-bg);color:var(--accent)' : ''}"><span>${on ? '◉' : '○'}</span><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(r.name)}</span></div>`; }).join('');
        h += `<label style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer"><input type="checkbox" data-act="nexcl" ${nativeExclusive ? 'checked' : ''}><span>Exclusivo (bit-perfect)</span></label>`;
        h += '<div style="font-size:11px;color:var(--text-2);margin-top:4px">En bit-perfect la muestra sale intacta: el volumen y el EQ no se aplican.</div>';
      }
    } else if (!sinkSupported()) {
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

  // ── ajustes de audio: ecualizador + crossfade (popover) ──
  let eqpanel = null;
  function ensureEqPanel() {
    if (eqpanel) return;
    eqpanel = document.createElement('div'); eqpanel.id = 'eqpanel';
    eqpanel.setAttribute('style', 'position:fixed;right:16px;bottom:62px;z-index:60;width:320px;max-width:calc(100vw - 32px);background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px 14px;display:none;font-size:13px');
    document.body.appendChild(eqpanel);
    document.addEventListener('click', e => { if (eqpanel.style.display === 'block' && !e.target.closest('#eqpanel') && !e.target.closest('[data-act="eq"]')) eqpanel.style.display = 'none'; });
  }
  function toggleEqPanel() { ensureEqPanel(); if (eqpanel.style.display === 'block') { eqpanel.style.display = 'none'; return; } if (zpanel) zpanel.style.display = 'none'; eqpanel.style.display = 'block'; renderEqPanel(); }
  function setEqEnabled(on) { eqOn = on; applyEq(); persistEq(); renderEqPanel(); const b = document.querySelector('#nowbar [data-act="eq"]'); if (b) b.style.color = (eqOn || xfade > 0) ? 'var(--accent)' : 'var(--text-2)'; }
  function setEqBand(i, v) { eqGains[i] = v; if (ctx && eqOn && eqBands[i]) eqBands[i].gain.value = v; persistEq(); const lab = document.getElementById('eqval' + i); if (lab) lab.textContent = (v > 0 ? '+' : '') + v + ' dB'; }
  function setPreset(name) { const p = EQPRE[name]; if (!p) return; eqGains = p.slice(); if (!eqOn) eqOn = true; applyEq(); persistEq(); renderEqPanel(); const b = document.querySelector('#nowbar [data-act="eq"]'); if (b) b.style.color = 'var(--accent)'; }
  function setXfade(v) { xfade = Math.max(0, Math.min(12, v)); persistX(); const lab = document.getElementById('xfadeval'); if (lab) lab.textContent = xfade === 0 ? 'desactivado' : xfade.toFixed(1).replace('.0', '') + ' s'; const b = document.querySelector('#nowbar [data-act="eq"]'); if (b) b.style.color = (eqOn || xfade > 0) ? 'var(--accent)' : 'var(--text-2)'; }
  function renderEqPanel() {
    ensureEqPanel();
    let h = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><span style="font-weight:600">Ecualizador</span><span data-act="eqtoggle" style="cursor:pointer;font-size:12px;padding:2px 10px;border-radius:999px;background:${eqOn ? 'var(--accent)' : 'var(--surface-2)'};color:${eqOn ? '#fff' : 'var(--text-2)'}">${eqOn ? 'Activado' : 'Desactivado'}</span></div>`;
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' + Object.keys(EQPRE).map(k => `<span data-pre="${k}" style="cursor:pointer;font-size:12px;padding:3px 9px;border-radius:999px;background:var(--surface-2);text-transform:capitalize">${k}</span>`).join('') + '</div>';
    h += EQF.map((f, i) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;opacity:${eqOn ? 1 : .5}"><span style="width:38px;font-size:11px;color:var(--text-2);text-align:right">${EQLAB[i]}</span><input class="eqband" data-i="${i}" type="range" min="-12" max="12" step="1" value="${eqGains[i]}" style="flex:1;accent-color:var(--accent)"><span id="eqval${i}" style="width:48px;font-size:11px;text-align:right">${(eqGains[i] > 0 ? '+' : '') + eqGains[i]} dB</span></div>`).join('');
    h += `<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px"><span style="font-weight:600">Crossfade</span><span id="xfadeval" style="font-size:12px;color:var(--text-2)">${xfade === 0 ? 'desactivado' : xfade.toFixed(1).replace('.0', '') + ' s'}</span></div><input data-act="xfade" type="range" min="0" max="12" step="0.5" value="${xfade}" style="width:100%;accent-color:var(--accent)"><div style="font-size:11px;color:var(--text-2);margin-top:3px">Fundido entre pistas al cambiar automáticamente.</div></div>`;
    eqpanel.innerHTML = h;
  }

  // interacción de la barra y los popovers (delegada)
  document.addEventListener('click', e => {
    const zd = e.target.closest('#zonepanel .zdev'); if (zd) { setZoneDevice(zd.dataset.id, zd.dataset.label); return; }
    if (e.target.closest('#zonepanel [data-act="unlock"]')) { unlockLabels(); return; }
    if (e.target.closest('#zonepanel [data-act="ntoggle"]')) { setNativeMode(!nativeMode); return; }
    const nd = e.target.closest('#zonepanel .ndev'); if (nd) { setNativeDevice(nd.dataset.id); return; }
    if (e.target.matches('#zonepanel [data-act="nexcl"]')) { setNativeExclusive(e.target.checked); return; }
    const pre = e.target.closest('#eqpanel [data-pre]'); if (pre) { setPreset(pre.dataset.pre); return; }
    if (e.target.closest('#eqpanel [data-act="eqtoggle"]')) { setEqEnabled(!eqOn); return; }
    const a = e.target.closest('#nowbar [data-act]'); if (!a) return;
    const k = a.dataset.act;
    if (k === 'prev') prev();
    else if (k === 'next') next();
    else if (k === 'toggle') toggle();
    else if (k === 'eq') toggleEqPanel();
    else if (k === 'zone') toggleZPanel();
    else if (k === 'mute') setVol(vol === 0 ? (parseFloat(localStorage.getItem(VKEY + '.last')) || 0.8) : (localStorage.setItem(VKEY + '.last', vol), 0));
    else if (k === 'seek') { const box = a.getBoundingClientRect(); seekFrac((e.clientX - box.left) / box.width); }
  });
  document.addEventListener('input', e => {
    const v = e.target.closest('#nowbar [data-act="vol"]'); if (v) { setVol(parseFloat(v.value)); return; }
    const zn = e.target.closest('#zonepanel #zname'); if (zn) { zone.name = zn.value; persistZone(); updateZoneBtn(); return; }
    const eb = e.target.closest('#eqpanel .eqband'); if (eb) { setEqBand(+eb.dataset.i, parseInt(eb.value, 10)); return; }
    const xf = e.target.closest('#eqpanel [data-act="xfade"]'); if (xf) { setXfade(parseFloat(xf.value)); }
  });

  // biblioteca en vivo: el servidor avisa por SSE cuando reescanea; las vistas se refrescan
  try { const es = new EventSource('/api/events'); es.onmessage = e => { try { if (JSON.parse(e.data).type === 'library') document.dispatchEvent(new CustomEvent('escucharrr:changed')); } catch (x) {} }; } catch (e) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  const getGain = () => (ctx ? masterGain.gain.value * (active().gain ? active().gain.gain.value : 1) : active().el.volume);  // ganancia efectiva (vol × ReplayGain)
  const getZone = () => ({ name: zone.name, deviceId: zone.deviceId, label: zone.label });
  const getAudio = () => ({ eqOn, eqGains: eqGains.slice(), xfade });
  const getNative = () => ({ nativeMode, nativeDeviceId, nativeExclusive, nativePos, playing, startedIdx: nativeStartedIdx });
  return { playAlbum, playTracks, next, prev, toggle, jumpTo, removeAt, clearUpcoming, getState, setVol, getGain, getZone, getAudio, getNative, setNativeMode };
})();
