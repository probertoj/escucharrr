'use strict';
// escucharrr — obtener credenciales de scrobbling, sin dependencias.
//
// ListenBrainz (token de usuario, de https://listenbrainz.org/settings/):
//   node scrobble-auth.js --listenbrainz --token TU_TOKEN   (valida y lo guarda)
//
// Last.fm (necesita api key + secret de https://www.last.fm/api/account/create):
//   1) node scrobble-auth.js --lastfm                 -> imprime una URL para autorizar
//   2) abre esa URL, pulsa "Yes, allow access"
//   3) node scrobble-auth.js --lastfm-finish          -> canjea el token por la session key
//
// Lee/escribe app/scrobble.json (copia de app/scrobble.example.json).

const fs = require('fs');
const path = require('path');
const { post, lastfmSig } = require('./scrobble');

function arg(n) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : undefined; }
const CFG_PATH = path.resolve(arg('config') || path.join(__dirname, '..', 'app', 'scrobble.json'));
const TOKEN_PATH = path.join(path.dirname(CFG_PATH), '.lastfm-token');

function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { return { listenbrainz: {}, lastfm: {} }; } }
function saveCfg(cfg) { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); console.log('guardado en', CFG_PATH); }

// Last.fm firma también las llamadas de auth (params method+api_key[+token]).
async function lfmAuth(cfg, method, extra) {
  const params = { method, api_key: cfg.lastfm.apiKey, ...extra };
  params.api_sig = lastfmSig(params, cfg.lastfm.apiSecret);
  params.format = 'json';
  const r = await post('https://ws.audioscrobbler.com/2.0/', { form: true, body: params });
  let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
  if (r.status !== 200 || j.error) throw new Error('Last.fm ' + (j.error || r.status) + ': ' + (j.message || r.body.slice(0, 200)));
  return j;
}

async function main() {
  const cfg = loadCfg();

  if (process.argv.includes('--listenbrainz')) {
    const token = arg('token') || (cfg.listenbrainz && cfg.listenbrainz.token);
    if (!token || token === true) { console.error('Pasa --token TU_TOKEN (de listenbrainz.org/settings).'); process.exit(2); }
    const r = await post('https://api.listenbrainz.org/1/validate-token', { body: JSON.stringify({}), headers: { Authorization: 'Token ' + token } });
    let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
    if (r.status === 200 && j.valid) { cfg.listenbrainz = { ...cfg.listenbrainz, token }; saveCfg(cfg); console.log('ListenBrainz OK como usuario:', j.user_name); }
    else { console.error('token inválido:', r.status, r.body.slice(0, 200)); process.exit(1); }
    return;
  }

  if (process.argv.includes('--lastfm')) {
    if (!cfg.lastfm || !cfg.lastfm.apiKey || !cfg.lastfm.apiSecret) { console.error('Rellena lastfm.apiKey y lastfm.apiSecret en', CFG_PATH, '(crea una app en last.fm/api/account/create).'); process.exit(2); }
    const j = await lfmAuth(cfg, 'auth.getToken', {});
    fs.writeFileSync(TOKEN_PATH, j.token, 'utf8');
    console.log('\n1) Abre esta URL y pulsa "Yes, allow access":\n');
    console.log('   https://www.last.fm/api/auth/?api_key=' + cfg.lastfm.apiKey + '&token=' + j.token);
    console.log('\n2) Luego ejecuta:  node scrobble-auth.js --lastfm-finish\n');
    return;
  }

  if (process.argv.includes('--lastfm-finish')) {
    let token; try { token = fs.readFileSync(TOKEN_PATH, 'utf8').trim(); } catch (e) {}
    if (!token) { console.error('No hay token pendiente; ejecuta primero --lastfm.'); process.exit(2); }
    const j = await lfmAuth(cfg, 'auth.getSession', { token });
    cfg.lastfm = { ...cfg.lastfm, sessionKey: j.session.key };
    saveCfg(cfg);
    try { fs.unlinkSync(TOKEN_PATH); } catch (e) {}
    console.log('Last.fm OK como usuario:', j.session.name);
    return;
  }

  console.error('uso: --listenbrainz --token T | --lastfm | --lastfm-finish   [--config ruta]');
  process.exit(2);
}
main().catch(e => { console.error(e.message); process.exit(1); });
