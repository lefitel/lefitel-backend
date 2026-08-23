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
viva** — rotarla; **`JWT_SECRET` es una sola palabra en minúsculas con forma de
nombre propio, y su valor estuvo escrito aquí en claro y sigue en el historial de
git** (ver el aviso de rotación en la sección 11 del diseño de autenticación); las
fotos se sirven sin autenticar
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


## Auditoría del 21 de agosto y lo que se arregló

Cinco lentes adversariales sobre el flujo completo del generador: el estado del
frontend, la autorización, el motor SQL, la exportación y las costuras entre
navegador y servidor. **Las 331 pruebas de `api` y las 122 de `web` pasaban con
todo lo de abajo roto**, que es el hallazgo de fondo: casi todo se comprobaba
contra subcadenas del SQL generado o contra el nombre de una función, no contra
filas ni contra el fichero producido.

Ahora son **348 en `api` y 144 en `web`**, con typecheck y lint limpios en los
dos. Cada arreglo lleva una prueba que falla sin él; las dos del frontend se
verificaron desactivando el arreglo y viéndolas caer.

### Números falsos — lo que contestaba mal sin fallar

**El límite del día caía ocho horas antes.** `$1::date AT TIME ZONE 'zone'` no
hace lo que parece: `AT TIME ZONE` tiene dos versiones y Postgres, ante un
`date`, elige la que *convierte un instante a hora local* en vez de la que *lee
una hora local como instante*. Con la sesión en UTC el límite inferior quedaba en
las 20:00 del día anterior, así que «los eventos del 17/01/2026» devolvía **63
donde ocurrieron 4**, y un filtro de un día abarcaba 32 horas desde las 16:00 del
día anterior. Afectaba a `eq`, a `neq` y al extremo inferior de todo `between`.
El arreglo es un `::timestamp` antes del operador. La prueba que llevaba el
nombre exacto del fallo —*"reads a bare date in the zone the report is read in"*—
comprobaba que la cadena `AT TIME ZONE 'America/La_Paz'` estuviera en el SQL, y
estaba: pasaba encima del error. Ahora hay una prueba que ejecuta contra Postgres
y compara con el calendario, y otra que fija el instante bajo tres zonas de
sesión distintas.

**`gte` y `lt` no trataban la fecha en absoluto.** Caían a un `default` que
ignoraba el tipo del campo, cuatro horas de desfase, e incoherentes con sus
propias parejas: `lte` cubría el día entero y `lt` no. «Desde el 17» devolvía 225
donde son 195. El `default` ahora lanza en vez de construir SQL con un operador
que nadie listó.

**Contar hijos a través de un padre multiplicaba.** La guarda anterior solo
miraba los campos calculados, así que `poste.numEventos` se rechazaba y
`poste.eventos` con conteo se aceptaba: **1.390 eventos donde hay 1.376**, y
agrupando revisiones por estado **91.195 donde hay 7.337**. La regla correcta no
es rechazarlo siempre —un total del padre es cierto por fila— sino rechazarlo
donde se aplica: al resumir por grupo. En modo detalle sigue disponible, que es
lo que un usuario quiere ver.

**Ordenar por uno de esos totales mentía solo en el orden.** El bucle de
ordenación no tenía la guarda. En «los tramos con más revisiones» solo tres de
los ocho primeros puestos eran correctos, con el número bueno en la columna de al
lado. Es la peor forma del fallo porque nada en pantalla lo contradice.

**Los valores de filtro no se comprobaban contra el tipo del campo.** Nueve
formas —`{}`, `[1,2]`, texto en un número, «si» en un booleano— construían SQL
válido y reventaban en Postgres. Como guardar un reporte valida construyendo ese
mismo SQL, se guardaban limpias y fallaban en cada ejecución, para siempre, con
un 500 que parece del servidor. Ahora se rechazan al construir, con el texto que
explica qué necesita el campo.

### Caídas y abusos

**Un fallo de la consulta de permisos tumbaba el proceso.** Las puertas son
`async` y Express 4 solo recoge lo que se lanza de forma síncrona: la promesa
rechazada se perdía y Node termina el proceso por eso. Alcanzable desde cualquier
cuenta con sesión, y como la matriz se cachea tras una sola promesa compartida,
un fallo rechazaba todas las comprobaciones a la vez. Ahora responde 500 y falla
cerrado, y hay una red de último recurso en `index.ts` que deja escrito qué mató
al proceso en vez de un stack pelado.

**`/consulta` no tenía tope de celdas ni cola**: 50.000 filas × 60 columnas son
tres millones de celdas en un JSON, quince veces el tope que sí tiene el Excel.
Ahora hay un tope de 300.000 celdas, comprobado antes de leer las filas.

**El tope de filtros era por grupo y el mensaje decía «por reporte»**: cien
grupos de cien condiciones pasaban limpios. Ahora se cuenta el árbol entero.

**`offset` tenía suelo y no techo**: `1e21` se aceptaba, Postgres lo rechazaba
como bigint inválido y el error volvía como 500 con línea en el log.

### Lo que rompía en la cara del usuario

**El filtro «está en la lista» se comía las comas.** El texto se derivaba de la
lista, y la lista descarta el trozo vacío que crea la coma final —correctamente—,
así que React reescribía el valor sin ella. `poste,cable` quedaba en
`postecable`: cero filas y un aviso diciendo que nada coincide con un filtro que
nadie construyó. Solo funcionaba pegando. Ahora el texto se guarda y la lista se
deriva de él.

**El botón de ordenar producía un 400 en todo reporte agrupado.** `toggleSort`
aceptaba el resumen desde la primera versión y ningún llamador se lo pasaba
nunca. Además el orden se identificaba solo por la ruta, así que el mínimo y el
máximo de la misma fecha eran un solo criterio. Y `validateConfig` no miraba el
orden en absoluto, así que no avisaba antes de pedirlo.

**Una respuesta abandonada aterrizaba sobre el reporte que la reemplazó.** `run`
retiraba sus propias peticiones y nada más lo hacía: abrir otro reporte guardado
mientras uno se generaba dejaba entrar la respuesta vieja. Las filas de A bajo el
nombre de B, y exportar entonces daba un fichero **titulado B con los datos de
A** — justo lo que el comentario del subtítulo argumenta que no debe pasar.

**Abrir un reporte guardado destruía sus filtros avanzados.** Pasaba por
`changeRoot` aunque el nivel de detalle no cambiara, y `changeRoot` borraba todo
`exists` y todo grupo anidado por principio. El reporte se ensanchaba en
silencio, el aviso culpaba al perfil del lector, y pulsar «Actualizar» escribía
la pérdida en la base para el autor y para todos los que lo tuvieran compartido.
Ahora hay `pruneToCatalog`, que conserva lo disponible y descarta un filtro
avanzado entero o nada —quitarle una cláusula a una frase no la estrecha, cambia
lo que dice—.

**Un fallo al paginar borraba la tabla** y dejaba muertos los botones de
exportar. Limpiar es correcto al Generar y no al pasar de página: el fallo suele
ser pasajero y la página que ya estaba sigue siendo verdad.

**Los topes mentían**: a 60 columnas decía «ya está en el reporte»; a 100 filtros
y a 10 criterios de orden no decía nada. Los tres avisan ahora, y dicen cuál es
el tope.

