# Re-vinculación de renombrados/movimientos (rebind)

Cuando renombras o mueves carpetas de música en tu disco/NAS (p. ej. `Disc1` → `CD 01`, o un álbum a
`Álbum (2020) [FLAC]`), las filas de `local_file` siguen apuntando a la ruta vieja. escucharrr re-vincula por
**identidad de contenido**, nunca borrando y recreando (modelo Roon; ver memoria `roon-storage-scanner`). Así
se conserva el id del fichero, el análisis (loudness/peaks/gain), el match y —lo importante— el **tier,
valoración, favoritos, etiquetas e historial**. **Nunca se toca el disco**: todo ocurre en SQLite.

Por qué el tier/valoración están a salvo aun sin rebind: cuelgan del `release_group`, que se indexa por el
**tag de álbum**, no por la ruta. Renombrar la carpeta no crea un álbum nuevo mientras el tag ALBUM no cambie;
y `pruneGraph` nunca borra un álbum con datos de usuario. El daño de un renombrado es a nivel de `local_file`
(ruta muerta) y, a veces, una "versión" (release) duplicada por carpeta.

## Dos mecanismos

1. **Durante el escaneo** (`data-layer/scan.js`, `reconcileMove`): por cada fichero visto en una ruta nueva,
   si corresponde a una fila existente cuya ruta vieja ya no se ve (misma huella Chromaprint, o ISRC+tamaño,
   o tamaño+duración, o misma ruta salvo normalización NFC/NFD), se **repath** la fila en vez de insertar una
   nueva. Cubre el caso común sin intervención.

2. **Reparación bajo demanda** (`data-layer/rebind.js`, Ajustes → Biblioteca → «Reparar ahora», endpoint
   `POST /api/config/repair`): para arreglar el estado **sin re-escanear toda la biblioteca** (caro sobre un
   SMB que flaquea) y para **fundir duplicados** que un escaneo malo pudo dejar. Pasos, solo-lectura en disco:
   - Detecta filas **huérfanas**: su carpeta ya no existe (renombrada) pero un ancestro SÍ se lee —así se
     distingue un renombrado de una **caída del share** (ENOENT definitivo vs error transitorio; si el
     ancestro no se puede leer, la fila se deja en paz).
   - Busca el fichero por **tamaño en bytes** (desempate por nombre) dentro del ancestro legible.
   - **REBIND**: si la ruta nueva no tiene fila → actualiza la ruta de la fila existente.
   - **FUSIÓN**: si la ruta nueva ya tiene fila (duplicado ingerido por separado) → re-apunta el historial a
     esa fila, migra datos de usuario del álbum viejo al nuevo donde el nuevo no los tenga (nunca pisa lo del
     usuario), borra la fila huérfana; la poda retira luego el release/álbum viejo ya vacío.

La reparación bajo demanda imprime estadísticas: huérfanos, re-vinculados, fusiones, ambiguos, y «sin
resolver» (ficheros realmente borrados del disco, que la poda tombstone-retirará). CLI equivalente:

```bash
node data-layer/rebind.js --db app/escucharrr.db --root "\\\\Diskstation\\...\\music" --apply
```

(sin `--apply` es un *dry-run* que solo informa). Verificado con pruebas sintéticas: rebind puro repatha por
tamaño; la fusión borra el duplicado y re-apunta el historial a la fila superviviente.
