# escucharrr — versión móvil + acceso remoto (diseño)

Diseño (4 nov 2026) de (A) cómo sería escucharrr en el móvil y (B) cómo llegar desde fuera de la red
local a lo que corre en casa — **con Tailscale** y **sin un servicio así**. Se apoya en que escucharrr
ya es una web app servida por `app/server.js` (sin deps npm) y en [[roon-analysis]] (RAAT es propietario;
el camino abierto a dispositivos es UPnP/DLNA/AirPlay/Chromecast, ya implementado).

> **Estado (5 nov 2026, commit 59040bc):** el andamiaje PWA ya está implementado y verificado en vivo —
> `manifest.webmanifest` (standalone, iconos SVG monocromos normal+maskable), `sw.js` que cachea SOLO el
> shell (nunca `/api`, audio ni SSE), y el `<head>` del shell con manifest, theme-color claro/oscuro, metas
> iOS y registro del SW. **Media Session API está integrada en `player.js` y verificada en vivo**: metadata
> (título/artista/álbum/carátula) y `playbackState` siguen al reproductor real, con handlers play/pause/
> prev/next/seek. Pendiente de verificar en navegador/móvil real: el **registro del service worker** (falla
> en el panel embebido de pruebas pese a servirse el script 200) y el **pulido táctil** por vista.

## A. La versión móvil = PWA responsive, no una app nativa

escucharrr ya es HTML/CSS/JS servido por el propio servidor; el móvil solo necesita apuntar el navegador
a la dirección del servidor. Convertirlo en **PWA (Progressive Web App)** da "app de verdad" sin tiendas
ni compilar nativo, reutilizando TODO:

1. **Instalable**: `manifest.webmanifest` (nombre, iconos monocromos de la app —nada de emojis, ver
   [[design-no-claude-emojis-roon-like]]—, `display: standalone`, `theme_color`, `start_url`) + un
   **service worker** mínimo que cachea el *shell* de la UI (HTML/CSS/JS/iconos) para arranque instantáneo
   y offline del chrome (los datos y el audio siguen viniendo del servidor). Se añade al móvil con "Añadir a
   pantalla de inicio" y abre a pantalla completa.
2. **Audio en móvil**: el `<audio>` reproduce `/api/stream` igual que en escritorio (el navegador del móvil
   decodifica FLAC/MP3/AAC/OGG/Opus; para formatos que no, el servidor transcodifica con ffmpeg). Añadir
   **Media Session API** (`navigator.mediaSession.metadata` + `setActionHandler('play'/'pause'/'nexttrack'/
   'previoustrack'/'seekto')`) → controles en la **pantalla de bloqueo** y auriculares, carátula incluida.
   Es lo que falta para que se sienta nativo. Reproducción en segundo plano = PWA + MediaSession.
3. **Layout móvil**: el proyecto ya tiene `@media` y `nav.js` conmuta a barra superior en móvil. Pendientes
   finos para táctil: objetivos de toque ≥44px, **barra de reproducción inferior** fija, navegación por
   gestos en la cola, grid de álbumes de 2–3 columnas, y revisar cada vista a ancho ~380px (parte de la QA
   de UX en vivo). Tema claro/oscuro ya se respeta.
4. **Casting desde el móvil**: dos modos — (a) *reproducir en el propio teléfono* (HTML5 audio, lo normal
   fuera de casa); (b) *mandar a un equipo de la LAN de casa* (Eversolo/Chromecast/AirPlay): el móvil solo
   da la orden y **es el servidor** quien hace de fuente (ya existe `/api` de UPnP/Cast), útil cuando estás
   en casa con el móvil de mando a distancia.

> No hace falta app nativa para la v1. Si más adelante se quiere envoltorio nativo (notificaciones push,
> descargas offline del audio), un wrapper tipo Capacitor/TWA envuelve la misma PWA.

## B. Acceso remoto — llegar a casa desde fuera

