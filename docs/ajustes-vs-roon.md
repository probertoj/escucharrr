# Ajustes: auditoría de Roon y rediseño para escucharrr

> Qué ajustes tiene Roon, cuáles **podemos** replicar, cuáles **no** (y por qué), y una propuesta de **estructura coherente** para escucharrr. Basado en ingeniería inversa de Roon 2.74.1716 y en las decisiones de arquitectura ya documentadas en [[diseno-vs-roon]].
>
> Sin reutilizar código propietario de Roon: son capacidades y decisiones de diseño sobre componentes libres.

## Resumen en una línea

**Todo el motor de audio de Roon es estándar y replicable** (DSP, dispositivos, análisis). Lo único que **no** podemos es lo atado a su nube/partners: metadatos editoriales licenciados, RAAT, Roon ARC (relay), Roon Radio (ML en nube) y los logins de streaming intermediados. Y nada de licencia/cuenta, que no queremos.

---

## 1. Capacidades del motor confirmadas por RE

Exports de `roonmedia.dll` y vocabulario de `Roon.Audio.*` — esto es *todo* lo que Roon ofrece en el camino de señal, y cada pieza tiene equivalente libre:

| Capacidad Roon (export/ajuste) | Qué es | Equivalente libre |
|---|---|---|
| `roon_polyphase_*` (sinc, SSE) | Resampling / upsampling | soxr, libsamplerate |
| `roon_iir_*` | EQ paramétrico / filtros | biquads propios / DSPFilters |
| convolución | Corrección de sala (FIR) | FFT propia (KissFFT/FFTW), convolución particionada |
| `roon_dsd2pcm_*`, `roon_sdm_*`, `roon_dsd_lpf_*` | DSD↔PCM, modulador sigma-delta | dsd2pcm (libre), SDM propio |
| `roon_dsp_remix_*`, `roon_dsp_chmap_*` | Mezcla / mapeo de canales | matriz de canales propia |
| `roon_dsp_truncate_dither_*` | Dither (TPDF / noise-shaping) | trivial propio |
| `roon_invert_phase*`, Headroom, `roon_dsp_crossfade`, `roon_dsp_fadeout` | Fase, headroom, crossfade | trivial propio |
| crossfeed (bs2b en el motor) | Crossfeed para auriculares | libbs2b |
| `soom_*` + `soom_analyze` | Decodificación + análisis (waveform/loudness) | libFLAC/opus/ALAC/FFmpeg + EBU R128 |
| ExclusiveMode / EventDriven / IntegerMode / MaxBits / MaxSampleRate / ResyncDelay | Control fino del dispositivo | WASAPI/ASIO/CoreAudio/ALSA vía miniaudio o nativo |

Conclusión: el DSP y el control de dispositivo de Roon **no tienen nada que no podamos construir**.

---

## 2. Clasificación de los ajustes de Roon

### ✅ PODEMOS replicar (local / estándar)

| Área Roon | Contenido | Nota |
|---|---|---|
| General (browsing) | barra lateral, mostrar playlists, personalizar álbum, ocultos, créditos de compositor, idiomas | preferencias de UI |
| Storage | carpetas vigiladas en tiempo real, no modifica tus ficheros | igual que Roon |
| Setup | aceptar conexiones remotas, nombre del servidor, tema, tamaño de texto, opciones táctiles, limpiar caché, **soporte Squeezebox** | Squeezebox = SlimProto (abierto) |
| Play actions | acción de un clic configurable (Reproducir/A continuación/Cola/Radio/Aleatorio), orden arrastrable | igual |
| Library | importación, des-fusionar artistas/obras, mapeo de géneros, ficheros omitidos, **análisis de audio** (R128/waveform/crossfade), velocidad de análisis, trabajo en segundo plano programado | estándar |
| Audio | dispositivos de salida (exclusivo/event/integer, máx bits/SR, resync), **endpoints de red** (AirPlay/Cast/UPnP/SlimProto), **motor DSP completo** (ver §1) | todo replicable |
| Displays | pantalla "ahora suena" a pantalla completa, **web display** servido por HTTP | igual |
| Backups | copia de la base de datos (no de los ficheros) | de *nuestra* BD |
| Extensions | API para extensiones de terceros | diseñamos la nuestra |
| Keyboard shortcuts | atajos | igual |
| Profiles | multi-usuario | igual |
| Scrobbling | **Last.fm**, **ListenBrainz** | APIs abiertas (ver §4) |

### ⚠️ PARCIAL / enfoque distinto

| Área | Por qué parcial | Nuestro enfoque |
|---|---|---|
| Services (streaming) | Roon usa logins intermediados por su nube | integración directa por servicio (Qobuz/Tidal API; **Spotify vía Web Playback SDK**, ver §3) |
| Roon ARC (acceso remoto) | usa el **relay** de Roon en internet | lo construimos: Tailscale/WireGuard o relay propio |
| Roon Radio / recomendaciones | ML en la nube de Roon | ListenBrainz + Last.fm + similitud local (distinto, menos pulido) |
| Metadatos / editorial | datos licenciados (AllMusic/TiVo) | MusicBrainz + Wikidata + Discogs + Cover Art Archive (misma estructura, menos texto editorial) |
| HQPlayer | integración con un 3º propietario | opcional: integrar su protocolo o upsampling propio |