**Avisos disparados dentro de un `setConfig`**, que React invoca dos veces en
desarrollo a propósito: salían por duplicado, y en render concurrente eso deja de
ser una cortesía de desarrollo.

**El `memo` de las filas era inerte** porque el padre creaba funciones nuevas en
cada render: sesenta filas con sus `Select` se reconciliaban en cada tecla, que
es exactamente el medio segundo por pulsación que el `memo` existía para quitar.

**`sameQuery` comparaba con `JSON.stringify`**, sensible al orden de las claves,
así que poner un resumen y devolverlo al anterior anunciaba «cambió la
configuración» sobre una tabla idéntica. Un aviso que grita en falso es un aviso
que nadie lee — y ese es el que avisa de que las filas ya no cuadran con la
cabecera.

**El Excel prometía fotos y no las llevaba, sin decirlo.** El contador de
omitidas solo contaba las que pasan del tope: una foto que no se puede leer no la
contaba nadie. Pedir 1.376 y recibir un fichero de 37 KB con ninguna parecía una
exportación correcta. Ahora se cuentan aparte y el subtítulo del fichero lo dice.
La prueba que debía cogerlo —*"survives asking for photographs that are not on
this machine"*— nunca leía una celda; ahora abre el libro y lo comprueba.

### Permisos: lo de la matriz quedó a medias y se completó en parte

**Las rutas del frontend seguían con listas de roles a mano** mientras el menú ya
decidía por la matriz, y discrepaban en las dos direcciones: quitar
`generador.ver` a un rol escondía el menú y dejaba la URL viva —la pantalla
montaba, el catálogo devolvía 403 y se ofrecía «Reintentar» para una negativa
permanente—; y un rol nuevo creado desde Seguridad quedaba con la barra lateral
dibujada y el contenido en blanco. `RoleRoute` es ahora `ModuleRoute` y pregunta
a la matriz.

**La pantalla del generador no consultaba la matriz**: Guardar, Actualizar,
Duplicar, Estrella y Eliminar se dibujaban siempre y el servidor contestaba 403 a
quien pulsara. Hoy coincidía porque los tres roles sembrados lo tienen todo; se
rompía a la primera casilla que destildaras, que es para lo que existe esa
pantalla.

**Marcar un favorito revalidaba la configuración guardada entera.** Un `{favorite:
true}` reconstruía el SQL, así que un reporte con una etiqueta escrita antes del
tope de 120 caracteres, o de un autor al que le bajaron el rol, dejaba de poder
renombrarse, compartirse ni desmarcarse. Solo se revalida cuando la petición trae
configuración.

## Lo que la auditoría dejó abierto

Por orden de gravedad, y ninguno tocado todavía:

1. **El rol 2 saca el directorio de personal por el generador.** `catalog.ts`
   tiene `STAFF_ONLY = [1, 2]` escrito a mano, mientras la matriz dice que ese
   rol no tiene `seguridad.ver`. `GET /usuario` le responde 403 y el generador le
   devuelve nombres, **usuarios de login** y teléfonos. El arreglo honesto es que
   la visibilidad de campo deje de ser una lista de roles y pase a resolverse
   contra la matriz — el constructor es una función pura y recibe un número de
   rol, así que hay que pasarle las capacidades ya resueltas.
2. **Cancelar una exportación no cancela nada.** El servidor sigue construyendo y
   reteniendo el único hueco del proceso; el siguiente lee «ya hay una
   exportación en curso» sin saber que es la suya. No hay ni abort ni plazo.
3. **`POST /reportes` no tiene limitador** —el comentario dice que comparte «el
   global», que no existe— y `getReportes` no pagina.
4. **Los 403 del generador no dejan rastro** en la bitácora, y ninguna de sus
   entradas guarda IP, mientras el resto del sistema sí.
5. **La configuración de un reporte compartido enseña rutas que el catálogo
   esconde** a quien lo lista, literales de filtro incluidos.
6. **Duplicar falla donde Abrir limpia**: 400 con una ruta interna a la vista,
   sobre un reporte que la pantalla acaba de mostrar.
7. **`ADMIN_ROLE = 1` a mano** para moderar reportes ajenos: no se puede conceder
   ni revocar desde Seguridad.
8. **El token que se renueva en cada respuesta no refresca rol ni permisos** en
   el cliente, así que un cambio de rol a mitad de sesión es invisible hasta
   recargar.
9. **El tope del PDF cuenta celdas y promete megabytes**: 80.000 celdas con
   columnas de texto largo dan 32,9 MB, un 32% por encima del límite de correo
   que justifica el tope.
10. **Cada exportación ejecuta la consulta de conteo dos veces**, en dos
    transacciones, y la que decide si cabe no sale del mismo snapshot que las
    filas.
11. **`diasAbierto` convierte «no se sabe» en 0** —`GREATEST(0, NULL)` es 0—, el
    mismo fallo que el campo de al lado corrige y documenta. Hoy no se observa:
    haría falta un evento pendiente sin fecha.
12. Menores: el título del PDF se solapa con el subtítulo pasados ~99 caracteres;
    el PDF colorea filas y no tiene leyenda; `PreviewTable` puede mostrar tres
    hechos que se contradicen si los datos cambian entre páginas; `catalog.limits`
    se publica para que los topes no se dupliquen y se duplican igual a mano; las
    fotos se deduplican por nombre y no por fichero; `buildCountQuery` no
    deduplica `groupBy` y `buildQuery` sí.

**Pruebas cuyo nombre promete más que su cuerpo:** quedan varias señaladas por la
auditoría y sin tocar —el numerado de páginas del PDF, el peso del logo, la
privacidad del listado de reportes, y el hecho de que `routeGuards.test.ts`
compara nombres de función y no distingue `("generador","ver")` de
`("generador","archivar")`—.


## Segunda auditoría: sobre los arreglos de la primera

Tres lentes más, esta vez con el encargo explícito de **romper lo que se acababa
de cambiar**. Encontraron nueve defectos nuevos, cinco de ellos introducidos por
los propios arreglos. Vale la pena decirlo así de claro: la primera tanda cerró
quince fallos y abrió cinco.

### Regresiones que había metido yo

**«Generar» se quedaba muerto para el resto de la sesión.** `run` solo baja el
indicador de «cargando» cuando la petición que vuelve sigue siendo la vigente —
lo cual era seguro mientras `run` era el único que tocaba el contador. El
`retireInFlight` nuevo lo subía sin lanzar ninguna petición, así que la respuesta
abandonada volvía, se descartaba, y nadie bajaba el indicador. Abrir otro reporte
o cambiar el nivel de detalle mientras algo se generaba dejaba el botón
deshabilitado sin vuelta atrás.

**Refusé consultas que estaban bien.** Marcar como «grano ajeno» toda ruta
to-many alcanzada a través de una relación es correcto para `suma` y `conteo`, y
falso para `mínimo` y `máximo`: el máximo de un valor repetido diez veces es ese
valor. Reportes que devolvían el número correcto pasaron a ser imposibles. La
regla ahora distingue qué agregados corrompe de verdad un grano ajeno.

