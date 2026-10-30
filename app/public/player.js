// escucharrr — reproductor real: <audio> + grafo Web Audio (ganancia / punto de DSP).
// Hace streaming del fichero local vía /api/stream?track=ID (con Range -> seek real).
// Cola persistente (localStorage) + barra fija de "ahora suena" en todas las páginas.
// Al empezar una pista registra la escucha vía POST /api/play.
window.player = (function () {
  const KEY = 'escucharrr.queue', VKEY = 'escucharrr.volume';
  const PAIRS = [['#0F6E56', '#1D9E75'], ['#534AB7', '#7F77DD'], ['#185FA5', '#378ADD'], ['#854F0B', '#BA7517'], ['#72243E', '#D4537E'], ['#5F5E5A', '#888780'], ['#3B6D11', '#639922'], ['#993C1D', '#D85A30']];
  let q = [], idx = -1, playing = false, loadedIdx = -1, loggedIdx = -1, bar = null;
  let vol = 1; try { const v = parseFloat(localStorage.getItem(VKEY)); if (v >= 0 && v <= 1) vol = v; } catch (e) {}
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) { q = s.q || []; idx = (s.idx == null ? -1 : s.idx); } } catch (e) {}

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
    } catch (e) { ctx = null; }
  }
  function applyVol() { if (gainNode) gainNode.gain.value = vol; else audio.volume = vol; try { localStorage.setItem(VKEY, String(vol)); } catch (e) {} }

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ q, idx })); } catch (e) {} };
  const cur = () => q[idx] || null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const mmss = ms => { ms = ms || 0; if (!isFinite(ms)) ms = 0; return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0'); };
  const lenMs = () => { const c = cur(); const d = audio.duration; return (loadedIdx === idx && isFinite(d) && d > 0) ? d * 1000 : (c && c.length_ms) || 0; };
  const posMs = () => (loadedIdx === idx ? audio.currentTime * 1000 : 0);
  function cover(id, s) { const p = PAIRS[(id || 0) % PAIRS.length]; return `<svg width="${s}" height="${s}" viewBox="0 0 46 46" style="border-radius:7px;display:block"><rect width="46" height="46" fill="${p[0]}"/><rect y="30" width="46" height="16" fill="${p[1]}"/><circle cx="33" cy="16" r="10" fill="#FAC775"/></svg>`; }
  function logPlay() { const c = cur(); if (c && c.trackId && loggedIdx !== idx) { loggedIdx = idx; fetch('/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track_id: c.trackId }) }).catch(() => {}); } }

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
       <a href="queue.html" title="Cola" style="font-size:16px;color:var(--text-2);text-decoration:none">☰ ${idx + 1}/${q.length}</a>`;
    emit();
  }
  function progress() { const c = cur(); if (!c) return; const len = lenMs(), p = posMs(); const pr = document.getElementById('npprog'), el = document.getElementById('npel'); if (pr && len) pr.style.width = Math.min(100, p / len * 100) + '%'; if (el) el.textContent = mmss(p); }
  const emit = () => document.dispatchEvent(new Event('player:change'));

  function start(i) {
    idx = i; save(); const c = cur(); if (!c) return;
    if (c.playable === false) { playing = false; loadedIdx = -1; audio.removeAttribute('src'); render(); return; }
    ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume();
    loadedIdx = idx; loggedIdx = -1;
    audio.src = '/api/stream?track=' + c.trackId;
    audio.play().catch(() => {});
    render();
  }
  function next() { if (idx < q.length - 1) start(idx + 1); else { playing = false; audio.pause(); render(); } }
  function prev() { if (loadedIdx === idx && audio.currentTime > 3) { audio.currentTime = 0; } else if (idx > 0) start(idx - 1); else audio.currentTime = 0; }
  function toggle() { const c = cur(); if (!c || c.playable === false) return; if (loadedIdx !== idx) return start(idx); if (audio.paused) { ensureGraph(); if (ctx && ctx.state === 'suspended') ctx.resume(); audio.play().catch(() => {}); } else audio.pause(); }
  function seekFrac(f) { const len = lenMs(); if (loadedIdx === idx && len) audio.currentTime = Math.max(0, Math.min(1, f)) * len / 1000; }
  function setVol(v) { vol = Math.max(0, Math.min(1, v)); applyVol(); render(); }

  function playTracks(tracks, i) { if (!tracks || !tracks.length) return; q = tracks; start(i || 0); }
  function playAlbum(id, i) { fetch('/api/album?id=' + id).then(r => r.json()).then(a => { const tr = (a.tracks || []).map(t => ({ trackId: t.trackId, title: t.title, artist: a.artist, albumId: a.id, length_ms: t.length_ms, playable: t.playable !== 0 })); if (!tr.length) { alert('Este álbum aún no tiene pistas en tu biblioteca.'); return; } playTracks(tr, i || 0); }); }
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
    const a = e.target.closest('#nowbar [data-act]'); if (!a) return;
    const k = a.dataset.act;
    if (k === 'prev') prev();
    else if (k === 'next') next();
    else if (k === 'toggle') toggle();
    else if (k === 'mute') setVol(vol === 0 ? (parseFloat(localStorage.getItem(VKEY + '.last')) || 0.8) : (localStorage.setItem(VKEY + '.last', vol), 0));
    else if (k === 'seek') { const box = a.getBoundingClientRect(); seekFrac((e.clientX - box.left) / box.width); }
  });
  document.addEventListener('input', e => { const a = e.target.closest('#nowbar [data-act="vol"]'); if (a) setVol(parseFloat(a.value)); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  return { playAlbum, playTracks, next, prev, toggle, jumpTo, removeAt, clearUpcoming, getState, setVol };
})();
