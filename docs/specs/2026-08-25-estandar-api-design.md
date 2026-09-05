# Estándar de la API — diseño

Fija la convención de la superficie HTTP y del contrato de respuesta, y la aplica
a las **105 rutas que no son de autenticación**. No añade ninguna función: cierra
la puerta a que la próxima ruta se escriba de una séptima manera.

> **Segunda versión.** La primera fue auditada por cuatro revisores con enfoques
> distintos —hechos, consecuencias de diseño, seguridad y completitud— y no la
> aguantó: cuarenta y tantos hallazgos, dieciséis de los cuales cambiaban una
> decisión y no una frase. Uno de ellos no era un defecto del documento sino un
> agujero abierto en producción, y está arreglado antes que este texto (§9).
> Lo que sigue incorpora todo aquello. Los descartes de la primera versión están
> en §8 junto a los demás, porque un descarte razonado vale lo mismo que una
> regla.

> **Tercera versión, 3 de septiembre.** Isaias pidió una auditoría de lo hecho y
> de lo planeado, con cinco revisores a la vez —diseño, seguridad, honestidad de
> los tests, riesgo de despliegue y el código commiteado— porque el arco se había
> construido con un modelo anterior. Sobre lo commiteado: ningún commit debilitó
> nada. Sobre lo planeado: la premisa del despliegue estaba mal, tres reglas se
> contradecían o costaban más de lo que daban, y dos afirmaciones de este texto
> sobre el árbol ya eran falsas. Isaias tomó diez decisiones ese día; están
> incorporadas y marcadas «(decisión del 3 de septiembre)». Lo que la auditoría
> encontró en el propio trabajo del arco está arreglado en `7faa178`, y dos
> defectos de producción ajenos al arco en `67f9d56`.

**Ninguna cifra de este documento sirve para firmar nada, y hay que decirlo
arriba.** Mientras se escribía la primera versión, la otra sesión añadió cuatro
rutas de autenticación y el total pasó de 114 a 118 en unas horas. Esa versión
concluyó que las que no son de autenticación «no se movieron ni una, y por eso
son la cifra de este documento». Al día siguiente se movieron: la sesión de roles
añadió `PATCH /api/rol/:id/desarchivar` y pasaron de 104 a **105**.

En veinticuatro horas envejecieron cinco cifras más. La lección no es corregirlas
—van corregidas— sino la que gobierna §9: **el criterio de terminado de cada
tarea es un comando que se ejecuta, no un número escrito aquí.** Los números del
texto sirven para entender el tamaño del trabajo. Nada más.

---

## 1. Por qué hace falta

No es cuestión de gusto. Son cuatro hechos, todos reproducibles con un comando:

**Seis contratos para «una lista de cosas».**

```
GET /api/poste/              → { data, total, page, totalPages, limit }
GET /api/bitacora/           → { data, total }
GET /api/generador/reportes  → { rows, total, limit, offset }
GET /api/adss/               → [ … ]
GET /api/dashboard/          → { eventos: […], postes: […] }
GET /api/permisos/           → { roles, modulos, acciones, permisos }
```

El tercero llama `rows` a lo que los demás llaman `data`, y pagina por
desplazamiento mientras el primero pagina por página. Los dos últimos ni siquiera
son una lista: son varias en un objeto. Ninguno es incorrecto por sí solo; el
problema es que un cliente no puede escribir una función que consuma un listado
sin mirar antes cuál de los seis le toca. En el frontend ya se paga:
`PostePaginatedResponse` y `EventoPaginatedResponse` son la misma forma declarada
dos veces, y `GetPosteParams` / `GetEventoParams` son literalmente idénticos.

**Seis lecturas viajan por `PUT`.** Los seis informes fijos piden `reportes:ver`
—el permiso de lectura— y llegan por el método que declara que van a sustituir un
recurso. Ningún intermediario los cachea, y un reintento automático se considera
seguro sobre una consulta que recorre miles de eventos con sus fotografías. El
generador, que es el módulo nuevo, ya resuelve lo mismo con `POST`.

**Veinte lecturas no preguntan por ningún permiso.** Está contado en
[`routeGuards.test.ts`](../../src/routes/routeGuards.test.ts) desde antes de este
diseño: la columna `ver` de la matriz decide qué botones dibuja el navegador y
nada más. Cualquier cuenta con sesión válida —el rol Cliente incluido— puede
pedir el registro completo de postes, de eventos, y las revisiones y soluciones
de cualquier evento escribiendo la URL.

**Noventa y siete manejadores devuelven `error.message` en un `500`.** Al
navegador llega el texto crudo de Sequelize o Postgres: nombres de columna,
nombres de restricción, a veces el SQL. Ochenta con la forma literal, doce a
través de una variable `msg` y cinco con un ternario en línea — las tres formas
importan, porque un `grep` del literal encuentra el 82 % y deja el resto
tranquilo. El manejador global de [`app.ts`](../../src/app.ts) sí responde con un
mensaje neutro; estos se lo saltan.

### Lo que este diseño no es

No es un rediseño de la API ni una revisión de sus funciones. Pero **sí cambia
capacidades**, y la primera versión decía que no: cerrar esas lecturas quita a
algún rol algo que hoy puede hacer, y eso es el punto, no un efecto colateral.
Los cambios de capacidad, enumerados: la bitácora deja de fallar en silencio
(§5.4), los desplegables pasan a pedirse en una sola petición (§5), y los roles
sin el `ver` correspondiente dejan de poder leer lo que hoy leen (§6).

---

## 2. Alcance

**Las dos orillas.** La superficie HTTP —método, ruta, permiso, código de
estado—, el sobre de la respuesta, el formato de error, y cómo lo consume
`web/src/api`. Un estándar que sólo cubriera el servidor dejaría sin decidir la
mitad que hoy destruye la información del fallo.

**Los nombres de campo del JSON quedan fuera**, y conviene decir qué se queda sin
decidir: `id_poste` y `ciudadA` conviven en la misma respuesta, `solucions` es un
plural inglés sobre una palabra española, y las consultas aceptan `entity_id` y
`filterColumn` a la vez. Se decidirán cuando se decidan los nombres de tabla,
porque Sequelize los deriva de ellas y separarlos obliga a configurar el ORM
campo por campo. *La primera versión prometía cubrirlos en §2 y no los mencionaba
en ninguna regla; esto es la corrección.*

**Sin tocar la base de datos.** Los nombres de tabla y columna se quedan como
están, incluida `revicions` —escrita así, con su falta— y la mezcla de
`permisos`, `sesiones`, `reporte_vistas` y `token_uso_unico`. Cada renombrado es
una migración con ventana de despliegue y sin ningún cambio visible para quien
usa la aplicación.

**105 rutas.** Las catorce de autenticación las lleva otra sesión, en el Plan 3
(correo verificado y recuperación de contraseña) y el Plan 4 (TOTP, passkeys):

```
POST   /api/login/
POST   /api/auth/login            GET    /api/auth/me
POST   /api/auth/logout           POST   /api/auth/logout-all
GET    /api/auth/sessions         DELETE /api/auth/sessions/:id
POST   /api/auth/email/send       POST   /api/auth/email/verify
POST   /api/auth/password/forgot  POST   /api/auth/password/reset
PUT    /api/usuario/username/:id  PUT    /api/usuario/userpass/:id
PATCH  /api/usuario/:id/desbloquear
```

Las tres últimas salen por prudencia y no por colgar de `/auth`: la recuperación
de contraseña toca `userpass` de lleno, las dos primeras comparten el middleware
`chargeConfirmBudgetOnSelfChange`, y el desbloqueo de cuentas es la vía de vuelta
de la que habla su plan.

**Consecuencia que conviene no perder de vista:** el agujero del desbloqueo —el
servidor bloquea cuentas por intentos fallidos y guarda `locked_until`, y el
frontend no pinta ese estado ni ofrece manera de levantarlo— es el único defecto
del recuento que un usuario nota hoy, y este diseño no lo arregla porque no le
corresponde. Queda anotado para que nadie lo dé por cubierto.

### Lo que queda fuera, y por qué

**Introducir un cliente de datos.** No hay ninguno: `@tanstack/react-table` es la
tabla, no el fetching, y no existe un solo `useQuery` en el repositorio. Los 52
ficheros que tocan la capa de API lo hacen con `useState` y `useEffect` a mano,
o desde manejadores de evento. Pasar eso a otro modelo es un proyecto con su
propio diseño. Los endpoints de opciones (§5) bajan las peticiones de diez a dos
en las dos pantallas peores sin necesitar ninguna librería.

**Renombrar las tablas.** Ver arriba.

**Versionar la API.** No hace falta, y el argumento es organizativo, no mecánico
— la primera versión lo escribió al revés y merece la corrección: `CORS_ORIGIN`
**es una lista separada por comas**, y el comentario de
[`security.ts`](../../src/config/security.ts) dice por qué («*so a second
frontend, a preview deployment, is a variable and not a code change*»). Además
`requireSameOrigin` sólo juzga escrituras que ya llevan cookie de sesión, y la
cabecera `Origin` únicamente es infalsificable **desde un navegador**: un script
pone la que quiera. Lo que sostiene la decisión es que no hay ningún otro cliente
conocido y que los dos repositorios son nuestros — no que el mecanismo lo impida.

**Mantener alias es otra cosa, y sí se hace.** La primera versión metía las dos
en el mismo saco y con eso se cerraba la única salida barata a la ventana de
despliegue. Son distintas: versionar es una forma permanente («la API tiene una
`v1` y una `v2` para siempre»), y un alias es una tolerancia **temporal y con
fecha de borrado** mientras el cliente viejo se apaga. Lo segundo no sólo se
permite, es obligatorio en la familia C entera — §11 lo explica, y el motivo es
que la aplicación se actualiza cuando el usuario pulsa un botón, no cuando
despliega Vercel. El código de tolerancia se borra en el paso 3 de su propia
tarea, y ese borrado está en la lista.

---

### Dónde para este documento

Hay otras dos sesiones trabajando el mismo árbol, y sus fronteras no se declaran
una vez sobre una lista de rutas: hay que decir **qué reglas no las alcanzan**,
porque las de §3 y §4 están escritas en universal y un implementador diligente
las aplicaría a todo.

**Autenticación** — `/api/login`, `/api/auth/*` y los tres cambios de credencial
bajo `/api/usuario`. No les aplican §3.3 (el sobre: `GET /api/auth/sessions`
devuelve una colección y **no** se envuelve), §3.5 (los códigos: su `DELETE` de
sesión no pasa a `204`), §3.6 salvo el manejador de 404, ni §4.1/§4.2. Y dos
ficheros son suyos aunque este documento los toque: `api/src/app.ts` y
`web/src/api/http.ts`, más el interceptor de `SesionProvider.tsx`.

**Roles** — `/api/rol` entero, sus cuatro rutas, y en el cliente `Rol.api.ts`,
`RolesPanel.tsx` y `PermisosPanel.tsx`. No les aplica ninguna regla de este
documento. La única excepción es §6, que asigna `roles:ver` a `GET /api/rol/`
para poder vaciar la lista de excepciones de lectura — y eso hay que acordarlo
con ellos, porque el comentario que hoy encabeza ese controlador dice
explícitamente lo contrario.

**De los tres** — `routeGuards.test.ts`. Este documento le quitó tres entradas en
A1 y le vació la lista de lecturas en C5, que además lo llevó de siete routers
bajo comprobación de completitud a diecisiete; la sesión de autenticación le
añade rutas en su Plan 4. Cualquier cambio ahí se avisa.

---

## 3. Las reglas del servidor

### 3.1 El método dice la verdad

`GET` lee y no cambia nada. `POST` crea, o consulta cuando el filtro no cabe en
la URL. `PUT` sustituye un recurso entero. `PATCH` cambia un campo o un estado.
`DELETE` archiva.

Consecuencia: **los seis informes pasan a `GET`** (decisión del 3 de septiembre).
La segunda versión decía `POST`, y la propia regla de arriba la desmiente: el
filtro de un informe son cinco valores —dos tramos, dos fechas y un booleano—
que caben en la URL de sobra. `GET` es cacheable y reintentable, que es
exactamente lo que §1 echa en falta y `POST` tampoco da. El único argumento a
favor de `POST` era el generador, cuyo cuerpo es la configuración entera de un
informe y no cabe en ninguna URL: ése sí.

**`PUT /api/permiso/:id_rol` es la excepción, y hay que escribirla como tal.** La
primera versión afirmaba que ahí `PUT` era correcto «porque sustituye la matriz
completa del rol». **Es falso**:
[`permiso.controller.ts`](../../src/controllers/permiso.controller.ts) aplica un
**delta por celda** —`changesFrom` acepta cualquier subconjunto y no hay ningún
reset de lo que no se nombra— y `PermisosPanel.tsx` envía sólo las casillas que
el administrador tocó. Implementar aquella frase al pie de la letra habría hecho
que el siguiente guardado pusiera a `false` las otras 39 casillas del rol; si la
tocada fuera de un administrador, la vía de vuelta depende de que exista un
segundo administrador intacto, porque `putPermisos` se niega a editar el rol
propio. Se documenta como delta. Renombrarlo a `PATCH` sería más honesto y no se
hace: es un cambio de dirección sobre el endpoint que gobierna todos los permisos
del sistema, y el beneficio es nomenclatura.

### 3.2 El hijo cuelga del padre

Un listado que sólo existe respecto a otra fila va bajo esa fila, y el parámetro
de una ruta significa siempre lo mismo dentro de su montaje.

| Hoy | Después |
|---|---|
| `GET /api/adssposte/:id_poste` | `GET /api/poste/:id/adss` |
| `GET /api/eventoObs/:id_evento` | `GET /api/evento/:id/obs` |
| `GET /api/revision/:id_evento` | `GET /api/evento/:id/revisiones` |
| `GET /api/solucion/evento/:id_evento` | `GET /api/evento/:id/solucion` |
| `GET /api/evento/poste/:id_poste` | `GET /api/poste/:id/eventos` |
| `GET /api/evento/usuario/:id_usuario` | `GET /api/usuario/:id/eventos` |
| `GET /api/bitacora/:id_usuario` | `GET /api/usuario/:id/bitacora` |

`obs` y no `observaciones`: la excepción de §3.4 —que `obs` se queda como
abreviatura— manda también en las rutas nuevas. La séptima fila faltaba en la
primera versión y la regla la exige: en `/api/bitacora`, `:id_usuario` no es la
bitácora.

**Un segmento literal se declara antes que cualquier paramétrico del mismo
nivel.** Es la regla implícita de la que ya dependen `/opciones` antes de `/:id`
en [`poste.routes.ts`](../../src/routes/poste.routes.ts) y `/orphans` antes de
`/:name` en `files.routes.ts`, y la primera versión no la escribió — con lo que
su propio `GET /api/bitacora/autores` habría caído dentro de `GET /:id_usuario`,
consultando `id_usuario = "autores"` y produciendo un 500 con el texto de
Postgres: la ruta nueva disparando la fuga que §3.5 arregla.

**La justificación de esta sección cambia cuando se lee junto con §7.** La
primera versión la apoyaba en que `GET /api/revision/5` devuelve las revisiones
*del evento* 5 mientras `DELETE /api/revision/5` borra *la revisión* 5. Cierto —
pero §7 borró ese `DELETE` y ese `PUT` por no tener cliente, así que para cuando
llegó D1, el renombrado, la trampa ya no existía. Lo que queda en pie es más
sencillo y menos dramático: siete direcciones que se leen solas frente a cuatro
convenciones que hay que memorizar.

Desaparecen **cuatro** montajes y no tres. Los tres que decía esta sección
—`/api/adssposte` y `/api/eventoObs` dejan de ser recursos raíz, y
`/api/solucion` se queda sin rutas al mover la suya y borrar las otras cuatro
(§7)— más `/api/upload`, que era un verbo montado como recurso raíz: guardar un
fichero es `POST /api/files/`, en el router que ya los gestiona (§3.4).

**Y las cifras que traía eran otras.** Medido sobre `app.ts` al cerrar D1: **17
montajes fuera de autenticación**, 24 contando los de `/api/auth` y `/api/login`.
La frase «de 23 a 20» describía un árbol de hace dos semanas. Los modelos siguen
todos en pie: los usan otros controladores.

✅ **Hecho en D1.** Las siete direcciones son las de la columna «Después», con el
parámetro renombrado a `:id` en las siete y en sus controladores. Dos de ellas
—la bitácora de una persona y sus incidencias— pasan por `requireSelfOrPermission`,
cuyo tercer argumento nombra el parámetro: al moverlas, `evento.self.test.ts` y
`bitacora.self.test.ts` son lo único capaz de ver que la rama de propiedad se
rompe, porque leer la cadena de middlewares no manda ninguna petición y las demás
suites simulan el permiso a `true`. La segunda no existía y se escribió primero,
contra la dirección vieja.

### 3.3 Una URL, una forma

**Qué es un listado**, porque la primera versión no lo definía y la mitad de las
respuestas no caía ni en «listado» ni en «detalle»: un `GET` cuya respuesta es
una colección de filas de una tabla. Nada más.

**Todo listado** devuelve el mismo sobre, tenga doce filas o mil quinientas:

```json
{ "data": [], "total": 0, "page": 1, "limit": 50 }
```

Sin `totalPages`. Lo llevaba la segunda versión, y la auditoría lo buscó en el
cliente: dos declaraciones de tipo y **cero lectores**. La tabla calcula las
páginas a partir de `total` y `limit`, y un campo que nadie lee es un campo que
un día alguien calcula mal sin que nada lo note.

**El detalle de una fila devuelve el objeto.** El sobre lleva metadatos de la
colección, y en un detalle no hay metadatos que llevar. Un detalle tampoco va a
necesitar `total` más adelante. **Y devuelve 404 cuando la fila no existe**: hoy
`GET /api/poste/:id` responde `200` con cuerpo `null` para un poste inexistente,
y la pantalla se renderiza vacía sin error.

**Tercera categoría: la respuesta agregada.** Un objeto, sin sobre, con su forma
actual intacta. Se enumeran aquí para que el test de §10 las conozca y para que
nadie las envuelva por parecerse a un listado:

| Ruta | Por qué no es un listado |
|---|---|
| `GET /api/evento/:id/solucion` | Relación 1:1. Devuelve el objeto **o `null`**, y `null` es el caso normal — un evento sin resolver. Envolverla haría `{data: null}`, que es *truthy*, y **todo evento pendiente aparecería como resuelto**. Ésta es ya la dirección de D1; era `/api/solucion/evento/:id_evento`, con su propio montaje. `solucion.evento.test.ts` afirma el `null` **en el cable** (`res.text === "null"`), no sólo tras parsearlo: `{"data":null}` también se lee como algo falso en una aserción descuidada, y ésta es la única ruta donde esa distinción decide si una incidencia abierta se pinta como arreglada |
| `GET /api/dashboard/` | Dos colecciones nombradas en un objeto |
| `GET /api/permiso/` | Cuatro colecciones paralelas |
| los tres `/options` (§5) | Varias colecciones nombradas en un objeto, cada una con su proyección — la misma forma que `/api/permiso/`. Faltaban en esta tabla y ya estaban montados |
| `GET /api/bitacora/authors` (B2) | Una lista de `{id, name, lastname, deletedAt}`; sin sobre, como los bloques de opciones. `deletedAt` porque los archivados van en la lista y la pantalla los marca |
| `GET /api/files/orphans`, `/broken-refs` | Diagnóstico de la pantalla de Archivos; su forma la fija esa pantalla |
| los cinco `/stats` | Un resumen. **No es el mismo en los cinco**: adss, material y tipo-obs devuelven `{ total, mostUsed, empty }`; obs devuelve `{ total, unclassified, critical }` y propietario `{ total, mostPostes, mostPendientes }`. La segunda versión afirmaba uno solo |
| `GET /api/files/entity-stats` | Un objeto de objetos |
| `GET /api/generator/catalog` | Un árbol |
| los seis de `/api/reporte/` | Su forma la fija la pantalla de informes y no cambia en este arco. **Tres de los seis sí devuelven filas de `eventos`** con sus includes —general, tramo y recorrido—, así que la justificación de la segunda versión («filas calculadas») era falsa para la mitad. Se quedan sin sobre porque ninguno pagina; acotarlos es trabajo aparte (§9, familia E) |
| `GET /api/generator/reportes` | Pagina por `offset`, y su cliente también. Conserva `rows`/`offset` |

