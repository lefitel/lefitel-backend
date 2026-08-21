# Generador de Reportes — estado

Punto de retomada. El diseño está en dos documentos:
[el motor de consultas](superpowers/specs/2026-08-04-generador-reportes-dinamicos-design.md)
y [la exportación en el servidor](superpowers/specs/2026-08-06-exportacion-en-servidor-design.md).

## Dónde está el trabajo

Rama **`isaias`** en los dos repos (ninguno es `master`).

Las carpetas son **`api/`** y **`web/`** —antes `backend/` y `TSfrontend/`—. Cada
una es su propio repositorio git con sus propios remotos, así que el nombre local
no lo ve nadie más: ni GitHub, ni Coolify, ni Vercel.

**346 pruebas**: 232 en `api`, 114 en `web`. Lint, typecheck y build limpios en ambos.

## Qué hay construido

**El motor** (`api/src/reportBuilder/`) — `catalog.ts` es la lista blanca y el
único sitio donde viven los nombres físicos de tabla; `sqlBuilder.ts` convierte
una configuración en SQL parametrizado y es una función pura; `execute.ts` la
ejecuta con transacción, `statement_timeout` y lectura consistente.

**La exportación** (`api/src/reportBuilder/export/`) — el archivo se genera en
el servidor, no en el navegador:

| Fichero | Qué hace |
|---|---|
| `indicators.ts` | Franja de indicadores desde la semántica. Puro |
| `rowStyle.ts` | Regla de color: resuelto gana sobre gravedad. Puro |
| `values.ts` | Formato de valores, zona horaria, nombre de fichero. Puro |
| `photos.ts` | Lectura desde `IMAGES_DIR` y compresión con `sharp` |
| `branding.ts` | Logos, comprimidos una sola vez por proceso |
| `excel.ts` / `pdf.ts` | Los dos constructores |
| `queue.ts` | Una exportación a la vez |
| `index.ts` | `buildExport()`: orquesta y devuelve bytes |

Endpoints en `/api/generador`: `catalogo`, `consulta`, `exportar`, y el CRUD de
`reportes`.

**El frontend** — `lib/reportConfig.ts` concentra las reglas como funciones puras;
`pages/menu/generador/` tiene la página y cinco componentes. Ruta `/app/generador`,
roles 1, 2 y 3. La página de Reportes anterior sigue intacta.

## Cómo levantarlo

```
cd api  && npm run dev     # 3000, Postgres local en 5434, base osefi_local
cd web  && npm run dev     # 5173
```

`npm test` en cualquiera de los dos. Las pruebas que necesitan base se saltan solas
si no responde.

Para medir la exportación con datos reales:

```
npm run bench:export -- <carpeta>        # los cinco reportes tipo, con tiempos
npm run bench:photos -- <carpeta> 3000   # genera las fotos y mide el peor caso
```

**Cuidado:** `DB_SYNC=true` reescribe el esquema y solo debe usarse contra
`osefi_local`. La configuración de producción vive en las variables de entorno de
Coolify, no en `api/.env` — ese fichero es solo desarrollo local.

## Rendimiento medido

Sobre los 1.376 eventos reales, con las 1.973 fotografías recreadas a 559 KB cada
una:

| Reporte | Peso | Tiempo | RSS |
|---|---|---|---|
| General, Excel | 96 KB | 0,5 s | 29 MB |
| General, Excel con 1.955 fotos | 1,8 MB | 8,9 s | 97 MB |
| General, PDF | 4,0 MB | 0,7 s | 2 MB |

Lo mismo en el navegador eran entre siete y trece minutos.

**Los topes se corrigieron después de medirlos.** El primero era de filas, y
dejaba pasar 20.000 × 30 columnas: **1,25 GB de RSS**, un tercio del servidor.
Tres formas distintas de 200.000 celdas cuestan la misma memoria, así que la
unidad es la celda:

| | Tope | Por qué |
|---|---|---|
| Excel | 200.000 celdas | ~475 MB de RSS, con Postgres al lado |
| PDF | 80.000 celdas | ~25 MB, el adjunto máximo de un correo |
| Ambos | 20.000 filas | Ningún reporte es un reporte a esa altura |

Un PDF de 20.000 × 60 pesaba 401 MB y tardaba 90 segundos. Ahora se rechaza con
un 413 que nombra las dos palancas: cuántas filas, cuántas columnas y cuál es el
máximo.

