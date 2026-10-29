# Diseño de tu reproductor, comparado con Roon

> Documento de diseño. Cada sección contrasta **la decisión de Roon** (deducida por ingeniería inversa de Roon 2.74.1716) con **la decisión recomendada para tu app**, y el porqué. Objetivo: conservar lo que te gusta de Roon (sobre todo la página de álbum y la riqueza de datos) en una app propia, local-first, sin dependencia de licencia ni interrupciones.
>
> Nada aquí reutiliza código propietario de Roon: son decisiones de arquitectura y componentes de software libre.

## Principio rector

Lo que hace grande a Roon **no es su UI, es su modelo de datos.** La página de álbum luce así porque detrás hay un *grafo relacional canónico* (quién tocó qué, qué ediciones existen, cómo se enlazan artistas y obras), no las etiquetas ID3 de tus ficheros. Si aciertas con el modelo de datos, la UI es lo fácil.

Las dos divergencias deliberadas respecto a Roon:
1. **Local-first:** todo funciona sin nube ni licencia; la nube es enriquecimiento opcional, nunca una puerta.
2. **Tú eliges las fuentes** de metadatos y el comportamiento; Roon impone las suyas.

Orden de construcción (de los cimientos hacia arriba): **datos → página de álbum → scanner/identificación → motor de audio → transporte/zonas → arquitectura sin interrupciones.**

---

## 1. Modelo de datos de la biblioteca (los cimientos)

**Decisión de Roon** — Almacenamiento en **SQLite + un key-value (LevelDB)** (`Roon.Storage.*`, `Microsoft.Data.Sqlite`, `LevelDb.Database`, `Sqlite.Kv`). La biblioteca NO es un reflejo de tus tags: es una **proyección sobre un grafo canónico** de metadatos (artista / obra / grabación / edición / crédito-por-rol), poblado desde su servicio en la nube (datos comerciales tipo AllMusic/TiVo + MusicBrainz). Tus ficheros se *mapean* a ese grafo; los no identificados caen a un modo "por tags". Por eso Roon se ve consistente aunque tu colección esté sucia.

**Tu decisión** — Mismo principio (grafo canónico + ficheros como capa que mapea a él), pero **tú eres dueño del grafo, en local**. Basa el esquema en el modelo de **MusicBrainz**, que es casi idéntico al de Roon:

```
Artist
ReleaseGroup   (el "álbum" lógico: agrupa ediciones)
  └─ Release    (edición concreta: remaster, vinilo, hi-res…)
       └─ Medium (disco 1, disco 2…)
            └─ Track      (posición en esa edición)
                 └─ Recording  (la grabación real; una Recording puede
                                aparecer en muchos Tracks/Releases)
Work           (la composición; una Recording interpreta una Work)
ArtistCredit + Relationship (crédito TIPADO por rol: bajo, mezcla, producción…)
```

Tablas locales añadidas:
- `local_file (path, hash, format, …)` y `file_recording_map (file → recording_id, confidence)` — separa "lo que tienes" de "lo que es".
- `user_edit (entity, field, value)` — tus correcciones ganan a cualquier fuente.
- `source_provenance (entity, field, source, fetched_at)` — de dónde salió cada dato (Roon lo oculta; tú puedes mostrarlo).

**Por qué** — Este grafo es lo que habilita *todo* lo que te gusta: créditos por rol, ediciones agrupadas, enlaces navegables. Decidir esto primero condiciona el resto.

---

## 2. La página de álbum (una consulta sobre el grafo)

**Decisión de Roon** — La página de álbum es una vista del `ReleaseGroup` que: (a) agrupa ediciones, (b) lista **créditos por rol** a partir de relaciones tipadas, (c) ofrece "Focus"/marcadores, (d) muestra "también aparece en" y artistas relacionados, (e) añade texto editorial (reseñas, biografías). Todo sale del grafo de §1; la UI solo lo renderiza. Su framework de UI es propio (`BrooEngine`, formato `.broo` compilado, con un motor JS `Jint` embebido).

**Tu decisión** — La página = **consultas** sobre tu grafo; la UI (web, Qt, lo que prefieras) solo pinta. Consultas clave:
- *Créditos por rol:* `Track → Recording → relationships(role, artist)` agrupado por rol.
- *Ediciones:* `ReleaseGroup → Releases`, con diferencias (formato, año, país, resolución).
- *Apariciones:* `Artist → Recordings` donde el rol ≠ principal ("also appears on").
- *Editorial:* biografías/reseñas de fuentes abiertas (Wikipedia/Wikidata) + tus notas.

**Diferencias que te convienen** — muestra la **procedencia** de cada dato; permite **editar** in-place (y que tu edición mande); elige qué fuentes rellenan la página. Roon no deja nada de esto.

---

## 3. Scanner + identificación

**Decisión de Roon** — Vigila carpetas, extrae tags, y luego **identifica** cada pista contra su nube (fingerprint de audio + match de metadatos, vía `Identifier.Messages`/`Roon.Metadata`) para engancharla al grafo canónico. Lo no identificado vive en modo degradado "por tags".