**Cuarta categoría: la descarga.** Un `POST` cuya respuesta es un fichero. No
existía cuando se escribió esta sección porque no había ninguna fuera del
generador, y C3 añadió tres: `POST /api/poste/export`, `/api/evento/export` y
`/api/usuario/export`. No es un listado ni una agregada, y meterla en la tabla de
arriba habría dejado una prueba en verde cuya frase ya no describía lo que
comprueba — esa tabla se afirma sobre respuestas JSON, y un `.xlsx` no es un
objeto. Lleva su propia casilla en `listShape.test.ts`, con su propio barrido.

Lo que una descarga promete, y lo que la prueba mide:

- **`Content-Disposition: attachment`**, con el nombre en sus dos formas — la
  codificada, para que los acentos sobrevivan, y una ASCII para lo que ignore la
  RFC 5987. Llega al navegador sólo porque `app.ts` expone esa cabecera en CORS;
  sin eso, todas las descargas se llaman «download» y nada falla.
- **`Cache-Control: no-store`**, por el mismo motivo que los seis informes fijos:
  esto es el registro de activos de una empresa saliendo del sistema.
- **Un `Content-Type` que no es JSON**, y un cuerpo que no es el sobre.
- **Sus propios topes**, que no son el de los listados. `MAX_LIST_ROWS` gobierna
  `limit=all` y su mensaje dice «pida la lista por páginas», que es un consejo
  imposible de seguir mientras te descargas un fichero. Una descarga se corta por
  filas (20.000), por celdas según el formato (200.000 en hoja de cálculo, 80.000
  en documento) y por peso del fichero terminado (25 MB) — los tres números del
  generador, medidos donde están definidos — y responde **`413`**.

  `413` aquí y `422` en un listado no es una contradicción, aunque lo parezca. El
  argumento de más abajo contra el `413` es que un cliente no puede distinguirlo
  de «tu foto es demasiado grande», y eso vale en un router que acepta subidas;
  estas tres rutas no aceptan ninguna, y su vecina de significado — la
  exportación del generador — ya responde `413` desde que existe. Un solo código
  para «el fichero que pides no se puede construir», en las cuatro.

**Y son `POST`, para una descarga.** `requireSameOrigin` sólo guarda los verbos
que escriben, así que un `GET` que arma una hoja de cálculo es algo que
cualquier página de internet puede hacer ejecutar al navegador de un empleado con
sesión, una vez por navegación de primer nivel —que es lo único que la cookie
`Lax` acompaña; un `<img>` no la lleva— y sin llegar a leer la respuesta. No se
lleva nada: gasta memoria ajena y la única plaza que el proceso tiene para armar
documentos. Es la misma puerta que `reporte.routes.ts` tuvo anotada como deuda
de B3 para los seis informes hasta que B3 les puso el cubo del generador, que la
acota; estas tres nacen sin ella. Los filtros viajan
igualmente en la cadena de consulta, porque son los del listado y los lee la
misma función — una segunda forma de decir «filtrado por nombre» es una segunda
cosa que se desincroniza.

**Fuera `?export=true`.** Hoy ese parámetro cambia el tipo de la respuesta en la
misma URL, y el frontend vive con la consecuencia: cuatro funciones sobre `GET
/api/poste/`, de las cuales tres cuelan `export=true` — y dos de ellas
(`getPosteByCiudad`, `getPosteByTramo`) no exportan nada, sólo esquivan la
paginación.

**La lista completa se pide con `limit=all`, no con `limit=0`.** El centinela
numérico de la primera versión era inutilizable: `Number("0") || 50` da 50 porque
el cero es *falsy*, así que `limit=0` habría devuelto 50 filas en silencio — y si
el frontend se despliega antes que el servidor, las exportaciones a Excel, CSV y
PDF salen truncadas **sin un solo error**. Eso es dato incorrecto, no pantalla en
blanco, que es la peor clase de fallo que este documento puede provocar.
`limit=all` no colisiona con ninguna lectura numérica.

**El techo: `MAX_LIST_ROWS = 5.000`, por petición, contado en filas, y superarlo
responde `422`** con `{ message, total, max }`. Sobre una colección vacía
responde el sobre con `total: 0`.

`422` y no `413`, que es lo que decía la segunda versión. `413` es *Content Too
Large*: habla del cuerpo de la **petición**, y es lo que este servidor ya
responde a una subida que pasa de tamaño y a un cuerpo JSON que pasa de tamaño.
Un cliente que reciba `413` de `limit=all` no puede distinguirlo de «tu foto es
demasiado grande». El precedente del generador que la segunda versión citaba
tampoco valía: allí el mensaje pide al usuario que reduzca la consulta, y
`limit=all` no se puede reducir, es todo o nada.

**Y una honestidad sobre el techo, porque la auditoría la pidió:** hoy no acota
nada grande. Las dos listas paginadas ya se topan en 100 por página, y las
lecturas de verdad sin tope —la pantalla de inicio, los tres informes de filas,
los dos diagnósticos de Archivos— están en la tabla de agregadas y
fuera de su alcance. El techo gobierna `limit=all`, y solo eso. Acotar el
inicio y los informes es trabajo con nombre propio en §9 (familia E), no una
consecuencia de esta regla.

Dos cosas que la primera versión dijo mal y conviene no repetir: el precedente
que citaba, `MAX_CONSULTA_CELLS = 300_000`, mide **celdas**, no filas; y existe
`MAX_EXPORT_ROWS = 20_000` en el exportador, cuatro veces más laxo, que no
mencionó. Y la respuesta de postes con `limit=all` ronda **0,7 MB**, no «decenas
de megas»: el argumento del techo se sostiene sin exagerar la magnitud.

**Pero la conciliación entre los dos topes que escribió la primera versión es
falsa, y la auditoría del 26 de agosto la tumbó.** Decía que «una exportación
construye un fichero y se mete en su propio presupuesto». Eso sólo vale para
`POST /api/generador/exportar`, que construye el fichero **en el servidor**. Los
botones de Excel, CSV y PDF de las pantallas de Postes y Eventos no hacen eso:
piden todas las filas con `?export=true` y construyen el fichero **en el
navegador**. Al quitar ese parámetro pasan a ser lecturas de listado y heredan el
techo de 5.000 — o sea que en cuanto la tabla de eventos lo supere, **los tres
botones de exportación dejan de funcionar con un `413`**, y los 20.000 que este
párrafo cita quedan inalcanzables desde el navegador.

Y hay un segundo uso que el nombre esconde: `exportPostes(true)` y
`exportEventos(true)` **no exportan nada** — son el cargador de la pestaña
«Archivados». Quitar `export=true` también la rompe.

**Decidido en C3, y se hicieron las dos** (Isaias, 4 de septiembre): la pestaña
de archivados pagina en el servidor como la de al lado, y las nueve
exportaciones de navegador se construyen en el servidor como las del generador.
La tercera opción — que el techo distinguiera por destino — se descartó: era la
única que dejaba en pie la duplicación que causó el problema.

Lo que decidió el empate no fue el techo, que hoy no muerde con 1.687 postes y
1.514 incidencias, sino lo que encontró la auditoría previa dentro de esas
doscientas líneas copiadas tres veces: un PDF que dibujaba su pie en el
milímetro 212 de una hoja de 210 — sin números de página en ninguna página, en un
documento que va al cliente —, otro con los anchos de columna de un diseño que
había perdido una columna, fechas que cambiaban según el huso del portátil que
exportaba, y el mismo escapador de CSV en los tres sin defensa contra lo único
para lo que existe un escapador de CSV. Ninguna de las tres pantallas tenía una
sola prueba sobre su fichero, porque en el navegador no se podía mirar dentro.

**Por qué el sobre también en los catálogos.** Un catálogo de doce materiales
envuelto responde `page: 1` y `total: 12`, que hoy no aporta nada. Aporta el día que la
colección crezca: `GET /api/ciudad/` devuelve todas las ciudades, y en una red que
crece las ciudades crecen. Si fuera un array pelado, ese día habría que cambiarlo
a sobre y romper a todos sus consumidores — el mismo cambio de contrato que este
diseño existe para evitar. Clasificar hoy qué colección «puede crecer» es una
apuesta sobre el futuro, y la factura de perderla la paga quien esté delante.

### 3.4 Nombres

**Sustantivos del negocio en español. Todo lo demás en inglés.**

Los nombres propios de esta red eléctrica se quedan como son, porque su
traducción es peor: «tramo» no es *span* —es el segmento entre dos ciudades, con
dos claves ajenas y sin orden entre ellas, que es por lo que el controlador de
postes busca el par en las dos direcciones—; «bitácora» no es *log* —es un
registro de acciones con severidad, entidad y autor—; y ADSS es una sigla de
cable de fibra que no traduce a nada.

**La regla, entera y sin desempate (decisión del 3 de septiembre): los
sustantivos del negocio van en español; los verbos y las operaciones van en
inglés. Sin excepciones en ninguno de los dos lados.** `/api/evento/5/reopen`,
`/api/poste/5/restore`, `/api/generator/query`.

La segunda versión tenía aquí un «criterio de desempate» —«si el cliente usa la
palabra cuando habla del sistema, va en español»— y la auditoría demostró que
contradecía la tabla de abajo: el cliente dice «Desarchivar», «Reabrir» y
«Resolver» en los botones que pulsa cada día, y la tabla los traducía. Una regla
con un desempate que la contradice se rediscute en cada ruta, que es lo que un
desempate existe para evitar. Se borra el desempate y se queda la regla.

Había otra regla coherente posible, y conviene dejarla escrita porque se
descartó a sabiendas: **todo en español**, con inglés solo donde no hay palabra
(`files`, `orphans`, `stats`). Era lo que el árbol ya hacía, costaba cero rutas,
y era la recomendación de quien escribe esto. Isaias prefirió los verbos en
inglés por coherencia con el resto del código, que es inglés, y el coste de
renombrar desapareció el mismo día por la decisión de §11: antes del corte no hay
cliente viejo que proteger.

**El número lo decide el idioma, no una regla única.** La primera versión escribió
«singular en todos los segmentos» y a continuación dejó tres plurales sin
explicar. Queda así: un sustantivo de negocio conserva el número con el que lo
dice el cliente (`tramos`, `reportes`, `poste`, `evento`); una colección inglesa
va en plural, que es lo correcto en inglés (`files`, `orphans`); una operación va
en singular (`export`, `count`, `query`).

| Hoy | Después | Por qué |
|---|---|---|
| `/:id/desarchivar` (×10) | `/:id/restore` | Verbo de operación |
| `/:id/reabrir` | `/:id/reopen` | Verbo |
| `/:id/resolver` | `/:id/resolve` | Verbo |
| `/exportar` | `/export` | Verbo |
| `/consulta` | `/query` | Operación |
| `/conteo` | `/count` | Operación |
| `/reportes/:id/duplicar` | `/reportes/:id/duplicate` | El verbo cambia; `reportes` es palabra del cliente |
| `/catalogo` | `/catalog` | No es vocabulario de la red, es de la API |
| `/obs-frecuencia` | `/frecuencia-obs` | Sigue en español, con el orden correcto |
| `/tipoObs` | `/tipo-obs` | Español, kebab-case |
| `/permisos` | `/permiso` | Montaje de negocio: singular |
| `/opciones` (×3) | `/options` | **Añadida en D1.** Son las listas de los desplegables de un formulario: vocabulario de la API y no de la red, el mismo argumento con el que esta tabla traduce `/catalogo`. §5 las describe entera y nunca las pasó por esta regla |
| `/bitacora/autores` | `/bitacora/authors` | **Añadida en D1.** La creó B2 después de escribirse esta tabla. Colección inglesa, en plural como `/files` y `/orphans` |
| `/tiempos-resumen` | `/resumen-tiempos` | **Añadida en D1.** La misma inversión que `/obs-frecuencia`, y no estaba listada: en español es «resumen de tiempos» |
| `/generador` | `/generator` | **Añadida en D1.** Nombre de una funcionalidad de la aplicación, no de la red — la misma categoría que `/dashboard`. Dejarlo habría sido un montaje en español con cinco de sus seis rutas en inglés |
| `/dashboard` | sin cambio | Vocabulario de la API, no de la red: con la regla de arriba se queda en inglés. La segunda versión lo traducía a `/inicio` por el desempate que ya no existe, y `docs/ARCHITECTURE.md` seguía anunciando esa traducción hasta D1 |
| `/upload` | **fundido** en `POST /api/files/` | Cambió de decisión en D1. Era un verbo montado como recurso raíz al lado del sustantivo que gestiona los mismos ficheros, y renombrarlo por renombrarlo no arreglaba eso. Cuesta ocho llamadas en `web`, todas dentro de `uploadImage`. Su exención de permiso viaja con él — ver §3.7 |
| `/files`, `/orphans`, `/broken-refs`, `/stats` | sin cambio | Inglés, y correctos. `/stats` son los cinco de adss, material, obs, propietario y tipo-obs; el módulo de archivos tiene `/entity-stats`, que esta tabla confundía con ellos |
| `/desbloquear` | sin cambio | Verbo en español, y a propósito: §2 deja fuera las catorce rutas de autenticación y ésta es una de ellas. `naming.test.ts` la exime **por su dirección**, escrita una a una, para que no parezca un descuido |
| `/poste`, `/evento`, `/adss`, `/bitacora` | sin cambio | Sustantivos del negocio |

✅ **Hecho en D1**, y la cuenta de esta tabla era otra: la ficha de la tarea decía
«los doce renombrados» y aquí había **once** filas de cambio. Con las cuatro
añadidas arriba son **quince renombrados**, y con la fusión de la subida —que no
es un renombrado— **dieciséis** filas de cambio en total, más las siete mudanzas
de §3.2. La ficha de §9 dice quince porque cuenta sólo los renombrados; esta
tabla las lista todas.

**Lo que fija la regla es `naming.test.ts`, y lee la tabla montada.** Escrito
sobre `src/routes/*.ts` habría certificado el trabajo sin mirarlo: los dos únicos
segmentos con mayúscula de toda la API —`eventoObs` y `tipoObs`— eran prefijos de
montaje de `app.ts`, que ningún fichero de router contiene, así que ese test
habría pasado el día antes de empezar D1 y habría seguido pasando si D1 no se
hubiera hecho nunca. Clasifica cada segmento literal en una de tres listas
—sustantivo del negocio en español, inglés, o nombre de informe— en las dos
direcciones, y afirma aparte que ninguna dirección lleva un verbo en español.
`web/src/api/rutas.test.ts` es su espejo en el cliente: ejecuta las funciones y
mira la dirección que axios recibió de verdad.

**Lo que D1 no toca, dicho para que no parezca olvido:** los nombres de las
funciones de controlador. `desarchivarEvento` sigue llamándose así aunque sirva
`/restore`. Esta sección regula la superficie HTTP; renombrar setenta funciones
internas no cambia nada para quien usa la API y son sesenta ediciones más en dos
repositorios. Si se quiere, es tarea propia.

**Dos excepciones conscientes**, escritas para que no aparezcan luego como
descuidos:

- **`obs` se queda como abreviatura**, aunque el cliente diga «observación». Está
  en los modelos y en los nombres de columna, y desenredarlo cruza el límite de §2.
- **Los permisos siguen en español.** `parametros:crear` no es código: son
  **filas** en la tabla `permisos`, con índice único junto al rol. Traducirlos es
  una migración sobre la matriz de todos los roles.

### 3.5 Códigos de estado

`201` al crear, `200` al leer y al actualizar, `204` al archivar.

**Qué cuenta como crear**, porque «201 al crear» sin lista no es aplicable: `201`
cuando la respuesta representa una fila nueva, y son quince — los **once**
`create*` (eran doce hasta que `e8cf5f6` borró `createSolucion`), más
`postReporte`, `postDuplicar`, `UploadImage` y `registerVerify`, que ya lo hacía.
De esas quince, **doce cambiaron en C4** y tres ya contestaban `201`.

`POST /:id/resolver` no está entre ellas aunque **sí** inserta una fila —una
solución, dentro de su transacción—, y el motivo no es el que decía la primera
versión: no es que «cambie el estado de algo que ya existía», es que lo que
contesta no lleva nada de esa fila. Un `201` con el cuerpo vacío le habla al
cliente de un recurso que no puede leer.

**`204` donde la escritura no informa de nada**, y son veinticuatro, no diez: el
`DELETE` de las diez entidades con papelera, **los diez `desarchivar`**, el
desbloqueo de una cuenta, el borrado de un fichero, y `resolver` y `reabrir`.
Esos dos últimos los decidió Isaias el 5 de septiembre, porque §3.5 («son 200»)
y §9 («las 24 respuestas vacías pasan a 204») se contradecían y las dos rutas
estaban en las dos listas. Ganó la regla: no devuelven nada, así que contestan
`204`.

**Se escribe `res.status(204).end()`, nunca `res.sendStatus(204)`.** Medido
contra el Express instalado: `sendStatus` calcula el `ETag` **antes** de quitar
el cuerpo para un 204 y no quita esa cabecera, así que las veinticuatro
respuestas saldrían con el mismo validador, calculado sobre la cadena `"No
Content"`. `statusCodes.test.ts` lo comprueba en la respuesta real y prohíbe
`sendStatus` para cualquier 2xx en un controlador.

**`DELETE /api/files/orphans` y `/broken-refs` se quedan en `200` con su
cuerpo**, porque devuelven cuántos ficheros limpiaron y esa cifra es la única
salida de la pantalla de Archivos — un `204` no puede llevar cuerpo, y la
pantalla diría «undefined referencias limpiadas». Y una tercera, que la primera
versión no conocía: `DELETE /api/generador/reportes/:id` archiva un informe y
contesta una frase que su cliente está tipado para recibir.

**Un `500` nunca devuelve `error.message`.** Responde el mensaje neutro que ya
usa el manejador global, y el real va al log con su identificador de petición,
que `httpLogger` ya escribe. No se pierde diagnóstico: se mueve a donde sólo lo
ve quien administra.

**Pero el error esperado no se silencia con el inesperado — y eso ya estaba
pasando.** La primera versión lo escribió como un riesgo futuro: «hoy llega con
texto legible y mañana llegaría como Ocurrió un error». Al medirlo resultó ser
al revés. Todo fallo cae en el mismo `catch` desde que existe `makeHandler`, y
la fuga de texto se cerró en `7faa178`, así que **una criticidad fuera de rango
o una ciudad sin coordenadas contestaban ya un `500` mudo**: el cuerpo que
mandó el que llama, devuelto como si el servidor estuviera roto.

C4 lo arregla en `utils/handler.ts`, que es el único sitio por donde pasan los
74 manejadores: una `ValidationError`, una violación de clave ajena, una de
unicidad o una excepción de datos (SQLSTATE clase 22) contestan `400` o `409`
con una frase, y **se registran como `warn`, no como `error`** — un campo que
falta no es una incidencia y no debe compartir cubo con las que sí lo son.

