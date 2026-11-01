// escucharrr — iconos de línea MONOCROMOS (SVG, currentColor). Sin emojis ni imágenes:
// estética sobria tipo Roon. Uso: window.icon('home', 18). Los glifos de transporte van
// rellenos (sólidos); el resto son de trazo. Se incluye antes que nav.js/player.js.
(function () {
  'use strict';
  // cada entrada son los paths internos; `fill="currentColor" stroke="none"` marca sólido.
  var P = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
    library: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    discover: '<circle cx="12" cy="12" r="8.5"/><path d="M15.6 8.4 13.4 13.4 8.4 15.6 10.6 10.6z"/>',
    genres: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.4"/>',
    lists: '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 14.5 22 17l-4 2.5z" fill="currentColor" stroke="none"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
    settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h7M15 17h5"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="13" cy="17" r="2"/>',
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/>',
    prev: '<path d="M7 5h2.2v14H7z" fill="currentColor" stroke="none"/><path d="M20 5v14l-10-7z" fill="currentColor" stroke="none"/>',
    next: '<path d="M14.8 5H17v14h-2.2z" fill="currentColor" stroke="none"/><path d="M4 5l10 7-10 7z" fill="currentColor" stroke="none"/>',
    'volume-high': '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11"/>',
    'volume-low': '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M16 9.5a3.6 3.6 0 010 5"/>',
    'volume-mute': '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>',
    eq: '<path d="M6 4v5M6 13v7M12 4v3M12 11v9M18 4v9M18 17v3"/><circle cx="6" cy="11" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="18" cy="15" r="2"/>',
    zone: '<rect x="6" y="3" width="12" height="18" rx="2.5"/><circle cx="12" cy="14" r="3.6"/><circle cx="12" cy="7" r="1.1"/>',
    lyrics: '<path d="M5 7h14M5 12h14M5 17h9"/>',
    queue: '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 14.5 22 17l-4 2.5z" fill="currentColor" stroke="none"/>',
    star: '<path d="M12 3.6l2.6 5.3 5.8.9-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.8l5.8-.9z"/>',
    'star-fill': '<path d="M12 3.6l2.6 5.3 5.8.9-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.8l5.8-.9z" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M5 12.5 9.5 17 19 7"/>',
    'chevron-right': '<path d="M9 5l7 7-7 7"/>',
    'arrow-left': '<path d="M20 12H5M11 6l-6 6 6 6"/>',
    refresh: '<path d="M20 11.5A8 8 0 006.3 6.3L3 9"/><path d="M3 4v5h5"/><path d="M4 12.5A8 8 0 0017.7 17.7L21 15"/><path d="M21 20v-5h-5"/>',
    radio: '<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M7 9 17 4.5"/><circle cx="8" cy="14.5" r="2.2"/><path d="M14 13h4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
    backup: '<path d="M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9.2 3.5 3.5 0 0 1 17.5 18"/><path d="M12 12v6M9.5 15.5 12 18l2.5-2.5"/>',
    'chevron-up': '<path d="M5 15l7-7 7 7"/>',
    'chevron-down': '<path d="M5 9l7 7 7-7"/>',
    download: '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M6.5 7l1 13h9l1-13"/>',
    heart: '<path d="M12 20s-7-4.4-7-9.5A3.8 3.8 0 0112 7a3.8 3.8 0 017 3.5c0 5.1-7 9.5-7 9.5z"/>',
    music: '<path d="M9 18V6l11-2v12"/><circle cx="6.3" cy="18" r="2.7"/><circle cx="17.3" cy="16" r="2.7"/>',
    'theme-auto': '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 010 17z" fill="currentColor" stroke="none"/>',
    'theme-light': '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/>',
    'theme-dark': '<path d="M20 13.2A8 8 0 1110.8 4 6.5 6.5 0 0020 13.2z"/>'
  };
  window.icon = function (name, size) {
    var s = size || 18, inner = P[name];
    if (!inner) return '';
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:none">' + inner + '</svg>';
  };
  // Pinta iconos en HTML ESTÁTICO: <span data-icon="play" data-s="16"></span> → el SVG.
  function paint(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      el.innerHTML = window.icon(el.getAttribute('data-icon'), +el.getAttribute('data-s') || 18);
      el.style.display = 'inline-flex'; el.style.alignItems = 'center';
      el.removeAttribute('data-icon');
    });
  }
  window.paintIcons = paint;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { paint(); }); else paint();
})();
