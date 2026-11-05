# El formato compilado de la UI de Roon: BROO / BrooEngine (descifrado completo)

RE del **cuerpo compilado** de los bundles `*.brooxgz` de Roon (2.74.1719, instalación local
`…\Roon\Application\207401719\`). Cierra el hueco que quedaba en [[roon-analysis]]: antes solo se había
mineado la tabla de cadenas («~21% imprimible, cuerpo NO decodificado»). Ahora el formato está **descifrado
al 100% y validado** contra el `ui.broo` real (20,3 MB, 6127 entradas) con un desensamblador que produce
código legible con fichero+línea fuente.

**Método (la forma correcta, no adivinar bytes):** se decompiló el *parser* desde los ensamblados .NET de
Roon con ICSharpCode.Decompiler 11.2 (net9) — `BrooEngine.dll` y `Broo.Runtime.dll`. El formato lo define su
lector; adivinarlo desde los bytes es lo que llevó, en la primera pasada histórica, a etiquetar mal unos
campos del header. Clases clave: `Broo.BrooLoader`, `Broo.Runtime.BrooxLoader` (parser), `Broo.Runtime.Opcode`
(set de instrucciones), `Broo.Runtime.Interpreter` (VM), `Broo.Engine.BinaryHelper` + `Broo.Runtime.BinaryHelper`
(primitivas).

## Qué es BROO

No es «datos de UI» ni un árbol serializado plano: es el **programa compilado de un lenguaje de script propio**
que ejecuta una **VM de registros reactiva**. `BrooLoader.Load` descomprime el `.brooxgz` (gzip), pasa los bytes
a `new BrooContext(...)`, monta un `GlobalScope` con objetos `ui`/`os`/`droo`/`broo`/`webviewhost`, y ejecuta.
El motor (`Broo.Engine`) es un framework de widgets retenido (paneles, listas, grids, diálogos, con
dependency-properties `BrooProperty`, drawables, estilos, fuentes) que además renderiza a un **DOM de WebView2**
(hay JS embebido en `BrooEngine.dll`). Las 95 fuentes `.broo` (`Client/ui/*.broo`, rutas `D:\a\1\s\Client\ui\`
de Azure Pipelines) se compilan a este bytecode.

## Codificaciones enteras

- **int32 fijo**: little-endian de 4 bytes (`BitConverter.ToInt32`). Para: version, directoryptr, RegisterCount,
  Length de código, y los destinos de salto `BR/BR_TRUE/BR_FALSE`.
- **FlexInt (varint)**: `Broo.Runtime.BinaryHelper.ReadFlexInt`. Atajo: si el primer byte < 128, es el valor.
  Si no, varint **big-endian base-128**: 7 bits por byte, bit alto (0x80) = continuación, grupos MSB primero
  (`num = (num << 7) | (b & 0x7F)`). Para: longitudes de string, punteros y casi todos los operandos del bytecode.
- **DateTime**: `DateTime.FromBinary(int64 LE)` (8 bytes; 2 bits altos = Kind, resto = ticks desde 0001-01-01).
- **Guid**: 16 bytes crudos (`new Guid(byte[16])`).
- **String (en Runtime)**: FlexInt longitud + N bytes UTF-8; longitud −1 = null, 0 = "". Las cadenas viven en
  offsets absolutos y se resuelven por puntero con `GetString(ptr)` (interned + cacheado).
  (Ojo: `Broo.Engine.BinaryHelper.ReadString` usa int32 fijo para la longitud; es otra clase, para otros usos.)

## Contenedor (header de 36 bytes)

Tras `gunzip` del `.brooxgz`, `BrooxLoader` lee (y lanza `InvalidBrooxException` si falla):

| offset | tamaño | campo | valor |
|---|---|---|---|
| 0 | 4 | magic | `'B','R','O','O'` (0x42 0x52 0x4F 0x4F) |
| 4 | 4 | version (int32) | debe ser **1** |
| 8 | 8 | build_timestamp (int64) | `DateTime.FromBinary` (del `ui.broo` real: 2026-11-03) |
| 16 | 16 | build_guid | Guid del build |
| 32 | 4 | directoryptr (int32) | offset absoluto al **directorio** |

> Corrección vs. la vieja nota estática: lo que se había etiquetado como «digest de 24 bytes @ offset 8» son en
> realidad el **timestamp (8B) + guid (16B)**. El parser manda.

## Directorio (índice / TOC) en `directoryptr`

- FlexInt **count**.
- `count` entradas: `{ FlexInt nsPtr, FlexInt keyPtr, byte BrooxObjectType, FlexInt objPtr }`.
  - `nsPtr`/`keyPtr` → `GetString` → (namespace, clave). `objPtr` → offset del objeto.
- Mapa resultante: **namespace → clave → (tipo, puntero)**.

`BrooxObjectType`: `String=1, Scope=2, Code=3, ModuleRef=4, MethodRef=5, TypeRef=6, Function=7`.

**Validado contra `ui.brooxgz` real:** 6127 entradas; namespaces `_global, drawable, string, component, style,
defaultstyle, color`; 6126 de tipo `Code` + 1 `Scope`. Las claves son las pantallas/recursos reales:
`component::component_artist_details`, `component::component_all_albums`,
`component::component_all_albumversions`, `component::component_artist_toptracks`, `component::component_queue`,
`component::component_phone_unified_search`, `drawable::roon_icon_med`, `string::label__n_artists`, etc.

## Objetos

**Code** (en ptr): `int32 RegisterCount`, `int32 Length`, luego `Length` bytes de bytecode (empiezan en
`InitialPC`). Es una VM de **registros**: `RegisterCount` registros `Value` por bloque.

**Function** (en ptr): `bool isConst`, `FlexInt→nombre(string)`, `FlexInt paramCount`, `paramCount × BrooxParam`,
`FlexInt→scope`, `FlexInt→code`.

**Refs a .NET** (`ModuleRef`/`TypeRef`/`MethodRef`): punteros a metadatos del **ensamblado de bindings**
(`Roon.Client.Desktop.bindings.dll`), resueltos por token + MVID de módulo. Si no cuadran, Roon exige
«Recompile your broo against the updated assembly». Así, `CALL_STATIC`/`NEWOBJ_STATIC`/`DEREF_MEMBER` saltan del
script al código C# compilado (widgets, API).

## Bytecode: set de instrucciones (`Opcode : byte`)

Los 2 bits altos del byte de opcode (`& 0xC0`) clasifican y fijan el preámbulo de operandos:

- **BINOP (0x80–0xBF)** → `FlexInt regA, FlexInt regB, FlexInt regDst` y luego la operación:
  `OR 0x81, AND 0x82, EQ 0x83, NE 0x84, LE 0x85, GE 0x86, LT 0x87, GT 0x88, CONCAT 0x89, ADD 0x8A, SUB 0x8B,
  MULT 0x8C, DIV 0x8D, MOD 0x8E, BITAND 0x8F`.
- **UNOP (0x40–0x7F)** → `FlexInt regSrc, FlexInt regDst`:
  `BITOR 0x41, NOT 0x42, NEGATE 0x43, ID 0x44, BITNOT 0x45, ENUM_GETENUMERATOR 0x46, ENUM_MOVENEXT 0x47,
  ENUM_CURRENT 0x48`.
- **Literales/memoria (0xC0+)** y **control (0x00+)**, operandos por opcode (todos FlexInt salvo donde se diga):

| opcode | hex | operandos | efecto |
|---|---|---|---|
| LIT_INT | C1 | val, dst | `r[dst]=int` |
| LIT_DOUBLE | C2 | double(8B), dst | `r[dst]=double` |
| LIT_TRUE/FALSE/UNDEFINED | C3/C4/C7 | dst | literal |
| LIT_STRING | C5 | strPtr, dst | `r[dst]=GetString(ptr)` |
| LIT_CUSTOMVAL | C6 | ptr, int32, dst | valor personalizado |
| LIT_LIST/TUPLE/MAP | C8/C9/CA | dst | colección vacía (se rellena) |
| LIT_FUNC | CB | funcPtr, dst | `r[dst]=Function` |
| LIT_EQUATION | CC | regCount, codePtr, dst | **binding reactivo** (re-evalúa al cambiar deps) |
| LIT_ACTION | CD | regCount, codePtr, dst | manejador de evento |
| LIT_TEMPLATE | CE | typeRef, regCount, codePtr, dst | plantilla de widget instanciable (tipo .NET) |
| MOV | CF | src, dst | copia registro |
| LOAD | D0 | scopeIdx, slotIdx, dst | lee variable de scope (reactivo; deref de Equation) |
| STORE | D1 | scopeIdx, slotIdx, src | escribe variable de scope |
| DEREF_CALL | D2 | obj, dst | llama `r[obj](args)` |
| DEREF_SUBSCRIPT | D3 | obj, key, dst | `r[obj][r[key]]` |
| DEREF_MEMBER | D4 | obj, namePtr, dst | `r[obj].name` |
| ASSIGN_SUBSCRIPT | D5 | obj, key, val | `r[obj][r[key]]=r[val]` |
| ASSIGN_MEMBER | D6 | obj, namePtr, val | `r[obj].name=r[val]` |
| CALL_STATIC | D7 | self, methodRef, dst | invoca método .NET del bindings |
| NEWOBJ_STATIC | D8 | methodRef, dst | construye objeto .NET del bindings |
| LAZY_VAL | D9 | codePtr, dst | valor perezoso |
| LOAD_DYNAMIC | DA | namePtr, dst | `scope.Get(name)` por nombre (reactivo) |
| STORE_DYNAMIC | DB | namePtr, src | `scope.Set(name, …)` |
| ADD_TO_BROOLIST | DC | list, val | añade a una BrooList |
| LOAD_ARG | 01 | n, dst | `r[dst]=args[n]` |
| BEGIN_ARGS | 02 | n | abre lista de args |
| PUSH_ARG | 03 | src | empuja arg posicional |
| PUSH_NAMED_ARG | 04 | namePtr, src | empuja arg con nombre |
| POP_ARGS | 05 | — | cierra lista de args |
| EXEC | 06 | scopePtr, codePtr, dst | ejecuta bloque de código anidado |
| PUSH_SCOPE / POP_SCOPE | 07/08 | scopePtr / — | entra/sale de scope |
| BR_TRUE / BR_FALSE | 09/0A | cond, **int32** target | salto condicional (target = int32 + InitialPC) |
| BR | 0B | **int32** target | salto incondicional |
| RETURN | 0C | reg | devuelve `r[reg]` |
| RETURN_UNDEFINED | 0D | — | devuelve undefined |
| PUSH_NODEPS / POP_NODEPS | 0E/0F | — | suspende/reanuda el tracking de dependencias |
| DEBUG_LOC | 1F | strPtr(fichero), line | info de depuración (mapea al `.broo` fuente) |

Reactividad: `LOAD`/`LOAD_DYNAMIC`/`DEREF_*` notifican dependencias a la `Equation` activa; `LIT_EQUATION`
captura esas deps y se re-evalúa cuando cambian. `PUSH_NODEPS`/`POP_NODEPS` acotan qué lecturas cuentan como
dependencia. Es el motor de data-binding de Roon a nivel de bytecode.

## Validación (desensamblado real)

Desensamblando `component::component_artist_details` del `ui.broo` real: cada entrada del directorio es un
envoltorio que `EXEC` del cuerpo; el cuerpo (code@…, 536 registros, 7934 bytes) construye el árbol de widgets:

```
0: DEBUG_LOC  "…\Client\ui\artistdetails.broo":600
7: NEWOBJ_STATIC  new method@1068373 -> r1          ; crea el objeto raíz (constructor del bindings)
12: STORE  r1 -> scope[1].slot[21]
16: BEGIN_ARGS n=1
18: LIT_STRING "component_artist_details" -> r2
26: CALL_STATIC self=r1 method@1068414(args) -> r0   ; set del nombre del componente
39: NEWOBJ_STATIC new method@1445415 -> r3           ; crea un widget hijo
53: LIT_EQUATION regs=0 code@14227116 -> r4          ; binding reactivo de una propiedad
62: CALL_STATIC  self=r3 method@1445450(args)
77: LIT_ACTION   regs=… code@14227137 -> r5          ; manejador de evento
88: CALL_STATIC  self=r3 method@1445865(args)
105: CALL_STATIC self=r1 method@4788574(args)         ; añade el hijo al padre
… (patrón repetido por cada widget)
```

Las `DEBUG_LOC` dan el fichero+línea fuente exactos (`artistdetails.broo:2382…`), confirmando el mapeo a los
95 `.broo`.

## Reproducir

- Decompilar el parser: `scratchpad/decomp/` = consola net9 con ICSharpCode.Decompiler 11.2
  (`dotnet decomp.dll <BrooEngine.dll|Broo.Runtime.dll> <Tipo.Full.Name> …`).
- Parsear/desensamblar un bundle: `scratchpad/broo-parse.mjs` (header+directorio) y `scratchpad/broo-disasm.mjs`
  (`node broo-disasm.mjs ui.brooxgz "component::component_artist_details" [maxInstr]`, o `@<ptr>` para un bloque).

## Para escucharrr

El valor no es replicar BROO (es el runtime propietario de Roon), sino **leer de él** la paridad: el inventario
real de pantallas/recursos (6127 entradas), los nombres de componentes y el mapeo a sus `.broo`, para seguir
llenando `docs/roon-parity-gaps.md`. Nuestra UI es HTML/JS; no necesitamos su VM.
