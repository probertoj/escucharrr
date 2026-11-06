'use strict';
// escucharrr — Sync (Modelo A, fase 1): EXPORTAR / IMPORTAR la "capa de usuario" (lo que TÚ pusiste:
// valoraciones, tiers, favoritos, etiquetas, ediciones, listas, historial, ajustes) en un fichero
// portable, reanclado por MBID / huella / clave normalizada en vez de por los IDs internos (que cambian
// entre instancias). Así puedes llevar tu curación de una instalación a otra sin reescanear.
//
// NO exporta el catálogo (álbumes/pistas/artistas) — eso sale de escanear tus ficheros. Solo la capa
// de usuario que se superpone al grafo. Sin dependencias.

// ── normalización de claves (igual criterio que el emparejado de artistas/Spotify) ──
function stripDia(s) { return String(s == null ? '' : s).normalize('NFD').replace(/\p{Diacritic}/gu, ''); }
function normArtist(s) {
  let n = stripDia(s).replace(/[.,]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (n.startsWith('the ')) n = n.slice(4);
  return n;
}
function normTitle(s) { return stripDia(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function rgKey(a, n) { return normArtist(a) + '|' + normTitle(n); }

// ────────────────────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────────────────────
function buildExport(db) {
  const rgArtistExpr = `(SELECT group_concat(acn.name || acn.join_phrase,'') FROM artist_credit_name acn WHERE acn.artist_credit_id = rg.artist_credit_id ORDER BY acn.position)`;
  const qRg = db.prepare(`SELECT rg.mbid, rg.title, ${rgArtistExpr} artist FROM release_group rg WHERE rg.id=?`);
  const qArtist = db.prepare(`SELECT mbid, name FROM artist WHERE id=?`);
  const recArtistExpr = `(SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=r.artist_credit_id ORDER BY acn.position LIMIT 1)`;
  const qRec = db.prepare(`SELECT r.mbid, r.title, ${recArtistExpr} artist FROM recording r WHERE r.id=?`);
  // una posición representativa (disco/pista) de una grabación, para anclarla aunque no tenga MBID
  const qRecPos = db.prepare(`SELECT rel.release_group_id rg, m.position disc, t.position pos
       FROM track t JOIN medium m ON m.id=t.medium_id JOIN "release" rel ON rel.id=m.release_id
       WHERE t.recording_id=? ORDER BY rel.id LIMIT 1`);
  const qTrack = db.prepare(`SELECT rel.release_group_id rg, m.position disc, t.position pos, t.title,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=t.artist_credit_id ORDER BY acn.position LIMIT 1) artist
       FROM track t JOIN medium m ON m.id=t.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE t.id=?`);

  const rgCache = new Map(), artCache = new Map();
  function rgAnchor(id) {
    if (rgCache.has(id)) return rgCache.get(id);
    const r = qRg.get(id); const a = r ? { mbid: r.mbid || undefined, a: normArtist(r.artist), n: normTitle(r.title) } : null;
    rgCache.set(id, a); return a;
  }
  function anchorFor(type, id) {
    if (type === 'release_group') { const r = rgAnchor(id); return r ? { t: 'rg', ...r } : null; }
    if (type === 'artist') { if (artCache.has(id)) return artCache.get(id); const r = qArtist.get(id); const a = r ? { t: 'artist', mbid: r.mbid || undefined, n: normArtist(r.name) } : null; artCache.set(id, a); return a; }
    if (type === 'recording') { const r = qRec.get(id); if (!r) return null; const p = qRecPos.get(id); return { t: 'rec', mbid: r.mbid || undefined, a: normArtist(r.artist), n: normTitle(r.title), rg: p ? rgAnchor(p.rg) : undefined, disc: p ? p.disc : undefined, pos: p ? p.pos : undefined }; }
    if (type === 'track') { const r = qTrack.get(id); if (!r) return null; return { t: 'track', a: normArtist(r.artist), n: normTitle(r.title), rg: rgAnchor(r.rg), disc: r.disc, pos: r.pos }; }
    return null;
  }

  const out = { format: 'escucharrr-user-layer', version: 1, generated_at: new Date().toISOString() };
  const rows = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return []; } };

  // tier / rating / flag / user_edit (anclados por sujeto)
  out.rating_tier = rows(`SELECT subject_type, subject_id, tier_key, source, updated_at FROM rating_tier`)
    .map(r => { const an = anchorFor(r.subject_type, r.subject_id); return an && { anchor: an, tier_key: r.tier_key, source: r.source, updated_at: r.updated_at }; }).filter(Boolean);
  out.rating = rows(`SELECT subject_type, subject_id, stars, source, updated_at FROM rating`)
    .map(r => { const an = anchorFor(r.subject_type, r.subject_id); return an && { anchor: an, stars: r.stars, source: r.source, updated_at: r.updated_at }; }).filter(Boolean);
  out.flag = rows(`SELECT subject_type, subject_id, flag, set_at FROM flag`)
    .map(r => { const an = anchorFor(r.subject_type, r.subject_id); return an && { anchor: an, flag: r.flag, set_at: r.set_at }; }).filter(Boolean);
  out.user_edit = rows(`SELECT subject_type, subject_id, field, value, updated_at FROM user_edit`)
    .map(r => { const an = anchorFor(r.subject_type, r.subject_id); return an && { anchor: an, field: r.field, value: r.value, updated_at: r.updated_at }; }).filter(Boolean);

  // etiquetas: nombre + sujetos
  const tags = rows(`SELECT id, name FROM tag`);
  out.tags = tags.map(t => ({
    name: t.name,
    items: rows(`SELECT subject_type, subject_id FROM tag_item WHERE tag_id=${t.id}`).map(it => anchorFor(it.subject_type, it.subject_id)).filter(Boolean),
  })).filter(t => t.items.length);

  // listas de reproducción (ítems anclados por grabación)
  const pls = rows(`SELECT id, name, created_at FROM playlist`);
  out.playlists = pls.map(p => ({
    name: p.name, created_at: p.created_at,
    items: rows(`SELECT position, track_id, recording_id FROM playlist_item WHERE playlist_id=${p.id} ORDER BY position`)
      .map(it => it.track_id ? anchorFor('track', it.track_id) : (it.recording_id ? anchorFor('recording', it.recording_id) : null)).filter(Boolean),
  })).filter(p => p.items.length);

  // historial de escucha (anclado por grabación / pista)
  out.plays = rows(`SELECT recording_id, track_id, played_at, ms_played, zone, source FROM play`)
    .map(p => { const an = p.track_id ? anchorFor('track', p.track_id) : (p.recording_id ? anchorFor('recording', p.recording_id) : null); return an && { anchor: an, played_at: p.played_at, ms_played: p.ms_played, zone: p.zone, source: p.source }; }).filter(Boolean);

  // tablas autocontenidas (no referencian ids del grafo): se llevan tal cual, idempotentes por nombre/URL
  out.bookmarks = rows(`SELECT name, state, created_at FROM bookmark`);
  out.dsp_presets = rows(`SELECT name, state, created_at FROM dsp_preset`);
  out.smart_playlists = rows(`SELECT name, rules, created_at FROM smart_playlist`);
  out.radio_stations = rows(`SELECT name, url, homepage, favicon, created_at FROM radio_station`);

  out.counts = {
    rating_tier: out.rating_tier.length, rating: out.rating.length, flag: out.flag.length,
    user_edit: out.user_edit.length, tags: out.tags.length, playlists: out.playlists.length,
    plays: out.plays.length, bookmarks: out.bookmarks.length, dsp_presets: out.dsp_presets.length,
    smart_playlists: out.smart_playlists.length, radio_stations: out.radio_stations.length,
  };
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// IMPORT — resuelve cada ancla a un id LOCAL; lo que no resuelve, se salta y se informa.
// mode: 'fill' (no pisa lo que ya tienes, por defecto) | 'overwrite' (la importación gana).
// ────────────────────────────────────────────────────────────────────────────
function buildResolver(db) {
  const rgArtistExpr = `(SELECT group_concat(acn.name || acn.join_phrase,'') FROM artist_credit_name acn WHERE acn.artist_credit_id = rg.artist_credit_id ORDER BY acn.position)`;
  // índices normalizados (se construyen una vez)
  const rgByMbid = new Map(), rgByKey = new Map();
  for (const r of db.prepare(`SELECT rg.id, rg.mbid, rg.title, ${rgArtistExpr} artist FROM release_group rg`).all()) {
    if (r.mbid) rgByMbid.set(r.mbid, r.id);
    const k = rgKey(r.artist, r.title); if (!rgByKey.has(k)) rgByKey.set(k, r.id);
  }
  const artByMbid = new Map(), artByName = new Map();
  for (const a of db.prepare(`SELECT id, mbid, name FROM artist`).all()) {
    if (a.mbid) artByMbid.set(a.mbid, a.id);
    const k = normArtist(a.name); if (!artByName.has(k)) artByName.set(k, a.id);
  }
  const recByMbid = new Map();
  for (const r of db.prepare(`SELECT id, mbid FROM recording WHERE mbid IS NOT NULL`).all()) recByMbid.set(r.mbid, r.id);
  const qTrackAt = db.prepare(`SELECT t.id trackId, t.recording_id recId
       FROM "release" rel JOIN medium m ON m.release_id=rel.id JOIN track t ON t.medium_id=m.id
       WHERE rel.release_group_id=? AND m.position=? AND t.position=? ORDER BY rel.id LIMIT 1`);

  function resolveRg(an) { if (!an) return null; if (an.mbid && rgByMbid.has(an.mbid)) return rgByMbid.get(an.mbid); const k = (an.a || '') + '|' + (an.n || ''); return rgByKey.has(k) ? rgByKey.get(k) : null; }
  function trackAt(rgId, disc, pos) { if (rgId == null || disc == null || pos == null) return null; return qTrackAt.get(rgId, disc, pos) || null; }
  // Devuelve {subject_type, subject_id} local o null
  function resolve(an) {
    if (!an) return null;
    if (an.t === 'rg') { const id = resolveRg(an); return id ? { st: 'release_group', sid: id } : null; }
    if (an.t === 'artist') { if (an.mbid && artByMbid.has(an.mbid)) return { st: 'artist', sid: artByMbid.get(an.mbid) }; const id = artByName.get(an.n || ''); return id ? { st: 'artist', sid: id } : null; }
    if (an.t === 'rec') {
      if (an.mbid && recByMbid.has(an.mbid)) return { st: 'recording', sid: recByMbid.get(an.mbid) };
      const t = trackAt(resolveRg(an.rg), an.disc, an.pos); if (t) return { st: 'recording', sid: t.recId };
      return null;
    }
    if (an.t === 'track') { const t = trackAt(resolveRg(an.rg), an.disc, an.pos); return t ? { st: 'track', sid: t.trackId } : null; }
    return null;
  }
  // Para listas/historial que quieren la GRABACIÓN y la PISTA locales
  function resolveRecTrack(an) {
    if (!an) return null;
    if (an.t === 'track') { const t = trackAt(resolveRg(an.rg), an.disc, an.pos); return t ? { recording_id: t.recId, track_id: t.trackId } : null; }
    if (an.t === 'rec') {
      if (an.mbid && recByMbid.has(an.mbid)) return { recording_id: recByMbid.get(an.mbid), track_id: null };
      const t = trackAt(resolveRg(an.rg), an.disc, an.pos); if (t) return { recording_id: t.recId, track_id: t.trackId };
    }
    return null;
  }
  return { resolve, resolveRecTrack };
}

function applyImport(db, data, opts = {}) {
  if (!data || data.format !== 'escucharrr-user-layer') throw new Error('Formato no reconocido (no es un export de capa de usuario de escucharrr).');
  const overwrite = opts.mode === 'overwrite';
  const R = buildResolver(db);
  const applied = {}, skipped = {};
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

  db.exec('BEGIN');
  try {
    // rating_tier
    // Nota: con .changes contamos SOLO lo que realmente cambió (en 'fill', un sujeto que ya tienes
    // o dos anclas que resuelven al mismo sujeto cuentan como «ya existía», no como aplicado). Así el
    // informe es exacto e idempotente (re-importar no infla «aplicadas»).
    const insTier = db.prepare(`INSERT INTO rating_tier(subject_type,subject_id,tier_key,source,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(subject_type,subject_id) DO UPDATE SET tier_key=excluded.tier_key, source=excluded.source, updated_at=excluded.updated_at WHERE ${overwrite ? '1' : '0'}`);
    for (const r of (data.rating_tier || [])) { const s = R.resolve(r.anchor); if (!s) { bump(skipped, 'rating_tier'); continue; } bump(insTier.run(s.st, s.sid, r.tier_key, r.source || 'user', r.updated_at || null).changes ? applied : skipped, 'rating_tier'); }

    const insRating = db.prepare(`INSERT INTO rating(subject_type,subject_id,stars,source,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(subject_type,subject_id) DO UPDATE SET stars=excluded.stars, source=excluded.source, updated_at=excluded.updated_at WHERE ${overwrite ? '1' : '0'}`);
    for (const r of (data.rating || [])) { const s = R.resolve(r.anchor); if (!s) { bump(skipped, 'rating'); continue; } bump(insRating.run(s.st, s.sid, r.stars, r.source || 'user', r.updated_at || null).changes ? applied : skipped, 'rating'); }

    const insFlag = db.prepare(`INSERT OR IGNORE INTO flag(subject_type,subject_id,flag,set_at) VALUES(?,?,?,?)`);
    for (const r of (data.flag || [])) { const s = R.resolve(r.anchor); if (!s) { bump(skipped, 'flag'); continue; } bump(insFlag.run(s.st, s.sid, r.flag, r.set_at || null).changes ? applied : skipped, 'flag'); }

    const insEdit = db.prepare(`INSERT INTO user_edit(subject_type,subject_id,field,value,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at WHERE ${overwrite ? '1' : '0'}`);
    for (const r of (data.user_edit || [])) { const s = R.resolve(r.anchor); if (!s) { bump(skipped, 'user_edit'); continue; } bump(insEdit.run(s.st, s.sid, r.field, r.value, r.updated_at || null).changes ? applied : skipped, 'user_edit'); }

    // etiquetas
    const getTag = db.prepare(`SELECT id FROM tag WHERE name=?`), insTag = db.prepare(`INSERT OR IGNORE INTO tag(name) VALUES(?)`);
    const insTagItem = db.prepare(`INSERT OR IGNORE INTO tag_item(tag_id,subject_type,subject_id) VALUES(?,?,?)`);
    for (const t of (data.tags || [])) {
      insTag.run(t.name); const tag = getTag.get(t.name); if (!tag) continue;
      for (const an of (t.items || [])) { const s = R.resolve(an); if (!s) { bump(skipped, 'tags'); continue; } bump(insTagItem.run(tag.id, s.st, s.sid).changes ? applied : skipped, 'tags'); }
    }

    // listas de reproducción (crea si el nombre no existe; si existe, se salta salvo overwrite)
    const plExists = db.prepare(`SELECT id FROM playlist WHERE name=?`), plCreate = db.prepare(`INSERT INTO playlist(name,created_at) VALUES(?,?)`);
    const plAdd = db.prepare(`INSERT INTO playlist_item(playlist_id,position,track_id,recording_id) VALUES(?,?,?,?)`);
    for (const p of (data.playlists || [])) {
      if (plExists.get(p.name) && !overwrite) { bump(skipped, 'playlists'); continue; }
      const pid = Number(plCreate.run(p.name, p.created_at || null).lastInsertRowid);
      let pos = 0; for (const an of (p.items || [])) { const rt = R.resolveRecTrack(an); if (!rt) { bump(skipped, 'playlist_items'); continue; } plAdd.run(pid, pos++, rt.track_id, rt.recording_id); }
      bump(applied, 'playlists');
    }

    // historial de escucha (evita duplicar la misma escucha exacta)
    const playDup = db.prepare(`SELECT 1 FROM play WHERE recording_id IS ? AND played_at=? AND ms_played IS ? LIMIT 1`);
    const insPlay = db.prepare(`INSERT INTO play(recording_id,track_id,played_at,ms_played,zone,source) VALUES(?,?,?,?,?,?)`);
    for (const p of (data.plays || [])) {
      const rt = R.resolveRecTrack(p.anchor); if (!rt) { bump(skipped, 'plays'); continue; }
      if (playDup.get(rt.recording_id, p.played_at || null, p.ms_played == null ? null : p.ms_played)) { bump(skipped, 'plays'); continue; }
      insPlay.run(rt.recording_id, rt.track_id, p.played_at || null, p.ms_played == null ? null : p.ms_played, p.zone || null, p.source || 'local'); bump(applied, 'plays');
    }

    // autocontenidas (por nombre/URL, idempotentes)
    const selfTables = [
      ['bookmarks', 'bookmark', `INSERT OR IGNORE INTO bookmark(name,state,created_at) VALUES(?,?,?)`, b => [b.name, b.state, b.created_at || null], `SELECT 1 FROM bookmark WHERE name=?`, b => [b.name]],
      ['dsp_presets', 'dsp_preset', `INSERT OR IGNORE INTO dsp_preset(name,state,created_at) VALUES(?,?,?)`, b => [b.name, b.state, b.created_at || null], `SELECT 1 FROM dsp_preset WHERE name=?`, b => [b.name]],
      ['smart_playlists', 'smart_playlist', `INSERT INTO smart_playlist(name,rules,created_at) VALUES(?,?,?)`, b => [b.name, b.rules, b.created_at || null], `SELECT 1 FROM smart_playlist WHERE name=?`, b => [b.name]],
      ['radio_stations', 'radio_station', `INSERT INTO radio_station(name,url,homepage,favicon,created_at) VALUES(?,?,?,?,?)`, b => [b.name, b.url, b.homepage || null, b.favicon || null, b.created_at || null], `SELECT 1 FROM radio_station WHERE url=?`, b => [b.url]],
    ];
    for (const [key, , insSql, args, existsSql, existsArgs] of selfTables) {
      const ins = db.prepare(insSql), exists = db.prepare(existsSql);
      for (const row of (data[key] || [])) { if (exists.get(...existsArgs(row))) { bump(skipped, key); continue; } bump(ins.run(...args(row)).changes ? applied : skipped, key); }
    }

    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, mode: overwrite ? 'overwrite' : 'fill', applied, skipped };
}

// Vista previa (solo lectura): cuántas filas resolverían contra ESTA biblioteca y cuántas no.
function previewImport(db, data) {
  if (!data || data.format !== 'escucharrr-user-layer') throw new Error('Formato no reconocido (no es un export de capa de usuario de escucharrr).');
  const R = buildResolver(db);
  const match = {}, miss = {};
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const tally = (arr, key, fn) => { for (const r of (arr || [])) { bump(fn(r) ? match : miss, key); } };
  tally(data.rating_tier, 'rating_tier', r => R.resolve(r.anchor));
  tally(data.rating, 'rating', r => R.resolve(r.anchor));
  tally(data.flag, 'flag', r => R.resolve(r.anchor));
  tally(data.user_edit, 'user_edit', r => R.resolve(r.anchor));
  for (const t of (data.tags || [])) for (const an of (t.items || [])) bump(R.resolve(an) ? match : miss, 'tags');
  for (const p of (data.playlists || [])) { bump(match, 'playlists'); for (const an of (p.items || [])) bump(R.resolveRecTrack(an) ? match : miss, 'playlist_items'); }
  tally(data.plays, 'plays', p => R.resolveRecTrack(p.anchor));
  for (const k of ['bookmarks', 'dsp_presets', 'smart_playlists', 'radio_stations']) match[k] = (data[k] || []).length;
  return { ok: true, format: data.format, version: data.version, generated_at: data.generated_at, match, miss, counts: data.counts || null };
}

module.exports = { buildExport, applyImport, previewImport, normArtist, normTitle, rgKey };