**`die()` dejaba la API sirviendo dos segundos con la base ya cerrada.** Los
manejadores nuevos de `unhandledRejection` cierran Sequelize y arman una salida
diferida, pero no paraban el listener: durante ese margen toda petición entrante
se aceptaba y se contestaba con un 500, y a las que ya estaban en vuelo se les
arrancaba la transacción por debajo. Antes de esto Node mataba el proceso al
instante — feo, y al menos honesto. Ahora se deja de aceptar antes de cerrar.

**El tope de celdas medía el límite pedido, no el que se iba a usar.** Pedir un
millón de filas de una columna se rechazaba citando un millón de celdas, cuando
el constructor habría recortado a 50.000. Y el tamaño se comprobaba antes de
validar, así que un campo inexistente salía como «demasiadas celdas, quite
columnas» — exactamente la inversión que la exportación ya tenía corregida.

**Borrar un carácter fundía dos valores del filtro de lista.** El texto se
readoptaba desde la configuración cuando ambos diferían, y `"uno, d"` menos una
letra difiere de `"uno"`: la caja se reescribía desde la lista y se llevaba el
separador. La misma forma del fallo original, alcanzada editando en vez de
escribiendo.

### Lo que estaba mal desde antes y ahora también se arregló

**Escritura de ficheros arbitraria por `POST /api/upload`.** El nombre subido
entraba en la ruta de destino por concatenación, sin sanear: subir con el nombre
`../../../tmp/pwn.png` escribía fuera del directorio de imágenes. La ruta lleva
autenticación y nada más, así que cualquier cuenta con sesión podía hacerlo. La
lectura se había endurecido hace meses —`%2F` en un parámetro dejaba borrar
cualquier fichero del servidor— y al escritor no lo tocó nadie. Ahora el nombre
lo pone el servidor y `resolveImagePath` tiene la última palabra.

**El `SUM` de un valor del padre multiplicaba.** La guarda solo miraba los
campos calculados que ya eran un conteo, así que `SUM(evento.diasAbierto)` sobre
revisiones devolvía **1.026.699 donde el número honesto es 103.323**. Diez veces,
bajo una cabecera que no nombra ningún grano. Ahora el catálogo deja de ofrecer
`suma` en cualquier campo alcanzado a través de una relación, y el constructor la
rechaza si llega igual.

**El orden aceptaba en silencio un resumen que luego tiraba.** Una columna con
`suma` en modo detalle se rechaza; el mismo `suma` en el orden se aceptaba y se
descartaba, así que el ranking salía por un número distinto del pedido y sin
ninguna cabecera que enseñe la fórmula.

**Un nodo de filtro mal formado tumbaba el abrir.** El podador nuevo leía `.path`
de cualquier cosa, así que un `null` en la lista lanzaba dentro del manejador del
clic: el reporte no se abría, no salía aviso, y la fila parecía muerta.

**Agrupar dejaba el orden desincronizado**, `setColumnAgg` con «sin resumen» se
quedaba con el agregado viejo en el criterio, y la validación del orden rechazaba
rutas que sí son columnas válidas — las tres, formas de que la flecha diga una
cosa y la configuración diga otra.

**Quien tuviera `crear` pero no `editar` se quedaba sin ningún botón de guardar**
en cuanto abría un reporte propio.

**Y varias pruebas mías eran decorativas**, dicho por el auditor y con razón: la
que elegía «el día con más eventos» escogía uno donde las dos lecturas coinciden,
la que comprobaba la partición pasaba igual con el fallo puesto —ambos operadores
compartían el límite roto—, y la de las zonas horarias no llamaba al constructor:
comprobaba una propiedad de Postgres y habría seguido verde con el código
revertido. Reescritas para que muerdan.

### Verificación

**357 pruebas en `api`, 22 ficheros. 144 en `web`.** Typecheck y lint limpios en
los dos, pruebas incluidas.

### Lo que sigue abierto de esta segunda ronda

1. **`checkValue` decide con el número convertido y liga el texto original**, así
   que `2.5` sobre una columna entera —escribible desde la propia pantalla, en
   «Criticidad ≤»— sigue dando 500. Doce formas más viven ahí, fechas
   imposibles incluidas (`2026-02-30`). Lo honesto es ligar el número convertido,
   exigir el formato de fecha con ida y vuelta, y mapear la clase 22 de Postgres
   a un 400 en vez de un 500.
2. **`null` dentro de una lista `in` o de un `between`** construye SQL válido y
   devuelve cero filas sin decir nada.
3. **El tope de filtros del cliente cuenta solo el primer nivel** mientras el
   servidor cuenta el árbol, así que el aviso local no salta antes del rechazo.
4. **`postConsulta` y `putReporte` siguen sin pruebas propias**, y `src/index.ts`
   está excluido de la cobertura: los tres arreglos de esta ronda que viven ahí
   se pueden borrar sin que la suite se entere.
5. **`logger.test.ts` falla en arranque en frío** —cinco segundos— porque
   `import` de pino y pino-pretty lanza `chcp.com` de forma síncrona por worker.
   `npm test` no es determinista con la caché vacía.


## Por dónde se sigue (21 de agosto, fin de sesión)

Estado en git: `api` en `6a4c428`, `web` en `a0713b6`, los dos en la rama
`isaias` y sin subir. **357 pruebas en `api`, 144 en `web`**, typecheck y lint
limpios en ambos. Fuera del commit, sin tocar, quedan dos ficheros de Isaias:
`docs/specs/2026-08-21-autenticacion-mfa-design.md` y la carpeta `docs/plans/`.

**El generador no está listo.** Funciona y contesta bien donde antes contestaba
mal, pero quedan dos cosas que sí bloquean, y falta que la pantalla se use de
verdad — dos rondas de auditoría no son eso.

### Bloqueante 1: un decimal en un filtro numérico da 500

`api/src/reportBuilder/sqlBuilder.ts`, función `checkValue`. Decide con el
número convertido (`Number(String(value).trim())`) y el `switch` de abajo liga
**el valor original**, así que `2.5` pasa la validación y Postgres lo rechaza con
`22P02` sobre una columna entera. Se llega tecleando, en «Criticidad ≤». Doce
formas más viven ahí: `"1e5"`, `"7."`, `"3.0"` dentro de un `in`, y fechas que
`new Date()` acepta rodando el calendario (`2026-02-30`, `"2026"`).

Tres pasos, en este orden:

1. **Ligar el número convertido, no el texto.** `checkValue` solo valida hoy; hay
   que devolver el valor normalizado y usarlo en el bind. Eso arregla `1e5`,
   `7.` y `3.0`.
2. **Fecha con ida y vuelta**: exigir `/^\d{4}-\d{2}-\d{2}$/` y comprobar que
   `new Date(v).toISOString().slice(0,10) === v`, que es lo que descarta el 30 de
   febrero.
3. **Red final en `handleError`** (`api/src/controllers/generador.controller.ts`):
   mapear la clase `22` de SQLSTATE a un 400 con un texto legible. Hoy solo
   reconoce `57014` y todo lo demás sale como 500 «no se pudo generar el
   reporte», que se lee como servidor roto. Esto cubre las formas que no se
   hayan pensado.

`2.5` sobre una columna entera **no** se arregla con el paso 1 —el catálogo no
distingue entero de decimal—, así que su salida honesta es el paso 3: un 400 que
diga que el campo no admite decimales.

