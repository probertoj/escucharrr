# escucharrr — empaquetado standalone (Windows)

Cómo convertir el repo en algo que un usuario arranca con doble clic, sin instalar nada. escucharrr
**no tiene dependencias npm** (solo módulos core de Node), así que empaquetar es mover ficheros, no
compilar una cadena de dependencias. `node:sqlite` exige **Node ≥ 22.5** y viaja *dentro* del binario de
Node, por eso el empaquetado debe llevar un Node moderno (probado con 24.x). Ver también
[`../docs/standalone-readiness.md`](../docs/standalone-readiness.md).

## Opción 1 — Carpeta portátil + lanzador (recomendada para la primera prueba)

Funciona **ya**, sin build. La distribución es una carpeta con esta forma:

```
escucharrr\
  escucharrr.cmd        <- lanzador (doble clic)
  node\node.exe         <- Node portátil v24 (zip oficial de nodejs.org)  [opcional en dev]
  bin\ffmpeg.exe        <- ffmpeg estático (opcional; habilita DSD/transcode)
  app\                  <- servidor + UI
  data-layer\           <- esquema + escáner/enriquecido
  engine\               <- motor nativo / UPnP / cast (opcional)
```

Pasos:

1. Copia el árbol del repo (`app\`, `data-layer\`, `engine\`, `escucharrr.cmd`) a la carpeta de destino.
2. **Node portátil**: descarga el ZIP de Windows x64 de [nodejs.org](https://nodejs.org) (v24 LTS/Current),
   extrae `node.exe` y colócalo en `node\node.exe`. (Si no lo pones, el `.cmd` usa el `node` del PATH —
   útil en desarrollo, no para distribuir.)
3. **ffmpeg** (opcional pero recomendado): coloca un `ffmpeg.exe` estático en `bin\`. Sin él, la app
   **sigue funcionando** (el navegador decodifica FLAC/MP3/AAC/OGG/Opus); solo se desactivan DSD y la
   transcodificación, y Ajustes → Audio lo avisa.
4. Doble clic en `escucharrr.cmd`. Arranca el servidor, abre el navegador en `http://localhost:7733` y, si
   es el **primer arranque sin biblioteca**, crea la BD vacía y muestra el onboarding «Añade tu carpeta de
   música».

Contras: es una carpeta, no un único fichero. Para «un `.exe`» → Opción 2.

## Opción 2 — Node SEA (Single Executable Application): un único `.exe`

[SEA](https://nodejs.org/api/single-executable-applications.html) es la vía **oficial** de Node: inyecta un
blob en una copia de `node.exe`. Como no hay deps npm, el blob es nuestro propio bundle. `node:sqlite` sigue
disponible porque viaja en el `node.exe` base. Esquema:

1. **Entry único**: `app\server.js` usa muchos `require('../data-layer/…')` y `require('../engine/…')`
   relativos. Para SEA hay que o bien (a) agrupar todo el JS en un entry con un bundler sin dependencias
   (p. ej. `esbuild --bundle --platform=node`), o (b) usar la **API de assets de SEA** (`sea.getAsset`)
   para servir los estáticos de `app\public\` y `data-layer\schema.sql` desde el blob.
2. **Estáticos**: hoy el servidor lee `app\public\*` y `schema.sql` del disco (`fs.readFileSync`). Para SEA
   hay que redirigir esas lecturas a `sea.getAsset(...)` cuando `require('node:sea').isSea()` es true. Es el
   principal trabajo pendiente (está acotado: son `sendFile`, el `schema.sql` del primer arranque y los
   `require` de `data-layer`).
3. **Generar**:
   ```bat
   node --experimental-sea-config packaging\sea-config.json
   node -e "require('fs').copyFileSync(process.execPath,'escucharrr.exe')"
   npx postject escucharrr.exe NODE_SEA_BLOB sea-prep.blob ^
     --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
   ```
4. **ffmpeg** sigue siendo externo (es otro binario): se distribuye junto al `.exe` en `bin\` igual que en la
   Opción 1, o se define `ESC_FFMPEG`.

`pkg`/`nexe` **no** se recomiendan aquí: su soporte de `node:sqlite` (módulo nativo interno) y de Node 24 es
frágil, y SEA es lo soportado oficialmente.

## Variables de entorno

| Variable | Efecto |
|---|---|
| `PORT` | Puerto del servidor (por defecto `7733`). |
| `ESC_OPEN_BROWSER=1` | Abre el navegador por defecto al arrancar. Lo pone el lanzador; en `node app\server.js` de desarrollo no se abre. |
| `ESC_NO_BROWSER=1` | Fuerza a **no** abrir el navegador aunque el lanzador lo pida. |
| `ESC_FFMPEG=<ruta>` | Ruta explícita a `ffmpeg.exe` (gana sobre `bin\ffmpeg.exe` y el PATH). |
| `ESC_DB=<ruta>` | Mueve la base de datos a una carpeta escribible (por defecto `app\escucharrr.db`). Útil si el programa vive en una ruta de solo-lectura. |

## Primer arranque (sin biblioteca)

El servidor ya **no aborta** si no existe `app\escucharrr.db`: crea la BD vacía con el esquema canónico
(`data-layer\schema.sql`) y arranca. La UI muestra un banner de onboarding que lleva a **Ajustes →
Biblioteca**, donde el usuario añade su carpeta de música (selector nativo de Windows incluido). escucharrr
solo **lee** esos ficheros: nunca mueve ni renombra nada en disco.

## Qué queda fuera de «empaquetado» (otra fase)

- **Auth + bind opt-in** (`127.0.0.1` por defecto + token para exponer en red): prerrequisito del acceso
  remoto/móvil, se implementa en esa fase. Ver [`../docs/mobile-and-remote-access.md`](../docs/mobile-and-remote-access.md).
- Registro del service worker / instalación PWA: verificar en navegador o móvil real.