Para volver a medir cuando crezcan los datos: `npm run bench:export` y
`npm run bench:photos`.

## Lo que se arregló de camino

Nada de esto era del generador, pero todo le afectaba:

1. **`Dockerfile` sin `NODE_ENV`.** Cada `FROM` reinicia las variables, así que el
   contenedor arrancaba con `NODE_ENV` sin definir, y el código lee eso como
   desarrollo: **`sequelize.sync({ alter: true })` reescribía el esquema real en
   cada arranque**. Ahora `NODE_ENV=production` está en la imagen, la conexión sale
   de qué variables existen y no del nombre del entorno, y sincronizar el esquema
   exige decir `DB_SYNC=true` a mano.
2. **La migración salía del `CMD`.** Encadenada con `&&`, una migración fallida
   dejaba la API caída y el contenedor reiniciándose. Va como comando de
   pre-despliegue: si falla, aborta el despliegue y deja en pie la versión anterior.
3. **Registro de migraciones duplicado.** umzug las guardaba con extensión, así que
   la misma migración figuraba como `.ts` y como `.js` — y se ejecutó dos veces.
   Ahora el nombre no lleva extensión, y hay una normalización que arregla lo ya
   guardado sin volver a ejecutar nada.
4. **Recorrido de rutas en `DELETE /api/files/:name`.** Express decodifica `%2F` en
   los parámetros, así que un administrador podía borrar cualquier fichero del
   servidor, no solo fotografías.
5. **Salto del limitador por IPv6** en el generador: quien tuviera un prefijo podía
   gastar el presupuesto una vez por dirección.
6. **12% de las fotos no se habrían embebido.** 424 de 3.514 están guardadas como
   `images/nombre` y no como `/nombre`. Ahora se aceptan las dos formas.
7. **Un megabyte de logo en cada PDF.** jsPDF guarda el PNG descomprimido; ahora se
   reduce al tamaño al que se dibuja.
8. **Las pruebas no se lintaban ni se typecheckeaban** en el backend: `tsconfig.json`
   las excluye y nadie había creado un config aparte.
9. **`use-mobile.ts` y `use-mobile.tsx`**, idénticos, en el frontend. TypeScript
   resolvía al primero y el segundo no lo compilaba nadie.

> **Hay una auditoría de seguridad aparte y sin resolver:**
> [AUDITORIA-SEGURIDAD.md](AUDITORIA-SEGURIDAD.md). Encontró que cualquier usuario
> autenticado puede hacerse administrador con una petición, que 44 escrituras no
> tienen puerta de rol, y que varios de los números que lee el cliente están mal
> —Tiempos de Resolución da 60 días donde son 25, y Estado de la Red puede dar un
> "todo en orden" falso—. **Nada de eso está parcheado.** Leerlo antes de tocar nada.

## La auditoría del 8 de agosto

Cinco lentes adversariales sobre las 4.900 líneas de la feature. Lo arreglado va
en el commit `9248824` de `api`.

**Aguantó:** no se pudo romper la inyección SQL con más de treinta cargas
hostiles; las restricciones por rol están cerradas por los seis caminos; no hay
IDOR en los reportes guardados; la travesía de rutas en fotos está tapada; la
paginación es determinista sobre 399 configuraciones aleatorias; el conteo y la
página siempre coinciden; el constructor es puro.

**Respuestas erróneas, corregidas.** Eran lo peor: no fallaban, contestaban mal.

| Fallo | Impacto |
|---|---|
| La franja contaba grupos | "2 eventos · 1 resueltos" donde había 1.376 y 938 |
| Filtros de fecha en UTC, fechas mostradas en La Paz | 26% de los eventos en el día equivocado |
| `neq` sobre fecha comparaba un instante y `eq` el día | los dos no partían el conjunto |
| `like` no escapaba `%` ni `_` | buscar `%` devolvía todo |
| Los archivados no archivaban a sus hijos | 404 revisiones y 141 observaciones de más |
| Un total ajeno se sumaba una vez por fila | un poste con *n* eventos aportaba *n²* |

Los totales por raíz cambiaron: revisiones **7.741 → 7.337**, observaciones
**1.563 → 1.422**. Eventos sin cambio.

