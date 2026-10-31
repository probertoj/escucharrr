'use strict';
// Demo de línea de comandos del motor nativo, para probar el bridge a mano:
//   node engine/cli.js devices
//   node engine/cli.js play "C:\ruta\a\pista.flac" [segundos] [--exclusive] [--gain-db -6]
const { NativePlayer } = require('./native-player');

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const p = new NativePlayer();
  p.on('engine', o => console.error('[motor]', o.event + ':', o.message));
  p.on('error', e => console.error('[error]', e.message));

  if (cmd === 'devices') {
    const devs = await p.listDevices();
    for (const d of devs)
      console.log(`${d.default ? '*' : ' '} ${d.name}  [${d.rate}/${d.channels}/${d.bits}]  ${d.id}`);
    return;
  }

  if (cmd === 'play') {
    const file = rest[0];
    if (!file) { console.error('falta la ruta del fichero'); process.exit(2); }
    const secs = rest[1] && !rest[1].startsWith('--') ? parseFloat(rest[1]) : 0;
    const exclusive = rest.includes('--exclusive');
    const gi = rest.indexOf('--gain-db');
    const gainDb = gi >= 0 ? parseFloat(rest[gi + 1]) : 0;

    await new Promise(async (resolve) => {
      p.on('state', s => console.log('[estado]', s.mode || '...', s.device || '', 'pos', s.positionSec.toFixed(1)));
      p.on('ended', () => { console.log('[fin]'); resolve(); });
      await p.play(file, { exclusive, gainDb });
      if (secs > 0) setTimeout(() => { p.stop(); }, secs * 1000);
      const iv = setInterval(() => process.stdout.write(`  ${p.state.positionSec.toFixed(1)}s\r`), 500);
      p.on('ended', () => clearInterval(iv));
    });
    return;
  }

  console.error('uso: node engine/cli.js devices | play <fichero> [segundos] [--exclusive] [--gain-db N]');
  process.exit(2);
}
main().catch(e => { console.error(e); process.exit(1); });
