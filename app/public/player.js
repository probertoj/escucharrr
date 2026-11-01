// escucharrr — reproductor real: doble "deck" + grafo Web Audio con EQ y crossfade.
//   decks[A|B]: <audio> -> source -> gain(ReplayGain × envolvente de fundido) ─┐
//                                                                               ├─ EQ (BiquadFilters) -> gain maestra (volumen) -> salida (setSinkId)
//   el deck inactivo queda en silencio; el crossfade solapa dos decks al cambiar de pista.
// Hace streaming del fichero local vía /api/stream?track=ID (con Range -> seek real).
// Cola persistente (localStorage) + barra fija de "ahora suena" en todas las páginas.
// Al empezar una pista registra la escucha vía POST /api/play (con la zona de salida).
window.player = (function () {
  const KEY = 'escucharrr.queue', VKEY = 'escucharrr.volume', ZKEY = 'escucharrr.zone', EQKEY = 'escucharrr.eq', XKEY = 'escucharrr.xfade', RGKEY = 'escucharrr.rg';
  const PAIRS = [['#0F6E56', '#1D9E75'], ['#534AB7', '#7F77DD'], ['#185FA5', '#378ADD'], ['#854F0B', '#BA7517'], ['#72243E', '#D4537E'], ['#5F5E5A', '#888780'], ['#3B6D11', '#639922'], ['#993C1D', '#D85A30']];
  const EQF = [60, 150, 400, 1000, 2400, 6000, 15000];                 // bandas del ecualizador (Hz)
  const EQLAB = ['60', '150', '400', '1k', '2.4k', '6k', '15k'];
  const EQPRE = { plano: [0, 0, 0, 0, 0, 0, 0], graves: [6, 4, 1, 0, 0, 0, 1], voz: [-2, -1, 1, 3, 3, 1, 0], brillo: [0, 0, 0, 0, 2, 4, 5], loudness: [5, 3, 0, -1, 0, 3, 5] };
  let q = [], idx = -1, playing = false, loggedIdx = -1, bar = null;
  let scrobbledIdx = -1, trackStartEpoch = 0;   // scrobbling: una vez por pista, con la hora de inicio
  let radioOn = false; try { radioOn = localStorage.getItem('escucharrr.radio') === '1'; } catch (e) {}   // radio: auto-extiende la cola
  let radioFetching = false, undoStack = [];     // deshacer: pila de instantáneas de la cola
  let vol = 1; try { const v = parseFloat(localStorage.getItem(VKEY)); if (v >= 0 && v <= 1) vol = v; } catch (e) {}
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) { q = s.q || []; idx = (s.idx == null ? -1 : s.idx); } } catch (e) {}
  // zona de salida: nombre + dispositivo (base para multi-sala al estilo Roon; hoy = salida de este equipo)
  let zone = { name: 'Este equipo', deviceId: '', label: '', native: false, nativeDeviceId: '', nativeExclusive: false, upnp: false, upnpDeviceId: '', upnpName: '' };
  try { const z = JSON.parse(localStorage.getItem(ZKEY)); if (z && typeof z === 'object') zone = Object.assign(zone, z); } catch (e) {}
  const persistZone = () => { try { localStorage.setItem(ZKEY, JSON.stringify(zone)); } catch (e) {} };
  // ── motor nativo (salida WASAPI del servidor, fuera del navegador) ──
  // Cuando está activo, el transporte va a /api/native/* en vez del audio del navegador,
  // y los decks se silencian para no duplicar el sonido. La posición se sondea del servidor.
  let nativeMode = !!zone.native, nativeDeviceId = zone.nativeDeviceId || '', nativeExclusive = !!zone.nativeExclusive;
  let nativePos = 0, nativeBusy = false, nativeMiss = 0, nativePollTimer = null, nativeVolTimer = null, nativeEqTimer = null, nativeStartedIdx = -1;
  // ── salida de RED (UPnP/DLNA, p. ej. Eversolo): otra zona-servidor; el servidor controla el renderer ──
  let upnpMode = !!zone.upnp, upnpDeviceId = zone.upnpDeviceId || '', upnpDevName = zone.upnpName || '';
  let upnpPos = 0, upnpBusy = false, upnpMiss = 0, upnpPollTimer = null, upnpVolTimer = null, upnpStartedIdx = -1;
  // ecualizador + crossfade (persistentes)
  let eqOn = false, eqGains = [0, 0, 0, 0, 0, 0, 0];
  try { const e = JSON.parse(localStorage.getItem(EQKEY)); if (e) { eqOn = !!e.on; if (Array.isArray(e.g) && e.g.length === 7) eqGains = e.g.map(Number); } } catch (e) {}
  let xfade = 0; try { const x = parseFloat(localStorage.getItem(XKEY)); if (x >= 0 && x <= 12) xfade = x; } catch (e) {}
  const persistEq = () => { try { localStorage.setItem(EQKEY, JSON.stringify({ on: eqOn, g: eqGains })); } catch (e) {} };
  const persistX = () => { try { localStorage.setItem(XKEY, String(xfade)); } catch (e) {} };
  // ── DSP avanzado: EQ paramétrico (bandas configurables) + convolución (impulso WAV) ──
  // Tipos de banda; el índice es también el tipo que entiende el motor nativo.
  const PEQKEY = 'escucharrr.peq', CONVKEY = 'escucharrr.conv';
  const PEQTYPES = ['peak', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch'];
  const PEQLABEL = { peak: 'Campana', lowshelf: 'Shelf grave', highshelf: 'Shelf agudo', lowpass: 'Paso bajo', highpass: 'Paso alto', notch: 'Notch' };
  let peqOn = false, peqBands = [];
  try { const p = JSON.parse(localStorage.getItem(PEQKEY)); if (p) { peqOn = !!p.on; if (Array.isArray(p.bands)) peqBands = p.bands.map(b => ({ type: b.type | 0, freq: +b.freq || 1000, q: +b.q || 1, gain: +b.gain || 0 })).slice(0, 16); } } catch (e) {}
  let convOn = false, convFile = '';
  try { const c = JSON.parse(localStorage.getItem(CONVKEY)); if (c) { convOn = !!c.on; convFile = c.file || ''; } } catch (e) {}
  const persistPeq = () => { try { localStorage.setItem(PEQKEY, JSON.stringify({ on: peqOn, bands: peqBands })); } catch (e) {} };
  const persistConv = () => { try { localStorage.setItem(CONVKEY, JSON.stringify({ on: convOn, file: convFile })); } catch (e) {} };
  // normalización ReplayGain: 'track' (cada tema a -18 LUFS) | 'album' (misma ganancia por disco, conserva dinámica) | 'off'
  let rgMode = 'track'; try { const m = localStorage.getItem(RGKEY); if (m === 'track' || m === 'album' || m === 'off') rgMode = m; } catch (e) {}
  const persistRg = () => { try { localStorage.setItem(RGKEY, rgMode); } catch (e) {} };

  // ── dos decks de audio + grafo Web Audio (se crea tras el primer gesto del usuario) ──
  const mkEl = () => { const a = new Audio(); a.preload = 'metadata'; a.volume = vol; return a; };
  const decks = [{ el: mkEl(), src: null, gain: null, trackIdx: -1 }, { el: mkEl(), src: null, gain: null, trackIdx: -1 }];
  let cur0 = 0; const active = () => decks[cur0], other = () => decks[1 - cur0];
  let ctx = null, eqBands = [], masterGain = null;
  let dspIn = null, dspOut = null, peqNodes = [], convNode = null, convBuffer = null;   // subgrafo DSP reconstruible
  let fading = false, fadeTimer = null;
  // ── radio por internet (stream en vivo; modelo is_live de Roon: sin cola/seek/duración) ──
  const IRKEY = 'escucharrr.radio.station';
  let irEl = null, irStation = null, irTitle = '', irPlaying = false, irPollT = null;
  try { const s = JSON.parse(localStorage.getItem(IRKEY)); if (s && s.id) irStation = s; } catch (e) {}

  function ensureGraph() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;   // sin Web Audio: usamos el.volume
    try {
      ctx = new AC();
      masterGain = ctx.createGain(); masterGain.gain.value = vol;                    // ganancia maestra = volumen
      eqBands = EQF.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === EQF.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; if (b.type === 'peaking') b.Q.value = 1.1; b.gain.value = eqOn ? eqGains[i] : 0; return b; });
      for (let i = 0; i < eqBands.length - 1; i++) eqBands[i].connect(eqBands[i + 1]);
      dspIn = ctx.createGain(); dspOut = ctx.createGain();                            // puntos del subgrafo DSP avanzado
      eqBands[eqBands.length - 1].connect(dspIn);                                     // EQ gráfico → [EQ paramétrico] → [convolución] → maestra
      dspOut.connect(masterGain);
      masterGain.connect(ctx.destination);
      decks.forEach(d => { d.src = ctx.createMediaElementSource(d.el); d.gain = ctx.createGain(); d.gain.gain.value = 0.0001; d.src.connect(d.gain); d.gain.connect(eqBands[0]); d.el.volume = 1; });
      if (convFile) loadImpulse(convFile, true); else rebuildDsp();                   // arma el subgrafo con el estado persistido
      applySink();                                                                   // enruta a la salida/zona elegida
    } catch (e) { ctx = null; }
  }
  // Reconstruye el tramo dspIn → [paramétrico] → [convolución] → dspOut (sin tocar decks/EQ/maestra).
  function rebuildDsp() {
    if (!ctx || !dspIn || !dspOut) return;
    try { dspIn.disconnect(); } catch (e) {}
    peqNodes.forEach(n => { try { n.disconnect(); } catch (e) {} });
    if (convNode) { try { convNode.disconnect(); } catch (e) {} }
    peqNodes = [];
    let node = dspIn;
    if (peqOn && peqBands.length) {
      const nyq = ctx.sampleRate / 2 - 1;
      peqBands.forEach(b => {
        const f = ctx.createBiquadFilter();
        f.type = PEQTYPES[b.type] || 'peaking';
        if (f.type === 'peak') f.type = 'peaking';
        f.frequency.value = Math.max(10, Math.min(nyq, b.freq || 1000));
        f.Q.value = b.q > 0 ? b.q : 0.707;
        if (f.type === 'peaking' || f.type === 'lowshelf' || f.type === 'highshelf') f.gain.value = b.gain || 0;
        node.connect(f); node = f; peqNodes.push(f);
      });
    }
    if (convOn && convNode && convBuffer) { node.connect(convNode); node = convNode; }
    node.connect(dspOut);
  }
  // Carga un impulso WAV del servidor en el ConvolverNode (normalize=false para respetar la IR tal cual).
  async function loadImpulse(file, keep) {
    if (!keep) { convFile = file || ''; persistConv(); }
    if (!file) { convBuffer = null; if (convNode) { try { convNode.buffer = null; } catch (e) {} } rebuildDsp(); return; }
    try {
      const ab = await fetch('/api/dsp/impulse?f=' + encodeURIComponent(file)).then(r => r.ok ? r.arrayBuffer() : Promise.reject());
      if (!ctx) return;
      convBuffer = await ctx.decodeAudioData(ab);
      if (!convNode) convNode = ctx.createConvolver();
      convNode.normalize = false; convNode.buffer = convBuffer;
      rebuildDsp();
    } catch (e) { convBuffer = null; rebuildDsp(); }
  }
  // enruta el audio al dispositivo de la zona. Con Web Audio el que manda es el AudioContext
  // (setSinkId del <audio> queda anulado al conectarlo al grafo), por eso priorizamos ctx.setSinkId.
  function applySink() {
    const id = zone.deviceId || '';
    try {
      if (irEl && typeof irEl.setSinkId === 'function') irEl.setSinkId(id).catch(() => {});   // la radio usa su propio elemento
      if (ctx && typeof ctx.setSinkId === 'function') return ctx.setSinkId(id).catch(() => {});
      decks.forEach(d => { if (typeof d.el.setSinkId === 'function') d.el.setSinkId(id).catch(() => {}); });
    } catch (e) {}
  }
  function sinkSupported() { return (window.AudioContext && 'setSinkId' in AudioContext.prototype) || typeof (new Audio()).setSinkId === 'function'; }
  function applyEq() { if (ctx) eqBands.forEach((b, i) => { b.gain.value = eqOn ? eqGains[i] : 0; }); }

  // ReplayGain: ganancia lineal según el modo (pista/álbum/off), limitada por el pico.
  // En 'album' usa la ganancia y el pico del disco (si faltan, cae a los de pista).
  function rgLinear(c) {
    if (!c || rgMode === 'off') return 1;
    let g, peak;
    if (rgMode === 'album' && c.album_gain_db != null) { g = c.album_gain_db; peak = c.album_peak_dbfs; }
    else { g = c.gain_db; peak = c.peak_dbfs; }
    if (g == null) return 1;
    if (peak != null) { const ceil = -1 - peak; if (g > ceil) g = ceil; }
    return Math.pow(10, g / 20);
  }
  function setDeckGain(d, track) { const g = Math.max(0.0001, rgLinear(track)); if (d.gain) { try { d.gain.gain.cancelScheduledValues(ctx.currentTime); } catch (e) {} d.gain.gain.value = g; } }
  function applyVol() { if (ctx) masterGain.gain.value = vol; else { active().el.volume = Math.min(1, vol * rgLinear(cur())); other().el.volume = 0; } try { localStorage.setItem(VKEY, String(vol)); } catch (e) {} }

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ q, idx })); } catch (e) {} };
  const cur = () => q[idx] || null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const mmss = ms => { ms = ms || 0; if (!isFinite(ms)) ms = 0; return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0'); };
  const loadedCur = () => active().trackIdx === idx;
  const lenMs = () => { const c = cur(); if (nativeMode) return (c && c.length_ms) || 0; const d = active().el.duration; return (loadedCur() && isFinite(d) && d > 0) ? d * 1000 : (c && c.length_ms) || 0; };
  const posMs = () => nativeMode ? nativePos * 1000 : upnpMode ? upnpPos * 1000 : (loadedCur() ? active().el.currentTime * 1000 : 0);
  function cover(id, s) { return `<img src="/api/cover?rg=${id || 0}" alt="" draggable="false" style="width:${s}px;height:${s}px;object-fit:cover;border-radius:7px;display:block">`; }
  function logPlay() { const c = cur(); if (c && c.trackId && loggedIdx !== idx) { loggedIdx = idx; fetch('/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track_id: c.trackId, zone: zone.name }) }).catch(() => {}); } }
  const spost = (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).catch(() => {});
  function trackStarted() { trackStartEpoch = Math.floor(Date.now() / 1000); const c = cur(); if (c && c.trackId) spost('/api/scrobble/nowplaying', { track_id: c.trackId }); fetchPeaks(); if (lypanel && lypanel.style.display === 'block') loadLyrics(); }   // "sonando ahora" + recargar letra si el panel está abierto
  // scrobble al superar el umbral (mitad de la pista o 4 min; pistas ≥ 30 s), una sola vez
  function maybeScrobble() {
    const c = cur(); if (!c || !c.trackId || scrobbledIdx === idx) return;
    const len = lenMs(); if (!len || len < 30000) return;
    if (posMs() >= Math.min(len / 2, 240000)) { scrobbledIdx = idx; spost('/api/scrobble/submit', { track_id: c.trackId, listened_at: trackStartEpoch || Math.floor(Date.now() / 1000) }); }
  }
  // ── radio (modelo "Swim"): al llegar a la última pista, extiende la cola desde el grafo ──
  function maybeRadio() {
    if (!radioOn || radioFetching || idx < 0 || idx < q.length - 1) return;   // sólo en la última de la cola
    const seed = cur(); if (!seed || !seed.trackId) return;
    radioFetching = true;
    const exclude = q.map(t => t.recording_id).filter(Boolean).join(',');
    fetch('/api/radio?n=5&seed=' + seed.trackId + (exclude ? '&exclude=' + encodeURIComponent(exclude) : ''))
      .then(r => r.json()).then(j => { radioFetching = false; if (j && j.tracks && j.tracks.length) { q = q.concat(j.tracks); save(); render(); } })
      .catch(() => { radioFetching = false; });
  }
  function setRadio(on) { radioOn = !!on; try { localStorage.setItem('escucharrr.radio', radioOn ? '1' : '0'); } catch (e) {} if (radioOn) maybeRadio(); render(); }
  // ── deshacer cambios de cola (quitar / vaciar lo próximo) ──
  function snapshot() { try { undoStack.push(JSON.stringify({ q, idx })); if (undoStack.length > 25) undoStack.shift(); } catch (e) {} }
  function undo() { const s = undoStack.pop(); if (!s) return false; try { const o = JSON.parse(s); q = o.q; idx = o.idx; save(); render(); return true; } catch (e) { return false; } }

  // ── waveform (barra de onda tipo Roon): picos 0-255 por pista, servidos por /api/peaks ──
  let curPeaks = null, curPeaksTrack = -1;
  function fetchPeaks() {
    const c = cur(); if (!c || !c.trackId) { curPeaks = null; curPeaksTrack = -1; return; }
    if (c.trackId === curPeaksTrack) return;
    curPeaksTrack = c.trackId; curPeaks = null;
    fetch('/api/peaks?track=' + c.trackId).then(r => r.ok ? r.json() : null).then(j => { const cc = cur(); if (j && j.peaks && cc && cc.trackId === curPeaksTrack) { curPeaks = j.peaks; render(); } }).catch(() => {});
  }
  function wfSvg(peaks) {
    const n = peaks.length; let b = '';
    for (let i = 0; i < n; i++) { const h = Math.max(3, peaks[i] / 255 * 100); const y = ((100 - h) / 2).toFixed(1); b += '<rect x="' + (i + 0.12).toFixed(2) + '" y="' + y + '" width="0.76" height="' + h.toFixed(1) + '" rx="0.3"/>'; }
    return '<svg viewBox="0 0 ' + n + ' 100" preserveAspectRatio="none" width="100%" height="100%" style="display:block">' + b + '</svg>';
  }
  // ── pantalla "ahora suena" a pantalla completa (estilo Roon) ──
  let npfs = null;
  function ensureNpFs() { if (npfs) return; npfs = document.createElement('div'); npfs.id = 'npfs'; npfs.setAttribute('style', 'position:fixed;inset:0;z-index:75;background:var(--bg);display:none;flex-direction:column;overflow:auto'); document.body.appendChild(npfs); }
  function toggleNpFs() { ensureNpFs(); if (npfs.style.display === 'flex') { npfs.style.display = 'none'; return; } renderNpFs(); npfs.style.display = 'flex'; }
  function renderNpFs() {
    if (!npfs) return; const c = cur(); if (!c) { npfs.style.display = 'none'; return; }
    const len = lenMs(), p = posMs(), frac = len ? Math.min(100, p / len * 100) : 0, wf = curPeaks && curPeaksTrack === c.trackId;
    const up = q.slice(idx + 1, idx + 6);
    npfs.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px">
        <span style="color:var(--text-2);font-size:13px">Ahora suena${nativeMode ? ' · nativo' : upnpMode ? ' · ' + esc(upnpDevName || 'red') : ''}</span>
        <span data-act="npclose" title="Cerrar" style="cursor:pointer;display:inline-flex;color:var(--text-2)">${ic('close', 22)}</span>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:0 20px 36px;max-width:680px;margin:0 auto;width:100%">
        <div style="width:min(54vh,320px);aspect-ratio:1;border-radius:16px;overflow:hidden;box-shadow:0 12px 44px rgba(0,0,0,.28)"><img src="/api/cover?rg=${c.albumId}" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></div>
        <div style="text-align:center">
          <div style="font-family:var(--serif);font-size:27px;font-weight:600;line-height:1.2">${esc(c.title)}</div>
          <div style="font-size:16px;color:var(--text-2);margin-top:5px">${esc(c.artist || '')}${c.album ? ` · <a href="album.html?id=${c.albumId}" style="color:var(--text-2)">${esc(c.album)}</a>` : ''}</div>
        </div>
        <div style="width:100%;display:flex;align-items:center;gap:10px">
          <span id="npfsel" style="font-size:12px;color:var(--muted);width:40px;text-align:right">${mmss(p)}</span>
          ${wf
            ? `<div data-act="seek" title="Buscar" style="position:relative;flex:1;height:48px;cursor:pointer"><div style="position:absolute;inset:0;fill:var(--surface-2)">${wfSvg(curPeaks)}</div><div id="npfswf" style="position:absolute;inset:0;fill:var(--accent);clip-path:inset(0 ${100 - frac}% 0 0)">${wfSvg(curPeaks)}</div></div>`
            : `<div data-act="seek" title="Buscar" style="flex:1;height:10px;display:flex;align-items:center;cursor:pointer"><div style="width:100%;height:5px;background:var(--surface-2);border-radius:999px;overflow:hidden"><div id="npfsprog" style="width:${frac}%;height:100%;background:var(--accent)"></div></div></div>`}
          <span style="font-size:12px;color:var(--muted);width:40px">${mmss(len)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:30px;color:var(--text)">
          <span data-act="prev" style="cursor:pointer;display:inline-flex;color:var(--text-2)" title="Anterior">${ic('prev', 28)}</span>
          <span data-act="toggle" style="cursor:pointer;display:inline-flex" title="Play/Pausa">${ic(playing ? 'pause' : 'play', 46)}</span>
          <span data-act="next" style="cursor:pointer;display:inline-flex;color:var(--text-2)" title="Siguiente">${ic('next', 28)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:20px;color:var(--text-2)">
          <span data-act="mute" style="cursor:pointer;display:inline-flex" title="Silenciar">${ic(volIcon(), 18)}</span>
          <input data-act="vol" type="range" min="0" max="1" step="0.01" value="${vol}" title="Volumen" style="width:120px;accent-color:var(--accent)">
          <span data-act="lyrics" title="Letra" style="cursor:pointer;display:inline-flex">${ic('lyrics', 18)}</span>
          <span data-act="eq" title="Ecualizador y crossfade" style="cursor:pointer;display:inline-flex;${eqOn || xfade > 0 ? 'color:var(--accent)' : ''}">${ic('eq', 18)}</span>
          <span data-act="zone" title="Salida / zona" style="cursor:pointer;display:inline-flex;${nativeMode || upnpMode ? 'color:var(--accent)' : ''}">${ic('zone', 18)}</span>
        </div>
        ${up.length ? `<div style="width:100%;margin-top:6px"><div style="font-size:12px;color:var(--text-2);margin-bottom:6px">A continuación</div>${up.map((t, i) => `<div data-act="npjump" data-i="${idx + 1 + i}" style="display:flex;gap:10px;padding:7px 8px;border-radius:7px;cursor:pointer;font-size:14px"><span style="color:var(--text-2);width:18px;text-align:right">${idx + 2 + i}</span><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(t.title)}</span><span style="color:var(--text-2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:40%">${esc(t.artist || '')}</span></div>`).join('')}</div>` : ''}
      </div>`;
  }
  function ensureBar() { if (bar) return; bar = document.createElement('div'); bar.id = 'nowbar'; bar.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--surface);border-top:1px solid var(--border);padding:8px 16px;display:none;align-items:center;gap:14px'); document.body.appendChild(bar); }
  const ic = (n, s) => window.icon ? window.icon(n, s || 18) : '';           // icono de línea monocromo
  const volIcon = () => vol === 0 ? 'volume-mute' : vol < 0.5 ? 'volume-low' : 'volume-high';
  function render() {
    ensureBar();
    if (irStation) return renderRadioBar();
    const c = cur();
    if (!c) { bar.style.display = 'none'; emit(); return; }
    const len = lenMs(), p = posMs(), noAudio = c.playable === false;
    bar.style.display = 'flex';
    bar.innerHTML =
      `<a href="album.html?id=${c.albumId}" style="flex:none">${cover(c.albumId, 46)}</a>
       <div data-act="npopen" title="Ahora suena" style="min-width:110px;cursor:pointer"><div style="font-size:14px;font-weight:600">${esc(c.title)}</div><div style="font-size:12px;color:var(--text-2)">${esc(c.artist)}${noAudio ? ' · sin audio local' : ''}</div></div>
       <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
         <div style="display:flex;align-items:center;gap:18px;color:var(--text)">
           <span data-act="prev" style="cursor:pointer;display:inline-flex;color:var(--text-2)" title="Anterior">${ic('prev', 20)}</span>
           <span data-act="toggle" style="cursor:pointer;display:inline-flex" title="Play/Pausa">${ic(playing ? 'pause' : 'play', 26)}</span>
           <span data-act="next" style="cursor:pointer;display:inline-flex;color:var(--text-2)" title="Siguiente">${ic('next', 20)}</span>
         </div>
         <div style="display:flex;align-items:center;gap:8px;width:100%;max-width:420px">
           <span id="npel" style="font-size:11px;color:var(--muted);width:34px;text-align:right">${mmss(p)}</span>
           ${(() => { const frac = len ? Math.min(100, p / len * 100) : 0; const wf = curPeaks && curPeaksTrack === c.trackId;
             return wf
               ? `<div data-act="seek" title="Buscar" style="position:relative;flex:1;height:26px;cursor:${noAudio ? 'default' : 'pointer'}"><div style="position:absolute;inset:0;fill:var(--surface-2)">${wfSvg(curPeaks)}</div><div id="npwf" style="position:absolute;inset:0;fill:var(--accent);clip-path:inset(0 ${100 - frac}% 0 0)">${wfSvg(curPeaks)}</div></div>`
               : `<div data-act="seek" title="Buscar" style="flex:1;height:8px;display:flex;align-items:center;cursor:${noAudio ? 'default' : 'pointer'}"><div style="width:100%;height:4px;background:var(--surface-2);border-radius:999px;overflow:hidden"><div id="npprog" style="width:${frac}%;height:100%;background:var(--accent)"></div></div></div>`; })()}
           <span style="font-size:11px;color:var(--muted);width:34px">${mmss(len)}</span>
         </div>
       </div>
       <span data-act="mute" style="cursor:pointer;display:inline-flex;color:var(--text-2)" title="Silenciar">${ic(volIcon(), 17)}</span>
       <input data-act="vol" type="range" min="0" max="1" step="0.01" value="${vol}" title="Volumen" style="width:72px;accent-color:var(--accent)">
       <span data-act="lyrics" title="Letra" style="cursor:pointer;display:inline-flex;color:var(--text-2)">${ic('lyrics', 17)}</span>
       <span data-act="eq" title="Ecualizador y crossfade" style="cursor:pointer;display:inline-flex;color:${eqOn || xfade > 0 ? 'var(--accent)' : 'var(--text-2)'}">${ic('eq', 17)}</span>
       <span data-act="zone" title="Salida / zona" style="cursor:pointer;font-size:12px;color:${nativeMode || upnpMode ? 'var(--accent)' : 'var(--text-2)'};display:inline-flex;align-items:center;gap:5px;max-width:160px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${ic('zone', 16)}<span style="overflow:hidden;text-overflow:ellipsis">${zoneLabel()}</span></span>
       <a href="queue.html" title="Cola" style="color:var(--text-2);text-decoration:none;display:inline-flex;align-items:center;gap:5px;font-size:13px">${ic('queue', 16)}${idx + 1}/${q.length}</a>`;
    if (npfs && npfs.style.display === 'flex') renderNpFs();
    emit();
  }
  function progress() { const c = cur(); if (!c) return; const len = lenMs(), p = posMs(); const frac = len ? Math.min(100, p / len * 100) : 0; const pr = document.getElementById('npprog'), wf = document.getElementById('npwf'), el = document.getElementById('npel'); if (pr && len) pr.style.width = frac + '%'; if (wf && len) wf.style.clipPath = 'inset(0 ' + (100 - frac) + '% 0 0)'; if (el) el.textContent = mmss(p);
    const pr2 = document.getElementById('npfsprog'), wf2 = document.getElementById('npfswf'), el2 = document.getElementById('npfsel'); if (pr2 && len) pr2.style.width = frac + '%'; if (wf2 && len) wf2.style.clipPath = 'inset(0 ' + (100 - frac) + '% 0 0)'; if (el2) el2.textContent = mmss(p);
    maybeScrobble(); maybeRadio(); syncLy(); }
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
    cur0 = 1 - cur0; idx = ni; save(); loggedIdx = -1; trackStarted();  // la entrante pasa a ser la actual (su 'play' registrará la escucha)
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
    nativeBusy = true; playing = true; loggedIdx = idx; nativeMiss = 0; nativeStartedIdx = idx; trackStarted(); render();
    const body = { track_id: c.trackId, deviceId: nativeDeviceId || null, exclusive: !!nativeExclusive, gainDb: nativeGainDb(c), zone: zone.name, eq: { on: eqOn, gains: eqGains }, peq: { on: peqOn, bands: peqBands }, conv: { on: convOn, file: convFile } };
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
  // EQ del motor nativo (en vivo): envía las bandas al servidor
  function nativeEqApply() { clearTimeout(nativeEqTimer); nativeEqTimer = setTimeout(() => { njson('eq', { on: eqOn, gains: eqGains }).catch(() => {}); }, 200); }
  let nativeDspTimer = null;
  function nativeDspApply() { clearTimeout(nativeDspTimer); nativeDspTimer = setTimeout(() => { njson('peq', { on: peqOn, bands: peqBands }).catch(() => {}); njson('conv', { on: convOn, file: convFile }).catch(() => {}); }, 200); }
  function setNativeMode(on) {
    on = !!on; if (on === nativeMode) return;
    const wasPlaying = playing, posSec = posMs() / 1000;
    if (upnpMode) { upnpStop(); upnpMode = false; zone.upnp = false; }   // zonas mutuamente excluyentes
    if (nativeMode) nativeStop(); else { cancelFade(); decks.forEach(d => d.el.pause()); }
    nativeMode = on; zone.native = on; persistZone(); updateZoneBtn();
    if (cur() && wasPlaying) { if (on) nativePlay(idx, { seekSec: posSec }); else start(idx, posSec); }
    else render();
    if (zpanel && zpanel.style.display === 'block') renderZPanel();
  }
  function setNativeDevice(id) { nativeDeviceId = id || ''; zone.nativeDeviceId = nativeDeviceId; persistZone(); if (nativeMode && playing) nativePlay(idx, { seekSec: nativePos }); renderZPanel(); }
  function setNativeExclusive(on) { nativeExclusive = !!on; zone.nativeExclusive = nativeExclusive; persistZone(); if (nativeMode && playing) nativePlay(idx, { seekSec: nativePos }); renderZPanel(); }

  // ── transporte por la salida de RED (UPnP/DLNA): el servidor manda al renderer (Eversolo…) ──
  function ujson(path, body) { return fetch('/api/upnp/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(r => r.json()); }
  function startUpnpPoll() { stopUpnpPoll(); upnpPollTimer = setInterval(pollUpnp, 900); }
  function stopUpnpPoll() { if (upnpPollTimer) { clearInterval(upnpPollTimer); upnpPollTimer = null; } }
  function primeUpnpNext() { const nx = q[idx + 1]; ujson('setnext', { track_id: (nx && nx.playable !== false) ? nx.trackId : null }).catch(() => {}); }
  function pollUpnp() {
    ujson('state').then(j => {
      if (!j || !j.ok || !j.state) return;
      const s = j.state;
      if (s.advanced && idx < q.length - 1) {          // el aparato saltó solo a la pista cebada (gapless)
        idx++; save(); loggedIdx = -1; scrobbledIdx = -1; upnpStartedIdx = idx; upnpPos = 0; trackStarted(); render();
        primeUpnpNext();                                // ceba la siguiente-siguiente
      }
      upnpPos = s.positionSec || 0;
      if (s.playing) { upnpMiss = 0; if (!playing) { playing = true; render(); } }
      else if (s.paused) { upnpMiss = 0; if (playing) { playing = false; render(); } }
      else if (playing && !upnpBusy && (s.state === 'STOPPED' || s.state === '' || s.state == null) && ++upnpMiss >= 2) { upnpMiss = 0; onUpnpEnded(); return; }
      progress();
    }).catch(() => {});
  }
  function onUpnpEnded() { if (idx < q.length - 1) upnpPlay(idx + 1); else if (radioOn) maybeRadio(); else { playing = false; stopUpnpPoll(); render(); } }
  function upnpPlay(i, opts) {
    idx = i; save(); const c = cur(); if (!c) return;
    if (c.playable === false) { playing = false; upnpStartedIdx = -1; render(); return; }
    upnpBusy = true; playing = true; loggedIdx = idx; upnpMiss = 0; upnpStartedIdx = idx; upnpPos = (opts && opts.seekSec) || 0; trackStarted(); render();
    const body = { track_id: c.trackId, deviceId: upnpDeviceId || null, zone: upnpDevName || zone.name };
    const nx = q[i + 1]; if (nx && nx.playable !== false) body.next_track_id = nx.trackId;   // ceba la siguiente → gapless
    if (opts && opts.seekSec) body.seekSec = opts.seekSec;
    ujson('play', body).then(j => {
      upnpBusy = false;
      if (!j || !j.ok) { playing = false; upnpStartedIdx = -1; render(); if (j && j.error) console.warn('[upnp]', j.error); return; }
      startUpnpPoll();
    }).catch(() => { upnpBusy = false; playing = false; render(); });
  }
  function upnpToggle() {
    const c = cur(); if (!c || c.playable === false) return;
    if (playing) { upnpBusy = true; playing = false; render(); ujson('pause', {}).then(() => { upnpBusy = false; stopUpnpPoll(); }); }
    else if (upnpStartedIdx === idx) { upnpBusy = true; playing = true; render(); ujson('resume', {}).then(() => { upnpBusy = false; startUpnpPoll(); }); }
    else upnpPlay(idx);
  }
  function upnpSeek(f) { const c = cur(); if (!c) return; const lenS = (c.length_ms || 0) / 1000; if (!lenS) return; const sec = Math.max(0, Math.min(1, f)) * lenS; upnpPos = sec; upnpBusy = true; ujson('seek', { sec }).then(() => upnpBusy = false); }
  function upnpStop() { playing = false; upnpStartedIdx = -1; stopUpnpPoll(); ujson('stop', {}).catch(() => {}); }
  function upnpVolumeApply() { clearTimeout(upnpVolTimer); upnpVolTimer = setTimeout(() => { ujson('volume', { v: vol }).catch(() => {}); }, 300); }
  function setUpnpMode(on, deviceId, name) {
    on = !!on;
    if (deviceId !== undefined) { upnpDeviceId = deviceId || ''; zone.upnpDeviceId = upnpDeviceId; }
    if (name) { upnpDevName = name; zone.upnpName = name; }
    const deviceChange = on && upnpMode && deviceId !== undefined;
    if (on === upnpMode && !deviceChange) return;
    const wasNative = nativeMode, wasUpnp = upnpMode, wasPlaying = playing, posSec = posMs() / 1000;
    if (wasNative) { nativeStop(); nativeMode = false; zone.native = false; }
    if (wasUpnp) upnpStop();
    if (!wasNative && !wasUpnp && on) { cancelFade(); decks.forEach(d => d.el.pause()); }   // venía del navegador
    upnpMode = on; zone.upnp = on; persistZone(); updateZoneBtn();
    if (cur() && wasPlaying) { if (on) upnpPlay(idx, { seekSec: posSec }); else start(idx, posSec); }
    else render();
    if (zpanel && zpanel.style.display === 'block') renderZPanel();
  }

  function start(i, atSec) {
    if (irStation) stopRadio(true);   // reproducir una pista para la radio
    if (nativeMode) return nativePlay(i);
    if (upnpMode) return upnpPlay(i, atSec ? { seekSec: atSec } : undefined);
    cancelFade();
    idx = i; save(); const c = cur(); if (!c) return;
    const d = active();
    if (c.playable === false) { playing = false; d.trackIdx = -1; d.el.removeAttribute('src'); render(); return; }
    ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume();
    d.trackIdx = idx; loggedIdx = -1;
    setDeckGain(d, c);                           // ReplayGain de esta pista en la ganancia del deck
    const o = other(); if (o.gain) { try { o.gain.gain.cancelScheduledValues(ctx.currentTime); } catch (e) {} o.gain.gain.value = 0.0001; } o.el.pause();
    d.el.src = '/api/stream?track=' + c.trackId;
    if (atSec > 0) { const onMeta = () => { try { d.el.currentTime = atSec; } catch (e) {} d.el.removeEventListener('loadedmetadata', onMeta); }; d.el.addEventListener('loadedmetadata', onMeta); }   // reanudar en la posición
    applyVol();
    d.el.play().catch(() => {});
    trackStarted();
    render();
  }
  function onEnded() { if (fading) return; next(); }
  function next() { if (nativeMode) { if (idx < q.length - 1) nativePlay(idx + 1); else if (radioOn) maybeRadio(); else { playing = false; stopNativePoll(); render(); } return; } if (upnpMode) { if (idx < q.length - 1) upnpPlay(idx + 1); else if (radioOn) maybeRadio(); else { playing = false; stopUpnpPoll(); render(); } return; } if (idx < q.length - 1) start(idx + 1); else if (radioOn) maybeRadio(); else { playing = false; active().el.pause(); render(); } }
  function prev() { if (nativeMode) { if (nativePos > 3 || idx <= 0) nativePlay(idx, { seekSec: 0 }); else nativePlay(idx - 1); return; } if (upnpMode) { if (upnpPos > 3 || idx <= 0) upnpPlay(idx, { seekSec: 0 }); else upnpPlay(idx - 1); return; } const d = active(); if (d.trackIdx === idx && d.el.currentTime > 3) { d.el.currentTime = 0; } else if (idx > 0) start(idx - 1); else d.el.currentTime = 0; }
  function toggle() { if (irStation) return toggleRadio(); if (nativeMode) return nativeToggle(); if (upnpMode) return upnpToggle(); const c = cur(); if (!c || c.playable === false) return; const d = active(); if (d.trackIdx !== idx) return start(idx); if (d.el.paused) { ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume(); d.el.play().catch(() => {}); } else d.el.pause(); }
  function seekFrac(f) { if (irStation) return; if (nativeMode) return nativeSeek(f); if (upnpMode) return upnpSeek(f); const len = lenMs(); if (loadedCur() && len) active().el.currentTime = Math.max(0, Math.min(1, f)) * len / 1000; }
  function setVol(v) { vol = Math.max(0, Math.min(1, v)); applyVol(); if (irEl) irEl.volume = vol; if (nativeMode) nativeVolumeApply(); else if (upnpMode) upnpVolumeApply(); render(); }

  function playTracks(tracks, i) { if (!tracks || !tracks.length) return; q = tracks; start(i || 0); }
  function playAlbum(id, i) { fetch('/api/album?id=' + id).then(r => r.json()).then(a => { const tr = (a.tracks || []).map(t => ({ trackId: t.trackId, recording_id: t.recording_id, title: t.title, artist: a.artist, albumId: a.id, length_ms: t.length_ms, playable: t.playable !== 0, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs, album_gain_db: t.album_gain_db, album_peak_dbfs: t.album_peak_dbfs })); if (!tr.length) { alert('Este álbum aún no tiene pistas en tu biblioteca.'); return; } playTracks(tr, i || 0); }); }

  // ── RADIO POR INTERNET: stream en vivo (sin cola/seek/duración), título "ahora suena" por ICY ──
  function persistRadio() { try { if (irStation) localStorage.setItem(IRKEY, JSON.stringify({ id: irStation.id, name: irStation.name })); else localStorage.removeItem(IRKEY); } catch (e) {} }
  function ensureIrEl() { if (!irEl) { irEl = new Audio(); irEl.preload = 'none'; irEl.onplaying = () => { irPlaying = true; renderRadioBar(); }; irEl.onpause = () => { irPlaying = false; renderRadioBar(); }; irEl.onerror = () => { irPlaying = false; renderRadioBar(); }; } return irEl; }
  function playRadio(st) {
    if (!st || !st.id) return;
    try { decks.forEach(d => d.el.pause()); } catch (e) {} playing = false; cancelFade();   // para la cola/decks
    if (nativeMode) nativeStop(); else if (upnpMode) { try { upnpStop(); } catch (e) {} }
    const el = ensureIrEl();
    irStation = { id: st.id, name: st.name, homepage: st.homepage }; irTitle = ''; persistRadio();
    try { if (el.setSinkId) el.setSinkId(zone.deviceId || '').catch(() => {}); } catch (e) {}
    el.volume = vol;
    el.src = '/api/radio/stream?id=' + st.id + '&t=' + Date.now();
    el.play().then(() => { irPlaying = true; renderRadioBar(); }).catch(() => { irPlaying = false; renderRadioBar(); });
    fetchRadioNow(); if (irPollT) clearInterval(irPollT); irPollT = setInterval(fetchRadioNow, 10000);
    render();
  }
  function toggleRadio() { if (!irStation) return; const el = ensureIrEl(); if (!el.src || el.src.indexOf('/api/radio/stream') < 0) return playRadio(irStation); if (el.paused) { el.play().catch(() => {}); } else el.pause(); }
  function stopRadio(silent) { if (irPollT) { clearInterval(irPollT); irPollT = null; } if (irEl) { try { irEl.pause(); irEl.removeAttribute('src'); irEl.load(); } catch (e) {} } const was = !!irStation; irStation = null; irTitle = ''; irPlaying = false; persistRadio(); if (was && !silent) render(); }
  function fetchRadioNow() { if (!irStation) return; fetch('/api/radio/nowplaying?id=' + irStation.id).then(r => r.json()).then(j => { if (j && j.ok && irStation) { if ((j.title || '') !== irTitle) { irTitle = j.title || ''; renderRadioBar(); } } }).catch(() => {}); }
  function renderRadioBar() {
    if (!irStation) return; ensureBar(); bar.style.display = 'flex';
    bar.innerHTML =
      `<span style="flex:none;width:46px;height:46px;border-radius:8px;background:var(--surface-2);display:inline-flex;align-items:center;justify-content:center;color:var(--text-2)">${ic('radio', 24)}</span>
       <div style="min-width:120px;max-width:300px"><div style="font-size:14px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(irTitle || 'En directo')}</div>
         <div style="font-size:12px;color:var(--text-2);display:flex;align-items:center;gap:7px"><span style="display:inline-flex;align-items:center;gap:4px;color:var(--accent);font-weight:700;font-size:10px;letter-spacing:.06em"><span style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block"></span>EN VIVO</span><span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(irStation.name)}</span></div></div>
       <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:20px;color:var(--text)">
         <span data-act="radiotoggle" style="cursor:pointer;display:inline-flex" title="Play/Pausa">${ic(irPlaying ? 'pause' : 'play', 26)}</span>
         <span data-act="radiostop" style="cursor:pointer;display:inline-flex;color:var(--text-2)" title="Parar la radio">${ic('close', 20)}</span>
       </div>
       <span data-act="mute" style="cursor:pointer;display:inline-flex;color:var(--text-2)" title="Silenciar">${ic(volIcon(), 17)}</span>
       <input data-act="vol" type="range" min="0" max="1" step="0.01" value="${vol}" title="Volumen" style="width:72px;accent-color:var(--accent)">
       <span data-act="zone" title="Salida / zona" style="cursor:pointer;font-size:12px;color:${nativeMode || upnpMode ? 'var(--accent)' : 'var(--text-2)'};display:inline-flex;align-items:center;gap:5px;max-width:160px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${ic('zone', 16)}<span style="overflow:hidden;text-overflow:ellipsis">${zoneLabel()}</span></span>
       <a href="radio.html" title="Radio" style="color:var(--text-2);text-decoration:none;display:inline-flex;align-items:center">${ic('radio', 16)}</a>`;
    emit();
  }
  const getRadio = () => ({ station: irStation, title: irTitle, playing: irPlaying });
  // cambia el modo de normalización y lo re-aplica en caliente (navegador o nativo)
  function applyRgMode() { if (nativeMode) { if (playing) nativeVolumeApply(); } else { const d = active(); if (d && d.gain && loadedCur()) setDeckGain(d, cur()); applyVol(); } }
  function setRgMode(m) { if (m !== 'track' && m !== 'album' && m !== 'off') return; if (m !== rgMode) { rgMode = m; persistRg(); applyRgMode(); } renderEqPanel(); }
  function jumpTo(i) { if (i >= 0 && i < q.length) start(i); }
  function removeAt(i) { snapshot(); const wasCur = i === idx; q.splice(i, 1); if (i < idx) idx--; if (idx >= q.length) idx = q.length - 1; save(); if (wasCur) { if (q.length) start(idx); else { idx = -1; cancelFade(); active().el.pause(); active().el.removeAttribute('src'); active().trackIdx = -1; render(); } } else render(); }
  function clearUpcoming() { snapshot(); q = q.slice(0, idx + 1); save(); render(); }
  const getState = () => ({ q: q.slice(), idx, playing, radioOn, canUndo: undoStack.length > 0 });

  // eventos de audio -> estado real (ambos decks; sólo cuenta el activo)
  decks.forEach(d => {
    // en modo nativo los decks están en silencio: sus eventos no deben tocar el estado de la UI
    d.el.addEventListener('play', () => { if (nativeMode || upnpMode || active() !== d) return; playing = true; logPlay(); render(); });
    d.el.addEventListener('pause', () => { if (nativeMode || upnpMode || active() !== d) return; playing = false; render(); });
    d.el.addEventListener('ended', () => { if (nativeMode || upnpMode || active() !== d) return; onEnded(); });
    d.el.addEventListener('timeupdate', () => { if (nativeMode || upnpMode || active() !== d) return; progress(); maybeCrossfade(); });
    d.el.addEventListener('durationchange', () => { if (nativeMode || upnpMode || active() !== d) return; render(); });
    d.el.addEventListener('error', () => { if (nativeMode || upnpMode || active() !== d) return; playing = false; render(); });
  });

  // ── selector de salida / zona (popover anclado a la barra) ──
  let zpanel = null;
  const zoneLabel = () => nativeMode ? esc(zone.name || 'Este equipo') + ' · nativo' : upnpMode ? esc(upnpDevName || 'Red') : esc(zone.name || 'Este equipo');
  function updateZoneBtn() { const b = document.querySelector('#nowbar [data-act="zone"]'); if (b) b.innerHTML = ic('zone', 16) + '<span style="overflow:hidden;text-overflow:ellipsis">' + zoneLabel() + '</span>'; }
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
        h += rows.map(r => { const on = (nativeDeviceId || '') === (r.id || ''); return `<div class="ndev" data-id="${esc(r.id)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;${on ? 'background:var(--accent-bg);color:var(--accent)' : ''}"><span style="width:16px;display:inline-flex;justify-content:center">${on ? ic('check', 15) : ''}</span><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(r.name)}</span></div>`; }).join('');
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
        return `<div class="zdev" data-id="${esc(r.deviceId)}" data-label="${esc(r.label)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;${on ? 'background:var(--accent-bg);color:var(--accent)' : ''}"><span style="width:16px;display:inline-flex;justify-content:center">${on ? ic('check', 15) : ''}</span><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(r.label)}</span></div>`;
      }).join('');
      if (!labeled && list.length) h += '<div data-act="unlock" style="margin-top:6px;color:var(--accent);cursor:pointer">Mostrar nombres de los dispositivos…</div>';
      if (!list.length) h += '<div style="color:var(--text-2)">No se detectaron dispositivos de salida.</div>';
    }
    // ── salida de RED (UPnP/DLNA): renderers de la LAN (Eversolo, etc.) — se rellena async ──
    h += '<div style="border-top:1px solid var(--border);margin:10px -14px 0;padding:10px 14px 0">';
    h += '<div style="font-weight:600;margin-bottom:6px">Salida de red</div>';
    h += '<div id="upnplist" style="color:var(--text-2);font-size:12px">Buscando dispositivos de red…</div>';
    if (upnpMode) h += '<div data-act="uoff" style="margin-top:7px;color:var(--accent);cursor:pointer;font-size:12px;display:inline-flex;align-items:center;gap:5px">' + ic('arrow-left', 13) + 'Volver a este equipo</div>';
    h += '<div style="font-size:11px;color:var(--text-2);margin-top:6px">El dispositivo descarga la música; el volumen va al aparato. ReplayGain y EQ no se aplican en red.</div></div>';
    zpanel.innerHTML = h;
    fillUpnpList();
  }
  async function fillUpnpList() {
    const box = document.getElementById('upnplist'); if (!box) return;
    let ur = null; try { ur = await ujson('devices'); } catch (e) {}
    if (!document.getElementById('upnplist')) return;                 // el panel se cerró mientras buscaba
    const urs = (ur && ur.ok && ur.items) ? ur.items : [];
    if (!urs.length) { box.textContent = 'No se encontraron dispositivos de red (UPnP/DLNA).'; return; }
    box.style.color = 'var(--text)';
    box.innerHTML = urs.map(d => { const on = upnpMode && (upnpDeviceId === d.id); return `<div class="udev" data-id="${esc(d.id)}" data-name="${esc(d.name)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;${on ? 'background:var(--accent-bg);color:var(--accent)' : ''}"><span style="width:16px;display:inline-flex;justify-content:center">${on ? ic('check', 15) : ''}</span><span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(d.name)}${d.model ? ' · ' + esc(d.model) : ''}</span></div>`; }).join('');
  }

  // ── letra de la pista (LRCLIB, con resaltado sincronizado tipo karaoke) ──
  let lypanel = null, lyIdx = -1, lyData = null, lyActive = -1, lyCache = {};
  function parseLRC(s) {
    const out = [];
    for (const line of String(s || '').split('\n')) {
      const times = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
      if (!times.length) continue;
      const text = line.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of times) out.push({ t: (+m[1]) * 60000 + (+m[2]) * 1000 + (m[3] ? +((m[3] + '000').slice(0, 3)) : 0), text });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function ensureLyPanel() {
    if (lypanel) return;
    lypanel = document.createElement('div'); lypanel.id = 'lyricspanel';
    lypanel.setAttribute('style', 'position:fixed;right:16px;bottom:62px;z-index:60;width:340px;max-width:calc(100vw - 32px);max-height:60vh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:14px 16px;display:none;font-size:14px;line-height:1.5');
    document.body.appendChild(lypanel);
    document.addEventListener('click', e => { if (lypanel.style.display === 'block' && !e.target.closest('#lyricspanel') && !e.target.closest('[data-act="lyrics"]')) lypanel.style.display = 'none'; });
  }
  function toggleLyPanel() { ensureLyPanel(); if (lypanel.style.display === 'block') { lypanel.style.display = 'none'; return; } if (eqpanel) eqpanel.style.display = 'none'; if (zpanel) zpanel.style.display = 'none'; lypanel.style.display = 'block'; loadLyrics(); }
  function loadLyrics() {
    const c = cur(); ensureLyPanel();
    if (!c || !c.trackId) { lypanel.innerHTML = '<div style="color:var(--text-2)">No hay nada sonando.</div>'; return; }
    lyIdx = idx; lyActive = -1;
    if (lyCache[c.trackId]) { lyData = lyCache[c.trackId]; renderLy(); return; }
    lyData = null; lypanel.innerHTML = '<div style="color:var(--text-2)">Buscando letra…</div>';
    fetch('/api/lyrics?track=' + c.trackId).then(r => r.json()).then(j => {
      j.syncedArr = j.synced ? parseLRC(j.synced) : null;
      lyCache[c.trackId] = j; if (idx === lyIdx) { lyData = j; renderLy(); }
    }).catch(() => { lypanel.innerHTML = '<div style="color:var(--text-2)">No se pudo cargar la letra.</div>'; });
  }
  function renderLy() {
    ensureLyPanel(); const c = cur();
    let h = `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px"><span style="font-weight:600">${esc(c ? c.title : '')}</span><span style="font-size:11px;color:var(--text-2)">${lyData && lyData.found ? 'LRCLIB' : ''}</span></div>`;
    if (!lyData || !lyData.found) h += '<div style="color:var(--text-2)">' + (lyData && lyData.instrumental ? 'Instrumental.' : 'Sin letra para esta pista.') + '</div>';
    else if (lyData.syncedArr && lyData.syncedArr.length) h += '<div id="lylines">' + lyData.syncedArr.map((l, i) => `<div class="lyline" data-i="${i}" style="padding:2px 0;color:var(--text-2);transition:color .1s">${esc(l.text) || '♪'}</div>`).join('') + '</div>';
    else if (lyData.plain) h += '<div style="white-space:pre-wrap">' + esc(lyData.plain) + '</div>';
    else h += '<div style="color:var(--text-2)">Sin letra para esta pista.</div>';
    lypanel.innerHTML = h;
    if (lyData && lyData.syncedArr) { lyActive = -1; syncLy(); }
  }
  // resalta la línea en curso según la posición de reproducción y la centra
  function syncLy() {
    if (!lypanel || lypanel.style.display !== 'block' || !lyData || !lyData.syncedArr || idx !== lyIdx) return;
    const p = posMs(); const arr = lyData.syncedArr;
    let a = -1; for (let i = 0; i < arr.length; i++) { if (arr[i].t <= p) a = i; else break; }
    if (a === lyActive) return;
    lyActive = a;
    const lines = lypanel.querySelectorAll('.lyline');
    lines.forEach((el, i) => { const on = i === a; el.style.color = on ? 'var(--accent)' : 'var(--text-2)'; el.style.fontWeight = on ? '600' : '400'; });
    if (a >= 0 && lines[a]) lines[a].scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  function setEqEnabled(on) { eqOn = on; applyEq(); persistEq(); renderEqPanel(); const b = document.querySelector('#nowbar [data-act="eq"]'); if (b) b.style.color = (eqOn || xfade > 0) ? 'var(--accent)' : 'var(--text-2)'; if (nativeMode) nativeEqApply(); }
  function setEqBand(i, v) { eqGains[i] = v; if (ctx && eqOn && eqBands[i]) eqBands[i].gain.value = v; persistEq(); const lab = document.getElementById('eqval' + i); if (lab) lab.textContent = (v > 0 ? '+' : '') + v + ' dB'; if (nativeMode) nativeEqApply(); }
  function setPreset(name) { const p = EQPRE[name]; if (!p) return; eqGains = p.slice(); if (!eqOn) eqOn = true; applyEq(); persistEq(); renderEqPanel(); const b = document.querySelector('#nowbar [data-act="eq"]'); if (b) b.style.color = 'var(--accent)'; if (nativeMode) nativeEqApply(); }
  function setXfade(v) { xfade = Math.max(0, Math.min(12, v)); persistX(); const lab = document.getElementById('xfadeval'); if (lab) lab.textContent = xfade === 0 ? 'desactivado' : xfade.toFixed(1).replace('.0', '') + ' s'; const b = document.querySelector('#nowbar [data-act="eq"]'); if (b) b.style.color = (eqOn || xfade > 0) ? 'var(--accent)' : 'var(--text-2)'; }
  const RGLAB = [['track', 'Pista'], ['album', 'Álbum'], ['off', 'No']];
  function renderEqPanel() {
    ensureEqPanel();
    // normalización ReplayGain (pista / álbum / off)
    let h = `<div style="margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:10px"><div style="font-weight:600;margin-bottom:6px">Normalización (ReplayGain)</div><div style="display:flex;gap:6px">` +
      RGLAB.map(([k, lab]) => `<span data-rg="${k}" style="cursor:pointer;font-size:12px;padding:4px 12px;border-radius:999px;background:${rgMode === k ? 'var(--accent)' : 'var(--surface-2)'};color:${rgMode === k ? '#fff' : 'var(--text-2)'}">${lab}</span>`).join('') +
      `</div><div style="font-size:11px;color:var(--text-2);margin-top:5px">Álbum conserva la dinámica entre pistas del disco; pista iguala cada tema.</div></div>`;
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><span style="font-weight:600">Ecualizador</span><span data-act="eqtoggle" style="cursor:pointer;font-size:12px;padding:2px 10px;border-radius:999px;background:${eqOn ? 'var(--accent)' : 'var(--surface-2)'};color:${eqOn ? '#fff' : 'var(--text-2)'}">${eqOn ? 'Activado' : 'Desactivado'}</span></div>`;
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' + Object.keys(EQPRE).map(k => `<span data-pre="${k}" style="cursor:pointer;font-size:12px;padding:3px 9px;border-radius:999px;background:var(--surface-2);text-transform:capitalize">${k}</span>`).join('') + '</div>';
    h += EQF.map((f, i) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;opacity:${eqOn ? 1 : .5}"><span style="width:38px;font-size:11px;color:var(--text-2);text-align:right">${EQLAB[i]}</span><input class="eqband" data-i="${i}" type="range" min="-12" max="12" step="1" value="${eqGains[i]}" style="flex:1;accent-color:var(--accent)"><span id="eqval${i}" style="width:48px;font-size:11px;text-align:right">${(eqGains[i] > 0 ? '+' : '') + eqGains[i]} dB</span></div>`).join('');
    h += `<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px"><span style="font-weight:600">Crossfade</span><span id="xfadeval" style="font-size:12px;color:var(--text-2)">${xfade === 0 ? 'desactivado' : xfade.toFixed(1).replace('.0', '') + ' s'}</span></div><input data-act="xfade" type="range" min="0" max="12" step="0.5" value="${xfade}" style="width:100%;accent-color:var(--accent)"><div style="font-size:11px;color:var(--text-2);margin-top:3px">Fundido entre pistas al cambiar automáticamente.</div></div>`;
    h += `<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px"><span data-act="dspopen" style="cursor:pointer;color:var(--accent);font-size:12.5px;display:inline-flex;align-items:center;gap:5px">${ic('eq', 14)}EQ paramétrico y convolución${(peqOn || convOn) ? ' · activo' : ''}</span></div>`;
    eqpanel.innerHTML = h;
  }

  // ── DSP avanzado: EQ paramétrico (bandas configurables) + convolución (impulso WAV) + presets ──
  let dsppanel = null, dspImpulses = [], dspPresets = [];
  function ensureDspPanel() {
    if (dsppanel) return;
    dsppanel = document.createElement('div'); dsppanel.id = 'dsppanel';
    dsppanel.setAttribute('style', 'position:fixed;right:16px;bottom:62px;z-index:61;width:364px;max-width:calc(100vw - 32px);max-height:72vh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px 14px;display:none;font-size:13px');
    document.body.appendChild(dsppanel);
    document.addEventListener('click', e => { if (dsppanel.style.display === 'block' && !e.target.closest('#dsppanel') && !e.target.closest('[data-act="dspopen"]')) dsppanel.style.display = 'none'; });
  }
  function toggleDspPanel() { ensureDspPanel(); if (dsppanel.style.display === 'block') { dsppanel.style.display = 'none'; return; } if (eqpanel) eqpanel.style.display = 'none'; if (zpanel) zpanel.style.display = 'none'; dsppanel.style.display = 'block'; renderDspPanel(); loadDspLists().then(() => { if (dsppanel.style.display === 'block') renderDspPanel(); }); }
  async function loadDspLists() { try { const [im, pr] = await Promise.all([fetch('/api/dsp/impulses').then(x => x.json()), fetch('/api/dsp/presets').then(x => x.json())]); dspImpulses = (im && im.impulses) || []; dspPresets = (pr && pr.presets) || []; } catch (e) {} }
  function markEqBtn() { const on = eqOn || xfade > 0 || peqOn || convOn; document.querySelectorAll('#nowbar [data-act="eq"], #npfs [data-act="eq"]').forEach(b => { b.style.color = on ? 'var(--accent)' : 'var(--text-2)'; }); }
  function dspChanged() { persistPeq(); rebuildDsp(); markEqBtn(); if (nativeMode) nativeDspApply(); }
  function setPeqEnabled(on) { peqOn = on; dspChanged(); renderDspPanel(); }
  function addPeqBand() { if (peqBands.length >= 16) return; peqBands.push({ type: 0, freq: 1000, q: 1, gain: 0 }); if (!peqOn) peqOn = true; dspChanged(); renderDspPanel(); }
  function removePeqBand(i) { peqBands.splice(i, 1); dspChanged(); renderDspPanel(); }
  function updatePeqBand(i, k, v) { if (!peqBands[i]) return; if (k === 'type') peqBands[i].type = Math.max(0, PEQTYPES.indexOf(v)); else peqBands[i][k] = +v; persistPeq(); rebuildDsp(); if (nativeMode) nativeDspApply(); }
  function setConvEnabled(on) { convOn = on; persistConv(); if (convOn && convFile && ctx && !convBuffer) loadImpulse(convFile, true); else rebuildDsp(); markEqBtn(); if (nativeMode) nativeDspApply(); renderDspPanel(); }
  function chooseImpulse(file) { ensureGraph(); loadImpulse(file); if (file && !convOn) { convOn = true; persistConv(); } markEqBtn(); if (nativeMode) nativeDspApply(); renderDspPanel(); }
  async function browseImpulse() { try { const r = await fetch('/api/dsp/impulse/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json()); if (r.ok && r.file) { dspImpulses = r.impulses || dspImpulses; chooseImpulse(r.file); } else if (r.ok && r.cancelled) { } else alert((r && r.error) || 'No se pudo abrir el selector.'); } catch (e) { alert('No se pudo abrir el selector de fichero.'); } }
  async function savePreset() { const name = (prompt('Nombre del preset DSP:') || '').trim(); if (!name) return; const state = { peq: { on: peqOn, bands: peqBands }, conv: { on: convOn, file: convFile }, eq: { on: eqOn, gains: eqGains } }; try { const r = await fetch('/api/dsp/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, state }) }).then(x => x.json()); if (r.ok) { dspPresets = r.presets || dspPresets; renderDspPanel(); } } catch (e) {} }
  function loadPreset(name) { const p = dspPresets.find(x => x.name === name); if (!p) return; const s = p.state || {}; if (s.peq) { peqOn = !!s.peq.on; peqBands = (s.peq.bands || []).map(b => ({ type: b.type | 0, freq: +b.freq || 1000, q: +b.q || 1, gain: +b.gain || 0 })); } if (s.eq) { eqOn = !!s.eq.on; if (Array.isArray(s.eq.gains) && s.eq.gains.length === 7) eqGains = s.eq.gains.map(Number); applyEq(); persistEq(); } persistPeq(); if (s.conv) { convOn = !!s.conv.on; ensureGraph(); loadImpulse(s.conv.file || ''); } else rebuildDsp(); markEqBtn(); if (nativeMode) { nativeEqApply(); nativeDspApply(); } renderDspPanel(); }
  async function deletePreset(name) { const p = dspPresets.find(x => x.name === name); if (!p) return; if (!confirm('¿Borrar el preset "' + name + '"?')) return; try { await fetch('/api/dsp/preset/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id }) }); dspPresets = dspPresets.filter(x => x.name !== name); renderDspPanel(); } catch (e) {} }
  function renderDspPanel() {
    ensureDspPanel();
    let h = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><span style="font-weight:600">DSP avanzado</span><span data-act="dspclose" style="cursor:pointer;color:var(--text-2);display:inline-flex">${ic('close', 16)}</span></div>`;
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0"><span style="font-weight:600;font-size:12.5px">EQ paramétrico</span><span data-act="peqtoggle" style="cursor:pointer;font-size:12px;padding:2px 10px;border-radius:999px;background:${peqOn ? 'var(--accent)' : 'var(--surface-2)'};color:${peqOn ? '#fff' : 'var(--text-2)'}">${peqOn ? 'Activado' : 'Desactivado'}</span></div>`;
    h += `<div style="opacity:${peqOn ? 1 : .5}">`;
    if (!peqBands.length) h += `<div style="font-size:11.5px;color:var(--text-2);margin:4px 0">Sin bandas. Añade una para empezar.</div>`;
    peqBands.forEach((b, i) => {
      h += `<div style="display:flex;gap:4px;align-items:center;margin:4px 0;flex-wrap:wrap">
        <select class="pqt" data-i="${i}" style="font-size:11px">${PEQTYPES.map(t => `<option value="${t}" ${PEQTYPES[b.type] === t ? 'selected' : ''}>${PEQLABEL[t]}</option>`).join('')}</select>
        <input class="pqf" data-i="${i}" type="number" min="10" max="24000" step="1" value="${Math.round(b.freq)}" style="width:62px;font-size:11px"><span style="font-size:10px;color:var(--text-2)">Hz</span>
        <input class="pqq" data-i="${i}" type="number" min="0.1" max="18" step="0.1" value="${b.q}" style="width:46px;font-size:11px"><span style="font-size:10px;color:var(--text-2)">Q</span>
        <input class="pqg" data-i="${i}" type="number" min="-24" max="24" step="0.5" value="${b.gain}" style="width:52px;font-size:11px"><span style="font-size:10px;color:var(--text-2)">dB</span>
        <span class="pqrm" data-i="${i}" style="cursor:pointer;color:var(--text-2);display:inline-flex">${ic('trash', 14)}</span></div>`;
    });
    h += `<div data-act="peqadd" style="cursor:pointer;color:var(--accent);font-size:12px;margin-top:4px;display:inline-flex;align-items:center;gap:4px">${ic('plus', 13)}Añadir banda</div></div>`;
    h += `<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="font-weight:600;font-size:12.5px">Convolución</span><span data-act="convtoggle" style="cursor:pointer;font-size:12px;padding:2px 10px;border-radius:999px;background:${convOn ? 'var(--accent)' : 'var(--surface-2)'};color:${convOn ? '#fff' : 'var(--text-2)'}">${convOn ? 'Activada' : 'Desactivada'}</span></div>`;
    h += `<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap"><select id="convsel" style="flex:1;min-width:150px;font-size:11.5px"><option value="">— ningún impulso —</option>${dspImpulses.map(im => `<option value="${esc(im.file)}" ${im.file === convFile ? 'selected' : ''}>${esc(im.file)}</option>`).join('')}</select><span data-act="convbrowse" style="cursor:pointer;color:var(--accent);font-size:12px;padding:3px 9px;border:1px solid var(--border);border-radius:7px">Explorar…</span></div>`;
    h += `<div style="font-size:11px;color:var(--text-2);margin-top:5px">Impulso WAV para corrección de sala / cabezal de altavoz. Convolución por FFT (~85 ms de latencia).</div></div>`;
    h += `<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px"><div style="font-weight:600;font-size:12.5px;margin-bottom:6px">Presets</div><div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap"><select id="dsppre" style="flex:1;min-width:130px;font-size:11.5px"><option value="">— cargar preset —</option>${dspPresets.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}</select><span data-act="dspsave" style="cursor:pointer;color:var(--accent);font-size:12px;padding:3px 9px;border:1px solid var(--border);border-radius:7px">Guardar…</span><span data-act="dspdel" title="Borrar preset seleccionado" style="cursor:pointer;color:var(--text-2);padding:3px 6px;display:inline-flex">${ic('trash', 14)}</span></div></div>`;
    dsppanel.innerHTML = h;
  }

  // interacción de la barra y los popovers (delegada)
  document.addEventListener('click', e => {
    const zd = e.target.closest('#zonepanel .zdev'); if (zd) { setZoneDevice(zd.dataset.id, zd.dataset.label); return; }
    if (e.target.closest('#zonepanel [data-act="unlock"]')) { unlockLabels(); return; }
    if (e.target.closest('#zonepanel [data-act="ntoggle"]')) { setNativeMode(!nativeMode); return; }
    const nd = e.target.closest('#zonepanel .ndev'); if (nd) { setNativeDevice(nd.dataset.id); return; }
    if (e.target.matches('#zonepanel [data-act="nexcl"]')) { setNativeExclusive(e.target.checked); return; }
    const ud = e.target.closest('#zonepanel .udev'); if (ud) { setUpnpMode(true, ud.dataset.id, ud.dataset.name); return; }
    if (e.target.closest('#zonepanel [data-act="uoff"]')) { setUpnpMode(false); return; }
    const rg = e.target.closest('#eqpanel [data-rg]'); if (rg) { setRgMode(rg.dataset.rg); return; }
    const pre = e.target.closest('#eqpanel [data-pre]'); if (pre) { setPreset(pre.dataset.pre); return; }
    if (e.target.closest('#eqpanel [data-act="eqtoggle"]')) { setEqEnabled(!eqOn); return; }
    if (e.target.closest('#eqpanel [data-act="dspopen"]')) { if (eqpanel) eqpanel.style.display = 'none'; toggleDspPanel(); return; }
    const prm = e.target.closest('#dsppanel .pqrm'); if (prm) { removePeqBand(+prm.dataset.i); return; }
    const dp = e.target.closest('#dsppanel [data-act]');
    if (dp) {
      const act = dp.dataset.act;
      if (act === 'dspclose') dsppanel.style.display = 'none';
      else if (act === 'peqtoggle') setPeqEnabled(!peqOn);
      else if (act === 'peqadd') addPeqBand();
      else if (act === 'convtoggle') setConvEnabled(!convOn);
      else if (act === 'convbrowse') browseImpulse();
      else if (act === 'dspsave') savePreset();
      else if (act === 'dspdel') { const sel = document.getElementById('dsppre'); if (sel && sel.value) deletePreset(sel.value); }
      return;
    }
    const a = e.target.closest('#nowbar [data-act], #npfs [data-act]'); if (!a) return;
    const k = a.dataset.act;
    if (k === 'radiotoggle') toggleRadio();
    else if (k === 'radiostop') stopRadio();
    else if (k === 'prev') prev();
    else if (k === 'next') next();
    else if (k === 'toggle') toggle();
    else if (k === 'npopen' || k === 'npclose') toggleNpFs();
    else if (k === 'npjump') jumpTo(+a.dataset.i);
    else if (k === 'eq') toggleEqPanel();
    else if (k === 'lyrics') toggleLyPanel();
    else if (k === 'zone') toggleZPanel();
    else if (k === 'mute') setVol(vol === 0 ? (parseFloat(localStorage.getItem(VKEY + '.last')) || 0.8) : (localStorage.setItem(VKEY + '.last', vol), 0));
    else if (k === 'seek') { const box = a.getBoundingClientRect(); seekFrac((e.clientX - box.left) / box.width); }
  });
  document.addEventListener('input', e => {
    const v = e.target.closest('#nowbar [data-act="vol"], #npfs [data-act="vol"]'); if (v) { setVol(parseFloat(v.value)); return; }
    const zn = e.target.closest('#zonepanel #zname'); if (zn) { zone.name = zn.value; persistZone(); updateZoneBtn(); return; }
    const eb = e.target.closest('#eqpanel .eqband'); if (eb) { setEqBand(+eb.dataset.i, parseInt(eb.value, 10)); return; }
    const xf = e.target.closest('#eqpanel [data-act="xfade"]'); if (xf) { setXfade(parseFloat(xf.value)); }
  });
  // cambios en el panel DSP (selects y campos numéricos: 'change' para no re-render mientras se teclea)
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.closest && t.closest('#dsppanel')) {
      if (t.classList.contains('pqt')) { updatePeqBand(+t.dataset.i, 'type', t.value); return; }
      if (t.classList.contains('pqf')) { updatePeqBand(+t.dataset.i, 'freq', t.value); return; }
      if (t.classList.contains('pqq')) { updatePeqBand(+t.dataset.i, 'q', t.value); return; }
      if (t.classList.contains('pqg')) { updatePeqBand(+t.dataset.i, 'gain', t.value); return; }
      if (t.id === 'convsel') { chooseImpulse(t.value); return; }
      if (t.id === 'dsppre') { if (t.value) loadPreset(t.value); return; }
    }
  });

  // biblioteca en vivo: el servidor avisa por SSE cuando reescanea; las vistas se refrescan
  try { const es = new EventSource('/api/events'); es.onmessage = e => { try { const d = JSON.parse(e.data); if (d.type === 'library') document.dispatchEvent(new CustomEvent('escucharrr:changed')); else if (d.type === 'radio' && irStation) fetchRadioNow(); } catch (x) {} }; } catch (e) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { render(); markEqBtn(); }); else { render(); setTimeout(markEqBtn, 0); }
  const getGain = () => (ctx ? masterGain.gain.value * (active().gain ? active().gain.gain.value : 1) : active().el.volume);  // ganancia efectiva (vol × ReplayGain)
  const getZone = () => ({ name: zone.name, deviceId: zone.deviceId, label: zone.label });
  const getAudio = () => ({ eqOn, eqGains: eqGains.slice(), xfade, rgMode });
  const getNative = () => ({ nativeMode, nativeDeviceId, nativeExclusive, nativePos, playing, startedIdx: nativeStartedIdx });
  // instantánea de ajustes para la página de Configuración (misma fuente que los paneles)
  function getSettings() { return { xfade, rgMode, radio: radioOn, eqOn, eqGains: eqGains.slice(), eqFreqs: EQLAB.slice(), presets: Object.keys(EQPRE), volume: vol, zone: Object.assign({}, zone), nativeMode, upnpMode, upnpName: upnpDevName, peqOn, peqBands: peqBands.slice(), convOn, convFile }; }

  return { playAlbum, playTracks, next, prev, toggle, jumpTo, removeAt, clearUpcoming, getState, setVol, getGain, getZone, getAudio, getNative, setNativeMode, setRadio, undo,
    getSettings, setXfade, setRgMode, setEqEnabled, setEqBand, setPreset, openOutput: toggleZPanel, openEq: toggleEqPanel, openDsp: toggleDspPanel,
    playRadio, stopRadio, getRadio };
})();