**Reportes que se guardaban rotos y fallaban para siempre**, porque guardar valida
construyendo el SQL y el SQL solo estaba mal cuando lo veía Postgres: 62 de las
245 rutas anunciadas (`ultimaRevision.evento.*`, la LATERAL no proyectaba la
clave del salto siguiente), y los agregados sin comprobación de tipos en toda
ruta a-muchos. El orden nunca tuvo comprobación de tipos.

**En la exportación:** `addImage` se llamaba una vez por fila y ExcelJS no
deduplica, así que una foto compartida se incrustaba una vez por fila — 38,6 MB y
425 MB de RSS donde bastaban 0,12. Un emoji al final del título daba 500 *después*
de construir el fichero. La cabecera y el nombre leían el reloj del servidor, así
que toda exportación posterior a las 20:00 en Bolivia iba fechada mañana.

**Cuatro pruebas no comprobaban lo que decían.** La que se llamaba *"refuses a
report larger than one file can hold"* afirmaba que tiene éxito; el indicador de
críticos se comprobaba con `toContain("cr")`, que casa con "Descripcion"; la foto
incrustada con `>= 1`, que satisface el logo solo; y el mensaje de cola ocupada
dentro de un `.catch` que no corre si la llamada resuelve. Ahora discriminan, con
un control al lado donde hace falta.

`sqlExecution.test.ts` es nuevo y es la red que faltaba: pasa **todas** las rutas
y **todos** los agregados del catálogo por Postgres con `EXPLAIN`. Nada más en la
suíte entregaba SQL generado a una base salvo por las pruebas que dependen de que
haya datos, y ahí se escondían las dos clases de 500 permanente.

## Para decirle a Fisher

Los reportes actuales **cuentan observaciones de eventos archivados**: 138 eventos
borrados con 141 observaciones. El generador los excluye, que es lo correcto, así
que algunos conteos le van a bajar. Mejor avisar antes de que lo note.

Y hay un segundo aviso, más gordo, **pendiente de su decisión**: «Días de
resolución» se mide desde `createdAt`, que no es cuándo se reportó el evento sino
cuándo se cargó la fila en esta base. El evento 135 ocurrió el 24/08/2025 y su
`createdAt` es del 09/04/2024 — dieciséis meses **antes** de ocurrir; 70 eventos
comparten ese mismo día de carga. Consecuencia: **426 de los 937 resueltos (45%)**
tienen su última revisión anterior a su `createdAt`, dan negativo, y el
`GREATEST(0,…)` los aplasta a cero.

| Promedio de resolución | |
|---|---|
| Desde la fecha del evento | **25 días** |
| Desde `createdAt` (lo que se muestra hoy) | ~60 días |

Solo **un** evento de 1.376 carece de fecha, así que anclar las dos columnas a
`date` no cuesta casi nada. No se ha tocado porque el número actual replica el
reporte anterior y una prueba de regresión lo exige: cambiarlo le baja la media a
menos de la mitad y tiene que saber por qué.

## Lo que queda

**Pendiente de comprobar en Coolify** (dos minutos):

1. ¿Está el Build Pack en **Nixpacks** o en **Dockerfile**? Si es Nixpacks, el
   `Dockerfile` se ignora y los arreglos 1 y 2 de arriba no llegan a producción.
2. ¿Existe `NODE_ENV=production` en las variables de la aplicación? ¿Y
   `DATABASE_URL`, o se conecta por `PG_*`? Las dos vías funcionan ahora.
3. ¿Hay un volumen persistente montado en `/images`? Si no, cada redespliegue borra
   las fotos subidas desde el anterior.

**Verificado en un navegador real** (Chrome sin interfaz, por el protocolo de
DevTools, sin añadir dependencias): la página carga con **cero errores de consola
y cero excepciones**, se arma un reporte de cuatro columnas, se genera —"Mostrando
1–100 de 1376"—, aparece el interruptor «Fotos en el Excel» cuando el reporte
tiene columnas de foto, y **se descargan el `.xlsx` y el `.pdf`**. El libro bajado
del navegador se releyó: 1.380 filas, franja «1.376 eventos · 93 …», los dos logos
incrustados y las filas resueltas en verde. La bitácora registra cada exportación
con formato, filas, bytes y el recuento de fotografías.

**Lo que la auditoría dejó abierto**, por orden de lo que un usuario choca antes:

*Frontend.* Ordenar por una columna con resumen **siempre** da 400: `toggleSort`
acepta el agregado y su único llamador nunca se lo pasa, y `validateConfig` no
mira el orden. Abrir un reporte guardado llama a `changeRoot` aunque la raíz no
cambie, y eso **destruye sus filtros avanzados**; si luego se guarda, la pérdida
se persiste — y el aviso que sale dice que fue por permisos, que es falso. Una
respuesta vieja puede aterrizar bajo otro reporte y exportar un fichero titulado
«Reporte B» con los datos de A. Un fallo al pedir la página siguiente borra la
tabla que ya estaba. Los topes de columnas y filtros se alcanzan en silencio o
avisan de un duplicado inexistente. El `memo` de las filas es inerte porque el
padre pasa funciones nuevas en cada render.

*Endurecimiento.* `MAX_CONDITIONS` se aplica por grupo y no por reporte (4.000
subconsultas en un cuerpo de 97 KB), los valores de filtro no tienen tope de
longitud, `/consulta` no tiene tope de celdas aunque `/exportar` sí, el CRUD de
reportes guardados no tiene limitador ni tope de tamaño, y cancelar una
exportación no cancela nada en el servidor: sigue construyendo y reteniendo el
hueco único.

*Deuda anterior, sigue en pie:* en `api/.env` hay una **credencial de producción
viva** — rotarla; `JWT_SECRET` es `isaiahsalah`; las fotos se sirven sin autenticar
para las etiquetas `<img>` —la exportación ya no las pide por ahí—; y
`reportGeneral.ts` y `reportTramo.ts` siguen generándose en el navegador con el
logo sin comprimir.

**Decisiones pendientes de Isaias:** anclar las dos columnas de duración a `date`
(ver el aviso a Fisher); y una migración que ponga `state` en `NOT NULL DEFAULT
false` — hoy hay 938 `true`, 438 `false` y ningún `NULL`, así que es barata y
cierra la clase entera.

## Decisiones de diseño que no conviene deshacer

- **La raíz define el grano de la fila.** Las relaciones a-uno se navegan libres; las
  de varios registros solo entran agregadas.
- **SQL generado, no `include` de Sequelize.** Las agregaciones con `group` más
  `include` producen SQL impredecible y `limit` corta filas del JOIN, no de la raíz.
- **Nada del usuario se convierte en identificador SQL.** Las rutas se buscan en el
  catálogo, los valores van por bind, los operadores son un conjunto cerrado.
- **El tramo agrupa por par de ids, no por nombre.** Hay tres ciudades con nombre
  repetido: agrupar por texto fusiona tramos distintos.
- **Los campos declaran su significado** (`semantic`), para que los exportadores no
  adivinen por una etiqueta que el usuario renombra.
- **Los indicadores cuentan filas y nombran la unidad.** Esto se escribió como
  decisión y no era cierto: agrupado por tramo decía "89 eventos", y agrupado por
  estado, "2 eventos · 1 resueltos · 1 pendientes" sobre 1.376, 938 y 438. Hoy
  dice "89 grupos" — verdadero, y menos informativo de lo que debería. Nombrar la
  entidad agrupada sigue pendiente.
- **Un valor agrupado no significa lo que significaba el campo.** El `semantic` se
  quita tanto al agregar como al agrupar. Quitarlo solo al agregar fue el corte
  equivocado y es lo que produjo la franja falsa.
- **La franja de cabecera, no una página de portada.** Es un reporte tabular, no un
  informe encuadernado.

## Concesiones conocidas

Arreglos que funcionan y no son lo que deberían ser. Anotados para que nadie los
lea como decisiones.

- **`89 grupos` en vez de `89 tramos`.** La información para nombrar la entidad
  está —la ruta de agrupación es `poste.tramo` y el catálogo sabe qué es—; se eligió
  lo que nunca miente sobre lo que informa. Es correcto y es la salida barata.
- **Un total ajeno se rechaza en vez de calcularse.** Sumar `poste.numEventos` a
  grano de evento daba *n²*, así que ahora el constructor lo refusa y el catálogo
  deja de ofrecer el resumen. El número honesto necesita contar una vez por padre,
  que es un grano que el lenguaje de configuración no sabe expresar. Es un "no"
  donde el producto quiere un "sí".
- **Las fotos se deduplican por nombre, no por fichero.** Las 424 rutas guardadas
  como `images/x` y las guardadas como `/x` apuntan al mismo archivo y siguen
  contando como dos entradas. El caso caro —muchas filas, una foto— está resuelto;
  el aliasing no.