### Bloqueante 2: el rol 2 lee el directorio de personal por el generador

`api/src/reportBuilder/catalog.ts`, `const STAFF_ONLY = [1, 2]`, y el espejo
`STAFF_ROLES` en `api/src/controllers/generador.controller.ts`. La matriz dice
que el rol 2 no tiene `seguridad.ver` —comprobado en `osefi_local`— y
`GET /usuario` le responde 403, mientras el generador le devuelve nombres,
apellidos, **usuarios de login**, teléfonos y el nombre del rol.

No es un parche de una línea: `buildQuery` es una función pura y recibe un
`role: number`, y la respuesta a «¿puede ver datos personales?» ahora vive en una
tabla y es asíncrona. La forma correcta:

1. Un tipo `Viewer { role: number; staff: boolean }`. `staff` se resuelve una
   sola vez por petición con `can(role, "seguridad", "ver")`.
2. El catálogo deja de declarar `roles: STAFF_ONLY` en los campos y declara que
   son de personal (`staffOnly: true`); `isVisible` pasa a mirar el `Viewer`.
3. Los cinco puntos de entrada —`buildQuery`, `buildCountQuery`,
   `buildCatalogView`, `runReport`/`countReport` y `buildExport`— reciben
   `Viewer` en vez de un número. Aceptar `number | Viewer` en el constructor
   ahorra tocar cientos de líneas de pruebas; lo que **no** debe existir es un
   camino de producción que pase un número, porque el respaldo silencioso es la
   fuga otra vez.
4. `ADMIN_ROLE = 1` en el controlador (quién archiva reportes ajenos) es la misma
   clase de literal y conviene resolverlo en el mismo viaje.

Media jornada las dos cosas. Después de eso, **que Isaias use la pantalla** antes
de considerarla lista para Fisher.

### Lo que conviene probar a mano cuando se pruebe

Un filtro de fecha de un día contra la pantalla de Eventos; agrupar por tramo con
un conteo e intentar ordenar por «Nº de eventos del poste» (debe negarse con una
frase); escribir `poste,cable` a mano en «está en la lista»; ordenar una columna
en un reporte agrupado; abrir un reporte guardado y comprobar que no pierde
filtros; y darle a Siguiente hasta que salte el límite de 30 por minuto — la
tabla debe quedarse donde está.

Aviso para esa prueba: `IMAGES_DIR` apunta a `C:/images`, que tiene 17 ficheros
frente a las 1.514 fotos que referencia la base. Marcar «Fotos en el Excel» va a
salir sin fotos —y ahora el subtítulo del fichero lo dice—; eso es la máquina, no
el código.


## Tercera tanda: los dos bloqueantes y la lista de abiertos, cerrada

La sesión del 21 de agosto por la tarde. No es una auditoría nueva: es ejecutar
lo que las dos anteriores dejaron escrito. Los dos bloqueantes y los quince
hallazgos abiertos, uno por uno, cada uno con una prueba que falla sin el
arreglo.

**427 pruebas en `api` (27 ficheros), 164 en `web` (8 ficheros).** Typecheck y
lint limpios en los dos, pruebas incluidas.

### Bloqueante 1: un decimal en un filtro ya no da 500

Tres pasos, los tres puestos.

**Se liga lo que se valida.** `checkValue` juzgaba el texto convirtiéndolo a
número y después ligaba el texto. `normalizeValue` devuelve el valor normalizado
y ese es el que va al bind, así que `"1e5"`, `"7."`, `" 42 "` y `"3.0"` llegan a
Postgres como números. Un booleano escrito `"false"` llega como `false`.

**El catálogo sabe qué columna admite decimales.** Comprobado contra
`osefi_local`: de las 31 columnas numéricas que toca el catálogo, exactamente
cuatro son decimales — `lat` y `lng` de ciudad y de poste. Se declaran con
`decimals: true` y todo lo demás rechaza un decimal con una frase que nombra el
campo, en vez de un 22P02 que sale como «no se pudo generar el reporte». Es la
respuesta honesta a `2.5` en «Criticidad ≤», que era el camino por el que se
llegaba tecleando.

**Fechas que existen de verdad.** `new Date("2026-02-30")` es el 2 de marzo:
JavaScript no rechaza un día imposible, lo rueda al mes siguiente. Ahora se exige
`AAAA-MM-DD` (o un instante ISO completo) y se comprueba la ida y vuelta, lo que
descarta el 30 de febrero, `"2026"` a secas y `"01/17/2026"` leído en orden
americano.

**Y una red debajo:** la clase 22 de SQLSTATE —cualquier valor que una columna no
puede leer— se contesta con 400 y una frase sobre los filtros, no con 500. Se
registra como aviso, porque cada vez que salte es un agujero de la validación de
arriba y la única forma de encontrar el siguiente es verlo.

### Bloqueante 2: la visibilidad de campo la decide la matriz, no el número de rol

Lo que había: `STAFF_ONLY = [1, 2]` en el catálogo y su espejo `STAFF_ROLES` en el
controlador. La matriz no le da `seguridad.ver` al rol 2, así que `GET /usuario`
le contestaba 403 mientras el generador le entregaba nombres, apellidos,
**usuarios de login**, teléfonos y el nombre del rol.

Ahora hay un tipo `Viewer { role, staff }` en `src/reportBuilder/viewer.ts`.
`staff` se resuelve **una vez por petición** con `can(role, "seguridad", "ver")`
—la matriz vive en memoria detrás de una caché de un minuto, así que no cuesta
nada— y el catálogo declara qué *es* un campo (`staffOnly: true`) en lugar de
quién puede verlo. `isVisible` es una línea, en un fichero, en vez de dos
ayudantes idénticos en dos ficheros más un literal en un controlador: así fue como
la fuga sobrevivió a una migración de permisos que debía borrar todos los números
de rol del código.

Los cinco puntos de entrada —`buildQuery`, `buildCountQuery`, `buildCatalogView`,
`runReport`/`countReport` y `buildExport`— exigen `Viewer`. **No se acepta un
número**: no hay camino de producción que pueda pasar uno por descuido. Y
`ADMIN_ROLE = 1`, que decidía quién archiva reportes ajenos, ahora pregunta
`seguridad.editar` — que el rol 1 ya tiene, así que no cambia de manos, pero por
fin se puede mover desde la pantalla de Seguridad.

🔴 **Cambio de comportamiento que hay que decidir:** el rol 2 (Coordinador) **deja
de ver los campos de personal** en el generador, porque la matriz no le da
`seguridad.ver`. Es exactamente el arreglo pedido y coincide con lo que ya hacía
`GET /usuario`. Si se quiere que los vea, se le marca `seguridad.ver` en Seguridad
— que es el sentido de todo el cambio.

### Lo que estaba abierto, y cómo quedó

**Cancelar una exportación cancela.** El navegador ya abortaba la petición; el
servidor seguía construyendo el fichero para nadie y reteniendo el único hueco de
exportación del proceso, así que el siguiente leía «ya hay una exportación en
curso» sobre la suya abandonada. Ahora la petición lleva un `AbortSignal` que se
comprueba entre pasos —validar, consultar, leer fotos, dibujar— y los lectores de
fotos lo miran entre fichero y fichero.