Dos cosas que la implementación aprendió y conviene no volver a descubrir:

- **Nombrar la columna sólo vale en la rama de validación.** En Postgres el
  error de clave ajena llega siempre con `fields: null` —está a fuego en el
  driver—, así que esa frase se queda genérica; y la de unicidad no nombra nada
  a propósito, porque «ya existe un registro con ese correo» es una forma de
  preguntar si una dirección tiene cuenta.
- **El valor nunca viaja.** `err.errors[*].value` es el dato que falló la
  validación, y una contraseña demasiado corta sigue siendo la contraseña.
  `logger.ts` ya lo censura en el log; aquí se queda fuera de la respuesta.

El patrón viene de casa — `handleError` en
[`generador.controller.ts`](../../src/controllers/generador.controller.ts) mapea
errores tipados a `400`/`413`/`429` con su propia frase y deja lo demás en
neutro. Se extendió, no se inventó.

**Los dos códigos se quedan (decisión del 3 de septiembre).** Se planteó quitar
el `204` —es de donde salen los ocho «No se pudo archivar» falsos— y se
descartó: `201 Created` con la fila y `204 No Content` al archivar son la
semántica de HTTP tal cual, e Isaias pidió buena práctica y no comodidad. El
coste se paga en el corte de §11, con el cliente arreglado en el mismo
despliegue. **Y C4 es cliente primero, no maniobra de tres pasos:** un código de
estado no admite «el servidor acepta las dos formas».

**Los códigos van en el mismo tramo que la capa cliente (C4 en §9), y por eso.**
El frontend compara literalmente contra `200` en decenas de sitios —la primera
versión decía trece, y la auditoría del 26 de agosto encontró 57 comparaciones
repartidas en 25 ficheros, de las que al menos quince rompen de verdad—. La cifra
exacta se recuenta al empezar C4 y vive en su test, no aquí. Desplegar `201`/`204`
antes de arreglarlos significa que cada archivado correcto muestra «No se pudo
archivar» y la fila sigue en pantalla, y que cada alta correcta muestra «No se
pudo crear» sobre algo que sí se creó — con el riesgo de que la persona reintente
y duplique. En `AddRevisionSheet` el comentario del propio fichero documenta que
ese fallo ya ocurrió una vez y costó una inspección de campo. Y su test mockea
`200` como éxito, así que seguirá verde con la pantalla rota.

### 3.6 El formato de error, que casi está resuelto

`{ message }` en toda respuesta de error, garantizado por el manejador global de
`app.ts` incluso para lo que falla antes de llegar a un controlador. Esto no se
decide: se documenta. Con dos correcciones que la primera versión daba por
hechas y no lo estaban:

- **Las respuestas sin `message`, recontadas el 4 de septiembre** porque el
  inventario de la tercera versión estaba caducado en las dos direcciones. Los
  dos `res.status(500).send("…")` de `upload.controller.ts` **ya no existen**:
  los quitó `3288fcc`. Y los `res.sendStatus(401)` no eran nueve sino **24** —que
  además no mandan cuerpo vacío, mandan `Unauthorized` en texto plano—: 22 son de
  la sesión de autenticación y 2 eran de éste, en `requirePermission.ts`. ✅ Esos
  dos llevan ya `{ message }`. Ninguna de las dos ramas es alcanzable por HTTP
  hoy —`authenticate` siempre rellena `id_rol`, y `routeGuards.test.ts` exige
  `authenticate` delante de toda ruta con puerta—, así que es defensa en
  profundidad y se verifica contra el middleware, no con una petición.
- ✅ **El manejador de 404**, hecho en A2. Una ruta que no existe no es un error,
  así que no llegaba al manejador global: caía en el `finalhandler` de Express,
  que responde **HTML** y además refleja el método y la ruta pedidos. Es
  prerrequisito de D1: mover direcciones es justo lo que fabrica 404s, y los 17
  sitios del cliente que leen `error.response.data.message` recibían `undefined`
  y enseñaban su propia frase genérica. **Global y no acotado a `/api`**, porque
  este proceso sólo sirve la API y el montaje de imágenes; y **de tres
  parámetros**, porque con cuatro Express lo trataría como manejador de error y
  dejaría de existir en silencio. Ojo con una cosa que la auditoría previa fijó:
  una ruta **no**-API no llega aquí, la contesta `authenticateArchivos` con 401
  antes de mirar el disco, y eso es a propósito — si contestara 404 para un
  fichero que falta y 401 para uno que existe, el montaje sería un oráculo para
  adivinar nombres de fotografías.

### 3.7 Toda ruta declara su permiso, lecturas incluidas

**Cuatro excepciones dentro de este alcance**, no tres. Cada una porque no puede
ser de otra forma:

- `POST /api/auth/login` — es lo que produce la credencial.
- `GET /api/auth/me` — es de donde salen los permisos; pedir un permiso para
  saber qué permisos tienes no se sostiene.
- `GET /api/auth/sessions` — son las tuyas: el identificador sale de `req.user`.
- **`POST /api/files/`** — sirve tres pantallas a la vez y una es la fotografía
  de tu propio perfil, así que atarla a un módulo dejaría fuera a alguna. Su
  router lo argumenta. **No es de autenticación y está dentro de las 104**, así
  que la primera versión, leída como norma, ordenaba cerrarla contra el
  razonamiento escrito en su propio fichero.

  D1 la trajo aquí desde `POST /api/upload/` y la excepción **se conserva
  entera**, que es lo que hace que la fusión no cueste nada: se monta sin
  `requirePermission` dentro de un router donde las otras seis rutas sí lo
  llevan, y eso está marcado en el fichero. Dos cosas medidas antes de moverla,
  por si alguien intenta «uniformarla»: el rol Coordinador y el rol Cliente **no
  tienen** el módulo `archivos`, así que ponerle esa puerta deja sin subir
  fotografías justo a quien las toma en campo; y la acción `archivos.crear` **no
  existe** —la migración `20260826000004` borró esas filas— así que pedirla es un
  403 para todos los roles, administrador incluido.

  Lo que sí la protege es el cubo de 30 por minuto y por cuenta, y va **en la
  línea de la ruta y no en el router**: como `router.use(uploadLimiter)` lo
  gastaría la pantalla de Archivos, que consume cuatro peticiones cada vez que se
  abre. `uploadLimiters.test.ts` lo comprueba leyendo el fuente, y también que
  siga por delante de multer.

**Hay dos listas de exenciones, no una.** `READ_GATE_NOT_APPLICABLE` para
lecturas y `GATE_NOT_APPLICABLE` para escrituras, y el criterio de terminado de
la primera versión sólo miraba la primera — con lo que no se habría enterado de
que `/api/upload/` seguía sin puerta.

**Criterio de terminado:** `READ_GATE_NOT_APPLICABLE` queda vacía de todo lo que
no sea autenticación. Lo comprueba el test que ya existe. ✅ Cumplido en C5: sólo
quedan las cuatro que contestan sobre quien pregunta. Y el criterio se quedaba
corto —lo dice la propia auditoría previa—: vaciar la lista prueba que hay
puerta, no que pida lo que debe, así que C5 añadió once routers a la
comprobación de completitud para que el **par** quede fijado en las dieciocho.

### 3.8 La propiedad no es un permiso

`requireSelfOrPermission` ya existe y ya está razonado: tu propia ficha, tu
contraseña y tu bitácora se alcanzan sin permiso de módulo, porque exigirlo
impediría que alguien cambiase su propia contraseña. No tiene casilla en la
matriz y no debe tenerla.

**Y el tercer argumento tiene que nombrar el parámetro que la ruta declara.** El
middleware lee `req.params["id"]` por omisión, y su docstring documenta esta
trampa como ya cometida una vez: en una ruta cuyo parámetro se llama de otra
forma, la comprobación de propiedad compara contra `undefined` y no coincide
nunca, así que la puerta degrada a permiso-solo y todo el que no tenga el módulo
pierde su propia ficha sin que nadie se entere.

🔴 **D1 le dio la vuelta al peligro, y este párrafo decía lo contrario.** Decía
que `GET /api/bitacora/:id_usuario` lleva el argumento «y las rutas nuevas se
escriben igual» — instrucción que hoy produce el fallo. Las dos rutas que lo
necesitaban se movieron bajo `/api/usuario/:id` (§3.2), así que sus parámetros se
llaman `id` y el valor por omisión es el correcto: **hoy la equivocación es
arrastrar el `"id_usuario"` viejo, no omitirlo.** Lo miden `evento.self.test.ts` y
`bitacora.self.test.ts`, y no puede medirlo nada más: leer la cadena de
middlewares no manda ninguna petición, y las demás suites simulan el permiso a
`true`, con lo que la otra rama contesta primero.

### 3.9 Lo que entra también tiene forma — *ya hecho*

Esta regla no estaba en la primera versión, y es la que produjo el hallazgo más
grave de la auditoría. Está implementada y verificada antes que este documento
(commits `ce91b1b` y `64431bf`); queda escrita porque es la regla, no la
anécdota.

**Ninguna escritura entrega el cuerpo de la petición a un modelo sin filtrarlo.**
`id`, `createdAt`, `updatedAt` y `deletedAt` no son cosas que un cliente elija.

Lo que pasaba: todos los modelos que estos controladores editan son
`paranoid: true`, así que **`deletedAt` es la papelera**. `authoredBy` la
descartaba al crear; `withoutAuthor` no la descartaba al editar; y siete
controladores de catálogo no pasaban por ninguno de los dos. Un `PUT` con
`deletedAt` en el cuerpo archivaba la fila — y el rol Coordinador está definido
con `archivar: false` en nueve de los diez módulos y `editar: true` en cinco, así que la
columna `archivar` de la matriz era decorativa para quien pudiera editar.

**Y ningún `include` manda más de lo que la pantalla lee.** `PosteModel` ganó
`id_usuario` con la autoría y no estaba en la lista de modelos vigilados, así que
`GET /evento/:id` y los tres informes fijos entregaban el autor de cada poste a
cualquier cuenta. La bitácora mandaba el nombre de cuenta de cada persona
saltándose la constante que existe para eso.

**Queda pendiente la mitad ancha de esta regla, y C5 no la hizo:** veinticinco
`include` siguen devolviendo la fila completa de ciudad, material o propietario
donde la pantalla sólo usa el nombre. Esta ficha decía que iba «en el mismo
tramo» que C5, y se dejó fuera a propósito el 2026-09-05: es **peso, no fuga de
autoría** —lo dice esta misma línea—, mientras que C5 es autorización; y
recortar veinticinco proyecciones cambia la forma de las respuestas que leen
muchas pantallas, así que necesita su propia pasada y su propia auditoría de qué
campo lee cada una. Tarea propia, no un añadido.

---

## 4. Las reglas del cliente

### 4.1 El cliente lanza, no devuelve

Las funciones que hacen `.then(r => r.status).catch(() => 400)` —cuántas son y en
cuántos módulos se recuenta al empezar C4, no aquí— pasan a devolver los datos y
a propagar el fallo. Hoy un `403` por permiso, un `500` del servidor y una red
caída llegan los tres como el número 400, así que la información se destruye en
la capa de API antes de que la pantalla pueda verla, y sólo cabe un mensaje.

El criterio contrario ya existe en parte del repositorio, y la primera versión lo
describió mal: `generador.api.ts` propaga y traduce con `mensajeDeError()`;
`Files.api.ts` propaga, pero su pantalla descarta el mensaje; y `Permisos.api.ts`,
`Usuario.api.ts` y `Revision.api.ts` ya devuelven el status y el mensaje reales.
`mensajeDeError` **no** vive en `Files.api.ts`.

### 4.2 Dónde vive el normalizador, y con qué rechaza

En `api/http.ts`, que se importa por efectos desde `main.tsx` antes de que monte
React. **Y rechaza con el `AxiosError` original enriquecido** —
`error.normalized = { status, message }` — **nunca con un objeto nuevo.**

Esto no es un detalle de implementación: hay **dos** interceptores de respuesta
hoy, no uno. El de `SesionProvider.tsx` lee `error.config`,
`error.response?.headers` y `error.response?.status === 401` para aprender el
vencimiento de la sesión y para cerrar sesión. Y el de `api/stepUpInterceptor.ts`,
instalado desde `http.ts` al cargar el módulo —o sea, **antes**—, lee
`error.config`, `error.response.status` y `error.response.data.code` para abrir
la ventana del segundo factor y reintentar la petición. Axios ejecuta los
interceptores en orden de registro. Un normalizador que rechace con un objeto
plano deja a los dos sin `config` ni `response`: **el 401 deja de detectarse y una
sesión revocada ya no echa a nadie**, y **la ventana del segundo factor deja de
abrirse**. Silencioso, y ningún test actual lo vería.

**Por eso el normalizador se registra después de `instalarInterceptorStepUp()`**,
en la línea siguiente de `http.ts`, y rechaza con el error original. Una
petición que el interceptor de step-up reintentó con éxito llega al normalizador
como éxito; la segunda versión no sabía que ese interceptor existía.

Un fallo sin respuesta lleva `status: 0` y el mensaje «Sin conexión con el
servidor».

---

## 5. Las opciones de los formularios

Tres endpoints, uno por formulario que necesita listas para sus desplegables.
Cada uno con **un** permiso. **Hechos y montados** (B1, `6f31a26`).

```
GET /api/poste/options     → postes:ver
    { adss, material, propietario, ciudad }

GET /api/evento/options    → eventos:ver
    { obs, tipoObs }

GET /api/reporte/options   → reportes:ver
    { ciudad, adss, material, propietario, obs, tramos }
```

Eran cuatro. El cuarto, `GET /api/usuario/options → roles:editar { rol }`, se
descartó el 3 de septiembre: ver §5.3.

### 5.1 Por qué tres y no uno

La primera versión proponía un `GET /api/catalog` único con ocho bloques y una
tabla de dos a cinco condiciones «o» por bloque. No podía funcionar, y por una
razón mecánica: `routeGuards.test.ts` decide si una ruta está protegida leyendo
un sello de **un solo par** `modulo.accion`. Una ruta con ocho grupos de
condiciones no cabe en ese sello, y los tres caminos posibles acababan igual — o
la ruta contaba como no protegida, o veintitantas decisiones de permiso se
mudaban a un `if` dentro de un controlador que nada comprueba. El comentario de
`requirePermission.ts` explica que el sello existe precisamente porque «*una ruta
con el par equivocado pasaba el test igual que una con el correcto, que es el
error más probable de todos*».

La pregunta que lo decide: **¿existe alguna dirección que sirva legítimamente a
varios módulos?** No. El caso real era «cuatro formularios necesitan listas», y
eso son cuatro direcciones. El sello multi-permiso habría resuelto un problema
creado al juntar cosas que no tenían por qué ir juntas.

### 5.2 Cada endpoint sabe para qué se usa su respuesta

Ésta es la ganancia que el diseño único no podía tener, y que arregla tres fallos
sin ninguna regla especial. La primera versión prometía `{id, name}` para los
ocho bloques, y con eso:

- **el mapa de `PosteSheet` y la línea de `ReportRecorrido` dejaban de dibujarse**,
  porque `CiudadInterface` declara `lat` y `lng` obligatorios y las dos pantallas
  los leen del catálogo. Las guardas `if (!a?.lat …)` salen por la primera línea:
  cero errores en consola, la pantalla llamada «Recorrido» sin recorrido;
- **el selector de observaciones de los dos formularios de evento se quedaba
  vacío**, porque agrupa por tipo con `listObs.filter(o => o.id_tipoObs === …)`.
  No es un `undefined.map`: es una lista vacía, que se lee como «no hay
  observaciones configuradas» y guarda el evento sin ellas;
- **`tramos` no podía cumplir el contrato**: un tramo no tiene `id` ni `name`, es
  un par `{id_ciudadA, id_ciudadB}`.

Con un endpoint por formulario, la forma de cada bloque la fija quien la va a
consumir:

| Endpoint | Bloque | Campos |
|---|---|---|
| `/api/poste/options` | `ciudad` | `id, name, lat, lng` — el formulario dibuja un mapa |
| | `adss`, `material`, `propietario` | `id, name` |
| `/api/evento/options` | `obs` | `id, name, id_tipoObs` — el selector agrupa por tipo |
| | `tipoObs` | `id, name` |
| `/api/reporte/options` | `tramos` | `id_ciudadA, id_ciudadB` — pares, no filas |
| | `ciudad` | `id, name, lat, lng` — **`ReportRecorrido` traza la línea con ellas**; sin `lat`/`lng` la guarda sale por la primera línea y la pantalla se dibuja sin recorrido |
| | resto | `id, name` |

Los archivados no viajan. Y `ciudad` apareciendo en tres respuestas no es
duplicación: son proyecciones distintas para consumidores distintos, servidas por
código compartido.

### 5.3 El cuarto endpoint, descartado

La segunda versión tenía `GET /api/usuario/options → roles:editar { rol }`, y
razonaba el permiso: quien asigna un rol necesita `roles:editar`, y sin él
`createUsuario` responde 403 y escribe `ROLE_CHANGE_DENIED` con severidad
`critical` en la bitácora. Eso sigue siendo cierto y sigue estando en
`createUsuario`.

Lo que la auditoría del 3 de septiembre añadió, y decidió la cuestión: `GET
/api/rol/` **ya sirve exactamente `{id, name}` a la misma pantalla**, y §6 le
asigna `roles:ver`. Servir la misma lista en una segunda dirección bajo un
permiso *distinto* no cierra nada: un rol que pueda editar usuarios sin
`roles:editar` —que el editor de la matriz puede crear— habría recibido 403 en
el desplegable de roles al abrir la ficha, y `UsuarioSheet` no tiene `.catch`
en esa carga, así que la ficha se quedaba en gris para siempre. Decisión del 3
de septiembre: **no existe**. `UsuarioSheet` sigue con `getRol()`, y el
manejador que ya estaba escrito se borró en `7faa178`.

### 5.4 La bitácora sirve sus propios autores

```
GET /api/bitacora/authors    → bitacora:ver
```

Declarado **antes** de `GET /:id_usuario` cuando se escribió esta sección (§3.2)
— **ese hermano paramétrico ya no está en este router**: D1 lo movió a
`GET /api/usuario/:id/bitacora`, así que hoy `/authors` no compite con nada y su
antiguo test de sombra medía una carrera que ya no existe. La regla de §3.2 sigue
en pie de forma general y `routeOrder.test.ts` la vigila; aquí simplemente no
tiene nada que atrapar. Devuelve id y nombre de quien
tiene entradas.

✅ **Hecha.** La pantalla rellenaba su filtro llamando a `GET /api/usuario/`,
que exige `seguridad:ver`. Un rol con `bitacora:ver` y sin `seguridad:ver` recibe
un 403 que la llamada descartaba con un `.catch(() => {})` vacío: el desplegable
aparecía con «Todos» y nada más. Parece que no hay usuarios.

**A ningún rol sembrado le pasa hoy**, y conviene decirlo con la misma
honestidad que §9 exige del resto: el rol 1 tiene los dos permisos, y los roles 2
y 3 no tienen bitácora, así que quien puede abrir la pantalla puede llamar al
directorio. Esto es endurecimiento, no una avería viva. Lo que lo hace real es
que el editor de la matriz crea ese rol en dos clics, y nadie habría sabido por
qué el filtro salía vacío.

**Los archivados sí van en la lista, y llevan `deletedAt` para poder marcarlos.**
Es la decisión que faltaba por escribir: son justo a quien busca alguien que
revisa trabajo antiguo —una persona que ya no está—, y el directorio los deja
fuera por defecto, que es como lo llamaba la pantalla (`GET /api/usuario/` sí los
devuelve con `?archived=true`). El desplegable los muestra como «Nombre Apellido
(archivado)».

