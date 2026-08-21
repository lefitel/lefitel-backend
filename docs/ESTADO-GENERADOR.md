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
