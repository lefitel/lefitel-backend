# Exportación de reportes en el servidor — diseño

Cierra lo que queda del contrato del generador —portada con logos, franja de
indicadores, fotografías embebidas y color por estado— moviendo la generación de
los archivos del navegador al backend.

Continúa
[`2026-08-04-generador-reportes-dinamicos-design.md`](2026-08-04-generador-reportes-dinamicos-design.md),
que describe el motor de consultas. Aquí solo se trata la salida.

## 1. Por qué se mueve al servidor

Hoy, para exportar un reporte de 1.376 filas, el navegador:

1. se descarga el resultado completo en JSON (`fetchAll()` pide `limit: total`),
2. pide **1.973 fotografías, una a una**, a la raíz estática,
3. las descomprime y recomprime con un `canvas`,
4. y arma el `.xlsx` entero en su propia memoria.

El servidor ya tiene los datos, ya tiene las fotos en disco y ya tiene `sharp`.
Mover la generación elimina las 1.973 peticiones, elimina el techo de memoria del
navegador, saca las fotos de una ruta pública para el caso de los reportes, y abre
la puerta a lo siguiente —un reporte que llega por correo cada lunes— que con
generación en el navegador es imposible.

Lo que **no** consigue: adelgazar el paquete del frontend. `exceljs` y `jspdf` se
quedan porque los reportes fijos anteriores los siguen usando (§9).

### Lo que se descartó, y por qué

**Streaming del `.xlsx` desde el servidor.** Sería el ideal: memoria constante sin
importar el tamaño. No se puede: `ExcelJS.stream.xlsx.WorkbookWriter` no admite
imágenes — `worksheet.addImage` es `undefined` en la versión 4.4.0, comprobado. No
existe ninguna librería en Node que haga streaming de xlsx con imágenes; la única
vía sería escribir el ZIP a mano, lo que produce archivos que Excel tampoco abriría
cómodamente a ese tamaño. El tope se queda, solo que ahora lo pone Excel.

**Un endpoint que devuelva las fotos por lotes al navegador.** Arreglaba las 1.973
peticiones pero dejaba el ensamblado —y el techo de memoria— en la pestaña, y
mantenía dos implementaciones del formato.

**Trabajos en segundo plano.** Correcto de verdad y necesario para reportes
programados, pero suma almacenamiento de archivos generados, consulta de estado y
limpieza. Queda fuera de este alcance; el diseño no lo estorba.

### Lo que se verificó antes de decidir

- `jsPDF` **funciona en Node** sin DOM: trae una compilación propia
  (`jspdf.node.min.js`). `jspdf-autotable` dibuja tablas con sus ganchos de estilo,
  y `addImage` acepta tanto un PNG real como un JPEG producido por `sharp`. Spike
  ejecutado, PDF válido de salida.
- La exportación se importa con nombre, no por defecto: `import { jsPDF } from "jspdf"`.
- `logo.png` son 512×512 y 196 KB, y jsPDF lo almacena descomprimido: **cada PDF que
  el sistema genera hoy lleva cerca de un megabyte de logo**. Reducido al tamaño al
  que se dibuja, son 12 KB.

## 2. Arquitectura

```
api/src/reportBuilder/export/
  indicators.ts   Franja de indicadores desde la semántica. Puro.
  rowStyle.ts     Regla de color de fila. Puro.
  photos.ts       Lectura desde IMAGES_DIR y compresión con sharp.
  branding.ts     Logos, cargados y comprimidos una sola vez.
  excel.ts        Constructor del libro.
  pdf.ts          Constructor del documento.
  queue.ts        Una exportación a la vez.
  index.ts        buildExport(): orquesta y devuelve bytes.
```

`indicators.ts` y `rowStyle.ts` no dependen de ExcelJS, de jsPDF ni de la base:
son las piezas que sobreviven a cualquier cambio de librería, y las que llevan la
lógica que de verdad puede estar mal.

El flujo completo:

```
POST /api/generador/exportar
      │
      ├─ valida el cuerpo y aplica los topes
      ├─ pide turno en la cola (una a la vez)
      ├─ runReport(config, role)          ← el mismo motor que la vista previa
      ├─ indicators(columns, rows, raíz)
      ├─ photos.load(...)                 ← solo si el formato es Excel y se piden
      ├─ excel.build(...) | pdf.build(...)
      └─ responde el binario con Content-Disposition
```

## 3. Contrato del endpoint