**Y sólo el desplegable.** En las filas de la tabla el autor aparece sin marca, y
es una decisión, no un olvido: marcarlas exigiría que `deletedAt` viajara también
en el `include` de autor, y ese `include` tiene un techo —`USUARIO_AS_AUTHOR`,
vigilado por `responseShape.test.ts`— que existe porque este mismo controlador
llegó a mandar el nombre de usuario escribiendo su propia lista. Ensanchar el
techo de **todos** los includes de autor de la aplicación para añadir un
paréntesis a una tabla es mal negocio. La marca va donde alguien **elige** entre
personas y dos pueden leerse igual; en las filas, el nombre dice quién hizo algo,
y eso no cambia porque esa persona se vaya.

**Sí hay una ampliación, pequeña y deliberada**, y la primera redacción de este
párrafo la negaba con un argumento circular: decía que los nombres «ya viajan en
las propias filas del log», y para las cuentas archivadas eso sólo es cierto
**desde este mismo cambio** —el `include` que se citaba como prueba es el que B2
arregló—. Y `deletedAt`, la fecha en que se archivó una cuenta, no viajaba bajo
`bitacora:ver` por ningún sitio.

Dicho con precisión: quien pueda leer la bitácora podrá saber también cuáles de
sus autores ya no están, y desde cuándo. Es lo que se busca, no un efecto
colateral —una lista de autores que omite a quien se fue es la lista equivocada
para un registro que se consulta justo para revisar su trabajo—, pero es una
ampliación y llamarla «ninguna» estaba mal. Lo que sigue sin poderse preguntar
por aquí es quién trabaja en la empresa: una cuenta que nunca tocó el sistema no
aparece.

### 5.5 Qué asume el frontend

Un endpoint de opciones puede responder 403 —si el rol no tiene el permiso de esa
pantalla— pero **nunca devuelve un bloque a medias**. La pantalla que lo pida
maneja el 403 como lo que es: no puede usar ese formulario.

Los consumidores que se migran en C2: `PosteSheet`, `ReportTramoSec`,
`ReportGeneralSec`, `ReportRecorrido`, `EventoSheet`, `AddEventoPageSheet` y la
edición en línea de `poste/index.tsx`. `UsuarioSheet` no: sigue con `getRol()`
(§5.3). Las cinco pantallas de
Parámetros y `CiudadesPage` siguen con los endpoints de administración, que es lo
suyo.

**Y una corrección de la auditoría previa de C2, porque el aviso de §9 nombraba
las pantallas equivocadas.** Decía que `poste/index.tsx` y `PosteSheet` se
muestran detrás de `postes.editar`/`crear` y no de `ver`. Medido: las dos cuelgan
de `<ModuleRoute modulo="postes">`, que ya exige `postes.ver` y redirige sin él,
así que el rol descrito no llega ni a montarlas. Los dos huecos reales son otros:
la **pantalla de inicio**, que pide `eventos.ver` y abre `PosteSheet` sólo tras
`postes.editar`; y **`EventoSheet` abierto desde las pantallas de postes**, por
lo mismo contra `/api/evento/options`. Ninguno afecta a un rol sembrado, pero la
matriz se edita en producción desde el 18 de agosto, así que la siembra ya no es
prueba de nada.

**Y dos que la primera versión se dejó fuera llamándose «la lista completa».** La
auditoría del 26 de agosto las encontró, y las dos importan porque son el único
camino hacia un dato que ningún endpoint de opciones sirve todavía:

- `useTramoNeighbors.ts` era el **único** llamante de `GET /api/poste/tramos`.
  ✅ Resuelto en C2, y con una vuelta de tuerca que la auditoría previa obligó a
  dar: el hook **recibe** los pares, no los pide. Si los pidiera él, cada
  pantalla de informes llamaría dos veces al mismo endpoint por montaje —el
  `GROUP BY` sobre `postes` incluido— que es estrictamente peor que las dos
  peticiones distintas que sustituye. Y como el bloque `tramos` pasa a ser la
  única fuente, **C2 retira `GET /api/poste/tramos`**: se quedaba sin un solo
  llamante en los dos repositorios.
- `AddEventoPageSheet` pide el listado de postes con `exportPostes()`, o sea con
  `?export=true`, que C3 borra. `/api/evento/options` cubre sus otros dos
  catálogos pero no los postes, y **añadir un bloque de postes ahí sería servir
  el registro de postes bajo `eventos:ver`, que es peor que el problema.** Queda
  como decisión de C3, no de C2, y hay que tomarla antes de quitar `export=true`.

---

## 6. Cómo quedaron las dieciocho lecturas

✅ **Hecho en C5, el 2026-09-05.** Las dieciocho llevan puerta. Lo que sigue es
lo que se construyó, no lo que se planeaba.

**Con las direcciones que tenían al cerrarse C5**, que es cuando se escribió esta
tabla: siete de ellas las movió D1 el mismo día, y las nuevas están en §3.2. Se
dejan como estaban a propósito — esta sección cuenta lo que hizo C5, y traducirla
al vocabulario de la tarea siguiente es lo que hacía la primera versión, que
obligaba a traducir de vuelta para comprobar nada.

Eran veinte cuando se escribió esta sección. Fueron **dieciocho** al hacerlo, y
no porque se hubieran cerrado: A1 borró `GET /api/solucion/` y C2 retiró
`GET /api/poste/tramos`. La cuenta viva está en `READ_GATE_NOT_APPLICABLE`, en
`routeGuards.test.ts`, donde hoy quedan sólo las cuatro exenciones de verdad —
las cuatro que contestan sobre quien pregunta y sobre nadie más.

**Y desde C5 el par queda fijado, no sólo la presencia de la puerta.** Antes,
`MODULOS_TABULADOS` sujetaba siete routers; ahora sujeta diecisiete, que son
aquéllos más los once que C5 cerró. Sin eso, once de las dieciocho puertas
habrían quedado comprobadas como «existe una puerta» y nunca como «pide lo que
debe»: poner `bitacora:ver` en `GET /api/ciudad/` —un par declarado, así que el
vocabulario lo acepta— habría dejado la batería entera en verde. Para
conseguirlo, `PARAMETROS_GATES` dejó de ser parcial a propósito: nombra las
treinta rutas con puerta de sus cinco routers, y hay una tabla nueva para
ciudades.

| Permiso | Rutas |
|---|---|
| `parametros:ver` | `GET /api/{adss,material,obs,tipoObs,propietario}/` |
| `postes:ver` | `/api/poste/`, `/api/poste/:id`, `/api/adssposte/:id_poste` |
| `eventos:ver` | `/api/evento/`, `/api/evento/:id`, `/api/evento/poste/:id_poste`, `/api/eventoObs/:id_evento`, `/api/revision/:id_evento`, `/api/solucion/evento/:id_evento` |
| `seguridad:ver` | `/api/evento/usuario/:id_usuario` |
| `ciudades:ver` | `/api/ciudad/`, `/api/ciudad/:id` |
| `roles:ver` | `/api/rol/` |
| se borra | `GET /api/solucion/` |

**`/api/evento/usuario/:id_usuario` lleva `seguridad:ver`, no `eventos:ver`.** El
rol Cliente **tiene** `eventos:ver`, así que con el permiso de la primera versión
podía recorrer `/api/usuario/1/eventos` … `/api/usuario/20/eventos` y armar el
expediente de actividad de cada empleado — y ese controlador no declara
`attributes`, así que devuelve la fila entera de cada evento. La misma pregunta
«qué ha hecho esta persona» ya tiene dos respuestas en el código y ninguna es
`eventos:ver`: el generador no deja hacer informes con las personas como raíz
sin `seguridad.ver`, y la bitácora usa
`requireSelfOrPermission("bitacora","ver",…)`.

🔴 **Y el tercer argumento no es opcional.** `requireSelfOrPermission` recibe el
nombre del parámetro de la ruta y **por defecto vale `"id"`**, mientras que ésta
se llama `:id_usuario`. Sin pasarlo, la rama de «es tu propia fila» compara
contra `undefined`, nunca casa, y la puerta degrada a permiso puro: todo el que
no sea administrador pierde su propio historial, en silencio, porque la pantalla
de perfil se traga el fallo e imprime «Eventos atendidos: 0». Ya pasó una vez en
la bitácora. Ni `routeGuards.test.ts` puede verlo —lee el par de la cadena
montada y no hace peticiones— ni `listShape.test.ts` —simula todos los permisos
a `true`, así que contesta la otra rama—. `evento.self.test.ts` existe para esa
línea, y pide sin el permiso: la tuya devuelve 200, la de otro 403, y con el
permiso la de otro devuelve 200.

**Cinco advertencias sobre lo que este cierre no consigue**, para no vender
humo. Las dos primeras estaban desde la primera versión; la tercera y la cuarta
las encontró la auditoría del 26 de agosto; la quinta, la previa de C5. Dicho de
una vez y en una frase: **C5 quita alcance ambiental, no cierra los datos.**

- **Gatear la topología de la red no la cierra**, y la advertencia ha cambiado
  de dirección sin cambiar de fondo. Se escribió sobre `GET /api/poste/tramos`,
  que C2 retiró; los mismos pares viajan hoy por dos sitios: el bloque `tramos`
  de `GET /api/reporte/options`, bajo `reportes:ver` —que el rol Cliente
  tiene—, y `GET /api/poste/`, que proyecta `id_ciudadA`/`id_ciudadB` en cada
  fila y que C5 puso bajo `postes:ver`. Y por debajo sigue el generador: el rol
  Cliente tiene `generador: TODO`, y sirve `ciudad` con `lat`/`lng` sin marca de
  personal. Se cierra por coherencia, no porque proteja.
- **`parametros:ver` sobre los cinco catálogos esconde poco** mientras
  `searchPoste` y `searchEvento` incluyan material, propietario y ciudades sin
  `attributes`. Esta línea decía que por eso los veinticinco `include` de §3.9
  iban «en el mismo tramo»; C5 los dejó fuera a propósito y §3.9 explica por qué:
  aquello es peso y esto es autorización, y recortar veinticinco proyecciones
  cambia la forma de lo que leen muchas pantallas. Sigue siendo verdad que
  cerrar la puerta principal y dejar la de servicio abierta no es cerrar — por
  eso está escrito aquí y no borrado.
- **Y los propios endpoints de opciones vuelven a servir esos catálogos bajo
  otros permisos.** `/api/poste/options` entrega adss, material y propietario
  con `postes:ver`; `/api/evento/options` entrega obs y tipoObs con
  `eventos:ver`; `/api/reporte/options` entrega cuatro de los cinco con
  `reportes:ver`. El rol Cliente tiene los tres. O sea que para los tres roles
  sembrados hoy, **cerrar `parametros:ver` no le quita a nadie el acceso a los
  nombres de los catálogos.** Eso no invalida el diseño —una pantalla que puede
  ver postes puede ver las opciones del formulario de postes, y §5.1 explica por
  qué el permiso es el del formulario— pero sí obliga a decir con precisión qué
  se cierra: la vista de administración, con `description`, las marcas de tiempo
  y el `?archived=true`. No los nombres. §1 lo vendía como un cambio de capacidad
  y para los roles de hoy no lo es.
- **Y hay dos segundas direcciones más grandes que las dieciocho, que siguen
  abiertas.** `GET /api/dashboard/` pide `eventos:ver` y devuelve **el registro
  entero de postes** sin `where` ni `limit`, así que `postes:ver` sobre
  `GET /api/poste/` no es una frontera: quien pueda ver incidencias ve todos los
  postes. Y el generador sirve `evento`, `poste`, `ciudad`, `revision`,
  `eventoObs` y `solucion` como niveles de detalle a quien tenga
  `generador:ver`, que los tres roles sembrados tienen entero. Seis de las
  dieciocho tienen ahí una segunda puerta. Ninguna de las dos es motivo para no
  hacer C5; las dos son motivo para no decir que C5 cerró los datos de postes o
  de incidencias.
- **La lectura más grande de la API no está en esta lista y el test no puede
  verla.** Las fotografías se sirven con `express.static`, que es un middleware
  sin ruta, y `routeGuards.test.ts` sólo enumera rutas. **Lo que la segunda
  versión decía de ese montaje ya no es verdad**, y la auditoría del 3 de
  septiembre lo desmintió: decía «en la raíz, once líneas antes del primer
  `authenticate`, servida a cualquiera sin sesión». La sesión de autenticación lo
  movió debajo de todos los routers y detrás de `authenticateArchivos`
  (`a90ff35`, `0d4f244`), con su test. Lo que queda es distinto y menor:
  **cualquier sesión viva ve cualquier fotografía**, sea de su poste o no, y los
  nombres se adivinan —van con el reloj en milisegundos— y viajan en respuestas
  sin permiso. C5 se declara terminado con eso escrito, no con la frase vieja.
  Cerrarlo del todo es un arco propio: permiso por objeto, o URL firmada.

---

## 7. Las siete rutas que se borran

Sin ningún cliente en `web`, con sus controladores:

```
POST   /api/solucion/       GET    /api/solucion/
PUT    /api/solucion/:id    DELETE /api/solucion/:id
PUT    /api/revision/:id    DELETE /api/revision/:id
GET    /api/files/
```

Comprobado el 26 de agosto contra el código y contra la historia de `web`, no
contra este documento. El árbol tiene dos consumidores —`api` y `web`—, así que
«sin cliente en `web`» quiere decir «sin cliente en ninguna parte».

**Cuatro no pierden nada.** `GET /api/files/` devuelve la lista del disco a
secas y `GET /api/files/orphans` devuelve lo mismo más quién usa cada fichero:
es un subconjunto estricto. Las tres de `solucion` las reemplazó
`POST /api/evento/:id/resolver` con su pareja `reabrir` — el cliente de
`getSolucion` y `deleteSolucion` se fue en `4d1b4fe` (17 de marzo) y el de
`createSolucion` en `0c6f4d2` (3 de mayo), el mismo commit que trajo `resolver`.
Y no son solo redundantes: crean o quitan la solución **sin** tocar
`evento.state`, mientras `resolver` y `reabrir` hacen las dos cosas en una
transacción. `POST /api/solucion/` deja un evento arreglado que la lista sigue
mostrando abierto; `DELETE /api/solucion/:id` deja un evento resuelto sin
registro de cómo se resolvió. `GET /api/solucion/` encima no declara ningún
permiso —lo dice su propio controlador—, así que borrarla cierra una lectura
abierta a cualquier sesión.

**Tres no tienen cliente hoy, y ahí está el matiz.** `PUT /api/solucion/:id`,
`PUT /api/revision/:id` y `DELETE /api/revision/:id` son el único sitio del
sistema donde se corrige un registro ya escrito.

Corrección de la primera redacción de este apartado, que decía que las tres
«no aparecen en la historia de `web` ni una sola vez». Es cierto para las dos de
`revision`, y **falso para la de `solucion`**: el cliente la llamaba desde 2024
bajo el nombre `editSolucion`, y se retiró en `4d1b4fe` (17 de marzo) junto con
el resto del CRUD. El error de comprobación fue buscar en el repositorio del
cliente el nombre que usa el servidor. El dato correcto **refuerza** el borrado
en vez de debilitarlo: no es una ruta que nadie quiso nunca, es una que se
retiró a propósito hace cinco meses.

Se borran igual, y la razón es que **hoy no dan esa capacidad**: sin pantalla
que las llame, corregir una solución ya exige entrar a la base de datos. Lo que
se pierde no es una función, es una puerta sin cerradura. «Corregir un registro
ajeno» trae detrás una pregunta de permisos que nadie ha contestado —¿un Técnico
corrige la suya, la de otro, hasta cuándo?— y una ruta muerta no la contesta:
sólo espera a que alguien la enchufe sin pensarla.

**Pendiente de producto, anotado aquí para no perderlo.** Corregir una solución o
una revisión necesita pantalla, permiso propio y rastro en la bitácora, igual que
la gestión de roles. Mientras no exista, la única salida sigue siendo reabrir y
volver a resolver — y conviene saber que reabrir **borra la foto del disco de
forma irrecuperable** (`deleteImageFile(solucionImage)` en `evento.controller.ts`),
aunque la fila sobreviva porque el modelo es `paranoid`.

**Lo que cuesta borrarlas, que es más de lo que decía la primera redacción.** Son
dos ficheros de test, no uno:

- `authorship.test.ts` —el que vigila el agujero de `deletedAt`— llama
  directamente a `createSolucion`, `updateSolucion` y `updateRevision`. Son
  **cinco** casos, no cuatro, y uno de ellos no se reescribe: el que fija la rama
  sin `:id` de `updateRevision`, que también crea, no tiene equivalente en ningún
  sitio después. Ése se borra.
- `routeGuards.test.ts`, que §12 declara intocable, nombra tres de las rutas que
  se van: `GET /api/solucion/` en `READ_GATE_NOT_APPLICABLE`, y las dos de
  escritura de `revision` en `EVENTOS_GATES`. Si no se quitan a la vez, **la
  suite queda roja** — y es justamente el fichero que gobierna la seguridad de
  las 105 rutas, así que dejarlo rojo un rato no es una opción.

Y quedan seis imports huérfanos que tumban el lint. El agujero sigue vigilado; se
vigila desde otra puerta.

**Las cuatro de `/api/rol` no entran en este apartado.** La gestión de roles la
lleva otra sesión. `POST /api/rol/`, `PUT /api/rol/:id`, `DELETE /api/rol/:id` y
`PATCH /api/rol/:id/desarchivar` se quedan donde están, este documento no las
toca, y el recuento las cuenta como vivas.

La primera redacción decía aquí que `RolModel` no era `paranoid` y que el
`DELETE` destruía las 40 filas de permisos en cascada. **Ya no es cierto**, y
dejó de serlo dieciocho minutos antes de que se escribiera: el commit `0c91d55`
puso `paranoid: true` en el modelo, añadió la migración que le da su columna de
archivado, y metió un `409` que se niega a archivar un rol mientras haya cuentas
usándolo. Es el ejemplo exacto de por qué §9 pone que **cada tarea se audita
antes de empezarla**: en este árbol trabajan tres sesiones y un párrafo puede
nacer caducado.

Recuento, y esta vez contado en vez de arrastrado. **Hoy hay 133 rutas
montadas, de las cuales 27 son de la familia de autenticación: 106 fuera de
ella.** Ése es el número de hoy, y es el que el resto de este documento debería
usar cuando dice «105» —una cifra del día en que se escribió, ya movida por dos
planes de autenticación y por B2—.

La proyección es otra cosa y conviene no confundirlas: **cuando las familias C y
D hayan retirado sus 7 rutas, quedarán 99.** La tercera versión escribía «105 − 7
+ 5 = 103» y la cuarta lo corrigió a 102 arreglando sólo el sumando —el cuarto
endpoint de opciones se borró en `7faa178`, §5.3— sin volver a derivar la base,
que era el error de verdad. Sirve de recordatorio de la advertencia que gobierna
todo este documento desde la segunda auditoría: **estas cifras son para entender
el tamaño, no para firmar nada.** Cinco rutas no-auth desaparecieron entre el día
del spec y hoy sin que ningún recuento se enterara. El manejador de 404 de §3.6 tampoco entra en la
cuenta: no es una ruta, es lo que responde cuando no hay ninguna.

---

## 8. Lo que se descartó, y por qué

**El sello multi-permiso para un catálogo único.** Ver §5.1. Habría tocado la
infraestructura de permisos —lo que gobierna las 105 rutas a la vez— para
resolver un problema creado al juntar ocho listas en una puerta.