**Un solo conteo, en el mismo snapshot que las filas.** La exportación contaba dos
veces, en dos transacciones: la cuenta que decidía si el fichero cabía no salía de
la misma lectura que las filas que iban dentro, así que con una inserción
simultánea la cabecera decía un número y la hoja tenía otro. Ahora `runReport`
acepta una guarda que se llama con el total antes de leer una sola fila, dentro de
la transacción.

**El peso del fichero se mide, no se deduce.** Los topes de celdas se justifican
en megabytes —«80.000 celdas son unos 25 MB, el adjunto más grande que acepta la
mayoría de los servidores de correo»— y las celdas solo predicen el peso mientras
son pequeñas: con columnas de texto largo las mismas 80.000 salían en 32,9 MB. Se
comprueba el fichero terminado contra 25 MB. Cuesta construir un documento que
luego se rechaza, y eso solo pasa en el caso que antes salía roto y callado.

**El listado pagina y dice cuántos no muestra.** `GET /reportes` devolvía todos los
reportes visibles, cada uno con su configuración entera, en una respuesta que crece
mientras el producto se use. Ahora son cien por página (máximo 200) y el total
viaja al lado: la barra dice «Mostrando 100 de 137» con un «Cargar más». Cambia la
forma de la respuesta (`{ rows, total, limit, offset }`) y el cliente está
actualizado.

**Las escrituras tienen limitador.** El comentario decía que compartían «el
global», y no existe ninguno: `app.ts` limita el login y nada más. Sesenta por
minuto y por usuario para guardar, editar, archivar y duplicar.

**Los 403 dejan rastro, y todo lleva IP.** Quien anduviera probando identificadores
buscando reportes privados ajenos producía la misma bitácora que quien no lo
intentó nunca. Cuatro acciones nuevas —`READ_REPORTE_DENIED`,
`EDIT_REPORTE_DENIED`, `DELETE_REPORTE_DENIED`, `DUPLICATE_REPORTE_DENIED`— y
`ip_address` en las seis entradas del módulo, que es lo que el resto del sistema
guarda desde hace meses.

**La configuración compartida se poda al salir.** Un reporte compartido nombra los
campos con los que se armó, y se entregaba tal cual: le decía a cualquier lector
que existe `usuario.user` y contra qué lo filtró alguien — los mismos datos
personales que el catálogo le niega, llegando como metadato en vez de como filas.
`pruneConfig` deja solo lo que ese lector puede pedir, en el listado y en el
reporte suelto, y devuelve cuántos elementos quitó para que la pantalla lo diga en
voz alta.

**Duplicar poda en vez de rechazar.** Era un 400 citando una ruta interna
—`usuario.user`, precisamente el nombre que el catálogo estaba escondiendo— sobre
un reporte que la pantalla acababa de listar con su botón de Duplicar. Ahora la
copia es siempre una que se puede ejecutar, y la bitácora anota cuánto se quedó
fuera.

**Un cambio de rol se ve sin recargar.** El servidor leía el rol de la base en cada
petición y metía el fresco en el token que devuelve — esa parte ya estaba bien. El
cliente adoptaba el token nuevo y se quedaba con los permisos del login, así que a
quien ascendían seguía viendo la aplicación pequeña y a quien degradaban le seguían
saliendo botones cuyo único resultado era un 403. Ahora compara el rol del token
con el que tiene y solo entonces vuelve a preguntar: el caso normal —un token
renovado en *cada* respuesta— no cuesta nada.

**«No se sabe» deja de ser 0.** `GREATEST` en Postgres ignora los nulos en vez de
propagarlos, así que `GREATEST(0, NULL)` es 0 y un evento sin fecha se leía como
«abierto hace 0 días», con la misma seguridad que los datos de verdad. Hoy no se
observa porque el único evento sin fecha está resuelto; el día que alguien registre
uno pendiente sin fecha, la columna mentía.

**Un `null` dentro de una lista o de un rango se rechaza.** `= ANY` y `BETWEEN`
propagan nulos, así que una casilla vacía entre cinco valores construía SQL válido,
devolvía cero filas y no decía nada.

**Las fotos se deduplican por fichero.** Los datos guardan dos formas de la misma
ruta —3.090 filas como `/foto.jpg` y 424 como `images/foto.jpg`— así que una sola
foto se abría, redimensionaba y codificaba dos veces, y se incrustaba dos veces en
el mismo libro. El tope cuenta ficheros por el mismo motivo.

**Los topes del cliente salen de `catalog.limits`.** Se publican precisamente para
no escribirlos dos veces y estaban escritos dos veces: quien cambie uno en el
servidor no tiene por qué sospechar que hay una copia en el navegador, y entonces
el aviso local no salta nunca o salta sobre un reporte que el servidor habría
aceptado. Las constantes se quedan como respaldo para antes de que llegue el
catálogo.

**El PDF: título de una línea y leyenda de colores.** `maxWidth` hacía que jsPDF
partiera el título en varias líneas, y crecer hacia abajo era meterse en el
subtítulo: pasados unos 99 caracteres se imprimían uno encima del otro, en una
banda de altura fija. Ahora la tipografía se reduce hasta un suelo y solo entonces
se corta el texto. Y el documento pintaba las filas por criticidad y por
resolución sin decirlo en ninguna parte: la leyenda que la hoja de cálculo lleva
desde el principio ya está también aquí.

**El pie de la tabla ya no se contradice.** Decía tres cosas calculadas con un
total que era cierto cuando se pidió la página. Si alguien archiva eventos entre
dos páginas, se leía «Mostrando 301–250 de 250» en la página 4 de 3: tres
imposibles seguidos y ninguna pista. Ahora el caso se nombra —«esta página ya no
existe: el reporte cambió mientras la miraba»— con el camino de vuelta.

**`buildCountQuery` agrupa como `buildQuery`.** El total era correcto igual
—`GROUP BY a, a` agrupa como `GROUP BY a`—, pero ahora los dos se leen igual y
nadie tiene que deducirlo para estar seguro.

### Pruebas que prometían más que su cuerpo

Cuatro señaladas por la segunda auditoría, las cuatro reescritas:

- **El numerado del PDF** comprobaba que existiera el texto «Pagina 1 de», que un
  documento de una sola página también cumple. Ahora comprueba que cada página se
  nombre, que todas citen el mismo total y que ese total sea el número de páginas.
- **El peso del logo** medía el tamaño del PDF. Un logo que no se encuentra no es
  un error —la banda sale sin él— así que la prueba pasaba *más* fácil justo cuando
  lo que mide no estaba. Ahora establece primero que hay un logo incrustado.
- **`routeGuards.test.ts`** leía el *nombre* de la función, y
  `requirePermission("generador","ver")` y `("generador","archivar")` se llaman
  igual: una ruta con la puerta equivocada —el error más probable de todos— pasaba
  igual que una correcta. Ahora cada puerta lleva escrito el par que pide y el
  fichero comprueba los nueve del generador uno por uno.
- **La privacidad del listado** ahora se comprueba de verdad: que no salgan las
  rutas escondidas, que no salgan los valores filtrados contra ellas, y que el
  lector reciba el número de elementos que se le quitaron.

### Pruebas nuevas donde no había ninguna