```
POST /api/generador/exportar
Roles 1, 2 y 3 — los mismos que el resto del módulo.

{
  "config":  ReportConfig,          // idéntico al de /consulta
  "format":  "excel" | "pdf",
  "title":   string,                // nombre del reporte, hasta 120 caracteres
  "subtitle": string | null,
  "photos":  boolean                // ignorado en PDF
}
```

Respuestas:

| Código | Cuándo | Cuerpo |
|---|---|---|
| 200 | Listo | El binario, con `Content-Disposition: attachment; filename*=UTF-8''…` |
| 400 | Configuración inválida o formato desconocido | `{ message }` |
| 413 | El reporte no cabe en un archivo (§8) | `{ message }` con filas, columnas y el tope |
| 429 | Ya hay una exportación en curso | `{ message }` |
| 500 | Cualquier otra cosa | `{ message }` genérico |

El cliente **manda la configuración, no las filas**. Así el navegador deja de
descargar 50.000 filas en JSON para volver a subirlas, y el archivo se genera
sobre una lectura consistente de la base en vez de sobre una copia que puede tener
minutos de antigüedad.

Se registra en la bitácora igual que `RUN_REPORTE`, con acción `EXPORT_REPORTE` y
el formato, el número de filas y si llevaba fotos.

### Sobre la barra de progreso

La petición es síncrona: se pide, se espera, llega el archivo. Durante la
**generación** no hay progreso real que informar —el servidor no emite nada hasta
que termina—, así que la interfaz muestra un indicador indeterminado con el tiempo
transcurrido y un botón de cancelar que aborta la petición. Durante la **descarga**
sí hay progreso real, que sale de `onDownloadProgress`.

Decirlo así es deliberado: una barra que finge avanzar mientras el servidor trabaja
miente, y cuando se queda parada en el 80% el usuario cree que se colgó.

## 4. Franja de indicadores

Se arma sola desde la semántica que el catálogo ya publica. Cuenta **filas**, y
nombra siempre la unidad correcta:

```
1.376 eventos  ·  597 resueltos  ·  779 pendientes  ·  84 críticos
91 tramos  ·  40 resueltos  ·  51 pendientes            ← el mismo reporte agrupado
```

| Indicador | Cuándo aparece | Qué cuenta |
|---|---|---|
| Total | Siempre | Filas, nombradas con el sustantivo de la raíz |
| Resueltos / Pendientes | Hay columna con `semantic: "state"` | Filas donde el estado es cierto / falso |
| Críticos | Hay columna con `semantic: "criticality"` | Filas con nivel 1, 2 o 3 |

Decisiones y sus porqués:

- **Nivel 1 a 3 es "crítico"**: Catastrófico, Ferretería suelta y Sujeto a árbol,
  que son exactamente los tres que la aplicación ya pinta en rojo, naranja y ámbar
  (`web/src/lib/criticality.ts`). El umbral vive
  en una constante nombrada, no suelto en una comparación.
- **Cuenta filas, no entidades.** Si el reporte agrupa por tramo, "40 resueltos"
  son cuarenta tramos cuya columna de estado dice resuelto. Es literalmente cierto
  mientras el sustantivo sea el correcto, y por eso el sustantivo es obligatorio.
- **Las columnas agregadas no cuentan.** El motor ya borra la semántica de una
  columna con `agg` ([`sqlBuilder.ts:736`](../../src/reportBuilder/sqlBuilder.ts)),
  así que un promedio no puede colarse como si fuera un estado.
- **Sin columnas reconocibles, solo el total.** No se inventa un indicador.

El sustantivo sale de un mapa `ROW_NOUN` junto a `ROW_MEANING` en `catalogView.ts`
(`evento → eventos`, `poste → postes`, …), con respaldo a la etiqueta de la entidad
en minúsculas.

## 5. Color de fila

Una regla de prioridad explícita, que hoy no existe:

| Situación | Color |
|---|---|
| Hay columna de estado y la fila está resuelta | Verde |
| Si no, hay columna de criticidad | Escala 1–9 actual |
| Si no | Bandas alternas |

Es la misma jerarquía que ya aplica `reportGeneral.ts` —resuelto gana sobre
gravedad— para que Fisher no vea dos criterios distintos según el reporte. Se
aplica igual en Excel y en PDF, y la leyenda acompaña a la franja.

Que un evento crítico ya resuelto salga verde es intencionado: la pregunta que
responde el color es "¿esto necesita a alguien?", no "¿qué tan grave fue?".

## 6. Cabecera

Franja superior, no página de portada: es un reporte tabular, no un informe
encuadernado, y una hoja de portada delante de una sola página de datos se ve
pretenciosa. Es además lo que hacen Power BI paginado, Crystal Reports y Metabase.