**Todo en inglés.** Era la lectura literal de la regla de la casa, y llevaba a
dos sitios malos: traducir el vocabulario del negocio empeora los nombres (§3.4),
y los permisos son datos, así que el estándar nacía con una excepción forzosa.

**Todo en español.** Obliga a pelearse con Sequelize por `createdAt` y
`deletedAt` en diecinueve modelos para no ganar nada que nadie note.

**Sobre sólo donde hoy hay paginación.** Era la opción barata: no tocaba ningún
consumidor. La clasificación «acotada / no acotada» es una apuesta sobre el
futuro, y cuando falla el arreglo es un cambio de contrato que rompe clientes.

**Sobre también en el detalle**, `{ data: {…} }`. Ceremonia sin destinatario, y
en el caso de `/evento/:id/solucion` habría convertido `null` en `{data: null}`,
que es *truthy*.

**Quitar `201`/`204` del estándar.** Se consideró, con un argumento real: es el
cambio más cosmético de la lista y el de más superficie de regresión. Se descarta
porque el objetivo es que la API quede bien hecha para documentarla, y una API
donde el código de estado es predecible se consume sin leer el controlador. Lo
que se acepta es el coste: van fusionados con la capa cliente (§3.5).

**Renombrar primero, para tocar cada fichero una sola vez.** Gasta el riesgo en
lo único de la lista sin beneficio visible, y deja lo que sí duele para después.

**Cada lectura con el `ver` de su propio módulo, sin endpoints de opciones.**
`parametros:ver` es también lo que decide si se pinta el menú de Parámetros:
marcarlo para que un técnico rellene un desplegable le abre una pantalla de
administración que no le corresponde.

---

## 9. El trabajo, tarea a tarea

La primera versión de este apartado agrupaba por materia: «los códigos de
estado», «los permisos», «los nombres». La segunda auditoría —26 de agosto,
cuatro revisores con encargos separados— demostró que ese corte estaba mal
hecho, y no por gusto: metía en la misma caja cosas que se despliegan de formas
incompatibles. El tramo 1 juntaba borrar código muerto, que no puede romper
nada, con cambiar seis métodos HTTP, que rompe a todo cliente que tenga la
aplicación instalada. Una caja así no se puede desplegar de ninguna manera
correcta.

**El corte nuevo es por radio de daño al desplegar**, no por materia. Salen
catorce tareas en cuatro familias, y las tres primeras familias se pueden hacer
en cualquier orden dentro de la suya.

### Las dos reglas que gobiernan la lista

**Primera: cada tarea se audita antes y después.** Antes, para que no se empiece
media definida: ¿el criterio de terminado es cierto?, ¿qué rompe que no esté
dicho?, ¿sigue el árbol donde el documento cree que está? Después, para no dar
por bueno lo que no lo está. No es una lectura por encima: son revisores
adversariales, del tamaño que pida la tarea.

La regla nace de un hecho concreto. El criterio de terminado del antiguo tramo 1
ordenaba que «`/api/solucion` no existe», y esa ruta tiene un consumidor vivo
cuyo cliente se traga el fallo con un `.catch(() => null)`: cumplirlo al pie de
la letra habría pintado **todo evento resuelto como pendiente**, sin un solo
error en consola. Lo encontró una auditoría, no una relectura.

**Segunda: el criterio de terminado es un test, no una cifra.** La primera
versión decía cosas como «los 13 sitios que comparan con `200` están migrados» o
«los 18 ficheros». En veinticuatro horas se movieron cinco de esas cifras, porque
hay otras dos sesiones trabajando el mismo árbol. Una cifra en un documento
envejece en silencio; un test que la asevera se pone rojo y avisa. Así que **el
número vive en el test y el documento apunta al test.**

Corolario incómodo pero cierto: **no hay CI en ninguno de los dos repositorios.**
No existe `.github/`, `api/Dockerfile` no ejecuta `npm test` y Vercel hace `npm
run build`, que comprueba tipos y nada más — la segunda versión decía «sólo
`vite build`» y era un poco peor de lo que es. Toda verificación es manual, y
por eso cada tarea nombra el comando exacto que hay que ejecutar y en qué
repositorio. **Decisión del 3 de septiembre: la puerta se mete en la tubería**
—tests y lint en el Dockerfile y en el `build` de web—, que es la tarea E3. Un
plan cuyos criterios de terminado son tests, desplegado por una tubería que
nunca los ejecuta, es un plan sin criterios.

**Tercera, desde el 3 de septiembre: lo que se haga antes del corte de §11 no
necesita maniobra de despliegue.** Producción está en `master`, meses atrás, y
el cliente instalado no puede ni iniciar sesión contra esta rama; el primer
despliegue es un corte de todos modos. Las familias C y D se hacen en los dos
repositorios a la vez y salen juntas. La maniobra de tres pasos queda para lo
que venga *después* del corte.

### Ya hecho

| | Qué | Estado |
|---|---|---|
| **0a** | El cuerpo de la petición deja de poder archivar filas (§3.9) | ✅ `ce91b1b` — 10 ficheros |
| **0b** | Autoría de postes, nombre de cuenta en bitácora, presupuesto de subidas | ✅ `64431bf` — 11 ficheros |
| **T0** | Este documento al día tras la segunda auditoría | ✅ — cifras, criterios, despliegue y este apartado |
| **A0** | La bitácora deja de apuntar lo que el servidor rechazó | ✅ `538f309` + `5add364` — 16 ficheros |
| **A1** | Las siete rutas muertas, borradas | ✅ `e8cf5f6` — 8 ficheros. De 119 rutas montadas a 112 |
| **A3** | Un fallo deja de contarle al navegador lo que dijo Postgres | ✅ `2d36db1` + `7898569` — 18 ficheros. 74 manejadores movidos a `makeHandler` |
| **A4** | `ARCHITECTURE.md` al día | ✅ — y el hallazgo: **ninguno** de sus nueve índices está en una migración |
| **B1** | Los tres endpoints de opciones | ✅ `6f31a26` — el cuarto, descartado el 3 de septiembre (§5.3) y borrado en `7faa178` |
| **Aud.** | Lo que la auditoría del 3 de septiembre encontró en el propio arco: un hash en el log, dieciséis fugas, cuatro tests con evasiones | ✅ `7faa178` — 16 ficheros. Ver la nota de cabecera |
| **F** | Dos defectos de producción de pérdida de datos, ajenos al arco: el botón de huérfanas y el borrado de la foto anterior | ✅ `67f9d56` — 10 ficheros |

### Familia A — sólo servidor, no rompe a nadie

Ninguna necesita que el cliente se entere. Se despliegan cuando convenga, sin
coordinar con Vercel.

**A0 · La bitácora deja de apuntar lo que el servidor rechazó.** ✅ Hecha, `538f309` y `5add364`. Fue primera, y no
estaba en la primera versión de esta lista: la encontró la auditoría previa de
A1, que es exactamente para lo que sirve auditar antes de empezar.

El commit `ce91b1b` cerró la puerta y dejó el recibo. Metió `assignable()` y
`withoutAuthor()` en el `set()` de cada edición, así que un cuerpo que traiga
`deletedAt` o `id_usuario` ya no toca la fila — pero el `logAction` de al lado
sigue construyendo su `before`/`after` desde `req.body` sin filtrar. Hoy un
`PUT /api/ciudad/5` con `deletedAt` responde 200, no archiva nada, y **deja
escrito en la bitácora que se archivó**, en el único registro que existe para
comprobar si ocurrió. Son **nueve** controladores; en seis de ellos el `after` es
`req.body` literal, de modo que cualquier clave inventada del cuerpo entra tal
cual.

Ocho se arreglan aquí. El noveno es `rol.controller.ts`, de la sesión de roles:
queda como excepción escrita en el test, con su motivo, y se les avisa.

Y va **antes de A1** por una razón dura: los dos únicos sitios que hoy lo hacen
bien eran `updateRevision` y `updateSolucion`, que A1 borró junto con los dos
tests que lo vigilan. Sin A0 delante, A1 no es una limpieza, es una regresión.
Plan: [`docs/plans/2026-08-26-a0-bitacora-no-apunta-lo-rechazado.md`](../plans/2026-08-26-a0-bitacora-no-apunta-lo-rechazado.md).

```
cd api && npx vitest run src/controllers/logShape.test.ts
```

**A1 · Borrar las siete rutas muertas.** ✅ Hecha, `e8cf5f6`. Las de §7. Requería A0 delante, y no como formalidad: sin él habría sido una regresión de bitácora.
Arrastra tres cosas que no
son opcionales: tres entradas de `routeGuards.test.ts` (`READ_GATE_NOT_APPLICABLE`
y `EVENTOS_GATES`) que dejan la suite roja si no se quitan, cinco casos de
`authorship.test.ts` que llaman directamente a los controladores que se van, y
seis imports que quedan huérfanos y tumban el lint. **Cuidado con `/api/solucion`:
no desaparece.** Conserva `GET /evento/:id_evento`, que sí tiene consumidor; el
montaje se va en D1, no aquí.

```
cd api && grep -cE 'router\.(post|put|delete)\(' src/routes/solucion.routes.ts   # 0
cd api && npx vitest run && npm run lint && npm run typecheck
```

**A2 · El manejador de 404 en JSON (§3.6).** ✅ Hecha. Las dos decisiones que
quedaban abiertas, resueltas y con su motivo: **global**, porque este proceso
sólo sirve la API y el montaje de imágenes y no hay ninguna ruta que deba
contestar HTML; y **delante del manejador terminal**, con tres parámetros, que es
lo que lo deja transparente para el camino de error —comprobado contra el
`router` instalado, no de memoria—.

Lo que la auditoría previa corrigió del plan: la frase **no** puede reutilizar la
del manejador terminal (17 sitios del cliente empiezan a enseñarla, y «ocurrió un
error» manda a buscar un fallo del servidor que no existe); el cuerpo **no**
refleja la ruta pedida, que es lo que hacía `finalhandler` y lo único que un
`toBe(404)` no ve; y una ruta **no**-API sigue contestando 401, no 404, porque
`authenticateArchivos` responde antes de mirar el disco — a propósito, para que
el montaje no sirva para adivinar qué fotografías existen.

```
cd api && npx vitest run src/app.notfound.test.ts
```

**A3 · Sacar `error.message` de las respuestas de 500 (§3.5).** ✅ Hecha,
`2d36db1` y `7898569`. **Y no era mecánica**, que es lo que decía esta línea:
sustituir el mensaje por uno neutro cambia una fuga por ceguera, porque estos
fallos no se registraban en ningún sitio y el navegador era el único lugar donde
asomaban. La herramienta correcta ya estaba en el árbol —`utils/handler.ts`, que
registra bajo el logger de su controlador y responde neutro—, así que 74
manejadores perdieron su `try/catch` entero. Quedan 16 fugas en tres ficheros de
otras sesiones, nombrados en la lista de excepciones del test. Eran unos
veinte controladores. Uno de ellos es `rol.controller.ts`, de la sesión de roles:
o se coordina, o se deja fuera y se dice. El criterio no es contar ficheros, es
que el test lo prohíba.

```
cd api && npx vitest run src/controllers/errorShape.test.ts
```

**A4 · `ARCHITECTURE.md` al día.** ✅ Hecha. Se quedó sin dueño al cortar esta lista —
estaba en el antiguo tramo 1 y no entró en ninguna de las catorce—, y lleva
desactualizado desde antes de este trabajo: documenta `/api/postes` y
`/api/eventos` en plural, montajes que no existen (son singulares), dice que
`limit` tiene un mínimo de 10 cuando el código pone 15, y nombra `RevicionModel`
donde el modelo se llama `RevisionModel`. Y hay **dos** ficheros con ese nombre,
uno en `api/docs/` y otro en `web/docs/`: el de esta tarea es el de `api`.

No entra en la familia C aunque describa contratos: es documentación, no
despliega nada. Se hace cuando A0 a A3 hayan asentado, para no escribirlo dos
veces.

```
cd api && grep -cE '/api/(postes|eventos)|RevicionModel' docs/ARCHITECTURE.md   # 0
```

### Familia B — aditivas, no cambian nada existente

Añaden rutas que no sustituyen a ninguna: nada deja de funcionar por ellas, y no
hay contrato que romper.

**Matiz que introdujo B2, y que la primera redacción no admitía.** Esto decía
«rutas que todavía no llama nadie», dejando toda la orilla del cliente para la
familia C. Vale para los tres endpoints de opciones, que sustituyen llamadas que
hoy funcionan. No vale para `/autores`, que no sustituye a nada: existe para
arreglar un fallo de la pantalla, y sin el cambio del cliente la ruta nace
muerta. Así que B2 lleva las dos orillas, y su criterio de terminado nombra un
test de cada repositorio. La regla que queda es la de verdad: **la familia B no
cambia ningún contrato existente**, y por eso no paga maniobra.

**B1 · Los tres endpoints de opciones, en el servidor (§5).** ✅ Hecha,
`6f31a26`. La trampa de §3.2 era real —`/opciones` es un literal y hay que
declararlo antes del `/:id` de su router— y quedó cerrada por un test genérico,
`routeOrder.test.ts`, que recorre el `stack` compilado de todos los routers y no
por tres comprobaciones a mano. El cuarto endpoint se descartó (§5.3). Dos cosas
que la tarea cambió respecto a lo planeado, ambas de sus auditorías: el criterio
de terminado eran dos tests y no uno, y todos los bloques llevan `order`
—`ReportTramoSec` construye una columna de Excel por elemento en el orden de la
lista, y un `findAll` sin `order` recibe el orden de montón de Postgres—. El
`tramos` nuevo descarta pares que nombran una ciudad archivada; `getTramos` se
dejó intacto hasta la tarea que lo retirase, que acabó siendo C2.

```
cd api && npx vitest run src/routes/opciones.test.ts src/routes/routeOrder.test.ts
```

**B2 · `GET /api/bitacora/authors` (§5.4).** ✅ Hecha. La trampa de §3.2 era la
misma que en B1 —el literal antes de `/:id_usuario`— y está probada en las dos
formas que hacen falta: `routeOrder.test.ts` la vigila genéricamente, y una
petición real comprueba que `getBitacora` **no** corrió.

Cinco cosas que la tarea añadió sobre lo planeado, de sus dos auditorías:

- **Una migración con un índice**, `idx_bitacoras_id_usuario`, sobre
  `(id_usuario, id DESC)`. La columna de autor de la bitácora no tenía ninguno, y
  tres consultas la usan: el historial del perfil, el filtro por usuario de la
  pantalla, y este endpoint. Medido antes de escribirlo: las dos formas de
  preguntar «quién tiene entradas» —un `JOIN` con `GROUP BY` y un `EXISTS`—
  planifican **igual de mal** sin índice, un escaneo secuencial de toda la
  bitácora. Con él, el `EXISTS` sondea una vez por cuenta y para. **Dos columnas
  y no una**, que es corrección de la auditoría posterior: las otras dos
  consultas piden «las últimas cincuenta entradas de esta persona», y con
  `id_usuario` a secas Postgres tiene que leer y ordenar el historial entero de
  esa persona para encontrarlas.
- **El autor dejó de desaparecer de sus propias entradas.** El `include` de
  `getAllBitacora` colgaba `deletedAt IS NULL` del `ON` del join, así que una
  entrada escrita por una cuenta ya archivada llegaba con `usuario: null`: la
  pantalla imprimía `#12` y `BitacoraPanel` —el bloque de actividad de ciudad,
  evento y poste— no pintaba autor ninguno. 13 entradas de 2 cuentas en los datos
  de hoy, y una más por cada persona que se archive.
- **Las dos orillas**, por lo dicho arriba: el cliente pasa a `/autores`, marca
  a los archivados y **dice en voz alta** que no pudo cargar la lista, en vez del
  `.catch(() => {})`. Con la excepción del 401, que ya lo cuenta
  `SesionProvider`: una sesión caducada producía tres avisos, dos de ellos
  señalando al problema equivocado.
- **`BitacoraPanel` dejó de mentir**, y esto sí era una avería viva. Ese bloque
  lee la bitácora desde pestañas gobernadas por `postes`, `eventos` y `ciudades`,
  y se tragaba el 403 para caer en «Sin actividad registrada en bitácora» — una
  afirmación sobre el registro, hecha sin saber nada del registro. Los roles
  sembrados 2 y 3 tienen esos permisos y **no** tienen `bitacora`, así que a
  Coordinador y Cliente el sistema les venía diciendo, en cada ficha de cada
  poste, que nunca había pasado nada. Ahora distingue tres respuestas: no hay
  actividad, no tiene permiso, o no se pudo cargar.
- **`BITACORA_GATES` en `routeGuards.test.ts`**, y el router entra en
  `MODULOS_TABULADOS`: tres rutas gobernadas por el mismo par son exactamente la
  forma en la que llega una cuarta sin puerta y nadie lo nota.

Y una cosa que la auditoría posterior tumbó y hay que dejar escrita, porque el
texto que la justificaba era mío: **la primera versión de la migración usaba
`CREATE INDEX IF NOT EXISTS` argumentando que un fallo dejaría el contenedor en
bucle de reinicio.** No es cierto desde que el `Dockerfile` sacó las migraciones
del arranque a propósito — «si falla, el despliegue aborta y la versión anterior
sigue en pie»—. Y `IF NOT EXISTS` compara el nombre y nunca la definición, así
que un índice hecho a mano con ese nombre sobre otra columna se habría tragado en
silencio, que es justo la ceguera que el test de al lado existe para cerrar.

```
cd api && npx vitest run src/routes/bitacora.autores.test.ts src/migrations/20260903000002-index-bitacora-author.test.ts
cd web && npx vitest run src/api/Bitacora.api.test.ts src/pages/menu/bitacora/index.test.tsx src/components/BitacoraPanel.test.tsx
```

**B3 · Los limitadores del generador a su propio fichero, y aplicados a los seis
informes.** ✅ Hecha. *(C1 le añadió urgencia: al pasar los seis a `GET` salieron
de `requireSameOrigin`, y este router no tenía ningún cubo.)* Los cuatro viven en
`src/middleware/limiters.ts` —el fichero que C3 ya había creado para `perUser` y
el cubo de exportación, así que el nombre `reportLimiters.ts` que decía esta
ficha no se usó: un solo fichero para todo cubo que cuenta por persona— con sus
números intactos: 30, 120, 10 y 60 por minuto.

**Las dos decisiones de Isaias, del 4 de septiembre.** Los seis informes fijos
**comparten cubo** con `POST /generator/query`: lo que se raciona es el tiempo
de la base de datos en un solo proceso, y un cubo por ruta dejaría a una persona
gastarlo siete veces rotando entre ellas. Y el dashboard de inicio
(`GET /api/dashboard/`), que la auditoría previa señaló como la lectura más
pesada sin medir de la API —el registro entero, sin filtro ni límite—, **queda
fuera de B3 y apuntado aquí**: meterlo en el cubo de los informes haría fallar la
pantalla de inicio por lo que alguien hizo en el generador, y un cubo propio es
un número nuevo que merece su propia decisión. Lo mismo, y sin decisión aún,
para `GET /api/files/{orphans,broken-refs,entity-stats}`. `routeGuards.test.ts`
deja escrito que `/reporte/opciones` y el dashboard siguen sin cubo a propósito.

