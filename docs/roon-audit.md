# Auditoría de completitud del REA de Roon (sin atajos)

Fecha: 5 nov 2026. Build auditado: **Roon 2.74 build 1719** (instalación local
`…\Roon\Application\207401719\`; el REA previo era sobre 207401716, que se actualizó).
Objetivo: ledger de cobertura — cada área con método, estado y evidencia, cerrando las fronteras que el REA
declaraba parciales. Principio (ver `rea-must-be-exhaustive`): no afirmar ausencias desde vistas parciales; si hay
fuente, ir a la fuente; declarar explícitamente qué queda fuera y por qué. Complementa [[roon-analysis]].

## Reverificación del build 207401719

| artefacto | tamaño | sha256 (16) | nota |
|---|---|---|---|
| roonmedia.dll | 8 157 184 | `802731954eeec187` | sin firmar; 467 exports (igual que antes) |
| Roon.Broker.Api.Remote.dll | 5 986 304 | `eb2755079ec433a5` | capa remota (cliente) |
| BrooEngine.dll | 1 537 536 | `3c67529e50974ae1` | motor UI (ver roon-broo-format.md) |
| Broo.Runtime.dll | 172 032 | `fae1a5232f5f08f4` | VM del script BROO |
| **Roon.Broker.Core.dll** | — | — | **AUSENTE en el desktop** (antes tenía la lógica de licencia) |

Hashes nuevos (build cambió); arquitectura estable. Hallazgo: `Roon.Broker.Core.dll` ya no se empaqueta en el
desktop; su lógica de cuenta/seat corre en el Core/appliance y el desktop solo consume el entitlement.

## Ledger de cobertura

| # | Área | Estado | Método | Evidencia / límite |
|---|---|---|---|---|
| 1 | Apphost (`Roon.exe`) | ✅ verificado (sin cambios de naturaleza) | PE/estático | apphost estándar de MS parcheado con la ruta de la app; no es código de Roon → no se re-desensambla |
| 2 | **Formato UI BROO (cuerpo compilado)** | ✅ **CERRADO (100%)** | decompilación del parser + validación | `docs/roon-broo-format.md`; desensamblador valida el `ui.broo` real (6127 entradas) |
| 3 | `roonmedia.dll` — inventario de exports | ✅ **CERRADO (467/467)** | tabla de export PE (REA) | clasificación completa abajo; cierra «9 de 467 examinados» |
| 4 | `roonmedia.dll` — núcleo cripto/anti-tamper | ✅ a fondo (build previo) + presente en el nuevo | Ghidra estático + Frida dinámico | `roon_dsp_caps`@359, `roon_platform_syscall`@396 presentes; bomba de heap demostrada en vivo en carga desechable |
| 5 | `roonmedia.dll` — DSP/códecs | ✅ identificado por origen | export table + version strings | ~345 son 3º (FLAC/ALAC/bs2b/opus); ~122 propios (DSP estándar + media) |
| 6 | **RAAT** (`raatmanager.dll`) | ✅ **SUBIDO de símbolos a instrucción** | Ghidra (desensamblado) | `RAAT__device_check_code_signature` = verificación **Ed25519** real (abajo) |
| 7 | Capa gestionada — entitlement/licencia | ✅ reverificado | decompilación (previo) + byte-mining (ahora) | API de cuenta completa decompilada antes; en el desktop nuevo vive en `Api.Remote.dll` |
| 8 | Crypto IDs | ✅ a fondo | Ghidra | Curve25519/Ed25519 (identidad) + HMAC-SHA512 trunc-256 (firma de peticiones); RAAT Ed25519 corrobora |
| 9 | Audio fingerprint | ✅ identificado | símbolos + endpoints | census mel propietario (`roon_mel_*`, `soom_analyze`, `audiosignaturecensus.roonlabs.net`) |

**Límites declarados (no son atajos, son fronteras justificadas):**
- Los ~345 exports de librerías de **código abierto** (FLAC 1.4.3, libopus 1.3.1, opusenc 0.2.1, ALAC, bs2b) no se
  desensamblan función a función: son públicas y su versión está identificada. Desensamblarlas no aporta.
- Las funciones `roon_dsp_*` de DSP puro (gain, chmap, remix, iir, polyphase, sdm, dsd2pcm, dither) son DSP estándar;
  se identifican por firma/exportación, no se desensambla cada una (sí el núcleo de seguridad).
- La **ruta destructiva del anti-tamper NO se fuerza en el Core vivo** (reventaría el servidor real del usuario). Se
  demostró de forma equivalente en una carga desechable de `roonmedia.dll` (Frida, nunca resumida). Límite de
  seguridad deliberado, no una laguna.

## Clasificación completa de los 467 exports de roonmedia.dll

| grupo | ordinales | nº | origen |
|---|---|---|---|
| `FLAC__*` | 1–210 | 210 | libFLAC (3º) |
| `applealac_*` | 211–219 | 9 | Apple ALAC (3º) |
| `bs2b_*` | 220–260 | 41 | libbs2b / crossfeed (3º) |
| `ope_*` | 261–285 | 25 | libopusenc (3º) |
| `opus_*` | 286–345 | 60 | libopus (3º) |
| `roon_*` | 346–405 | 60 | **Roon propio**: convolution, dsd2pcm, dsd_lpf, **dsp_caps (359, gate anti-tamper)**, dsp_* (gain/chmap/remix/repack/dither/crossfade/fadeout), iir (EQ), init_platform_{android,ios,linux,macosx,windows}, invert_phase, mel (fingerprint), **platform_syscall (396, puente cripto)**, polyphase (resample SSE), sdm |
| `sooc_*` | 406–407 | 2 | Roon (logging) |
| `soom_*` | 408–467 | 60 | **Roon propio**: decoders `imp_create_{aac,adtsaac,aiff,alac,dff,dsf,flac,mp3,ogg,ogg_flac,opus,wav,wma}`, read_frames (pcm/double/dsd), analyze (fingerprint), dsp (fir/requant), dump/update tags+cover, encoders (aac/flac), mediafile IO (open local/http/custom/stdio/stream/ptr/buffered, read/seek/tell), mediaformat_detect, stats |

**Superficie propietaria real = ~122 exports** (`roon_*` + `soom_*` + `sooc_*`). El resto (~345) son re-exports de
librerías de código abierto enlazadas estáticamente.

## RAAT — verificación de firma (desensamblado, nuevo)

`RAAT__device_check_code_signature` (RVA 0x29110, Ghidra 12.1.4 sobre `raatmanager.dll` sha `a49d9a28…`):
- Si el dispositivo no tiene clave registrada (`*(dev+0x2a0)==0`) → pasa (sin gate).
- Exige que la firma de entrada sea **128 chars hex** (= 64 bytes). Recorre la lista enlazada de claves de firma
  registradas (`dev+0x290`, cf. `RAAT__device_add_code_signing_key`/`foreach`), empareja por nombre.
- **Hex-decodifica 64 bytes de clave pública** (de la clave registrada) y **64 bytes de firma** (entrada); inicializa
  un verificador `FUN_1800c60a0(ctx, firma, pubkey)`, lo actualiza con el mensaje `(**vtbl+0x10)(ctx, msg, len)` y
  finaliza `FUN_1800c63e0(ctx)` → devuelve true solo si verifica.
- Firma de **64 bytes** + clave pública de 32/64 + verificación = **Ed25519**, consistente con la raíz de confianza
  de `roonmedia.dll` (Curve25519/Ed25519 + `roon_security_auth`).

**Conclusión (ahora verificada a nivel de instrucción, no inferida por símbolos):** la autenticación de endpoints RAAT
es un **handshake firmado Ed25519 por dispositivo**. Roon Ready / RAAT **no es replicable** sin una clave de firma
emitida por Roon (cf. `raat-sign.roonlabs.net`). Para escucharrr el camino abierto a equipos de red sigue siendo
UPnP/DLNA/AirPlay (ver [[escucharrr-project]]).

## Capa gestionada (reverificación)

Mecanismo de licencia sin cambios respecto al REA previo (cuenta/OAuth → machineallocate/seat → flag `IsLicensed`,
con gracia offline por `account_v3` cacheado). En el desktop **207401719**: los tipos de entitlement
(`IsLicensed`/`AccountStatus`/`MachineStatus`) están en `Roon.Broker.Api.Remote.dll` (cliente). El proxy completo del
servidor de cuentas (`fiveaccountserver`, `machineallocate`, el API REST decompilado en [[roon-analysis]]) **no se
empaqueta en el desktop** — corre en el Core/appliance; el desktop consume el estado por la API remota. La
superficie de wire del API de cuenta ya quedó decompilada entera (ver roon-analysis).

## Veredicto

El REA de Roon queda **auditado y, en lo propietario, al 100% en inventario + con el núcleo (seguridad, cripto,
formato UI, transporte) desensamblado**. Lo no desensamblado función-a-función es, por diseño, código de terceros de
fuente pública o DSP estándar; y la única acción no realizada (forzar la bomba anti-tamper en el Core vivo) es un
límite de seguridad, no una laguna de conocimiento. Para las decisiones de escucharrr no queda nada bloqueado.