`postConsulta` —el endpoint que de verdad extrae datos— no tenía ni una: ahora
tiene seis, incluida la del orden (validar antes de medir) y la de que la bitácora
guarda quién extrajo qué y desde dónde. `putReporte` tiene las dos caras de la
revalidación. Y `src/index.ts`, que la suite no puede importar porque conecta,
migra y ocupa un puerto al cargarse, ya no es intocable: la lógica de parada vive
en `src/lifecycle.ts` con seis pruebas — el orden de los dos cierres, que el código
de salida se ponga en vez de cortar el proceso, que el temporizador sea `unref`, y
que dos fallos seguidos no cierren dos veces.

**Y `npm test` volvió a ser determinista.** `logger.test.ts` fallaba en arranque en
frío porque `logger.ts` lanza `chcp.com` de forma **síncrona** al cargarse para
arreglar los acentos en la consola de Windows — una vez por worker de vitest, y
vitest lanza un worker por fichero. Cinco segundos y un timeout. Bajo pruebas no
hay consola que arreglar.

### Lo que sigue abierto

1. **Isaias no ha usado la pantalla.** Dos rondas de auditoría y una de arreglos no
   son eso. La lista de lo que conviene probar a mano está más arriba.
2. **Decidir si el Coordinador debe ver los datos de personal** en el generador
   (ver el bloqueante 2). Es un clic en Seguridad, pero es una decisión, no un
   arreglo.
3. **La cancelación se comprueba entre pasos, no dentro de uno.** Una consulta que
   tarda treinta segundos sigue treinta segundos aunque el cliente ya no esté; lo
   que la corta es el `statement_timeout`. Cancelar una consulta en vuelo desde
   Sequelize es otra cosa y no se ha intentado.
4. **El tope de peso se comprueba después de construir**, así que el caso
   patológico paga la memoria antes de que se le diga que no. Estimarlo antes
   pediría medir el texto y multiplicar por un factor inventado; se prefirió el
   número que no puede estar mal.
5. **Nadie mira el aviso de la clase 22.** Cada vez que salte, es una forma que la
   validación no previó. Está en el log del servidor y no hay alerta.
6. `IMAGES_DIR` apunta a `C:/images`, con 17 ficheros frente a las 1.514 fotos que
   referencia la base. Eso es la máquina, no el código.


## Estado al 22 de agosto: decisiones tomadas y qué sigue

Esta sección existe porque lo de abajo se decidió hablando y no está en ningún
otro sitio. Sin ella, la siguiente sesión vuelve a proponer lo mismo.

### Lo que se hizo el 22

Cuatro commits, todos en `isaias`:

- `api 5ff69f3` — **tres raíces nuevas**: Solución (1.024 filas), Ciudad (98) y
  Usuario (15, solo con `seguridad.ver`). Y el hallazgo de camino: el catálogo
  ofrecía caminos circulares («Evento › Última revisión › Evento › Poste»), 33 de
  los 78 campos de un reporte de eventos. Un reporte de eventos pasó a **52
  campos en 12 grupos** ofreciendo tres preguntas más.
- `api 4defb3a` — **`POST /conteo`** (cuenta sin leer filas, 120/min) y el campo
  `path` en cada columna del resultado.
- `web 6656c37` — **los cinco arreglos comunes**: refresco automático con
  interruptor, contador en vivo, ordenar desde la cabecera, guardados arriba,
  confirmación al cambiar el nivel de detalle. Y tres líneas en `src/test/setup.ts`
  que hacen probables todos los `<Select>` de la aplicación.

**538 pruebas en `api`, 188 en `web`.** Comprobado arrancando el servidor de
verdad, no solo con pruebas.

### Decisiones de Isaias, para no volver a preguntárselas

1. **Quién usa el generador: cualquiera con el permiso, igual que los reportes.**
   Lo cual incluye al rol 3, que **se llama «Cliente»** y tiene `generador.ver`,
   `crear`, `editar` y `archivar`. O sea que el cliente entra — y eso hace que
   las plantillas dejen de ser una comodidad: nadie de fuera arma un reporte
   partiendo de 52 campos en 12 grupos.
2. **El Coordinador se queda sin datos de personal** en el generador. Coincide
   con lo que ya hacía `GET /usuario`. Si algún día se quiere, es una casilla
   (`seguridad.ver`) en la pantalla de Seguridad, no código.
3. **Los seis reportes fijos no traen ni un dato de personal** — comprobado: el
   controlador no incluye `UsuarioModel` en ninguna consulta. El generador es el
   único sitio del producto que puede producir datos de personal en un reporte.
4. **Dirección de UX elegida: A + C** — «la tabla manda» con plantillas de
   entrada. Ver la página con las cuatro opciones:
   `https://claude.ai/code/artifact/97ec563b-92fb-4999-b6ea-4ede11e869f7`
5. **Autoría de revisiones y soluciones: sí, columna y relleno desde la
   bitácora.** Aprobado, **no hecho todavía** (ver abajo).

### La resolución de A + C, para cuando se retome

A no puede eliminar el panel izquierdo del todo: tres cosas no caben en un menú
de cabecera.

- **El orden múltiple.** Pinchando cabeceras no existe «este es el segundo
  criterio». Hace falta una ficha `Orden (2)` que abra la lista ordenada.
- **Muchos filtros.** Las fichas en una barra funcionan hasta cuatro; con doce
  son un muro, y el «cumplir todos / cualquiera» no tiene dónde vivir.
- **Sesenta columnas.** La `+` de la cabecera se va a la derecha y desaparece, y
  reordenar la columna 47 arrastrando no es viable.

Así que el panel **se colapsa en tres botones** —`Columnas (6)`, `Filtros (2)`,
`Orden (1)`— que abren su panel cuando hace falta. El caso normal se maneja
entero desde la tabla; el caso pesado sigue teniendo su lista. No se pierde
ninguna capacidad, cambia cuándo se ve.

Peaje que hay que aceptar al elegir A: **cambia visibilidad por calma.** Hoy los
seis iconos por fila son feos pero están a la vista. La mitigación es que el `⌄`
de cada cabecera sea visible siempre, nunca clic derecho.

Orden que no rompe la pantalla en ningún momento: (1) los cinco arreglos comunes
— **hecho**; (2) la galería y el modo simple; (3) el menú por columna, que vacía
la lista de la izquierda de a poco; (4) colapsar el panel, último, cuando ya no
quede casi nada dentro.

### Las seis plantillas propuestas (pendiente de que Isaias las confirme)

1. **General de eventos** — el que ya se entrega: poste, propietario,
   descripción, criticidad, estado, fecha. Existe como `generalConfig` en
   `export.integration.test.ts`.
2. **Pendientes por tramo** — agrupado por tramo, nº de eventos y criticidad
   mínima. Son 438 pendientes.
3. **Trabajos hechos** — raíz Solución. Imposible antes del 22 de agosto.
4. **Revisiones del mes** — raíz Revisión, 7.741 filas, el volumen real del
   trabajo.
5. **Cobertura por ciudad** — raíz Ciudad, con las 13 que no tienen ni un poste.
6. **Tiempos de resolución** — promedio de días del evento a su última revisión.

### Pendiente

1. 🔴 **Aplicar la migración de autoría.** El código está escrito y probado; lo
   que falta es ejecutarla contra `osefi_local` (`npm run migrate`), que es un
   permiso que hay que dar a mano. Ver la sección siguiente.