El servidor corre en casa (BD + biblioteca en el NAS). Hay que alcanzarlo desde el móvil en datos/otra red.
**Prerrequisito común e innegociable (ver [[standalone-readiness]]): autenticación.** Hoy el servidor
escucha en `0.0.0.0` SIN auth y `listdirs` enumera el árbol de ficheros — aceptable en LAN de confianza,
**inaceptable expuesto**. Diseño de auth (se implementa junto a esto):
- Clave/token de acceso (contraseña) guardada **hasheada** (scrypt de `node:crypto`) en la config.
- Página de login → cookie de sesión (HttpOnly, SameSite=Lax) firmada; middleware que exige sesión en
  TODO salvo el login y, opcionalmente, los estáticos, **cuando el bind no es localhost**.
- **Bind por defecto `127.0.0.1`**; exposición **opt-in** (`ESC_HOST=0.0.0.0` o ajuste "permitir acceso en
  red") que además **obliga** a tener contraseña puesta (si no, se niega a exponerse).

### B.1 Con Tailscale (recomendado)
- Instalar Tailscale en el equipo de casa (el que corre escucharrr) y en el móvil; ambos entran en el mismo
  *tailnet* (WireGuard, cifrado E2E, NAT traversal, sin abrir puertos en el router).
- El móvil abre `http://<nombre-MagicDNS-del-equipo>:7733` (p. ej. `http://casa-pc:7733`) desde cualquier
  red. Como el tráfico va por el túnel cifrado, basta con que escucharrr escuche en la interfaz Tailscale
  (bind `0.0.0.0` o la IP `100.x.y.z`). Auth igualmente recomendada (otros equipos del tailnet).
- **Ventajas**: cero configuración de router, cifrado, funciona tras CGNAT, ACLs del tailnet. **Es la vía
  preferente** y la que menos superficie expone.
- Opción extra: **Tailscale Serve/Funnel** da HTTPS con certificado válido sobre el servicio local — útil
  si se quiere TLS sin montar reverse proxy. (Funnel expone a Internet; con auth puesta.)

### B.2 Sin un servicio así (autogestionado)
Para quien no quiera depender de Tailscale/ngrok/Cloudflare:
- **DDNS + reenvío de puerto + TLS + auth** (la vía honesta "sin servicio"):
  1. DNS dinámico (hostname que sigue a la IP de casa; muchos routers lo traen).
  2. Reenviar en el router un puerto → `equipo-de-casa:7733`.
  3. **TLS obligatorio** (expones a Internet): o bien un **reverse proxy** local (Caddy/nginx) que
     termina HTTPS con Let's Encrypt y pasa a escucharrr, o TLS directo en Node con `node:https` y un
     certificado (Let's Encrypt vía DNS-01, o self-signed + confiar en el móvil).
  4. **Auth del paso previo, SÍ o SÍ** + considerar rate-limiting y fail2ban-like en el proxy.
  - Contras: más montaje, el puerto queda expuesto a Internet (de ahí TLS+auth imprescindibles), y tras
    **CGNAT** del operador el reenvío no funciona (ahí Tailscale es la única salida fácil).
- **VPN propia (WireGuard/OpenVPN self-hosted)**: equivalente a Tailscale pero manual (gestionar claves y
  endpoint). Da el mismo modelo "túnel privado, sin exponer el puerto" sin terceros.

### Recomendación
1. **PWA + Media Session** primero (sirve en LAN y por Tailscale ya, sin exponer nada).
2. **Auth + bind opt-in** (habilita cualquier acceso remoto con seguridad; prerrequisito de todo lo demás).
3. **Tailscale** como vía remota recomendada; **DDNS+proxy+TLS** documentado para quien lo prefiera sin
   servicios. Nada de esto toca la estructura de ficheros del usuario (ver [[read-only-user-files]]).

## Orden de implementación sugerido (todo reutiliza el servidor actual)
1. `manifest.webmanifest` + service worker del shell + Media Session (entregable móvil visible).
2. Capa de auth (scrypt + cookie de sesión) + bind `127.0.0.1` por defecto + `ESC_HOST` opt-in que exige
   contraseña. Verificación en vivo (QA).
3. Guía corta en Settings → "Acceso" : cómo abrirlo en el móvil (LAN), cómo con Tailscale, cómo con
   DDNS+proxy; y el conmutador "permitir acceso en red" con su aviso.
4. Pulido táctil de cada vista a ancho de móvil (parte de la QA de UX en vivo).
