// Renderer de Markdown mínimo, seguro y sin dependencias, para las notas de Obsidian
// (reseñas de álbum y bios de artista). Escapa el HTML ANTES de aplicar el markdown, así que
// el texto de la nota nunca puede inyectar etiquetas. Cubre lo habitual en una nota: encabezados,
// negrita/cursiva, código, enlaces, listas, citas, y [[wikilinks]] de Obsidian (a texto).
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  // 's' ya viene escapado; aplicamos el formato en línea.
  function inline(s) {
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => (b || a));   // [[wikilink|alias]] -> texto
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');                              // `código`
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');                              // ![alt](img) -> alt (sin cargar imágenes externas)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>                      // [texto](url) solo http(s)
      /^https?:\/\//i.test(u) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : t);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');                // *cursiva*
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');                // _cursiva_
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');                              // ~~tachado~~
    return s;
  }
  function mdToHtml(src) {
    if (src == null || src === '') return '';
    const lines = esc(String(src)).replace(/\r\n?/g, '\n').split('\n');
    const out = []; let i = 0;
    const isBlock = l => /^(#{1,6}\s|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*(---|\*\*\*|___)\s*$)/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      let hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) { const lvl = hm[1].length; out.push('<h' + lvl + '>' + inline(hm[2].trim()) + '</h' + lvl + '>'); i++; continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push('<blockquote>' + inline(buf.join('<br>')) + '</blockquote>'); continue; }
      if (/^\s*[-*+]\s+/.test(line)) { const it = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { it.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++; } out.push('<ul>' + it.join('') + '</ul>'); continue; }
      if (/^\s*\d+[.)]\s+/.test(line)) { const it = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { it.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; } out.push('<ol>' + it.join('') + '</ol>'); continue; }
      const buf = []; while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlock(lines[i])) { buf.push(lines[i]); i++; }
      out.push('<p>' + inline(buf.join('<br>')) + '</p>');
    }
    return out.join('');
  }
  window.mdToHtml = mdToHtml;
})();
