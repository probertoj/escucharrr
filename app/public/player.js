// escucharrr — reproductor de UI (sin motor de audio aún).
// Cola persistente (localStorage) + barra fija de "ahora suena" en todas las páginas.
// Al empezar una pista registra la escucha vía POST /api/play.
window.player = (function () {
  const KEY = 'escucharrr.queue';
  const PAIRS = [['#0F6E56', '#1D9E75'], ['#534AB7', '#7F77DD'], ['#185FA5', '#378ADD'], ['#854F0B', '#BA7517'], ['#72243E', '#D4537E'], ['#5F5E5A', '#888780'], ['#3B6D11', '#639922'], ['#993C1D', '#D85A30']];
  let q = [], idx = -1, playing = false, pos = 0, timer = null, bar = null;
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) { q = s.q || []; idx = (s.idx == null ? -1 : s.idx); } } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ q, idx })); } catch (e) {} };
  const cur = () => q[idx] || null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const mmss = ms => { ms = ms || 0; return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0'); };
  function cover(id, s) { const p = PAIRS[(id || 0) % PAIRS.length]; return `<svg width="${s}" height="${s}" viewBox="0 0 46 46" style="border-radius:7px;display:block"><rect width="46" height="46" fill="${p[0]}"/><rect y="30" width="46" height="16" fill="${p[1]}"/><circle cx="33" cy="16" r="10" fill="#FAC775"/></svg>`; }
  function logPlay() { const c = cur(); if (c && c.trackId) fetch('/api/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track_id: c.trackId }) }).catch(() => {}); }
  function ensureBar() { if (bar) return; bar = document.createElement('div'); bar.id = 'nowbar'; bar.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--surface);border-top:1px solid var(--border);padding:8px 16px;display:none;align-items:center;gap:14px'); document.body.appendChild(bar); }
  function render() {
    ensureBar(); const c = cur();
    if (!c) { bar.style.display = 'none'; emit(); return; }
    bar.style.display = 'flex';
    bar.innerHTML =
      `<a href="album.html?id=${c.albumId}" style="flex:none">${cover(c.albumId, 46)}</a>
       <div style="min-width:110px"><div style="font-size:14px;font-weight:600">${esc(c.title)}</div><div style="font-size:12px;color:var(--text-2)">${esc(c.artist)}</div></div>
       <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
         <div style="display:flex;align-items:center;gap:20px;font-size:15px;color:var(--text)">
           <span data-act="prev" style="cursor:pointer" title="Anterior">⏮</span>
           <span data-act="toggle" style="cursor:pointer;font-size:20px" title="Play/Pausa">${playing ? '⏸' : '▶'}</span>
           <span data-act="next" style="cursor:pointer" title="Siguiente">⏭</span>
         </div>
         <div style="display:flex;align-items:center;gap:8px;width:100%;max-width:380px">
           <span id="npel" style="font-size:11px;color:var(--muted);width:34px;text-align:right">${mmss(pos)}</span>
           <div style="flex:1;height:4px;background:var(--surface-2);border-radius:999px;overflow:hidden"><div id="npprog" style="width:${c.length_ms ? Math.min(100, pos / c.length_ms * 100) : 0}%;height:100%;background:var(--accent)"></div></div>
           <span style="font-size:11px;color:var(--muted);width:34px">${mmss(c.length_ms)}</span>
         </div>
       </div>
       <a href="queue.html" title="Cola" style="font-size:16px;color:var(--text-2);text-decoration:none">☰ ${idx + 1}/${q.length}</a>`;
    emit();
  }
  function progress() { const c = cur(); if (!c) return; const pr = document.getElementById('npprog'), el = document.getElementById('npel'); if (pr && c.length_ms) pr.style.width = Math.min(100, pos / c.length_ms * 100) + '%'; if (el) el.textContent = mmss(pos); }
  function tick() { clearInterval(timer); if (!playing) return; timer = setInterval(() => { const c = cur(); if (!c) { clearInterval(timer); return; } pos += 1000; if (c.length_ms && pos >= c.length_ms) next(); else progress(); }, 1000); }
  const emit = () => document.dispatchEvent(new Event('player:change'));
  function start(i) { idx = i; pos = 0; playing = true; save(); render(); logPlay(); tick(); }
  function next() { if (idx < q.length - 1) start(idx + 1); else { playing = false; clearInterval(timer); render(); } }
  function prev() { if (pos > 3000 || idx <= 0) { pos = 0; playing = true; render(); tick(); } else start(idx - 1); }
  function toggle() { if (!cur()) return; playing = !playing; render(); tick(); }
  function playTracks(tracks, i) { if (!tracks || !tracks.length) return; q = tracks; start(i || 0); }
  function playAlbum(id, i) { fetch('/api/album?id=' + id).then(r => r.json()).then(a => { const tr = (a.tracks || []).map(t => ({ trackId: t.trackId, title: t.title, artist: a.artist, albumId: a.id, length_ms: t.length_ms })); if (!tr.length) { alert('Este álbum aún no tiene pistas en tu biblioteca.'); return; } playTracks(tr, i || 0); }); }
  function jumpTo(i) { if (i >= 0 && i < q.length) start(i); }
  function removeAt(i) { q.splice(i, 1); if (i < idx) idx--; else if (i === idx) pos = 0; if (idx >= q.length) idx = q.length - 1; save(); render(); }
  function clearUpcoming() { q = q.slice(0, idx + 1); save(); render(); }
  const getState = () => ({ q: q.slice(), idx, playing });
  document.addEventListener('click', e => { const a = e.target.closest('#nowbar [data-act]'); if (!a) return; const k = a.dataset.act; k === 'prev' ? prev() : k === 'next' ? next() : toggle(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  return { playAlbum, playTracks, next, prev, toggle, jumpTo, removeAt, clearUpcoming, getState };
})();