- **Primera página**: logos Osefi y Tigo, título, subtítulo e indicadores.
- **Siguientes**: banda fina con logo, título y "parte N de M".
- **Excel**: filas 1 a 3 congeladas con los logos superpuestos, como `reportGeneral`.

Los logos son Osefi y Tigo, fijos. `logo_entel.png` y `logo_viva.png` existen en el
frontend pero no los usa nadie, y los propietarios de los postes en la base son
eléctricas (Cre, Elfec, Ende, Delapaz…), no operadores: no hay un logo que dependa
de los datos.

Los ficheros se copian a `api/src/assets/` y se comprimen **una sola vez al
arrancar**, no por documento. `tsc` no copia recursos, así que el `build` gana un
paso: `scripts/copy-assets.mjs`.

## 7. Fotografías

Solo en Excel. En el PDF siguen siendo "Sí": dos mil fotos en un documento tabular
pesan y no se leen.

**Lectura.** Desde `IMAGES_DIR`, con `sharp`: redimensionar a 160 px de lado mayor y
convertir a JPEG con calidad 65 — los mismos números que usa hoy `reportGeneral`.
`sharp` además convierte los `.webp` guardados en la base, que ExcelJS no admite.

**Seguridad de rutas.** El valor que viene de la base es un nombre de fichero, y
nunca se concatena a ciegas:

1. Se le quitan las barras iniciales.
2. Se rechaza cualquier resto que contenga `/`, `\` o `..`.
3. Se resuelve la ruta y se comprueba que sigue dentro de `IMAGES_DIR`.

Una foto que no exista, no se pueda leer o no sea una imagen no rompe la
exportación: esa celda sale como "Sí" y se sigue.

**Topes.** `MAX_EXPORT_PHOTOS = 3.000`, por encima del peor caso real de hoy
(1.973 = 1.376 eventos + 597 soluciones). Pasado el tope, el resto sale como texto
y el subtítulo lo dice. Concurrencia de lectura limitada a 8 ficheros a la vez, para
no ahogar el disco ni el pool de `sharp`.

## 8. Cola y topes

El servidor tiene 4 GB **compartidos con Postgres**, y ExcelJS arma el libro entero
en memoria. Sin control, dos exportaciones grandes a la vez tumban la API para
todos.

**El tope no es de filas, es de celdas**, y es distinto para cada formato. Medido
con un proceso limpio por caso:

| Excel | peso | tiempo | RSS |
|---|---|---|---|
| 20.000 × 10 | 1,1 MB | 3,1 s | 446 MB |
| 10.000 × 20 | 1,1 MB | 3,1 s | 474 MB |
| 5.000 × 40 | 1,1 MB | 3,4 s | 475 MB |
| 20.000 × 30 | 3,4 MB | 9,0 s | **1,25 GB** |

Tres formas distintas de 200.000 celdas caen en la misma memoria: por eso la
unidad honesta es la celda y no la fila. Un tope solo de filas dejaba pasar
20.000 × 30 y se comía un tercio del servidor.

| PDF | peso | tiempo |
|---|---|---|
| 5.000 × 10 | 15,1 MB | 3,6 s |
| 10.000 × 10 | 30,1 MB | 6,5 s |
| 20.000 × 60 | **401 MB** | 89,6 s |

El PDF es barato en memoria —135 MB constantes— pero cuesta unos 0,3 MB de
archivo por cada mil celdas. Ahí no manda el servidor sino quien lo recibe:
80.000 celdas son unos 25 MB, el adjunto más grande que aceptan la mayoría de
servidores de correo.

| Constante | Valor | Por qué |
|---|---|---|
| `MAX_EXPORT_ROWS` | 20.000 | Ningún reporte es un reporte a esa altura |
| `MAX_EXPORT_CELLS.excel` | 200.000 | ~475 MB de RSS, con Postgres al lado |
| `MAX_EXPORT_CELLS.pdf` | 80.000 | ~25 MB, el límite de un adjunto |
| `MAX_EXPORT_PHOTOS` | 3.000 | Peor caso real 1.973, con margen |
| `EXPORT_CONCURRENCY` | 1 | Una a la vez |
| `PHOTO_READ_CONCURRENCY` | 8 | Lectura de disco y `sharp` |

El mensaje del 413 nombra **las dos palancas**, porque el límite tiene dos: decirle
a alguien con sesenta columnas que "filtre filas" lo manda a arreglar lo que no es.

Si llega una segunda petición mientras hay una en curso, se responde **429 con un
mensaje claro**, no se encola en silencio: una espera invisible de dos minutos se
parece demasiado a que el sistema se colgó.

Superar cualquiera de los topes devuelve **413** con los números concretos —filas,
columnas, celdas y el máximo— para que el usuario sepa qué reducir. No se trunca
sin avisar.

## 9. Qué desaparece del frontend

- `src/lib/exports/dynamicExcel.ts` y `dynamicPdf.ts`, unas 360 líneas.
- `fetchAll()`, que dejaba de tener sentido.

**Las dependencias se quedan.** `exceljs`, `jspdf`, `jspdf-autotable` y
`file-saver` las siguen usando `reportGeneral.ts`, `reportTramo.ts`,
`SeguridadPage.tsx` y las páginas de evento y poste. El paquete que descarga el
usuario no baja: el beneficio de este trabajo es de memoria, de peticiones y de
mantenimiento, no de tamaño. Solo bajaría si los reportes fijos se mudaran también,
y eso no entra aquí.

Lo que se queda además: `formatValue` y `reportConfig.ts`, que la vista previa usa.

`reportFileName` y `toZonedExcelDate` se mudan al backend con sus pruebas: la
lógica de nombre de fichero y de zona horaria es la misma, y estaba bien resuelta.

Los reportes fijos anteriores (`reportGeneral`, `reportTramo`) **no se tocan** en
este alcance, aunque se beneficiarían del mismo tratamiento del logo.

## 10. Pruebas

**Puras, sin base de datos ni ficheros** — el grueso:

- `indicators`: sin semántica solo total; estado presente; criticidad presente;
  ambas; agrupado con sustantivo distinto; columna agregada ignorada; cero filas.
- `rowStyle`: estado gana sobre criticidad; criticidad sin estado; bandas sin
  ninguna; criticidad fuera de rango; valores nulos.
- Nombre de fichero y fecha en zona: las pruebas actuales se mudan tal cual.

**Con ficheros temporales**:

- `photos`: nombre válido; nombre con `..`; nombre absoluto; fichero inexistente;
  fichero que no es imagen; tope alcanzado.

**Con base de datos** (`describe.skipIf` como las de regresión):

- Exportación completa a Excel y a PDF sobre datos reales, releyendo el `.xlsx`
  con ExcelJS para comprobar la franja, la cabecera y el color.
- 413 al superar el tope de filas, 429 con la cola ocupada.

## 11. Medido

Sobre `osefi_local` con los 1.376 eventos reales, y con las 1.973 fotografías
recreadas en disco bajo los nombres que la base guarda, a 559 KB cada una —por
encima de una foto de campo típica:

| Reporte | Filas | Peso | Tiempo | RSS sobre la base |
|---|---|---|---|---|
| General, Excel sin fotos | 1.376 | 96 KB | 0,5 s | 29 MB |
| General, Excel con 1.955 fotos | 1.376 | 1,8 MB | 8,9 s | 97 MB |
| General, PDF | 1.376 | 4,0 MB | 0,7 s | 2 MB |
| Por tramo, Excel | 89 | 26 KB | 0,1 s | 5 MB |
| Por tramo, PDF | 89 | 187 KB | 0,1 s | 0,4 MB |

Los topes quedan holgados: el peor caso real cuesta menos de 100 MB por encima
de la base y termina en nueve segundos. En el navegador, lo mismo eran entre
siete y trece minutos de pestaña inutilizable.

## 12. Riesgos

- **Tiempo de respuesta.** Nueve segundos no preocupan a ningún proxy, pero un
  reporte de 20.000 filas con fotografías se acercaría al minuto, y el límite por
  defecto de muchos proxies es exactamente ese. Hay que comprobarlo en Coolify con
  un reporte grande; si molesta, la salida es el trabajo en segundo plano que este
  diseño deja preparado.
- **`/images` en producción.** Todo esto lee de `IMAGES_DIR`. Si Coolify no tiene un
  volumen persistente montado ahí, las fotos ya se están perdiendo en cada
  redespliegue, con o sin este trabajo.
- **El formato guardado no es uno solo.** 3.090 fotografías están registradas como
  `/nombre` y 424 como `images/nombre`. El resolutor acepta las dos, y hay pruebas
  de ello: rechazar el segundo formato habría dejado fuera al 12% de las imágenes
  sin decir nada.

## 13. Lo que no entra

- Trabajos en segundo plano y reportes programados.
- Fotografías en el PDF.
- Indicadores definidos por el usuario. La franja se deriva de la semántica; un
  panel donde el usuario arme los suyos es una funcionalidad aparte.
- Portada como página independiente.
- Migrar `reportGeneral.ts` y `reportTramo.ts` al servidor.