**Lo que la auditoría previa cambió, y hay que saber.** Primero, el cubo
**acota, no cierra**, la exposición que C1 abrió: la cookie es `SameSite=Lax`,
que sólo viaja en una navegación de primer nivel —no en un `<img>`, no en un
`fetch`—, así que una página ajena fuerza un informe por navegación visible, no
en bucle. Lo que el cubo sí acota es una sesión legítima, o robada, haciendo
scripting. Segundo, «30 por minuto» tiene **dos consumidores de distinta clase**:
un informe gasta una unidad por clic y nunca pregunta solo; el generador relanza
la consulta 700 ms después de cada cambio de configuración y cada «Siguiente» es
otra unidad. Quien monta un informe en el generador puede vaciar el cubo y dejar
Informes contestando «espere un momento» el resto del minuto sin haberlo tocado;
al revés no ocurre a ningún ritmo que produzca una mano. Isaias lo mantuvo
compartido sabiéndolo, y está escrito junto al número en `limiters.ts`.

**La otra orilla, que no estaba en la letra.** Las seis pantallas de Informes
tiraban la frase del servidor y decían «Error al generar el reporte», que es la
frase que manda a la persona de vuelta al botón. Ahora enseñan la del 429. Y un
defecto que el 429 volvía rutina: General, Tramo y Recorrido conservaban la lista
anterior cuando Generar fallaba, y el botón de exportar leía las fechas de los
selectores, no las del informe en pantalla —genera enero, mueve a febrero, recibe
429, pulsa Excel: cabecera de febrero, filas de enero, camino del cliente—. La
auditoría posterior encontró la otra mitad del mismo defecto un campo más allá:
en Por Tramo la cabecera «Tramo:» del fichero, y en Recorrido la etiqueta, los
marcadores y el nombre del CSV, se leían de los desplegables vivos. Las tres
pantallas guardan ahora **el filtro entero con el que se generaron las filas**
—fechas, tramo y el interruptor de «solo nuevas»— y todo lo que describe las
filas lee de ahí. Un fallo de Generar limpia la lista, como ya hacía el
generador con su Generar; y en Recorrido, cuyos dos relanzamientos automáticos
(tras resolver o revisar una incidencia desde el mapa) son justo el caso en que
el generador decidió **conservar** la tabla, un fallo de esos relanzamientos la
conserva, y un guardián de secuencia impide que un fallo tardío borre un éxito
fresco, porque los dos pueden solaparse.

**Verificado.** `limiters.test.ts` (cada cubo, su número y su frase, escritos a
mano), `routeGuards.test.ts` (dónde está montado cada cubo, por identidad de
función y con la ruta completa —la relativa al router no distinguía tres
`/export`—; detrás de la puerta de permiso en las dieciséis rutas; y las dos
lecturas fuera a propósito), `reporte.contract.test.ts` (el informe 31 contesta
429 sin consultar, un 403 no gasta, y el cubo es uno con el generador **en las
dos direcciones**, con un cortafuegos sobre `sequelize.query` porque la base es
copia de producción; ese fichero gastaba 32 unidades de 30 y necesitaba el
reset). En web, `ReportEstadoRedSec.test.tsx` —la única pantalla cuyo Generar no
pide fecha—, la ampliación de `ReportGeneralSec.test.tsx` con un selector de
fechas simulado, porque ningún test del repo maneja el calendario, y
`fallos.test.ts` sobre las seis a nivel de texto; tras la auditoría posterior,
`ReportTramoSec.test.tsx` cubre el tramo y el PDF por posición, y `fallos.test.ts`
el relanzamiento que conserva. Once mutaciones en api y once en web, cada una
muerta por el test que la nombra. Lo que la auditoría posterior tumbó de lo
mío y se arregló: tres frases falsas en la cabecera de `limiters.ts` —la regla
«todo cubo por persona vive aquí» no era cierta, el prefijo del cubo de fotos no
es lo que separa los contadores, y la librería no rechaza compartir almacén, lo
avisa—, y dos mutaciones que sobrevivían en las cabeceras del 429 (draft-7 y
las `X-RateLimit-*` antiguas), ahora cubiertas.