### ❌ NO podemos (propietario / nube / partners)

| Área | Por qué | Alternativa |
|---|---|---|
| **RAAT** (transporte) | protocolo propietario cerrado | AirPlay/Cast/UPnP/**Snapcast** (clock-sync abierto) |
| Roon Ready / Roon Tested | ecosistema de endpoints certificados | usar los estándares abiertos |
| Editorial licenciado verbatim | derechos de terceros | fuentes abiertas |
| Cuenta / licencia / ARC relay | infraestructura de Roon (y no la queremos) | n/a — local-first |

---

## 3. Spotify (tu Premium) — qué es posible

Roon **no** reproduce Spotify (solo lo enlaza como metadato). Para escucharrr, con cuenta **Premium**, hay tres caminos:

1. **Web Playback SDK (oficial, recomendado)** — reproduce **pistas completas** en un contexto web/Electron para usuarios Premium. 
   - ✅ Legal, pistas completas, con tu cuenta.
   - ⚠️ Audio **con DRM** (Widevine): **no hay acceso al PCM** → sin DSP, sin bit-perfect, sin ReplayGain sobre Spotify; ~160 kbps (web); requiere runtime web/Electron, una app registrada (client ID) y OAuth del usuario.
   - → Spotify entra como **fuente de segunda clase**, en un pipeline aparte del local (que sigue siendo el ciudadano de primera: bit-perfect + DSP).
2. **Web API** — buscar, tu biblioteca/playlists, pistas guardadas, *audio features*; solo **metadatos** (+previews de 30 s). Ideal para **importar tu biblioteca de Spotify como metadatos** y casarla con tus ficheros locales.
3. **Spotify Connect (control remoto)** — escucharrr como mando que controla un endpoint oficial de Spotify (móvil/altavoz). La reproducción ocurre en el dispositivo oficial.

Existe `librespot` (reimplementación libre de Spotify Connect que da audio en claro con credenciales Premium), pero **viola los ToS de Spotify, arriesga el baneo de la cuenta y Spotify lo rompe activamente** — no es una base fiable. Recomendación: **Web Playback SDK** para reproducir + **Web API** para navegar/importar.

**Decisión de diseño:** tu biblioteca local es el núcleo de alta calidad; Spotify se integra como capa opcional, claramente marcada como "con DRM / sin DSP", sin contaminar el camino bit-perfect.

---

## 4. Scrobbling (necesario): Last.fm + ListenBrainz

Ambos triviales y abiertos:

- **Last.fm**: API con `auth.getMobileSession` (o flujo web) + `track.updateNowPlaying` y `track.scrobble`. Necesita API key propia. Da también historial y "similares" (útil para recomendaciones).
- **ListenBrainz**: `submit-listens` con token de usuario; además **endpoints de recomendación** y estadísticas — encaja para alimentar *Discover*/radio sin depender de nube propietaria.

Diseño: un único módulo de "scrobbling" con reglas (umbral de %/segundos para contar escucha, now-playing, scrobble offline en cola si no hay red). Ambos activables a la vez.

---

## 5. Rediseño: estructura de ajustes coherente

Roon tiene **14 secciones planas** (y tú lo ves, con razón, como de lo más flojo). Propuesta: **8 grupos lógicos**, de lo más usado a lo más avanzado.

1. **Biblioteca** — carpetas vigiladas · **fuente Obsidian** (mapeo nota↔álbum, campo `tier`/`rating`) · importación y tags · análisis (R128, waveform, crossfade) · mantenimiento · copias de seguridad.
2. **Audio** — dispositivos de salida (exclusivo/event/integer, máx bits/SR, resync) · **zonas y endpoints de red** (AirPlay/Cast/UPnP/Snapcast) · **DSP por zona** (EQ paramétrico, convolución, upsampling, DSD, headroom, crossfeed, remix, dither, fase).
3. **Reproducción** — acciones rápidas (un clic) · cola · crossfade/gapless · volume leveling · radio/autoplay.
4. **Servicios y scrobbling** — Spotify (Premium, con aviso de DRM/sin DSP) · Last.fm · ListenBrainz · (Qobuz/Tidal opcionales).
5. **Interfaz** — tema claro/oscuro · tamaño de texto · barra lateral · página de álbum · displays / "ahora suena".
6. **Perfiles y acceso** — perfiles · acceso remoto (propio).
7. **Atajos de teclado.**
8. **Avanzado** — caché · logs · versión · extensiones (API propia).

Principios del rediseño (frente a Roon):
- **Agrupar por tarea**, no por componente interno (Roon mezcla "Setup", "Library", "Audio", "Services" sin jerarquía clara).
- **Búsqueda de ajustes** (Roon no tiene) — un buscador que salte a cualquier opción.
- **DSP por zona visible y editable en vivo**, no enterrado.
- **Procedencia y "tus datos mandan"** como ciudadanos de primera (fuente Obsidian en Biblioteca).

---

## 6. Qué NO necesita más ingeniería inversa

Tenemos el modelo completo. No hace falta reabrir el binario para esto. Lo único que podría merecer una mirada puntual (si lo quieres) son los **rangos exactos de parámetros del DSP de Roon** (p. ej. límites de la convolución, pasos del EQ) para clonar sus *defaults* — pero no sus valores, que se deciden mejor desde buenas prácticas de audio.
