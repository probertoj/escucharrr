---
name: qa
description: Verificación de cambios en escucharrr como lo haría un usuario real, antes de darlos por hechos. Úsalo siempre que toques UI, reproductor, escáner/ingesta, portadas, zonas o datos de la biblioteca. Impone: clics/arrastres reales en el navegador in-app contra el server local (no solo llamar a funciones internas), nunca escribir sobre la biblioteca/config real, copia de la BD para pruebas destructivas, el server parado antes de un escaneo real, limpieza del estado de prueba, y un informe honesto de qué se verificó en vivo y qué no se puede verificar (audio, hardware, tacto) y queda para el usuario.
---

# QA de escucharrr

Objetivo: no volver a decir «arreglado» sin haberlo probado como lo vive el usuario. Nació del fallo del
fader de volumen (se «verificó» con eventos `input` simulados + matemática, sin arrastrar ni escuchar) y del
escáner lossless-only (todo se probaba con una biblioteca FLAC). Dos lecciones: **prueba con interacción
real** y **no asumas que tu entorno/biblioteca representa a todos**.

## Principios (no negociables)

1. **Interacción real, no API interna.** Prueba clicando/arrastrando el elemento de verdad en el navegador
   in-app (`mcp__Claude_Browser__*`) contra el server en `http://localhost:7733`, y comprueba el resultado
   **visible** (DOM/`get_page_text`/`read_page`/captura), no que una función devolvió algo. Disparar un
   evento o llamar a `player.x()` vale para una comprobación rápida, **no** como prueba final.
2. **Navegación SPA con clics reales.** Nunca uses `location.href`/`reload()` dentro de `javascript_tool`
   para «navegar» (recarga el documento y corta el player). Clica el enlace/elemento como el usuario.
3. **Nunca contra la config/biblioteca real de forma irreversible.** Lo que escribe (merges, borrados,
   escaneos, cambios de tags) se prueba sobre **datos reversibles**:
   - **Lógica destructiva (SQL/merge/prune):** sobre una **copia** de la BD. Copia `escucharrr.db` + `-wal`
     + `-shm`, ejecuta, verifica, **borra la copia**. (Ej.: el merge de artistas se validó así, 2→24
     álbumes, sin huérfanos, sin tocar la biblioteca.)
   - **UI que muta:** intercepta el `fetch` de la petición mutante y comprueba su **payload** sin ejecutarla
     de verdad (se hizo con el merge: `{into, from[]}`).
4. **El escritor de BD y el server no corren a la vez.** Para un escaneo/escritura real: **para el server**,
   escanea (`--root <carpeta> --no-prune` para acotar), verifica, **reinicia el server**. WAL aguanta
   lectores + 1 escritor, pero no te la juegues en pruebas.
5. **Lo que no puedes verificar, dilo.** Audio (no se oye), hardware real (equipos de red, el NAS del
   betatester), tacto subjetivo (curva de volumen) → verifica lo **medible** (valores de la curva, cableado
   de eventos, tamaños, cabeceras HTTP, bytes de imagen) y **entrega al usuario** el juicio final de lo que
   no percibes. No digas «arreglado» de un tacto que no sientes.
6. **FS de red es asíncrono y lento.** La música suele estar en SMB/NAS: usa IO async, tolera latencia, y no
   confundas «tarda en cargar» (portadas lazy sobre SMB) con «roto».
7. **Limpia el estado de prueba y repórtalo.** Borra colas, zonas, claves de localStorage de prueba, resetea
   el volumen, elimina copias de BD. Al terminar, di **qué se verificó en vivo, qué por inspección/medición,
   y qué queda para el usuario**.

## Procedimiento

1. **Arranca/confirma el server** (tarea en segundo plano; una sola instancia). Si hay que reiniciarlo,
   párala antes (no abras dos).
2. **Abre la página real** afectada en el navegador in-app y reprodúcelo como el usuario.
3. **Ejercita la interacción** (clic/arrastre/teclado/rueda) y comprueba el efecto visible. Para estados
   (reproduciendo, zona activa, etc.) usa una captura o lee el DOM.
4. **Casos límite y errores:** biblioteca vacía/parcial, pista sin audio local, formato no-FLAC, red caída,
   sin Liderarrr. Los errores deben **verse**, no tragarse.
5. **Mide lo que no puedas percibir** y sepáralo claramente en el informe.
6. **Limpia** y **reporta** con el desglose verificado-en-vivo / medido / pendiente-usuario.

## Checklist por área

- **UI:** clic/arrastre reales → efecto visible; captura; ancho móvil (≈380 px) y escritorio; tema claro y
  oscuro; sin romper el player al navegar (SPA).
- **Reproductor:** cableado y valores medibles (curva, gapless, crossfade, ReplayGain, cola, zonas) en vivo;
  **el sonido en sí lo juzga el usuario**.
- **Escáner/ingesta:** parsea primero **ficheros reales del formato** (MP3/M4A/FLAC…) y enseña tags+info+
  carátula; luego escaneo acotado (`--root` a una carpeta) con el server parado; verifica en la BD; cuida los
  duplicados/typos que genera.
- **Portadas:** pide `/api/cover?rg=ID` y comprueba la **cabecera** (`image/*` vs `svg`) y los primeros bytes
  (JPEG `FF D8`, PNG `89 50`), no solo que «se ve algo».
- **Datos (merge/edición/borrado):** copia de BD o intercepción de payload; nunca sobre la biblioteca real.

## Cómo invocarlo

`/qa` (o pídelo: «pásale QA a esto»). No sustituye a `/code-review` (bugs de código) ni a `/run` (lanzar la
app): esto es la disciplina de **verificar el cambio como usuario** antes de darlo por bueno.