**Queda, y no es de esta tarea.** `generador/page.test.tsx` («shows the
server's own message when the export is refused») rechaza con un `Error` plano y
sólo mira que el toast sea de error: pasa con el lector borrado. Fichero de la
sesión del generador. (Los dos comentarios de `generador/index.tsx` que decían
que los treinta eran del generador solo se corrigieron en el árbol y salieron
con el commit `eef95d4` de esa sesión.) Y el selector de fechas real
(`components/ui/date-picker.tsx`) no tiene nombre accesible: la etiqueta de al
lado no está asociada al botón, y ningún test puede verlo porque el simulado sí
lo tiene.

```
cd api && npx vitest run src/middleware/limiters.test.ts src/routes/routeGuards.test.ts src/routes/reporte.contract.test.ts
cd web && npx vitest run src/pages/menu/reportes
```

### Familia C — las dos orillas

Aquí está todo lo que cambia un contrato. **Antes del corte de §11 no hay
maniobra**: cada tarea cambia las dos orillas en su repositorio y las dos salen
en el mismo corte. Lo que se escribe abajo sobre pasos vale sólo para lo que
quede pendiente cuando el corte ya haya pasado — y entonces, para los cambios de
respuesta (C3, C4), **el cliente va primero**, no el servidor.

**C1 · Los seis informes, de `PUT` a `GET` (§3.1).** ✅ Hecha. El filtro viaja
en la URL como cinco escalares, y las dos orillas cambian en el mismo commit
—§11: antes del corte no hay maniobra—.

**El primer entregable no era el cambio, era el test que no existía**, y sigue
siendo lo más valioso de la tarea. Corrección de la auditoría previa: *dos* tests
tocaban estos controladores, no uno. `reporte.tiempos.test.ts` corre siempre y es
bueno; lo que no existía es **ninguna prueba que ejercitara `/api/reporte` por
HTTP** — ni el método, ni la dirección, ni la puerta. Eso es
`src/routes/reporte.contract.test.ts`, junto a sus dos hermanos y no en
`controllers/`: mockear un modelo rompe el grafo de asociaciones de todos los
routers que carga `app.ts`, así que va por supertest con espías.

**Las validaciones, en un lector compartido** (`controllers/reporteFiltro.ts`).
Los seis leían cinco valores y comprobaban como mucho que dos estuvieran. Lo que
se cierra, en orden de gravedad:

- **`excludeOld` deja de ser booleano al viajar en la URL.** `false` llega como
  la cadena `"false"`, que es *truthy*: el interruptor «excluir arrastradas»
  habría ignorado su propia posición de apagado. Es el único defecto de la lista
  que produce **un informe plausible con las filas equivocadas**, y por eso el
  único que nadie reportaría.
- **Un parámetro repetido llega como array**, y leerlo como «no vino» ensancha el
  filtro en silencio: `?TramoInicial=1&TramoInicial=2` significaba *ningún
  tramo*, o sea el informe de toda la red mientras la URL nombra dos ciudades.
  La primera versión del lector tenía justo ese fallo y un comentario prometiendo
  lo contrario; lo encontró su propia auditoría.
- **`new Date("ayer")` es `Invalid Date`**, que Sequelize serializa como el texto
  `'Invalid date'` y Postgres rechaza: 500 neutro donde tocaba un 400 con una
  frase.
- **Un id de tramo mayor que `int4`** también acababa en 500. Y medio rango en
  `estado-red` se ignoraba: el informe cubría toda la historia con una fecha de
  inicio en pantalla.

**Y una cosa que C1 abre y no cierra, que es de Isaias.** `requireSameOrigin`
sólo guarda los cuatro verbos que escriben, así que al pasar a `GET` los seis
salen de ella: pierden la comprobación de `Origin` y la cabecera de cliente a la
vez, y la cookie es `SameSite=Lax`, que una navegación de primer nivel lleva. Una
página ajena puede hacer que el navegador de alguien con sesión ejecute la
consulta más cara del producto. **No puede leer la respuesta** —CORS— así que es
CPU ajena, no una fuga. Este router no tenía limitador ninguno; **B3** le puso el
del generador, que **acota** esa exposición —una sesión haciendo scripting— y no
la cierra: la ficha de B3 dice hasta dónde llega. Lo que sí lleva C1 es
`Cache-Control: no-store` en los seis, que con `PUT` sobraba.

```
cd api && npx vitest run src/routes/reporte.contract.test.ts src/controllers/reporteFiltro.test.ts
cd web && npx vitest run src/api/reporte.api.test.ts
```

**C2 · El cliente pasa a usar los endpoints de opciones (§5.5).** ✅ Hecha. Once
ficheros de código en el cliente —diez tocados y uno nuevo— y de diez peticiones
de catálogo a dos. **Sí retira algo del servidor**, al contrario de lo que decía
esta ficha: `GET /api/poste/tramos` se queda sin un solo llamante y se va con la
tarea.

**Y es la primera tarea del arco que no tolera media entrega.** §11 pide que las
dos orillas salgan en el mismo *corte*, no en el mismo commit —son dos
repositorios—. C1 y C3 dejan código que aguanta el desfase; ésta no: un `api`
sin la ruta junto a un `web` que aún la llama devuelve 404 y deja los
desplegables de tramo vacíos en las tres pantallas de informes. **Los dos
commits de C2 van juntos al corte o no va ninguno.**

**Un módulo cliente propio, `api/opciones.api.ts`, con tipos propios.** No es
estética: cinco de las seis interfaces compartidas declaran obligatorio un campo
que la proyección no trae —`description` en cuatro, `image` en `CiudadInterface`—
y `web` compila en `strict`. Tiparlo con ellas era no compilar o mentir con un
`as`. Y un módulo aparte evita una trampa medida: `vi.mock` con factoría
sustituye el módulo **entero**, así que añadir estas funciones a `Evento.api.ts`
habría dejado a `EventoSheet` llamando a `undefined` en un test que sigue verde.
Los exportadores de tramo pasan a pedir `{id, name}`, que es lo único que leían.

**Lo que la auditoría previa cambió de la tarea, y no es poco.** Tres agentes en
paralelo. Lo que encontraron, por gravedad:

- **La trampa que C2 habría metido, y la más cara.** Cuatro de los seis
  catálogos de `ReportTramoSec` se pedían **dentro** de `handleGenerar`, en el
  mismo `try` que el informe. Eso tenía una propiedad que nadie había escrito:
  si fallaban, la generación fallaba con ellos, la tarjeta «Resultados» no
  aparecía, y el botón Exportar vive dentro de esa tarjeta. Al mover la carga al
  montaje —que es lo que obliga una respuesta única— esa protección desaparece
  sola: el informe se genera bien con las cuatro listas vacías, y **todas las
  columnas de contenido de ese informe salen de esas cuatro listas**. El fichero
  resultante lleva su título, su rango de fechas y sus números de poste, y ni una
  columna de contenido, sin nada dentro que lo diga, camino de un cliente. Ahora
  la pantalla se niega a generar y lo dice en pantalla, no sólo en un aviso de
  cuatro segundos.
- **Dos huecos de permiso reales, y no los que esta ficha decía** (ver §5.5). La
  pantalla de inicio abre `PosteSheet` con `postes.editar` a secas, y las dos
  pantallas de postes abren `EventoSheet` sin exigir `eventos.ver`. §5.5 ya
  decidió qué hacer: la pantalla trata el 403 como lo que es. Las cinco pantallas
  distinguen ahora «no tiene permiso» de «no se pudo cargar», que antes eran el
  mismo aviso —y en la edición en línea de postes, un `.catch` vacío—.
- **`EventoSheet` se dibujaba en blanco.** En edición, los dos catálogos
  viajaban en el mismo `Promise.all` que la incidencia, sus revisiones y su
  solución. Un 403 en los catálogos rechazaba el lote entero y dejaba la ficha
  vacía —sin descripción, sin revisiones, sin solución— para una incidencia que
  el rol sí puede leer. Ahora son dos preguntas y dos respuestas.
- **Un cambio visible que conviene saber:** el bloque `tramos` descarta pares
  que nombran una ciudad archivada, y `/tramos` no lo hacía. Una ciudad cuyo
  único vecino esté archivado desaparece del desplegable «Tramo desde». Hoy se
  ofrece y no lleva a ninguna parte.

**Siete ficheros de prueba nuevos donde no había ninguno**, uno de ellos el
tercer espejo entre repositorios del sistema —los otros dos son de contraseñas,
de agosto—: lee `opciones.controller.ts` del disco y compara los nombres de
bloque que el servidor manda con los que el cliente lee. Se omite visiblemente
si `api` no está al lado, y **falla** —no se salta— si no encuentra el ancla.

Son **diez** ficheros de prueba al terminar, no siete: la auditoría posterior
señaló que tres de las pantallas tocadas se quedaban sin ninguna, y las tres la
tienen. `ReportRecorrido` pasó además de dos ficheros a uno —el que leía su
fuente como texto se fusionó con el nuevo, que ya monta la pantalla—, que es la
convención de este repositorio y además lo que el analizador de lint necesita
para no tropezar con dos ficheros del mismo nombre.

**La auditoría posterior encontró que el arreglo de arriba no estaba completo, y
eso es lo más instructivo de la tarea.** La primera versión guardaba «¿falló?»
en un valor que podía ser nulo, y **nulo significaba a la vez “aún no ha vuelto”
y “todo bien”**: durante toda la ventana de carga el botón Generar seguía
habilitado, el informe es otra petición y puede contestar antes, y la tarjeta de
Resultados —con su botón Exportar— aparecía con las cuatro listas todavía
vacías. Es decir: el fichero sin columnas seguía siendo alcanzable, producido
por el arreglo que decía impedirlo. Ahora el estado tiene cuatro valores
—cargando, listas, denegado, fallo—, y lo exigen **las dos** puertas: Generar y
`handleExport`. La misma auditoría encontró otras cinco: un 403 de segundo
factor pendiente que se leía como «no tiene permiso» —lo distingue el campo
`code`, que aparece en esas dos respuestas del servidor y en ninguna otra—, un
`catch` compartido que culpaba al catálogo de un fallo ajeno, un mensaje de alta
enseñado en un formulario de edición donde era falso, un «Cargando…» eterno para
un catálogo legítimamente vacío, y cinco afirmaciones falsas en mis propios
comentarios.

**Y una tercera auditoría, sobre las pruebas, encontró lo que la verificación
por mutación no ve: pruebas que pasan midiendo menos de lo que su comentario
promete.** Un `click` sobre un botón deshabilitado no despacha nada, así que
«y además pulsarlo no hace nada» repetía la línea anterior; dos aserciones
buscaban el mismo nodo creyéndose dos hechos; una negativa sobre un índice fijo
seguía en verde si la columna se desplazaba; y el espejo entre repositorios se
**saltaba** cuando el controlador se renombraba —justo la deriva que existe para
cazar— además de poder leer, en tres reescrituras válidas, la respuesta del
handler siguiente. Todo corregido, y con ello un defecto de verdad: el bloque
`tramos` llega de un `r.data` sin validar, así que una respuesta parcial dejaba
las tres pantallas de informes **en blanco** —no hay error boundary en ninguna
parte de la aplicación—.

```
cd web && npx vitest run
cd api && npx vitest run src/routes/
```

**C3 · El sobre único en los listados (§3.3).** Sin `totalPages`, con `422` al
pasarse del techo, y con **un solo lector de `limit`** en un sitio: hoy hay cinco
copias —dos con mínimo 15, una sin mínimo, una con techo 200— y tras esta tarea
habría quince. Antes del corte no hay ventana, pero el centinela sigue teniendo
la trampa que la segunda versión describía: contra un servidor sin el cambio,
`limit=all` es `Number("all") || 50` y devuelve **cincuenta filas en silencio**.
Por eso el cliente lleva un cortafuegos propio: si `data.length < total`, no
construye el fichero y avisa. Vale contra un servidor viejo y contra una vuelta
atrás.

Tres decisiones que la segunda versión dejaba a C3, tomadas o encaminadas:

- **La pestaña «Archivados» deja de pedir todas las filas**: pagina como la
  tabla de al lado, que ya es `manualPagination`. Cinco líneas de `web`, sin
  cambio de servidor, y se lleva por delante dos de los catorce llamantes de
  `?export=true`.
- **Los nueve botones de Excel, CSV y PDF se construyen en el servidor**, en
  `POST /api/{poste,evento,usuario}/export` (§3.3, cuarta categoría). No fue por
  el techo — con 1.687 postes y 1.514 incidencias no muerde — sino porque la
  auditoría previa encontró diez defectos dentro de las doscientas líneas
  copiadas en cada pantalla, y ninguno era comprobable desde una prueba de
  navegador. La hoja de cálculo y el documento son los del generador, así que
  las incidencias salen con las filas resueltas en verde y el resto teñido por
  gravedad, como el resto del producto; el CSV es nuevo y defiende contra la
  inyección de fórmulas, que las cinco copias del navegador no hacían.
  **Y el fichero es lo que la pantalla muestra**: los filtros, el orden y la
  pestaña viajan con la petición, leídos en el servidor por la misma función que
  usa el listado. El botón de antes no mandaba un solo parámetro.
- **Y lo que la auditoría posterior encontró debajo de todo esto, que no era de
  C3 y lo invalidaba entero: los filtros nunca llegaban al servidor.** Axios
  escribe un parámetro repetido como `filterColumn[]=name`; Express 5 cambió su
  lector de consultas por defecto de `extended` a `simple`, y `simple` no
  interpreta los corchetes. El servidor recibía un parámetro **llamado**
  `filterColumn[]` y nada bajo `filterColumn`, así que todos los controladores
  leían `undefined`, lo normalizaban a lista vacía y contestaban la tabla entera
  — con el chip del filtro dibujado como activo en la pantalla. Los tres
  controles de incidencias, la barra de filtros de columna y todo el orden por
  cabecera: nada de eso funcionaba, ni antes de este arco.

  Ninguna de las dos suítes podía verla. Las del cliente simulan los módulos de
  la API, así que jamás construían una cadena de consulta real; las del servidor
  hablan por `supertest`, que escribe las listas como claves repetidas — la
  única forma que sí funciona. Lo único que ninguna de las dos medía era la
  costura, y era lo único roto. Ahora la mide `listado.test.ts` en `web`.

  Se arregló en el cliente (`paramsSerializer: { indexes: null }`, que escribe
  claves repetidas) y no en el servidor. La otra opción de una línea,
  `app.set("query parser", "extended")`, cambia el lector para **todas** las
  rutas de la API y mete `qs`, que además convierte `?a[b][c]=1` en un objeto
  anidado donde todos los manejadores esperan una cadena. Ensanchar la forma de
  `req.query` en toda la superficie para arreglar cómo un cliente escribe una
  lista es el cambio grande y el arriesgado.
- **Dos cosas que quedan dichas y sin hacer.** Las pestañas «Archivados» de
  postes e incidencias **no tienen botón de exportar**, ni lo tenían antes; el
  servidor ya lo soporta y añadirlo es el menú repetido. Y la pantalla de
  Seguridad filtra y pagina en el navegador, así que su fichero es el directorio
  entero — como siempre fue — y lo dice en su subtítulo en vez de callarlo.
- `AddEventoPageSheet` pide los postes con `GET /api/poste/?limit=all`: es un
  problema de peso (0,7 MB en un desplegable), no de permiso —todo rol que puede
  crear incidencias tiene `postes:ver`—, y no bloquea C3.

Y el cliente gana lo que §1 diagnostica y §4 nunca prescribió: **un solo tipo
`Paginado<T>` y un solo `ListParams`**, en vez de `PostePaginatedResponse` y
`EventoPaginatedResponse` declarados iguales dos veces.

```
cd api && npx vitest run src/routes/listShape.test.ts src/middleware/limit.test.ts
```

**C4 · `201`/`204` y la capa cliente (§3.5, §4.1).** ✅ Hecha el 2026-09-05, y
fue la más grande de las catorce. Las dos orillas en el mismo trabajo, que es lo
que la ficha llamaba «cliente primero»: un código de estado no admite paso
intermedio, así que o cambian juntas o el corte enseña «no se pudo» sobre cosas
que sí se hicieron.

**El daño era dos veces y media el contado.** La ficha decía ocho «No se pudo
archivar» y cuatro «No se pudo crear». Son **treinta** sitios: la cuenta original
miró los diez archivados y se dejó fuera los **diez desarchivados**, el
desbloqueo de una cuenta, y reabrir y resolver una incidencia. Las 83
comparaciones literales sí eran 83 —una era un comentario—, y hoy quedan 46 en
el árbol: 35 de autenticación, que están fuera de este arco, y once de deuda
declarada.

**Un defecto vivo que la ficha describía como riesgo futuro.** Ver §3.5: los
once controladores de alta contestaban ya `500 «Ocurrió un error»` cuando el
fallo era del que escribe. Medido antes de tocar nada.

**La ficha se equivocaba al citar `AddRevisionSheet`.** El comentario de ese
fichero registra el fallo **contrario** —un éxito falso que perdió una
inspección—, no el que C4 provocaba. Lo que C4 habría provocado ahí es una
revisión **duplicada**: la hoja se queda abierta con el texto dentro y la
persona vuelve a darle a Guardar. Y sí era verdad que su test simulaba `200`
como éxito y habría seguido en verde con la pantalla rota; ahora no simula
ningún número.

**Lo que quedó sin terminar, y por qué.** Cinco funciones de `web/src/api`
—`createCiudad`, `editCiudad`, `createPoste`, `editPoste`, `reabrirEvento`—
siguen devolviendo un número, porque al menos un llamante de cada una vive en un
fichero que la sesión de MapLibre está reescribiendo (`CiudadSheet.tsx`,
`PosteSheet.tsx`, `EventoDetallePage.tsx`). Cada una lleva su nota en el código
y **resuelve 200 en el éxito sea cual sea el código real**, que es lo que
mantiene correctas esas once comparaciones. `statusComparisons.test.ts` las
lista y falla si la lista se queda vieja en cualquiera de las dos direcciones.
Coste declarado: crear o editar un poste o una ciudad **sigue diciendo «no se
pudo» sin decir por qué**, y son las dos entidades más usadas del producto.

**Choques con las otras sesiones, corregidos respecto a lo que decía la ficha.**
`http.ts` sí se toca —es donde va el traductor de fallos—, `SesionProvider.tsx`
**no** hacía falta tocarlo, y `/api/rol` con su pantalla sí entró, por decisión
de Isaias (ver §12).

**Dos cosas medidas que conviene no volver a razonar:**

- `res.sendStatus(204)` deja un `ETag` calculado sobre `"No Content"`; se usa
  `res.status(204).end()`. Está en §3.5.
- El traductor de fallos de `http.ts` rechaza con el `AxiosError` **original**
  enriquecido, y eso —no el orden de registro— es lo que mantiene vivos el
  cierre de sesión por 401 y los treinta lectores de `error.response`. El orden
  es defensa para el día que alguien cambie con qué rechaza. La primera versión
  de este documento atribuía cada cosa a la contraria.

```
cd web && npx vitest run src/api/statusPropagation.test.ts
cd api && npx vitest run src/routes/statusCodes.test.ts
```

**C5 · Cerrar las dieciocho lecturas sin permiso (§3.7, §6).** ✅ Hecha el
2026-09-05. Dieciocho y no veinte: A1 borró una y C2 retiró otra. El reparto de
permisos es el de la tabla de §6, y la lista viva sigue siendo
`READ_GATE_NOT_APPLICABLE`, donde ya sólo quedan las cuatro exenciones de
verdad.

**La decisión de datos que esta ficha reservaba a Isaias se había disuelto
sola.** Decía que `parametros:ver` es `false` para el rol Cliente y que cerrar
los cinco catálogos le quitaría el informe de tramo. C2 lo cambió sin que esta
ficha se enterara: hoy esos cinco endpoints sólo los llama la pantalla de
Parámetros, que ya estaba cerrada con ese mismo permiso en el navegador, y los
informes piden sus listas por `/api/reporte/options`. Ningún rol sembrado pierde
nada. Lo que sí conviene no repetir es el motivo que la auditoría previa corrigió:
no se salva por la puerta del navegador, sino porque **los mismos catálogos se
sirven bajo otros tres permisos** (`postes:ver`, `eventos:ver`, `reportes:ver`),
que el Cliente tiene. O sea que el permiso nuevo ordena; no esconde.

**Lo que la auditoría previa cambió del plan, y hay que saber:**

- **Sólo siete de las dieciocho habrían quedado con el par fijado.** Las once
  restantes viven en routers que la comprobación de completitud no sujetaba, y
  ahí `requirePermission("bitacora","ver")` sobre `GET /api/ciudad/` deja la
  batería entera en verde. Se extendió `MODULOS_TABULADOS` de siete routers a
  diecisiete y `PARAMETROS_GATES` dejó de ser parcial, que es una decisión y no
  un efecto: treinta entradas para cinco routers, más una tabla nueva de
  ciudades.
- **`GET /api/evento/usuario/:id_usuario` va con `requireSelfOrPermission`, no
  con `requirePermission`** —§3.8 ya decía cómo se escribe—, **y con el nombre
  del parámetro como tercer argumento**, que es la parte que ningún test del
  repositorio podía ver. Está contado en §6.
- **Dos de las dieciocho quedan sin ninguna prueba por HTTP**:
  `GET /api/ciudad/:id` y `GET /api/solucion/evento/:id_evento`. Están
  clasificadas en `listShape.test.ts` pero ese fichero nunca las pide, así que
  su puerta está fijada por el registro de rutas y por nada más.

**La autoría: decisión de Isaias del 2026-09-05, y corrige una premisa de este
documento.** La versión anterior de esta ficha decía que `GET /api/evento/` y
`GET /api/poste/` «siguen mandando el nombre del autor» como si fuera una fuga
que `responseShape.test.ts` no puede ver. Las dos mitades eran inexactas: el
`id_usuario` de la raíz sí es invisible para ese test, pero el nombre viaja en un
`include` que ese mismo test **inspecciona y aprueba** contra
`USUARIO_AS_AUTHOR`. Y, sobre todo, ya no es deuda: Isaias decidió que **la
autoría es procedencia**. Quien puede ver un poste puede ver quién lo registró y
quién ha trabajado en él; lo que sigue cerrado es preguntar *por persona*. Así
que la columna «Creador» se queda en las dos listas, y el generador —que era más
estricto que las pantallas— se abrió en el mismo sentido: `Registrado por`,
`Revisado por` y `Resuelto por` dejan de ser sólo para personal, y con ellas el
nombre y el apellido; el usuario de acceso, el teléfono, el rol, los contadores y
**hacer informes con las personas como raíz** siguen pidiendo `seguridad:ver`.
Se sigue de ahí, y se dice: con el nombre como columna filtrable, alguien puede
preguntar «los eventos que registró Juan». La lista ya contesta eso con
`limit=all` y un filtro en el navegador, así que negarlo en el generador sería
esconder en un sitio lo que otro entrega.

**La excepción de `express.static` se escribe con la verdad de hoy**, no con la
frase de la segunda versión: las fotos están detrás de sesión desde `a90ff35`;
lo que queda es que cualquier sesión ve cualquier foto (§6).

**La otra orilla.** Cerrar dieciocho puertas hace visible lo que pasa cuando una
se cierra, y ninguna de las pantallas afectadas distinguía un rechazo de un
fallo de red. Cinco sitios lo hacían mal de forma que la persona no se enteraba:
la hoja de usuario se quedaba en un esqueleto **para siempre** —el `await` no
tenía `catch`, así que el indicador de carga nunca se apagaba y la cuenta no se
podía guardar—, el botón de editar un poste desde el mapa de inicio no hacía
nada, la hoja de incidencia culpaba a la red, el guardián de archivar un poste
decía «ocurrió un error», y la hoja de postes daba dos mensajes que se
contradecían. Arreglados los cinco, más el informe de recorrido, cuyo
`Promise.all` dejaba que un rechazo de postes anulara un informe que había
llegado bien.

**Verificado.** api: 2.517 comprobaciones en 137 ficheros. web: 978 en 74. Tipos
y estilo limpios en los dos. Once averías metidas a propósito, y las once las
detecta el test que las nombra — entre ellas la de la puerta con el par
equivocado, que antes de esta tarea habría sobrevivido.

```
cd api && npx vitest run src/routes/routeGuards.test.ts src/routes/evento.self.test.ts
cd web && npx vitest run src/components/dialogs/upsert/UsuarioSheet.test.tsx
```

### Familia D — al final

✅ **D1 · Los nombres y los sub-recursos (§3.2, §3.4).** Hecho el 2026-09-05, las
dos orillas. Quince renombrados y siete mudanzas; cuatro montajes menos.

**Lo que la auditoría previa cambió del plan, y fue bastante:**

- **Eran quince cambios de nombre, no doce.** La ficha decía doce y a
  continuación listaba once. Aparecieron cuatro direcciones que el documento
  describe en otras secciones y nunca pasó por §3.4: los tres `/opciones` que
  creó C2, el `/autores` que creó B2, `/tiempos-resumen` —la misma inversión que
  `/obs-frecuencia`, sin listar— y el montaje `/api/generador`. Isaias las metió
  todas.
- **Los `/restore` son diez y no nueve.** `/api/rol` entra por decisión suya, con
  aviso a la sesión de roles. Y eso ahorra una exención: un `naming.test.ts` con
  nueve habría nacido teniendo que exceptuar por escrito el único `/desarchivar`
  que quedaba en español.
- **`/api/upload` se funde en `POST /api/files/`** en vez de quedarse anotado. La
  decisión cambió cuando se midió el coste: son ocho llamadas, todas dentro de
  `uploadImage`. Lo que **no** cambia es su exención de permiso — ver §3.7, donde
  está medido a quién dejaría fuera ponerle puerta.

**Las trampas, y hay una más de la que decía esta ficha:**

- **`MODULOS_TABULADOS` desarma la comprobación de completitud de dos routers, no
  de uno.** La ficha avisaba de `permisos` → `permiso`; `tipoObs` → `tipo-obs`
  tiene el mismo defecto y no estaba escrito. Y falla en el orden que lo esconde:
  las tablas por router **sí** se ponen rojas, quien las arregla queda satisfecho
  y la expresión conserva el nombre viejo.
- 🔴 **Hay una segunda expresión regular, y nadie la había mirado.**
  `ADMINISTRATIVOS` (`routeGuards.test.ts`) es la puerta de la decisión D6:
  contraseña en toda escritura sobre cuentas, roles y permisos. Con `permisos`
  dentro y `/api/permiso` fuera, `PUT /api/permiso/:id_rol` —la escritura que
  reescribe la matriz de permisos de todos los roles— se cae del conjunto, y la
  cota anti-vacuidad del bloque es `> 10`: de trece escrituras quedan doce y
  **pasa**. Las dos expresiones son ahora listas con nombre, y un `it` comprueba
  que cada prefijo sigue siendo un montaje.
- **Las nueve tablas de puertas se funden con spread**, así que una ruta escrita
  en dos de ellas gana la última en silencio. Con siete rutas cambiando de router
  era el momento exacto de que pasara. Hay guarda.
- **`/api/bitacora/:id_usuario` → `/api/usuario/:id/bitacora` cambia el nombre del
  parámetro**, y `requireSelfOrPermission` lo lee por nombre. Cierto, y la ficha
  no decía la otra mitad: **`/api/evento/usuario/:id_usuario` tiene la misma
  trampa**, y de las dos sólo una tenía test. `bitacora.self.test.ts` se escribió
  contra la dirección vieja, se vio verde, y sólo entonces se movió la ruta.
- **`GET /api/solucion/evento/:id` no la pedía ningún test.** Estaba clasificada
  en `listShape.test.ts` dentro de un grupo que nunca manda peticiones, y los dos
  llamantes del cliente la envuelven en `.catch(() => null)` — que es también su
  respuesta normal. Rota en silencio, **cada incidencia resuelta se pinta como
  pendiente**. `solucion.evento.test.ts` es nuevo y se escribió antes de mover.
- **C1 termina antes de que D1 empiece.** Ya estaba: los seis informes son `GET`.

**El cliente estaba casi ciego, y la primera versión de este párrafo exageró
cuánto.** Decía que de las diecinueve direcciones sólo una tenía test; contadas
bien eran **seis** —los tres `/opciones`, `/bitacora/autores` y dos informes—, y
las otras trece no tenían ninguna: los diez `/restore`, los dos verbos de
incidencia, los siete sub-recursos y las cinco rutas del generador. Lo que hace
que ese hueco sea total y no parcial es que **cada test de pantalla simula su
módulo `*.api` entero**, 79 veces, así que ninguno puede ver una dirección.
`rutas.test.ts` ejecuta las funciones y mira la que axios recibió de verdad.

**Y D1 cerró la deuda que dejó C4.** La sesión del mapa commiteó sus tres
ficheros, así que las cinco funciones que resolvían un número —`createCiudad`,
`editCiudad`, `createPoste`, `editPoste`, `reabrirEvento`— propagan como las
otras treinta y cuatro, y sus seis pantallas leen la frase del servidor. En
`poste/index.tsx` eso obligó a mover el revert de la actualización optimista a un
`catch` y el identificador de «guardando» a un `finally`.

`RolesPanel.tsx` y `PermisosPanel.tsx` son de la sesión de roles y `/api/permiso`
los toca: se le avisa. El generador también cambia (`/query`, `/count`,
`/catalog`, `/export`, `/duplicate`), y también se le avisa.

```
cd api && npx vitest run src/routes/naming.test.ts src/routes/bitacora.self.test.ts src/routes/solucion.evento.test.ts
cd web && npx vitest run src/api/rutas.test.ts
```

### Familia E — el corte, y lo que la auditoría dejó con nombre

Lo que hay que hacer antes o en el primer despliegue, que es un corte (§11), y
lo que la auditoría del 3 de septiembre encontró fuera de las catorce pero
dentro de lo que este documento no puede callar. Ninguna cambia un contrato.

**E1 · Los nueve índices, en una migración** (decisión del 3 de septiembre).
✅ Hecha, `20260904000001-hand-made-indexes`. Existían sólo en
`ARCHITECTURE.md`, creados a mano contra el servidor.

Cuatro correcciones de su auditoría previa, y las dos primeras evitaban un daño
real en producción:

- **Los nombres van tal cual están en la base, y dos no son los que parecen.**
  `idx_postes_ciudadA` se escribió sin comillas, y Postgres pasa a minúsculas
  todo identificador sin comillas: en la base se llama `idx_postes_ciudada`.
  Entrecomillarlo —que es lo que hace `queryInterface.addIndex` por su cuenta—
  busca un nombre que no existe y **crea un índice duplicado**: cuatro índices en
  `postes` donde hay dos, encareciendo cada escritura para siempre y sin que nada
  falle ni se registre. Lo mismo con `idx_reviciones_id_evento`, cuya errata
  **no** se corrige por el mismo motivo: son dos erratas distintas —la tabla es
  `revicions`— así que el índice no nombra a su tabla, y «arreglarlo» duplica.
- **`IF NOT EXISTS` no basta, porque compara el nombre y nunca la definición.**
  La migración lee de `pg_index` las columnas reales de los nueve al final de la
  misma transacción y falla si alguna no coincide. Ése es el único caso que la
  cláusula se traga —un índice a mano con uno de estos nombres sobre otra
  columna— y dejaría una consulta escaneando mientras el documento jura lo
  contrario. Verificado contra la base el 4 de septiembre: los nueve existen y
  coinciden byte a byte, así que la migración es un no-op real.
- **`down()` no borra nada, a propósito.** Los nueve existían antes de la
  migración; un `down` que los borrara destruiría índices que no creó, en el peor
  momento posible. Y `IF NOT EXISTS` no informa de si creó algo, así que no hay
  forma de que sepa cuáles son suyos.
- **`addIndex` no admite `IF NOT EXISTS` en Sequelize 6**, así que va en SQL
  crudo. La tercera versión de este documento mandaba a alguien a buscar una
  opción que no existe.

Y una corrección de fondo: **esto no arregla «un entorno nuevo»**, que es lo que
decían este documento y `ARCHITECTURE.md`. Ninguna migración crea las tablas
base —la más antigua ya hace `addColumn("obs", …)`— y el `sync({ alter: true })`
que las creaba se retiró, así que `npm run migrate` contra una base vacía muere
mucho antes de llegar aquí. Lo que E1 compra es **procedencia**: los nueve dejan
de vivir en prosa. El orden «antes de C3» se mantiene y no hace daño, pero su
justificación tampoco era correcta: en producción los nueve ya están, así que C3
corre igual con E1 que sin ella.

```
cd api && npx vitest run src/migrations/20260904000001-hand-made-indexes.test.ts
```

**E2 · La pantalla de inicio, acotada.** `GET /api/dashboard` no tiene `where`
ni `limit`: cada apertura de la aplicación descarga todos los postes y todas las
incidencias con sus revisiones, soluciones y observaciones. Está gateada con
`eventos.ver`, que tienen los tres roles, así que la puerta no cierra nada. Es la
lectura más cara del sistema y ninguna de las catorce la tocaba;
`ARCHITECTURE.md` afirmaba que este documento la cerraba, y no. Hay que decidir
qué necesita la pantalla —probablemente contadores y las N incidencias abiertas
más urgentes— y servir eso.

```
cd api && npx vitest run src/controllers/dashboard.controller.test.ts
```

**E3 · Las puertas de despliegue** (decisión del 3 de septiembre). ✅ Hecha.
`npm run lint` y `npm test` en la etapa de build del `Dockerfile` de `api`, antes
de `npm run build`; y `lint` + `test` al principio del script `build` de `web`.
Un despliegue con la suite roja no arranca, y Vercel se queda con el build
anterior.

Dos cosas que no estaban en la línea original:

- **Los tests necesitan una cadena de conexión falsa dentro del build**, y va en
  el propio `RUN`, no en un `ENV`. `.dockerignore` deja `.env` fuera del
  contexto, y `database/sequelize` llama a `process.exit(1)` **mientras se
  importa** si no encuentra configuración: sin ella la suite no falla un test,
  muere en el primer `import`. Nada se conecta —todas las consultas están
  mockeadas y `new Sequelize(url)` no abre socket—, y al ir en el `RUN` no puede
  llegar a la imagen de ejecución, que arranca de un segundo `FROM`.
- **Los tres avisos de lint ajenos, arreglados** (`d0fef5b`, `0c91d55`): una
  interfaz muerta en `reporte.controller.ts` —y el `import` que se quedó huérfano
  al quitarla— y dos `any` en dobles de respuesta de test, donde `any` es el tipo
  correcto (las aserciones bajan tres niveles por un cuerpo JSON) y la regla la
  que sobra: desactivada en una línea, con el motivo escrito.

La puerta de `web` está **probada de punta a punta** (`npm run build` completo).
La de `api` **no**: el demonio de Docker no estaba levantado en esta máquina, así
que la imagen no se ha construido. Lo que sí está comprobado por separado es la
premisa que la sostiene —sin variables de entorno el proceso muere con un FATAL
de configuración; con la cadena falsa arranca y no conecta—.

**E4 · La actualización deja de ser opcional, y la versión del cliente viaja en
cada escritura** (decisión del 3 de septiembre). ✅ Hecha, con **una desviación
que Isaias confirmó el 4 de septiembre**: se queda como está.

`X-Osefi-Client` pasa de `"web"` a `web/<versión del build>`: el servidor sólo
comprueba que no esté vacía, así que no rompe nada, y con la cabecera en el log
de peticiones «¿quién sigue en la versión vieja?» es una consulta. Sólo en
escrituras, como ya estaba — en lecturas forzaría un *preflight* por cada foto de
una exportación.

**La desviación.** La decisión decía `registerType: "autoUpdate"` en
`vite.config.ts`. Tomado al pie de la letra, ese ajuste **recarga la página en el
instante en que aterriza un despliegue**, y el fichero llevaba escrito desde
antes por qué no: a un técnico a medio rellenar un poste no se le arranca la
pantalla. Esa parte no se puso sobre la mesa al decidir, así que la decisión se
implementa por su intención —que ningún cliente se quede atrás— y no por su
letra:

- `registerType` se queda en `"prompt"`, que es lo único que deja a la aplicación
  elegir **el momento**. No es «que decida la persona»: es «que lo decida el
  código».
- `<UpdatePrompt />` aplica la versión nueva **sola, en el primer cambio de
  pantalla**, donde recargar no cuesta nada porque esa pantalla se estaba dejando
  igualmente. La ventana pasa de «hasta que alguien pulse Actualizar» a «hasta
  que pulse cualquier cosa».
- El aviso se queda como salida inmediata para quien la quiera ya, y es el único
  camino que puede perder trabajo, así que sigue diciéndolo.

Confirmada el 4 de septiembre, con el coste sobre la mesa: se queda. Volver a la
letra sería cambiar `"prompt"` por `"autoUpdate"` y borrar el efecto que mira la
navegación, y no se hace.

**E5 · `migrate:deploy` en Coolify, confirmado y escrito.** El servidor no
migra al arrancar; lo hace un *pre-deployment command* que vive en el panel de
Coolify y en ningún fichero. Esta rama trae las migraciones de MFA, correo y
passkeys: si ese ajuste no está, el servidor arranca contra una base sin esas
tablas. Se comprueba antes del corte y se apunta en `ARCHITECTURE.md`.

**E6 · Defectos de integridad que las auditorías encontraron y que no son de
este arco, apuntados con nombre.** *(Añadido el 4 de septiembre, de la auditoría
de E1:* **la ficha del poste y la lista de incidencias no cuentan lo mismo por
«pendiente»**. El contador del poste cuenta `state = false`; el filtro de la
lista usa `state IS NOT TRUE`, y su propio comentario explica por qué —`state` es
nullable, así que «pendiente» no puede ser `= false`, que se deja fuera las filas
donde nadie lo fijó nunca—. Una incidencia creada sin `state` cuenta cero en la
ficha y aparece en la lista: la pantalla se contradice consigo misma.*)* `POST /api/evento` acepta `state: true` en el
cuerpo y crea una incidencia nacida resuelta sin fila de solución —`updateEvento`
lo destructura fuera; `createEvento` no—. `resolverEvento` toma `date` del
cuerpo sin comprobarla, así que el tiempo de reparación de los informes se puede
fabricar. `updateObs` registra en la bitácora hasta con cuerpo vacío. Y los
`metadata` de la bitácora aceptan cualquier clave del cuerpo —`assignable` es
una lista negra de cuatro campos—, que es contenido almacenado que la pantalla
pinta. Ninguno bloquea el corte; todos merecen commit propio.

---

## 10. Cómo se verifica

Una regla sin forma de comprobarse es una recomendación. La primera versión
dejaba seis reglas sin verificación, incluida la orilla del cliente entera.

**Y cada tarea, además, se audita antes y después** — ver §9. La tabla de abajo
dice cómo se comprueba cada regla; la auditoría es otra cosa y no la sustituye:
el test dice que el código hace lo que dice el documento, y la auditoría dice si
el documento sigue teniendo razón.

| Regla | Cómo se comprueba |
|---|---|
| 3.1 método | ✅ `reporte.contract.test.ts`: los seis contestan en `GET`, ninguno en `PUT`, los seis piden `reportes.ver`, y la respuesta lleva `Cache-Control: no-store`. Con él `reporteFiltro.test.ts`, que cubre cada forma en que el filtro puede venir mal — incluida la que produce un informe plausible y falso (`excludeOld=false` leído como verdadero) y la que lo ensancha en silencio (un parámetro repetido) |
| 3.2 sub-recursos y orden de declaración | ✅ `routeOrder.test.ts`, escrito en B1, y desde D1 también `naming.test.ts` (la forma de la dirección) y `listShape.test.ts` (**seis** de las siete nuevas, pedidas de verdad — la de solución está en `AGREGADAS`, un grupo que ese fichero clasifica y nunca pide, y por eso tiene la suya en `solucion.evento.test.ts`). **El límite de `routeOrder.test.ts` importa aquí:** compara patrones declarados entre sí, así que no ve que `GET /:id/eventos` declarado antes de `GET /user/:user` se tragaría exactamente dos direcciones —la cuenta cuyo nombre de usuario fuese «eventos» o «bitacora»—. Por eso las dos rutas nuevas de `usuario.routes.ts` van declaradas después, con el motivo escrito en el fichero. Recorre el `stack` compilado de cada router —descubiertos por directorio, no listados— y falla si un patrón declarado antes ya casa con una ruta declarada después, contando `router.all` y avisando de un `router.use` con ruta, cuyo prefijo Express 5 no expone. **Desviación consciente:** lee los módulos de router, no la tabla montada, así que cubre un router antes de que nadie lo monte y no vería una ruta declarada directamente sobre la app — eso lo ve `routeGuards.test.ts` |
| 3.3 sobre | Test con la **lista escrita a mano** de los listados. Derivarlo es imposible: `res.json(x)` no revela la forma de `x`, y ése fue el error de la primera versión. La lista se cuenta al empezar C3, no ahora: A1 ya borró uno, así que la cuenta de la primera versión sobra |
| 3.3 techo y centinela | Test del centinela sobre una colección por encima y por debajo del tope —`422`, no `413`—, más un caso del valor que el servidor viejo interpretaba como `50`, y el lector único de `limit` con sus tres clamps |
| 3.4 nombres | ✅ `naming.test.ts`: recorre **la tabla montada** —no los ficheros, y ésa es la diferencia entre medir y certificar, porque los dos únicos segmentos con mayúscula eran prefijos de `app.ts`— y clasifica cada segmento literal en una de tres listas escritas, en las dos direcciones. Más: ningún verbo español en ninguna dirección, todo en minúsculas y con guion, y ninguna dirección que nombre un recurso raíz **antes** de identificar su fila, que es §3.2 dicho como forma en vez de como lista de siete. Las tres exenciones de §2 que viven en el router de usuario van por dirección, una a una; el prefijo `/api/auth` se excluye en bloque y eso es más ancho que las diez de §2, porque los planes de MFA y passkeys han montado veintiséis rutas ahí desde entonces. Su espejo en el cliente es `web/src/api/rutas.test.ts`, que ejecuta las funciones y lee la dirección que axios recibió — de las diecinueve que D1 mueve, antes había **seis** vigiladas y trece sin nada |
| 3.5 códigos | ✅ `statusCodes.test.ts`: registro de las **85 escrituras** montadas con el código que contesta cada una, leído del árbol de rutas real y contrastado contra el código fuente de su controlador; falla en las dos direcciones (una ruta sin clasificar, una entrada sin ruta) y fija las cuentas 15/24/46. Más cinco peticiones de verdad: que el `201` lleva la fila, que el `204` no lleva cuerpo **ni `Content-Type` ni `ETag`**, y que un cuerpo inválido contesta `400` con una frase que no es la neutra |
| 3.5 comparaciones en el cliente | ✅ `statusComparisons.test.ts` en `web`: **ninguna pantalla compara contra un número** salvo las que están en una de las dos listas escritas —autenticación, y la deuda que dejó el trabajo del mapa—, con la cuenta por fichero para que una nueva no se cuele en un fichero que ya estaba. La primera versión de §10 no tenía fila para esto, y es donde estaba todo el daño. **Desde D1 queda una sola lista**: la deuda del trabajo del mapa se cerró, y la lista desapareció en vez de quedarse vacía, porque una lista vacía invita a rellenarla. En su lugar, la regla sin excepciones: ninguna función de `src/api` convierte su rechazo en un número, en ninguna de las **tres** formas — y la tercera, `.then(() => 200)`, es la más engañosa, porque informa de un éxito sobre un código que nadie miró |
| 3.5 `error.message` | Test que lo prohíbe **en cualquier parte del cuerpo de un `catch` que responde**, no sólo dentro del `res.json` — la forma con variable intermedia es la mayoritaria. Acotado al `500`: el generador lo devuelve a propósito en `400`/`413`/`429`, y son frases escritas para el usuario |
| 3.6 formato de error | ✅ `app.notfound.test.ts`: una dirección inexistente responde 404 en JSON con `message`, la frase habla de la dirección y no de un error, el cuerpo **no** refleja la ruta pedida —que es lo que hacía `finalhandler`—, una ruta montada sigue llegando a su router, y un cuerpo mal formado sigue saliendo por el manejador terminal, que es lo que se rompe si alguien le pone cuatro parámetros a este manejador |
| 3.7 permisos | `routeGuards.test.ts`, que ya existe — con la excepción de `express.static` escrita **con la verdad de hoy** (§6): detrás de sesión, sin permiso por objeto |
| 3.8 propiedad | `routeGuards.test.ts` ya distingue el gate de propiedad del de permiso; se añade que el tercer argumento coincida con el parámetro de la ruta |
| 3.9 entrada | ✅ `requestShape.test.ts` y `responseShape.test.ts`, ya escritos |
| 4.1 / 4.2 cliente | Test en `web`: un 403, un 500 y un fallo de red producen `status` 403, 500 y 0; el auto-logout sigue disparando con 401; **y la ventana de step-up sigue abriéndose con un 403 con `code`** — el segundo interceptor que la segunda versión no sabía que existía |
| 5.4 autores | ✅ `bitacora.autores.test.ts` en `api` —el literal gana al paramétrico porque `getBitacora` no corre, el `where` es un semi-join que nombra la columna cualificada, y las columnas se leen contra `USUARIO_AS_AUTHOR`— y en `web` dos ficheros: `index.test.tsx` comprueba que la pantalla **no** vuelve a pedir el directorio de personal y que filtra por el `id` de la opción, y `BitacoraPanel.test.tsx` que «no hay actividad», «no tiene permiso» y «no se pudo cargar» son tres respuestas y no una |
| 5.5 cliente | ✅ Siete ficheros nuevos en `web`: `opciones.api.test.ts` (la dirección anclada al final de cada una, los bloques por su nombre, `lat`/`lng` y `id_tipoObs` **leídos por valor**, el rechazo que no se traga, y el espejo que lee el controlador del otro repositorio); `useTramoNeighbors.test.ts` (las dos direcciones del mapa, y que el hook no pide nada); siete de pantalla y una del exportador, que comprueban lo que ninguna otra cosa ve — que los catálogos viejos **no** se siguen llamando, que `ReportTramoSec` se niega a generar sin ellos, que `EventoSheet` sigue mostrando la incidencia cuando le niegan las observaciones, y que la edición en línea dice por qué su menú está vacío. Las veintitrés mutaciones probadas se detectan — medición a mano, no reproducible desde el repositorio: aquí no hay mutation testing montado |
| 5 opciones | ✅ `opciones.test.ts`, por endpoint y por bloque: qué bloques devuelve, con qué columnas **exactas pedidas a la base de datos** —leídas del espía y no de la respuesta, porque los modelos están mockeados y las filas serían las del propio test— y que el paramétrico no le robó la ruta, comprobado porque `findOne` no se llamó. Los tres endpoints |

---

## 11. Despliegue

**La premisa de la segunda versión estaba mal, y la corrigió la auditoría del 3
de septiembre.** Decía: `api` va a Coolify y `web` a Vercel, entre una y otra hay
una ventana, y la ventana dura semanas porque la aplicación instalable espera a
que el técnico pulse «Actualizar». De ahí una maniobra de tres pasos para cada
cambio de contrato. Dos hechos la tumban:

- **Producción está en `master`, sin desplegar desde mayo/junio** —172 commits
  por detrás en `api`, 71 en `web` (confirmado por Isaias)—. El cliente instalado
  autentica con un token en `localStorage` contra una ruta que esta rama borró;
  la rama autentica con cookie. **Ese cliente no puede ni iniciar sesión contra
  este servidor.** El primer despliegue es un corte, y ninguna maniobra lo
  convierte en otra cosa.
- **En producción no hay service worker todavía.** Lo trae esta rama. La ventana
  «de semanas» no existe aún: empieza el día que se despliegue esto, y con la
  actualización automática de E4 —la versión nueva se aplica sola en el primer
  cambio de pantalla— queda acotada a un clic. Elegirlo antes del primer
  despliegue es la única vez que sale gratis.

### El corte

Un solo despliegue coordinado, en este orden: **`api` primero, `web` después,
y todo el mundo vuelve a iniciar sesión.** Antes: E1, E3, E5 hechas, A2 hecha
—una ruta que ya no existe responde JSON, no HTML—, y las dos orillas de cada
tarea C y D en su repositorio. El corte lleva todo lo que esté terminado ese
día; lo que no, espera al siguiente y entonces sí paga maniobra.

**Todo cambio de contrato hecho antes del corte no necesita maniobra**, porque
no hay cliente viejo que proteger: ya está roto por la autenticación. Eso
convierte C1, C3, C4 y D1 en trabajo mecánico en dos repositorios, sin
despliegues intermedios.

🔴 **Ese argumento cubre el corte y nada más. Desde C4, `web` deja de poder
volver atrás sola.** Las dos orillas se despliegan por caminos independientes
—Coolify para `api`, Vercel para `web`— y Vercel deshace un despliegue con un
clic. Con el servidor nuevo y un cliente anterior a C4, cada alta correcta
enseña «no se pudo crear» sobre una fila que existe, y la persona lo reintenta:
ciudades, postes e incidencias duplicadas. Las dos consecuencias prácticas:

1. `api` y `web` van juntos al corte o no va ninguno; si la construcción de
   `web` falla después de que `api` haya subido, no hay degradación, hay caída
   —el despliegue anterior es el cliente de `master`, que ya no sabe
   autenticarse.
2. Después del corte, deshacer sólo `web` reabre esa ventana sobre producción.
   Un `revert` de C4 son las dos orillas a la vez. La propuesta de agrupar «las retiradas» de todas las
tareas C en un solo despliegue final se retiró el mismo día: sólo C1 y C3 dejan
código de tolerancia, y sin ventana no hay nada que tolerar.

### Después del corte

Lo que quede para después vuelve a tener ventana, ya acotada, y sigue esta
regla:

> **Ningún cambio puede romper al cliente viejo.** No existe «los dos a la vez».

Y la maniobra depende de **qué** cambia, cosa que la segunda versión no
distinguía y que la auditoría encontró al revés para las dos tareas más grandes:

- **Cambia la petición** —un método, una ruta, un parámetro—: servidor primero.
  (1) El servidor acepta lo viejo y lo nuevo. (2) El cliente pasa a lo nuevo.
  (3) El servidor retira lo viejo.
- **Cambia la respuesta** —el sobre, un código de estado—: **cliente primero**.
  Un servidor no puede contestar `[]` y `{data: []}` a la vez, ni `200` y `201`.
  (1) El cliente aprende a aceptar las dos formas. (2) Ese cliente llega a todos.
  (3) El servidor cambia. El código de tolerancia vive en el cliente, y es el
  que se queda cinco años si nadie lo apunta: `Array.isArray(r.data) ? r.data :
  r.data.data`. Su borrado es una tarea, con un test en `web` que falle mientras
  quede uno.

**Cómo saber cuándo es seguro dar el último paso**, que la segunda versión
dejaba sin decidir entre «contar en la bitácora» y «un plazo»: ninguna de las
dos. `httpLogger` ya escribe una línea JSON por petición con método, URL
completa y usuario, y `login.routes.ts` ya usó ese log para retirar una ruta:
«cero peticiones a la forma vieja durante cinco días laborables seguidos, mirado
en Coolify». Con E4, además, cada escritura lleva la versión del cliente que la
hizo. Contar en la bitácora habría metido fontanería HTTP en el registro de
negocio y una escritura en la ruta caliente de los informes.

Las familias A, B y E no necesitan nada de esto: no cambian ningún contrato.

---

## 12. Lo que no cambia

El formato de error `{ message }` y su manejador global. `requireSelfOrPermission`
y que la propiedad no sea un permiso. Los cuatro limitadores del generador y sus
números —B3 cambió dónde viven, no cuánto dejan pasar; lo que sí cambió es
**quién gasta** el de consultas: los seis informes fijos beben de él desde
entonces—. Los `separate: true`
que evitan el producto cartesiano y la subconsulta de eventos pendientes. Los
permisos como `modulo` y `accion` en español y en la base de datos. Y
`routeGuards.test.ts`, que no se sustituye: se le quitaron tres entradas en A1,
se le vació la lista de excepciones de lectura en C5, y la comprobación de
completitud pasó de tres routers a seis el 3 de septiembre y a diecisiete en C5.

De la paginación de postes y eventos no cambian el tope de 100 por página ni sus
optimizaciones. **La lectura de `limit` sí cambia** (§3.3) — la primera versión
declaraba intocable toda la paginación en una sección y la modificaba en otra.

Y no cambia nada de lo que llevan las otras dos sesiones: las catorce rutas de
autenticación. **`/api/rol` y `/api/permisos` sí cambiaron, por decisión de
Isaias del 5 de septiembre**, y en dos tareas. En C4: archivar y desarchivar un
rol contestan `204`, y tres sitios de `RolesPanel.tsx` leían un `200` — dejarlo
fuera habría sido dejar la pantalla de roles diciendo «no se pudo archivar el
rol» sobre un rol archivado. En D1: `PATCH /api/rol/:id/restore`, y el montaje
`/api/permisos` pasa a `/api/permiso`, que toca `PermisosPanel.tsx`. **La sesión
de roles tiene que saber las dos cosas.**

**Y el generador tampoco queda fuera.** D1 renombra su montaje a
`/api/generator` y cinco de sus rutas: `/catalog`, `/query`, `/count`,
`/export` y `/reportes/:id/duplicate`. En el cliente eso es
`generador.api.ts` y nada más — ninguna pantalla del generador construye una
dirección.

**Lo que D1 deliberadamente no toca, para que no parezca olvido:** los nombres de
las funciones de controlador. `desarchivarEvento` sigue sirviendo `/restore`.
§3.4 regula la superficie HTTP, no el código de dentro.

---

**Fuentes.** `src/routes/*.routes.ts`, `src/app.ts`, `src/routes/routeGuards.test.ts`,
`src/controllers/*.ts`, `src/middleware/requirePermission.ts`, cruzado con
`web/src/api/*.api.ts`, `web/src/pages`, `web/src/components` y `web/vite.config.ts`.

Recuento hecho sobre el árbol de trabajo del 25 de agosto de 2026 y **revisado el
26**, cuando la segunda auditoría encontró que cinco cifras se habían movido en
veinticuatro horas por trabajo de otras sesiones. Ésa es la razón de que los
criterios de terminado de §9 sean comandos y no números: el documento no puede
seguirle el ritmo al árbol, y no debe intentarlo.

Auditado tres veces por revisores adversariales con encargos separados —cuatro
el 25 de agosto sobre el diseño, cuatro el 26 sobre si se podía empezar a
construir, y cinco el 3 de septiembre sobre lo hecho y lo que quedaba—. Los
hallazgos que cambiaron una decisión están incorporados y señalados en el texto;
los que cambiaron sólo una cifra, corregidos en silencio.
