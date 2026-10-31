# Salida multi-dispositivo / multi-room: cómo lo hace Roon y cómo lo hará escucharrr

> Investigación del 31-oct-2026. Objetivo: que **escucharrr** pueda **enviar música a un
> Eversolo DMP-A6** (y a otros streamers de red) como una **zona de salida**, igual que
> Roon. Incluye ingeniería inversa de la Roon instalada para entender su transporte
> multi-dispositivo, y la decisión de arquitectura resultante.

## 0. Prioridades (fijadas por el usuario)

1. **Standalone en Windows primero.** La app debe funcionar sola, sin servicios externos
   más allá de las APIs abiertas que ya usa. Portar a otros SO vendrá después.
2. **Compatibilidad con dispositivos de red / "Roon Ready".** En concreto, el **Eversolo
   del usuario** debe ser una **zona de salida totalmente funcional** desde escucharrr.

## 1. Cómo hace Roon el multi-dispositivo / multi-room (RAAT)

Resumen de la ingeniería inversa de la Roon instalada (`…\AppData\Local\Roon\Application`,
build 2.74.1716; ver `memory/roon-analysis` para licencia/crypto/anti-tamper). El transporte
a endpoints es **RAAT (Roon Advanced Audio Transport)**, repartido en:

- `RAATServer.exe` / `RAATServer.dll` / `RAATServerApp.dll` (host .NET del servidor RAAT),
- `Roon.Audio.Raat.dll` (capa C# que envuelve el descubrimiento/endpoints),
- **`raatmanager.dll`** (el **SDK nativo de RAAT**, donde está toda la lógica),
- `raat.dat` (recursos).

**Descubrimiento = SOOD, no mDNS.** El SDK expone `RAAT__discovery_{new,start,stop,broadcast,
query,respond,message_*}` y la capa C# habla de `SOOD` y `DiscoveryMessage`; el puerto es
**UDP 9003**. Por eso un escaneo mDNS de la LAN **no** ve un `_raat._tcp`: Roon usa su propio
protocolo **SOOD** (Sonos-OS-like Object Discovery) en 9003, con mensajes de descubrimiento
firmados, en vez de Bonjour/Zeroconf.

**Transporte = PCM/FLAC con reloj y corrección de drift.** `RAAT__stream_*`
(`new/read/write/consume_packet/format/metadata/chmap`), **`RAAT__read_stream_with_drift_
correction`**, `Clock`, `rtp`. El Core envía audio (PCM o FLAC comprimido; soporta float y
MQA: `RAAT__mqa_*`, `mqa_core`, `mqa_original_sample_rate`) al endpoint en paquetes con sello
de tiempo; el endpoint corrige la deriva de reloj contra el reloj del Core. **Esa corrección
de drift es lo que da el multi-room sincronizado** (todas las zonas comparten el mismo reloj).

**Control = RNET (JSON-RPC) + sesiones Lua.** `RNET__json_server_*` /
`RNET__json_request_context_*` = un servidor JSON-RPC para el plano de control; las sesiones
corren **scripts Lua** embebidos (`RAAT__script_*`, `RAAT__session_run_script`, símbolos
`luv`/`uv`/`preload`/`on_script_error`): el comportamiento del endpoint lo dirige el Core
empujando Lua a un sandbox. También hay **HID** (`hid_*`) para DACs USB con volumen/control.

**El dispositivo "Roon Ready" = un conjunto de plugins del SDK.** Un endpoint certificado
implementa `raat_output_plugin`, `raat_volume_plugin`, `raat_transport_plugin`,
`raat_source_selection_plugin` y `app_channel_plugin`; el Core los maneja vía
`RAAT__client_*` y `RAAT__device_*`.

**La puerta cerrada = firma de código por dispositivo.** El SDK tiene
`RAAT__device_add_code_signing_key`, **`RAAT__device_check_code_signature`**,
`RAAT__device_foreach_code_signing_key` y `RAAT__manager_add_code_signing_key`, con `Signature`
y `Aes`. Es decir: los endpoints se autentican con **claves de firma de código** y el Core
**verifica la firma** — la certificación "Roon Ready". Encaja con lo ya sabido: el host
`raat-sign.roonlabs.net` y la raíz de confianza criptográfica en `roonmedia.dll`
(Curve25519/Ed25519 + HMAC-SHA-512, `roon_security_auth`; ver `roon-analysis`).

**Conclusión sobre RAAT.** RAAT es **propietario y certificado**: su SDK está bajo NDA y el
handshake Core↔dispositivo está firmado criptográficamente. **No es replicable** sin el SDK
licenciado y una clave de firma. escucharrr **no** puede hacerse pasar por un Core Roon ni
hablar RAAT con el Eversolo. (Y tampoco queremos: el objetivo es un reproductor abierto.)

## 2. El Eversolo DMP-A6: qué expone (verificado en vivo, 31-oct-2026)

El Eversolo está en la LAN del usuario (su IP, UDN y URLs concretas quedan en la memoria
local, no en este repo público). Además de Roon Ready (RAAT), es un streamer Android que
habla varios **protocolos abiertos** — descubiertos por SSDP/mDNS:

- **UPnP / DLNA — MediaRenderer** (pila **Plutinosoft Platinum 1.0.5.13**), descripción en
  `http://<ip-eversolo>:1331/description.xml`, `friendlyName=DMP-A6`, `manufacturer=EVERSOLO`.
  Servicios:
  - **AVTransport:1** — acciones confirmadas: `SetAVTransportURI`, **`SetNextAVTransportURI`**
    (¡permite **gapless**!), `Play`, `Pause`, `Stop`, `Seek`, `Next`, `Previous`,
    `GetPositionInfo`, `GetTransportInfo`, `GetMediaInfo`, `SetPlayMode`.
  - **RenderingControl:1** — `GetVolume`/`SetVolume`, `GetMute`/`SetMute`,
    **`GetVolumeDB`/`GetVolumeDBRange`** (volumen en dB).
  - **ConnectionManager:1** — `GetProtocolInfo` lista los formatos que acepta por `http-get`,
    entre ellos **`audio/flac`, `audio/x-flac`, `audio/wav`, `audio/aiff`, `audio/L16` (PCM),
    `audio/mp3`, `audio/aac`, `audio/mp4`(ALAC/AAC), `audio/ogg`, `audio/ape`, `audio/wma`**…
    → cubre de sobra lo que tiene el usuario (biblioteca FLAC/WAV).
- **AirPlay** (`_airplay._tcp`) y **AirPlay audio / RAOP** (`_raop._tcp`).
- **Qobuz Connect** (`_qobuz-connect._tcp`) y **ADB** (`_adb._tcp`, es Android).

(En la LAN hay además otros renderers UPnP/AirPlay no-Eversolo; útiles para probar el
descubrimiento, pero irrelevantes aquí.)

## 3. Decisión de arquitectura

**Primer objetivo: salida de red por UPnP/DLNA (AVTransport).** Razones:

- Es **abierto y estándar**, el Eversolo ya lo expone (verificado), y es el **mismo
  mecanismo** por el que Roon, con RAAT aparte, convive con DLNA en estos equipos.
- **Reutiliza lo que ya tenemos**: escucharrr ya sirve `GET /api/stream?track=ID` con
  **soporte de `Range`** (206). UPnP "push" consiste exactamente en darle al renderer esa
  **URL** para que él la descargue y la reproduzca. No hace falta reencodear nada: FLAC/WAV
  van tal cual.
- **Sin dependencias** (fiel al ethos del proyecto y a "standalone Windows"): SSDP es UDP
  multicast (`node:dgram`) y SOAP es un `POST` HTTP con XML (`node:http`). Nada de npm.
- **Gapless y volumen reales**: `SetNextAVTransportURI` encola la siguiente pista sin corte;
  `RenderingControl` da volumen/mute (y dB). `GetPositionInfo`/`GetTransportInfo` dan posición
  y estado para la barra del player.

**AirPlay (RAOP)** y **Chromecast** quedan como objetivos **posteriores** (AirPlay: RTP +
cifrado FairPlay/`_raop`, más trabajo; Chromecast: protobuf sobre TLS + app receptora). RAAT
queda **descartado** (cerrado/certificado). La arquitectura de zonas de escucharrr ya encaja:
hoy hay dos zonas (navegador Web Audio y nativa WASAPI); la **zona UPnP** es una tercera, con
la misma API de transporte (play/pause/seek/volumen) que ya expone el servidor.

## 4. Plan de implementación (fases)

1. **Descubrimiento (`data-layer/upnp-discover.js` + endpoint).** M-SEARCH SSDP por la
   interfaz LAN correcta (ojo: esta máquina tiene también Tailscale `169.254.x`; hay que fijar
   la interfaz `192.168.1.x`), filtrar `MediaRenderer`, leer `description.xml`
   (friendlyName/manufacturer/UDN/controlURLs) y `GetProtocolInfo` (formatos). Cachear la
   lista de renderers (con un refresco periódico / NOTIFY). Exponer `/api/upnp/devices`.
2. **Control UPnP (`engine/upnp-renderer.js`).** Cliente SOAP mínimo:
   `SetAVTransportURI(url, DIDL-Lite)` con `protocolInfo=http-get:*:audio/flac:*` y metadatos
   (título/artista/álbum/duración/arte → usar `/api/cover?rg=ID`), luego `Play`. Transporte:
   `Pause`/`Stop`/`Seek(REL_TIME)`/`Next`/`Previous`; **gapless** con `SetNextAVTransportURI`
   al acercarse el final; volumen/mute por `RenderingControl`; *polling* de
   `GetPositionInfo`/`GetTransportInfo` (o eventos GENA si compensa) para la barra.
3. **URL de stream alcanzable por el dispositivo.** El renderer descarga desde la IP LAN del
   PC, no `localhost`: construir `http://<IP-LAN>:7733/api/stream?track=ID` (detectar la IP de
   la interfaz que ve al dispositivo). `/api/stream` ya hace `Range`; verificar cabeceras
   `Content-Type` (audio/flac) y `Accept-Ranges` que esperan los renderers DLNA (añadir
   `contentFeatures.dlna.org` si hiciera falta).
4. **Zona en el servidor + player.** Añadir la zona UPnP al modelo de zonas y al selector de
   salida del player (junto a navegador y WASAPI nativa), enrutando play/pausa/seek/volumen a
   `upnp-renderer.js`. Registrar la escucha (`logPlay`, `source='upnp'`, `zone=friendlyName`).
5. **Verificación contra el Eversolo real** (está en la LAN): enviar una pista FLAC, comprobar
   reproducción, posición, pausa/seek, siguiente pista gapless y volumen.
6. **Multi-room (posterior).** DLNA no sincroniza varias zonas con un reloj común como RAAT;
   para multi-room real habrá que valorar **Snapcast** (open, con su propio cliente) o grupos
   AirPlay. Documentar que "varias zonas a la vez sincronizadas" es un objetivo aparte.

## 5. Notas honestas

- **RAAT no se va a implementar** (cerrado/certificado). "Totalmente funcional con el Eversolo"
  se consigue por **UPnP/DLNA**, que el propio Eversolo ofrece como ciudadano de primera.
- **Entorno de pruebas**: hoy el Eversolo responde en la LAN, así que la implementación es
  **verificable aquí mismo**. Cuidado con elegir la interfaz de red correcta en el código de
  descubrimiento (en esta máquina hay una Tailscale link-local `169.254.x` además de la
  Ethernet real `192.168.1.x`; el multicast debe salir por la Ethernet).
- **Calidad bit-perfect**: por UPnP el Eversolo decodifica y reloja él; el motor WASAPI nativo
  (resample Kaiser, bit-perfect local) sigue siendo para la salida *de este PC*. Son zonas
  distintas con garantías distintas, y así hay que presentarlo en la UI.
