// escucharrr — menú lateral compartido (se inyecta en todas las páginas, como la barra del
// player). Una sola fuente para la navegación + el tema claro/oscuro. En escritorio es una
// columna fija a la izquierda; en móvil, una barra superior desplazable.
(function () {
  'use strict';
  var TKEY = 'escucharrr.theme';                 // 'auto' | 'light' | 'dark'

  // ── tema: aplicar cuanto antes para minimizar el parpadeo ──
  function theme() { try { return localStorage.getItem(TKEY) || 'auto'; } catch (e) { return 'auto'; } }
  function applyTheme(t) {
    var r = document.documentElement;
    if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t); else r.removeAttribute('data-theme');
  }
  applyTheme(theme());

  var ITEMS = [
    { href: 'home.html', label: 'Inicio', ico: '🏠' },
    { href: 'index.html', label: 'Biblioteca', ico: '📚', root: true },
    { href: 'discover.html', label: 'Descubrir', ico: '✦' },
    { href: 'genres.html', label: 'Géneros', ico: '◈' },
    { href: 'playlists.html', label: 'Listas', ico: '≣' },
    { href: 'search.html', label: 'Buscar', ico: '🔍' }
  ];
  var SETTINGS = { href: 'settings.html', label: 'Ajustes', ico: '⚙' };

  function curFile() {
    var p = location.pathname.replace(/\/+$/, '');
    var f = p.substring(p.lastIndexOf('/') + 1);
    return f || 'index.html';
  }
  // qué entrada marcar activa (las páginas de detalle cuelgan de Biblioteca)
  function activeHref() {
    var f = curFile();
    var known = ITEMS.map(function (i) { return i.href; }).concat(SETTINGS.href);
    if (known.indexOf(f) >= 0) return f;
    if (f === '' ) return 'index.html';
    return 'index.html';                           // album/artist/genre/playlist/queue → Biblioteca
  }

  var THEMES = { auto: { ico: '◐', t: 'Tema: automático' }, light: { ico: '☀', t: 'Tema: claro' }, dark: { ico: '☾', t: 'Tema: oscuro' } };

  function build() {
    if (document.getElementById('appnav')) return;
    var act = activeHref();
    var nav = document.createElement('nav');
    nav.id = 'appnav'; nav.className = 'appnav';
    var html = '<a class="brand" href="index.html">escucharrr</a>';
    html += ITEMS.map(function (i) {
      var on = (i.href === act) ? ' on' : '';
      return '<a class="' + 'itm' + on + '" href="' + i.href + '"><span class="ico">' + i.ico + '</span>' + i.label + '</a>';
    }).join('');
    html += '<span class="sp"></span>';
    html += '<a class="itm' + (SETTINGS.href === act ? ' on' : '') + '" href="' + SETTINGS.href + '"><span class="ico">' + SETTINGS.ico + '</span>' + SETTINGS.label + '</a>';
    var th = THEMES[theme()] || THEMES.auto;
    html += '<button class="theme" id="themebtn" title="' + th.t + '" aria-label="' + th.t + '">' + th.ico + '</button>';
    nav.innerHTML = html;
    document.body.insertBefore(nav, document.body.firstChild);

    document.getElementById('themebtn').addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      var next = order[(order.indexOf(theme()) + 1) % order.length];
      try { localStorage.setItem(TKEY, next); } catch (e) {}
      applyTheme(next);
      var t = THEMES[next];
      this.textContent = t.ico; this.title = t.t; this.setAttribute('aria-label', t.t);
      document.dispatchEvent(new CustomEvent('escucharrr:theme', { detail: next }));
    });
  }

  // API mínima para la página de ajustes
  window.escunav = { getTheme: theme, setTheme: function (t) { try { localStorage.setItem(TKEY, t); } catch (e) {} applyTheme(t); var b = document.getElementById('themebtn'); if (b) { var x = THEMES[t] || THEMES.auto; b.textContent = x.ico; b.title = x.t; } }, THEMES: THEMES };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