2. **Pregunta sin contestar:** hoy cualquiera ve todos los reportes marcados
   «compartido», venga de quien venga. Si un coordinador comparte un análisis
   interno, el rol Cliente lo ve en su lista. ¿«Compartido» debería significar
   «con mi equipo» y no con los clientes?
3. **Isaias todavía no ha usado la pantalla.** Sigue siendo lo que más vale, y
   ahora hay más que probar: el refresco automático, el contador, ordenar desde
   la cabecera y las tres raíces nuevas.
4. Lo que ya estaba abierto y sigue: la cancelación de exportación se comprueba
   entre pasos y no dentro de uno; el tope de peso se mide después de construir;
   nadie mira el aviso de la clase 22; `IMAGES_DIR` apunta a `C:/images` con 17
   ficheros frente a 1.514 fotos referenciadas.


## La autoría de revisiones y soluciones (22 de agosto)

`revicions` y `solucions` eran las dos únicas tablas de trabajo sin autor. Un
evento sabe quién lo registró y un poste quién lo dio de alta, pero las **7.741
revisiones y 1.071 soluciones** —que son el volumen real del trabajo de campo,
frente a 1.376 eventos— solo sabían su fecha. «Quién inspecciona más» no era una
consulta difícil: era imposible.

### Lo que la bitácora podía devolver, y lo que no

Medido contra `osefi_local`, no estimado.

La bitácora guarda el autor de cada acción, pero su `entity_id` apunta **al
evento, no a la fila creada**. No hay ninguna clave por la que unir las dos
tablas. Lo que identifica una fila es la pareja (evento, momento): una entrada de
bitácora del mismo evento escrita a segundos de la fila.

**Y hay dos acciones que crean cada tipo de fila, no una.** Esto es lo que
cambió el resultado:

| Fila | Acción evidente | La que se me pasaba | Sola / las dos |
|---|---|---|---|
| Revisión | `ADD_REVISION` | `CREATE_EVENTO` — `createEvento` escribe la primera revisión ahí mismo | 1.319 → **1.345** |
| Solución | `CREATE_SOLUCION` | `RESOLVE_EVENTO` — `resolverEvento` escribe la reparación ahí mismo | 171 → **513** |

Ojo con leer la fila de las soluciones al revés: la dependencia va en el otro
sentido. **`RESOLVE_EVENTO` sola recupera 512 de las 513**, y `CREATE_SOLUCION`
aporta exactamente 1 — porque el flujo antiguo era registrar la solución *y luego*
cerrar el evento, así que casi todas tienen las dos entradas. Lo que habría sido
un desastre es mirar solo la evidente: 171 de 1.071.

**La ventana es de 2 segundos, y aquí la primera versión estaba mal.** Usaba 30,
justificados midiendo 30s, 1min y 5min: todos recuperan lo mismo, así que
ensanchar era claramente inútil. Lo que no medí fue **hacia abajo**, y era lo
único que importaba. Medido de verdad:

| ventana | atribuidas (rev/sol) | ambiguas | filas con una **acción ajena** dentro |
|---|---|---|---|
| 0,5 s – 5 s | 1.345 / 513 | 0 | **0** |
| 30 s | 1.345 / 513 | 0 | **123 / 59** |

Treinta segundos no recupera ni una fila más y es el único ancho que pone una
acción que no tiene nada que ver —`UPDATE_EVENTO`, `REABRIR_EVENTO`— al alcance
de una fila. Dos segundos está dentro de la banda segura con un segundo de
holgura, que el suelo de 0,5 s no tiene: la fila y su entrada de bitácora son dos
sentencias de una misma petición, y una petición lenta puede separarlas un
segundo.

Y hay que ser honesto con lo que la regla dice, porque no es exactamente la
pregunta: dice **«quién tocó este evento en ese momento»**, no «quién escribió
esta fila». Dos de las cuatro acciones las apunta también código que no escribe
nada — cerrar un evento apunta `RESOLVE_EVENTO` aunque no cree ninguna solución.
Medido, esa exposición es **una entrada**: de 513, 512 tienen una solución de
verdad a menos de dos segundos. El mecanismo existe; en estos datos no. La
ventana estrecha es lo que lo mantiene así.

Donde la prueba no es unánime la columna se queda en nulo, que es la respuesta
verdadera.

### El resultado, dicho sin adornar

Son **dos cifras por tabla, no una**, y confundirlas es como se acaba diciendo un
número equivocado en una reunión. Una es cuántas filas se rellenan; la otra,
cuántas de esas se pueden llegar a ver en un reporte —porque 404 revisiones y 81
soluciones cuelgan de eventos archivados, y un reporte con esa raíz las descarta.

| | Se rellenan | Se ven en un reporte |
|---|---|---|
| Revisiones | 1.345 de 7.741 | **1.289 de 7.337** (17,6%) |
| Soluciones | 513 de 1.071 | **422 de 943** (44,8%) |

- Dentro de la era de la bitácora (desde el 18 de marzo de 2026) la cobertura es
  **del 100%**: no se pierde ni una fila de las que se podían recuperar.
- Fuera de ella no hay nada que recuperar, y nunca lo habrá.
- Y esto describe **una base de datos un día concreto**, no una propiedad de la
  migración: contra producción saldrán otros números. `npm run check:authorship`
  los saca de la base a la que apunte el `.env`.

Y el dato que hay que tener en la cabeza al leer cualquier reporte por persona:
**aparecen tres personas de quince cuentas** (nueve sin archivar, que son las
únicas que la raíz Usuario puede mostrar). Y aquí también son dos cifras, no una:

| | se rellenan (rev/sol) | se ven en un reporte |
|---|---|---|
| Fisher | 846 / 459 | **831 / 380** |
| Omar | 439 / 50 | **433 / 41** |
| Miguel | 60 / 4 | **25 / 1** |

Las de la derecha son las que salen por pantalla, y suman 1.289 y 422. Que los
otros doce no aparezcan no significa que no trabajaran: significa que su trabajo
cae fuera de lo que la bitácora puede atribuir.

**Por eso el nulo no es un hueco que se limpie más adelante: es el 83% de las
revisiones y tiene que seguir viéndose.** Una tabla que dice «Fisher: 831
revisiones» se lee como el total del trabajo cuando es la décima parte. El
comentario del catálogo lo dice y una prueba lo asegura.

### La trampa que casi me como

Marcar `revision.usuario` como `required` en el catálogo parece un ordenar y no
lo es. `required` emite un `EXISTS` **incondicional** sobre la clave ajena —ver
`requiredParentGuards`— así que con `id_usuario` nulo no empareja con nada y la
fila **sale del reporte**, mencione el reporte al autor o no. Seis mil
revisiones desaparecerían de todos los totales, en silencio, y la tabla que
quedara tendría una pinta perfectamente razonable.

Dos pruebas de `sqlExecution.test.ts` lo sujetan: un reporte de revisiones con la
columna de autor tiene que devolver **todas** las filas vivas, y la mayoría de
ellas sin autor.

### La otra: firmar en nombre de otro