**Tu decisión** — Mismo flujo, offline-first:
1. *Watcher* de carpetas (p. ej. `inotify`/`ReadDirectoryChangesW`, o una librería multiplataforma).
2. Lectura de tags con **TagLib**.
3. **Chromaprint/AcoustID** → fingerprint → MBID de MusicBrainz.
4. Trae el subgrafo de MusicBrainz y **cachéalo en local**; portada desde Cover Art Archive.
5. Sin match → modo por tags, pero reconciliable después.

**Diferencias** — **cachea el grafo** (funciona sin red); degradación elegante; el usuario puede **corregir el match** y tú lo recuerdas (`user_edit`). Roon depende de la nube para identificar.

---

## 4. Motor de audio / pipeline DSP

**Decisión de Roon** — `roonmedia.dll` descodifica con **libFLAC 1.4.3 / libopus / Apple ALAC / bs2b** (todo open-source re-exportado) hacia un **pipeline en coma flotante**: resample polyphase (SSE), convolución, dsd2pcm/SDM, IIR, dither, remix; con **ruta bit-perfect** cuando no hay DSP activo, y configuración de DSP **por zona**. (El motor está blindado con el anti-tamper que ya analizamos — eso tú no lo necesitas.)

**Tu decisión** — Misma arquitectura sobre librerías libres directamente:
- **Decoders:** libFLAC, libopus, ALAC (Apache-2.0), y FFmpeg o `dr_libs` para el resto.
- **Interno:** todo a **float32** (como Roon).
- **DSP encadenable:** `soxr`/`libsamplerate` para resampling; convolución por FFT propia; dither TPDF/noise-shaping.
- **Salida:** WASAPI/CoreAudio/ALSA mediante p. ej. `miniaudio`; **modo bit-perfect** (bypass del DSP) como Roon.

**Conserva de Roon** — el pipeline float interno + el bypass bit-perfect opcional + DSP por zona (son buenas decisiones). **Diverge** — cadena DSP abierta y visible al usuario; sin blindaje.

---

## 5. Transporte y zonas

**Decisión de Roon** — Abstracción de **"zonas"** (salidas, agrupables); **RAAT** (protocolo propietario) para endpoints de red; puentes a **AirPlay / Chromecast / UPnP-DLNA / Meridian** (`Roon.Audio.*`). La cola de reproducción se llama **"Swim"** (`Roon.Broker.Transport`): cola + historial + "radio" (auto-extensión) + undo.

**Tu decisión** — Abstracción de zona = "destino de salida" (local o de red). Empieza por **salida local + Chromecast + AirPlay + UPnP** (estándares abiertos; RAAT déjalo, o un protocolo propio simple más adelante). Copia el **modelo de cola de Swim** (es un gran diseño): cola + historial + radio + deshacer.

**Diferencias** — endpoints abiertos en vez de RAAT; agrupación de zonas opcional y a tu gusto.

---

## 6. Arquitectura "sin interrupciones" (tu mayor divergencia)

**Decisión de Roon** — El núcleo está **acoplado a la nube**: login OAuth + heartbeat/auth periódico, **machine-allocation cada 4 h** (asiento de licencia atado al hardware), metadatos desde la nube, y la **puerta de licencia** (`IsLicensed`) que gatea todo. De ahí vienen las interrupciones que te molestan: si la red o la cuenta fallan, o el asiento se pierde, el reproductor se resiente.

**Tu decisión** — **Local-first radical:**
- Sin licencia, sin asiento, sin heartbeat, sin núcleo-en-la-nube.
- Todo funciona **offline**; la red solo enriquece (metadatos, portadas) y siempre de forma asíncrona y cacheada.
- Nada en el camino de reproducción toca la red. La música nunca se interrumpe por un chequeo.

**Por qué** — Es exactamente lo que pediste. Y como el reproductor es tuyo, no hay nada que "esquivar": simplemente no existe esa capa.

---

## Tabla resumen: 6 decisiones

| Área | Roon | Tu app | Qué conservas de Roon |
|---|---|---|---|
| Datos | Grafo canónico (nube) + SQLite/LevelDB | Grafo canónico **local** estilo MusicBrainz + SQLite | La idea del grafo relacional |
| Álbum | Vista de ReleaseGroup sobre el grafo | Consultas sobre tu grafo + procedencia + edición | Créditos por rol, ediciones, enlaces |
| Scanner | Tags + identificación en nube | Tags + Chromaprint/AcoustID + caché local | Identificación canónica |
| Audio | roonmedia (libs libres) + pipeline float | Las mismas libs libres + pipeline float | Float interno + bit-perfect + DSP por zona |
| Transporte | Zonas + RAAT + puentes | Zonas + estándares abiertos; modelo de cola "Swim" | Cola + historial + radio + undo |
| Nube/licencia | Acoplado, con puerta de licencia | **Local-first, sin puerta** | (aquí diverges del todo) |

## Primer paso concreto

Implementar el **esquema de datos de §1** en SQLite (es la decisión que más condiciona el resultado) y una consulta de "página de álbum" de §2 contra datos de ejemplo. Con eso en pie, lo demás encaja encima.