Cuatro de los cinco sitios que crean estas filas lo hacían con
`Model.create(req.body)`. En el momento en que existe una columna `id_usuario`,
el cuerpo de la petición pasa a ser un sitio donde escribirla: un `POST` con
`"id_usuario": 2` se habría guardado tal cual, y el reporte de arriba nombraría a
un compañero como autor del trabajo de otro. **Un nombre equivocado es peor que
un nulo:** el nulo se lee como «no se sabe», el nombre se lee como un hecho.

`src/utils/authorship.ts` tiene la regla por sus dos caras: al crear se escribe
la sesión encima de lo que llegara, y al editar el campo se descarta —corregir
una falta en una descripción no es reclamar haber hecho la inspección. Las cinco
puertas están cubiertas y cada una tiene su prueba, incluidas las dos de dentro
de `evento.controller` que son las fáciles de olvidar.

### Lo que se decidió y por qué

- **La clave ajena borra a nulo, no en cascada.** `eventos.id_usuario` y
  `bitacoras.id_usuario` son `ON DELETE CASCADE`, y eso no es una convención que
  merezca copiarse: significa que borrar una cuenta se lleva sus eventos y su
  rastro de auditoría. Las cuentas se archivan en vez de borrarse, así que nunca
  ha saltado — pero el trabajo de quien se va tiene que sobrevivir a su ficha. La
  inspección ocurrió. `SET NULL` pierde la atribución y conserva el registro, que
  es el orden correcto de prioridades. **Queda apuntado como defecto pendiente el
  `CASCADE` de `eventos.id_usuario`.**
- **Los dos contadores nuevos de la raíz Usuario excluyen las filas que cuelgan
  de un evento archivado** (404 revisiones y 81 soluciones). No es un detalle: un
  reporte con raíz Revisión ya las descarta, así que sin el mismo filtro aquí las
  revisiones de la misma persona darían 831 en un reporte y 846 en otro, las dos
  con pinta de ser la verdad.
- **Al rol Cliente no le cambia nada** — pero eso hubo que arreglarlo, no salió
  gratis. En el generador es cierto de entrada: todo lo de autoría es
  `staffOnly`, la raíz Revisión pasa de 51 a 62 campos para un administrador y se
  queda en 40 para un cliente. En la API **no lo era**: ver la sección siguiente.

### Lo que salió de auditarlo, que es la mitad del trabajo

Tres agentes adversariales, cada uno atacando una cosa distinta. La atribución en
sí salió limpia —cero ambigüedad, y de las 342 soluciones cuya descripción guarda
la bitácora, las 342 coinciden con la fila atribuida— pero salieron tres agujeros
y un puñado de cifras mal.

1. 🔴 **`GET /evento/:id` y `GET /poste/:id` devolvían el hash bcrypt del autor.**
   `include: [{ model: UsuarioModel }]` sin `attributes` manda todas las columnas
   de `usuarios`, y una es `pass`; las dos rutas solo piden estar autenticado.
   Cualquier cuenta, rol Cliente incluido, se llevaba también el teléfono, el
   usuario de login y el contador de intentos fallidos. **Anterior a este
   trabajo**, y de la misma familia que las 25 lecturas abiertas que salieron en
   la auditoría de la pantalla de inicio. Cerrado.
2. 🔴 **La columna nueva se escapaba por la API normal.** Añadir `id_usuario` al
   modelo bastó: tres rutas que no limitan columnas empezaron a mandarlo, y
   `GET /evento` ya devuelve `usuario {id, name, lastname}` con el que cruzarlo.
   Once includes pasan a nombrar sus columnas, con la lista al lado de la
   definición del modelo para que la vea quien añada la siguiente — y
   `responseShape.test.ts` recorre el código y las obliga, porque el defecto no
   es un valor mal puesto sino **una línea que falta**, y eso no lo caza una
   prueba por endpoint.
3. 🔴 **`pruneConfig` daba un pase libre cuando la raíz no era visible.** Buscaba
   la raíz en la vista ya filtrada, así que «no existe» y «no puedes verla» eran
   indistinguibles y las dos se iban de rositas. Un reporte con raíz Usuario,
   filtrado por un teléfono y marcado compartido, llegaba **intacto** a cualquier
   cuenta que pueda listar compartidos: los caminos ocultos y **los valores
   filtrados contra ellos**, que son el dato personal. Ejecutarlo sí se negaba;
   el valor ya había llegado. Y decía `omitted: 0`. Lo abrí yo al hacer la raíz
   Usuario `staffOnly`.
4. **`buildCountQuery` prometía en su comentario comprobaciones que no hacía** —
   nunca miraba las columnas. No explotable, porque todos los que la llaman
   construyen la consulta completa primero, pero es la llamada barata, la de cada
   tecleo, y la que alguien usará sin el paso previo.
5. **Al `UPDATE` del relleno le faltaba `WHERE id_usuario IS NULL`.** Umzug apunta
   la migración *después* de cerrar la transacción, así que hay una ventana en la
   que el trabajo está hecho y sin registrar; el arreglo natural de quien lo sufra
   es deshacer y volver a aplicar, y deshacer se lleva **los autores que la
   aplicación ya escribió sola**, que un segundo relleno sustituiría por
   adivinanzas.
6. **Y las cifras de mis propios comentarios estaban mal:** Fisher eran 846 y no
   845, «cinco meses» eran menos de dos, «16 inspecciones» eran 26, y había
   cifras de la tabla entera puestas al lado de cifras de reporte — que es
   exactamente el pecado del que avisa este documento unos párrafos antes.

### Los dos scripts que quedaron

Están en `scripts/`, con su entrada en `package.json`, porque los dos contestan
preguntas que se van a volver a hacer. Los ocho de medición que usé para llegar
hasta aquí eran de usar y tirar y no están en el repo: habrían envejecido mal.

- **`npm run check:authorship`** — qué recuperó el relleno y qué dejó sin saber,
  contra la base a la que apunte el `.env`. Funciona **antes** de la migración
  (dice lo que recuperaría) y **después** (lo que recuperó, más una comprobación
  de que las dos cosas coinciden). Solo lee. Importa la regla de emparejamiento
  **de la propia migración**, no una copia: una verificación que puede
  contradecir a lo que verifica no sirve de nada. Esto es lo que hay que correr
  contra producción antes y después de desplegar la migración.
- **`npm run show:catalog`** — qué ve cada rol de verdad en el generador. La
  visibilidad es dos cosas multiplicadas: el catálogo dice que un campo es dato
  de personal, y la matriz de permisos dice si ese rol tiene `seguridad.ver`. Las
  dos mitades viven en sitios distintos y la segunda se edita desde la pantalla
  de Seguridad, así que la pregunta «¿el Cliente ve teléfonos?» no se contesta
  leyendo ningún fichero. Y ese hueco no es teórico: el rol 2 tenía prohibido
  `GET /usuario` mientras el generador le daba nombres, usuarios y teléfonos.
  `npm run show:catalog -- 3 telefono` lo contesta en diez segundos.

Estado hoy, migración ya aplicada contra `osefi_local`: rol 1 ve 300 campos en 7
niveles de detalle; los roles 2 y 3 ven 195 en 6, sin un solo dato de personal.
`check:authorship` dice «la regla dice otra cosa: 0» en las dos tablas, o sea que
lo escrito coincide exactamente con lo que la regla predecía.
