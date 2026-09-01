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
capacidades**, y la primera versión decía que no: cerrar veinte lecturas quita a
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

**De los tres** — `routeGuards.test.ts`. Este documento le quita tres entradas en
A1 y le vacía la lista en C5; la sesión de autenticación le añade rutas en su
Plan 4. Cualquier cambio ahí se avisa.

---

## 3. Las reglas del servidor

### 3.1 El método dice la verdad

`GET` lee y no cambia nada. `POST` crea, o consulta cuando el filtro no cabe en
la URL. `PUT` sustituye un recurso entero. `PATCH` cambia un campo o un estado.
`DELETE` archiva.

Consecuencia: los seis informes pasan a `POST`.

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
nivel.** Es la regla implícita de la que ya dependen `/tramos` antes de `/:id` en
[`poste.routes.ts`](../../src/routes/poste.routes.ts) y `/orphans` antes de
`/:name` en `files.routes.ts`, y la primera versión no la escribió — con lo que
su propio `GET /api/bitacora/autores` habría caído dentro de `GET /:id_usuario`,
consultando `id_usuario = "autores"` y produciendo un 500 con el texto de
Postgres: la ruta nueva disparando la fuga que §3.5 arregla.

**La justificación de esta sección cambia cuando se lee junto con §7.** La
primera versión la apoyaba en que `GET /api/revision/5` devuelve las revisiones
*del evento* 5 mientras `DELETE /api/revision/5` borra *la revisión* 5. Cierto —
pero §7 borra ese `DELETE` y ese `PUT` por no tener cliente, así que para cuando
llegue D1, el renombrado, la trampa ya no existe. Lo que queda en pie es más
sencillo y menos dramático: siete direcciones que se leen solas frente a cuatro
convenciones que hay que memorizar.

Desaparecen **tres** montajes, no dos: `/api/adssposte` y `/api/eventoObs` dejan
de ser recursos raíz, y `/api/solucion` se queda sin rutas al mover la suya y
borrar las otras cuatro (§7). De 23 montajes a 20. Los modelos siguen todos en
pie: los usan otros controladores.

### 3.3 Una URL, una forma

**Qué es un listado**, porque la primera versión no lo definía y la mitad de las
respuestas no caía ni en «listado» ni en «detalle»: un `GET` cuya respuesta es
una colección de filas de una tabla. Nada más.

**Todo listado** devuelve el mismo sobre, tenga doce filas o mil quinientas:

```json
{ "data": [], "total": 0, "page": 1, "totalPages": 1, "limit": 50 }
```

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
| `GET /api/evento/:id/solucion` | Relación 1:1. Devuelve el objeto **o `null`**, y `null` es el caso normal — un evento sin resolver. Envolverla haría `{data: null}`, que es *truthy*, y **todo evento pendiente aparecería como resuelto** |
| `GET /api/dashboard/` | Dos colecciones nombradas en un objeto |
| `GET /api/permisos/` | Cuatro colecciones paralelas |
| los cinco `/stats` | Un resumen: `{ total, mostUsed, empty }` |
| `GET /api/files/entity-stats` | Un objeto de objetos |
| `GET /api/generador/catalogo` | Un árbol |
| los seis de `/api/reporte/` | Filas calculadas, no filas de una tabla |
| `GET /api/generador/reportes` | Pagina por `offset`, y su cliente también. Conserva `rows`/`offset` |

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
responde `413`** con el total y el tope, como hace el generador. Sobre una
colección vacía responde el sobre con `total: 0`, `totalPages: 1`.

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

Las dos cosas se deciden al empezar C3, y son decisiones de verdad, no detalles:
o el techo distingue por destino, o las exportaciones de navegador pasan a
construirse en el servidor como las del generador, o la pestaña de archivados
deja de pedir todas las filas de golpe. La tercera es la barata y probablemente
la correcta.

**Por qué el sobre también en los catálogos.** Un catálogo de doce materiales
envuelto responde `totalPages: 1`, que hoy no aporta nada. Aporta el día que la
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

**Criterio de desempate**, porque «sustantivo del negocio» tiene zona gris y un
estándar sin desempate se vuelve a discutir en cada ruta: **si el cliente usa la
palabra cuando habla del sistema, va en español.** El cliente dice «poste»,
«tramo», «bitácora», «reporte» y «el autor del evento»; no dice «sobre paginado».
Ante la duda gana el español: un nombre de más en español se entiende, y uno mal
traducido no.

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
| `/dashboard` | `/inicio` | El menú y el usuario dicen «Inicio»; el desempate lo manda |
| `/upload` | sin cambio | Verbo inglés como raíz, y chirría — pero renombrarlo toca seis diálogos para ganar coherencia y nada más. Queda anotado, no hecho |
| `/files`, `/orphans`, `/broken-refs`, `/stats` | sin cambio | Inglés, y correctos |
| `/tramos`, `/poste`, `/evento`, `/adss`, `/bitacora` | sin cambio | Sustantivos del negocio |

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
cuando la respuesta representa una fila nueva, y son quince — los doce `create*`
más `postReporte`, `postDuplicar` y `UploadImage`. `POST /:id/resolver` y
`POST /:id/reopen` son `200`: cambian el estado de algo que ya existía. (Hoy sólo
dos de esas quince responden `201`.)

**`204` sólo donde el archivado no informa de nada:** el `DELETE` de las diez
entidades con papelera. **`DELETE /api/files/orphans` y `/broken-refs` se quedan
en `200` con su cuerpo**, porque devuelven cuántos ficheros limpiaron y esa cifra
es la única salida de la pantalla de Archivos — un `204` no puede llevar cuerpo, y
la pantalla diría «undefined referencias limpiadas».

**Un `500` nunca devuelve `error.message`.** Responde el mensaje neutro que ya
usa el manejador global, y el real va al log con su identificador de petición,
que `httpLogger` ya escribe. No se pierde diagnóstico: se mueve a donde sólo lo
ve quien administra.

**Pero el error esperado no se silencia con el inesperado.** En los quince
controladores afectados todo fallo cae en el mismo `catch`, incluidos los que son
culpa de quien escribe: una criticidad fuera de rango es una `ValidationError` de
Sequelize que hoy llega con texto legible y mañana llegaría como «Ocurrió un
error». El patrón correcto ya está escrito en casa — `handleError` en
[`generador.controller.ts`](../../src/controllers/generador.controller.ts) mapea
errores tipados a `400`/`413`/`429` con su propia frase y deja lo demás en
neutro. Se extiende, no se inventa.

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

- **Once respuestas no llevan `message`:** nueve `res.sendStatus(401)` con cuerpo
  vacío y dos `res.status(500).send("…")` de texto plano en
  [`upload.controller.ts`](../../src/controllers/upload.controller.ts). Las dos
  de subida pasan a `{ message }`. De los nueve `401`, siete son de la sesión de
  autenticación; los otros dos están en `requirePermission.ts` y por tanto son de
  éste: una petición que llega sin `id_rol` recibe hoy un cuerpo vacío.
- **Falta el manejador de 404.** Una ruta que no existe no es un error, así que
  no llega al manejador global: cae en el `finalhandler` de Express, que responde
  **HTML**. Y el 404-de-ruta-inexistente es exactamente lo que fabrican los
  tramos que mueven direcciones. Se añade `app.use((req, res) => res.status(404)
  .json({ message: … }))` al final, y es prerrequisito de D1.

### 3.7 Toda ruta declara su permiso, lecturas incluidas

**Cuatro excepciones dentro de este alcance**, no tres. Cada una porque no puede
ser de otra forma:

- `POST /api/auth/login` — es lo que produce la credencial.
- `GET /api/auth/me` — es de donde salen los permisos; pedir un permiso para
  saber qué permisos tienes no se sostiene.
- `GET /api/auth/sessions` — son las tuyas: el identificador sale de `req.user`.
- **`POST /api/upload/`** — sirve tres pantallas a la vez y una es la fotografía
  de tu propio perfil, así que atarla a un módulo dejaría fuera a alguna. Su
  router lo argumenta. **No es de autenticación y está dentro de las 104**, así
  que la primera versión, leída como norma, ordenaba cerrarla contra el
  razonamiento escrito en su propio fichero.

**Hay dos listas de exenciones, no una.** `READ_GATE_NOT_APPLICABLE` para
lecturas y `GATE_NOT_APPLICABLE` para escrituras, y el criterio de terminado de
la primera versión sólo miraba la primera — con lo que no se habría enterado de
que `/api/upload/` seguía sin puerta.

**Criterio de terminado:** `READ_GATE_NOT_APPLICABLE` queda vacía de todo lo que
no sea autenticación. Lo comprueba el test que ya existe.

### 3.8 La propiedad no es un permiso

`requireSelfOrPermission` ya existe y ya está razonado: tu propia ficha, tu
contraseña y tu bitácora se alcanzan sin permiso de módulo, porque exigirlo
impediría que alguien cambiase su propia contraseña. No tiene casilla en la
matriz y no debe tenerla.

**Y se escribe con el tercer argumento.** El middleware lee `req.params["id"]`
por omisión, y su docstring documenta esta trampa como ya cometida una vez: en
una ruta cuyo parámetro se llama de otra forma, la comprobación de propiedad
compara contra `undefined` y no coincide nunca. `GET /api/bitacora/:id_usuario`
lleva hoy `requireSelfOrPermission("bitacora", "ver", "id_usuario")` y las rutas
nuevas se escriben igual.

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

**Queda pendiente la mitad ancha de esta regla:** veinticinco `include` siguen
devolviendo la fila completa de ciudad, material o propietario donde la pantalla
sólo usa el nombre. Eso es peso, no fuga de datos de autoría, y va en C5.

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

Esto no es un detalle de implementación: hay un único interceptor de respuesta
hoy, en `SesionProvider.tsx`, y su rama de error lee `error.config`,
`error.response?.headers` y `error.response?.status === 401` para aprender el
vencimiento de la sesión y para cerrar sesión. Axios ejecuta los interceptores en
orden de registro. Un normalizador que rechace con un objeto plano deja al de
`SesionProvider` sin `config` ni `response`, **el 401 deja de detectarse, y una
sesión revocada ya no echa a nadie de la aplicación**: la pantalla se queda con
botones que sólo devuelven 401. Silencioso, y ningún test actual lo vería.

Un fallo sin respuesta lleva `status: 0` y el mensaje «Sin conexión con el
servidor».

---

## 5. Las opciones de los formularios

Cuatro endpoints, uno por formulario que necesita listas para sus desplegables.
Cada uno con **un** permiso.

```
GET /api/poste/opciones     → postes:ver
    { adss, material, propietario, ciudad }

GET /api/evento/opciones    → eventos:ver
    { obs, tipoObs }

GET /api/reporte/opciones   → reportes:ver
    { ciudad, adss, material, propietario, obs, tramos }

GET /api/usuario/opciones   → roles:editar
    { rol }
```

### 5.1 Por qué cuatro y no uno

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
| `/api/poste/opciones` | `ciudad` | `id, name, lat, lng` — el formulario dibuja un mapa |
| | `adss`, `material`, `propietario` | `id, name` |
| `/api/evento/opciones` | `obs` | `id, name, id_tipoObs` — el selector agrupa por tipo |
| | `tipoObs` | `id, name` |
| `/api/reporte/opciones` | `tramos` | `id_ciudadA, id_ciudadB` — pares, no filas |
| | `ciudad` | `id, name, lat, lng` — **`ReportRecorrido` traza la línea con ellas**; sin `lat`/`lng` la guarda sale por la primera línea y la pantalla se dibuja sin recorrido |
| | resto | `id, name` |
| `/api/usuario/opciones` | `rol` | `id, name` |

Los archivados no viajan. Y `ciudad` apareciendo en tres respuestas no es
duplicación: son proyecciones distintas para consumidores distintos, servidas por
código compartido.

### 5.3 El permiso de `/api/usuario/opciones` es `roles:editar`

No `seguridad:crear`, que es lo que decía la primera versión. Quien asigna un rol
necesita `roles:editar`: sin él, `createUsuario` devuelve 403 **y escribe una
línea `severity: 'critical'` con `action: "ROLE_CHANGE_DENIED"` en la bitácora**.
Aquella tabla convertía el trabajo normal de un gestor de usuarios en alertas de
escalada de privilegios — el mismo fallo que `revision.routes.ts` documenta como
ya pagado una vez.

### 5.4 La bitácora sirve sus propios autores

```
GET /api/bitacora/autores    → bitacora:ver
```

Declarado **antes** de `GET /:id_usuario` (§3.2). Devuelve id y nombre de quien
tiene entradas.

Hoy la pantalla rellena su filtro llamando a `GET /api/usuario/`, que exige
`seguridad:ver`. Un rol con `bitacora:ver` y sin `seguridad:ver` recibe un 403 que
la llamada descarta con un `.catch(() => {})` vacío: el desplegable aparece con
«Todos» y nada más. Parece que no hay usuarios.

**No es acceso nuevo al directorio**, y conviene decirlo: los nombres ya viajan
en las propias filas del log, con `bitacora:ver`, desde el `include` de usuario
que hay en su controlador. Esto es una comodidad sobre datos ya servidos, no una
puerta nueva.

### 5.5 Qué asume el frontend

Un endpoint de opciones puede responder 403 —si el rol no tiene el permiso de esa
pantalla— pero **nunca devuelve un bloque a medias**. La pantalla que lo pida
maneja el 403 como lo que es: no puede usar ese formulario.

Los consumidores que se migran en C2: `PosteSheet`, `ReportTramoSec`,
`ReportGeneralSec`, `ReportRecorrido`, `EventoSheet`, `AddEventoPageSheet`,
`UsuarioSheet` y la edición en línea de `poste/index.tsx`. Las cinco pantallas de
Parámetros y `CiudadesPage` siguen con los endpoints de administración, que es lo
suyo.

**Y dos que la primera versión se dejó fuera llamándose «la lista completa».** La
auditoría del 26 de agosto las encontró, y las dos importan porque son el único
camino hacia un dato que ningún endpoint de opciones sirve todavía:

- `useTramoNeighbors.ts` es el **único** llamante de `GET /api/poste/tramos`, y
  de él cuelgan las tres pantallas de informes. §5 promete un bloque `tramos` en
  `/api/reporte/opciones`; o ese bloque no tiene quien lo use, o hay que tocar
  este fichero. Con los roles sembrados no rompe —Cliente tiene `postes:ver`—
  pero un rol de sólo informes se quedaría sin el desplegable de tramos.
- `AddEventoPageSheet` pide el listado de postes con `exportPostes()`, o sea con
  `?export=true`, que C3 borra. `/api/evento/opciones` cubre sus otros dos
  catálogos pero no los postes, y **añadir un bloque de postes ahí sería servir
  el registro de postes bajo `eventos:ver`, que es peor que el problema.** Queda
  como decisión de C3, no de C2, y hay que tomarla antes de quitar `export=true`.

---

## 6. Cómo quedan las veinte lecturas

**Con las direcciones de hoy**, porque este cierre es C5 y los
sub-recursos son D1 — la primera versión las nombraba ya renombradas y
obligaba a traducir la tabla de vuelta.

| Permiso | Rutas |
|---|---|
| `parametros:ver` | `GET /api/{adss,material,obs,tipoObs,propietario}/` |
| `postes:ver` | `/api/poste/`, `/api/poste/:id`, `/api/poste/tramos`, `/api/adssposte/:id_poste` |
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
`eventos:ver`: el generador marca la entidad `usuario` como `staffOnly` contra
`seguridad.ver`, y la bitácora usa `requireSelfOrPermission("bitacora","ver",…)`.

**Cuatro advertencias sobre lo que este cierre no consigue**, para no vender
humo. Las dos primeras estaban desde la primera versión; las dos últimas las
encontró la auditoría del 26 de agosto, y la cuarta es la más incómoda.

- **`GET /api/poste/tramos` gateado no cierra nada** mientras el generador siga
  por debajo: el rol Cliente tiene `generador: TODO`, y el generador sirve
  `ciudad` con `lat`/`lng` sin marca de staff. La topología de la red ya está a
  su alcance por otra puerta. Se cierra por coherencia, no porque proteja.
- **`parametros:ver` sobre los cinco catálogos esconde poco** mientras
  `searchPoste` y `searchEvento` incluyan material, propietario y ciudades sin
  `attributes`. Por eso los veinticinco `include` de §3.9 van en el mismo tramo:
  cerrar la puerta principal y dejar la de servicio abierta no es cerrar.
- **Y los propios endpoints de opciones vuelven a servir esos catálogos bajo
  otros permisos.** `/api/poste/opciones` entrega adss, material y propietario
  con `postes:ver`; `/api/evento/opciones` entrega obs y tipoObs con
  `eventos:ver`; `/api/reporte/opciones` entrega cuatro de los cinco con
  `reportes:ver`. El rol Cliente tiene los tres. O sea que para los tres roles
  sembrados hoy, **cerrar `parametros:ver` no le quita a nadie el acceso a los
  nombres de los catálogos.** Eso no invalida el diseño —una pantalla que puede
  ver postes puede ver las opciones del formulario de postes, y §5.1 explica por
  qué el permiso es el del formulario— pero sí obliga a decir con precisión qué
  se cierra: la vista de administración, con `description`, las marcas de tiempo
  y el `?archived=true`. No los nombres. §1 lo vendía como un cambio de capacidad
  y para los roles de hoy no lo es.
- **La lectura más grande de la API se queda fuera y el test no puede verla.**
  `express.static` está montado en la raíz de `app.ts`, once líneas antes del
  primer `authenticate`, así que **toda fotografía del disco** —de evento, de
  poste, de solución y el retrato de cada cuenta— está servida a cualquiera, sin
  sesión. Los nombres tampoco son secretos: viajan dentro de cada listado. Este
  trabajo no lo abre ni lo cierra, pero `routeGuards.test.ts` sólo enumera rutas
  y eso es un middleware sin ruta, así que C5 se declararía terminado —«toda
  lectura declara su permiso»— con esa puerta abierta. Queda escrito aquí para
  que la frase no mienta. Cerrarlo es un arco propio: hay que decidir si las
  imágenes se sirven autenticadas, con URL firmada, o se quedan públicas a
  sabiendas.

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

Recuento final: **105 − 7 borradas + 5 nuevas (cuatro de opciones y `autores`)
= 103 rutas.** Y con la advertencia que gobierna todo este documento desde la
segunda auditoría: esa cifra es para entender el tamaño, no para firmar nada. Se
movió dos veces en dos días. El manejador de 404 de §3.6 tampoco entra en la
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
No existe `.github/`, `api/Dockerfile` no ejecuta `npm test` y Vercel sólo hace
`vite build`. Toda verificación es manual, y por eso cada tarea nombra el comando
exacto que hay que ejecutar y en qué repositorio.

### Ya hecho

| | Qué | Estado |
|---|---|---|
| **0a** | El cuerpo de la petición deja de poder archivar filas (§3.9) | ✅ `ce91b1b` — 10 ficheros |
| **0b** | Autoría de postes, nombre de cuenta en bitácora, presupuesto de subidas | ✅ `64431bf` — 11 ficheros |
| **T0** | Este documento al día tras la segunda auditoría | ✅ — cifras, criterios, despliegue y este apartado |

### Familia A — sólo servidor, no rompe a nadie

Ninguna necesita que el cliente se entere. Se despliegan cuando convenga, sin
coordinar con Vercel.

**A0 · La bitácora deja de apuntar lo que el servidor rechazó.** Va primera, y no
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
bien son `updateRevision` y `updateSolucion`, que A1 borra junto con los dos
tests que lo vigilan. Sin A0 delante, A1 no es una limpieza, es una regresión.
Plan: [`docs/plans/2026-08-26-a0-bitacora-no-apunta-lo-rechazado.md`](../plans/2026-08-26-a0-bitacora-no-apunta-lo-rechazado.md).

```
cd api && npx vitest run src/controllers/logShape.test.ts
```

**A1 · Borrar las siete rutas muertas.** Las de §7. **Requiere A0 hecho.**
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

**A2 · El manejador de 404 en JSON (§3.6).** Vive en `src/app.ts`, que es
fichero de la sesión de autenticación: hay que avisar. Y decide dos cosas que la
primera versión daba por obvias: si va acotado a `/api` o es global —porque
`express.static` está montado en la raíz y un manejador global cambiaría también
lo que devuelve una imagen que falta— y si va antes o después del manejador de
error terminal.

```
cd api && npx vitest run src/app.notfound.test.ts
```

**A3 · Sacar `error.message` de las respuestas de 500 (§3.5).** Mecánico, unos
veinte controladores. Uno de ellos es `rol.controller.ts`, de la sesión de roles:
o se coordina, o se deja fuera y se dice. El criterio no es contar ficheros, es
que el test lo prohíba.

```
cd api && npx vitest run src/controllers/errorShape.test.ts
```

**A4 · `ARCHITECTURE.md` al día.** Se quedó sin dueño al cortar esta lista —
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

Añaden rutas que todavía no llama nadie. Si salen mal, no rompen nada, porque no
hay quien las use hasta la familia C.

**B1 · Los cuatro endpoints de opciones, en el servidor (§5).** Con una trampa
que el propio documento describe en §3.2 y que sus rutas nuevas pisaban:
`/opciones` es un literal y hay que **declararlo antes** del `/:id` de cada
router, o Express se lo come y acaba consultando `id = "opciones"`. Afecta a
`poste`, `evento` y `usuario`.

```
cd api && npx vitest run src/routes/opciones.test.ts
```

**B2 · `GET /api/bitacora/autores` (§5.4).** Misma trampa: antes de
`/:id_usuario`.

```
cd api && npx vitest run src/controllers/bitacora.autores.test.ts
```

**B3 · Los limitadores del generador a su propio fichero, y aplicados a los seis
informes.** Hoy son `const` sin `export` dentro de `generador.routes.ts`. Se
mudan a `src/middleware/reportLimiters.ts` sin cambiar sus números. **Decisión
pendiente:** si los seis informes fijos comparten cubo con
`POST /generador/consulta` —y entonces tirar informes se come el presupuesto del
generador— o tienen cubo propio con el mismo caudal. Se elige antes de empezar la
tarea.

```
cd api && npx vitest run src/middleware/reportLimiters.test.ts
```

### Familia C — las dos orillas

Aquí está todo lo que cambia un contrato, y todo se hace con la **maniobra de
tres pasos** de §11. Cada tarea son por tanto tres despliegues, no uno.

**C1 · Los seis informes, de `PUT` a `POST` (§3.1).** Paso 1: el servidor acepta
los dos métodos. Paso 2: `web/src/api/reporte.api.ts` pasa a `POST`. Paso 3: el
servidor retira el `PUT`. El primer entregable no es ninguno de los tres: **es el
test que hoy no existe.** Ninguna prueba ejercita `/api/reporte`, y el único test
que toca esos controladores se auto-omite si no hay Postgres, que es peor que
nada porque pasa en verde sin haberse ejecutado. Antes de mover un método hay que
decidir qué comprueba ese test y con qué datos, porque no hay base de pruebas.

```
cd api && npx vitest run src/controllers/reporte.contract.test.ts
cd web && grep -c 'axios.put' src/api/reporte.api.ts    # 0 tras el paso 2
```

**C2 · El cliente pasa a usar los endpoints de opciones (§5.5).** Ocho pantallas.
De diez peticiones de catálogo a dos. No retira nada del servidor, así que no
necesita paso 3 — pero sí necesita que B1 esté desplegado antes.

```
cd web && npx vitest run
```

**C3 · El sobre único en los listados (§3.3).** Y con él, **la decisión del
centinela, que hay que rehacer.** `limit=all` contra el servidor de hoy no falla:
`Number("all")` es `NaN`, `NaN || 50` es `50`, y devuelve cincuenta filas en
silencio — exactamente el fallo por el que se descartó `limit=0`. No es un
defecto del centinela, es la ventana de despliegue; se resuelve con la maniobra
de tres pasos, no cambiando de centinela.

```
cd api && npx vitest run src/routes/listShape.test.ts
```

**C4 · `201`/`204` y la capa cliente (§3.5, §4.1).** La tarea más grande de las
catorce. **La cifra de la primera versión estaba muy corta:** hay 57
comparaciones literales con `200` repartidas en 25 ficheros de `web/src`, de las
cuales las que rompen de verdad son al menos quince, cada una con su mensaje
falso — «No se pudo archivar» sobre una fila que sí se archivó, «No se pudo
crear» sobre algo ya creado, con el riesgo de que el usuario reintente y
duplique. Choca con `http.ts` y `SesionProvider.tsx`, de la sesión de
autenticación, y con `RolesPanel.tsx` y `Rol.api.ts`, de la de roles.

```
cd web && npx vitest run src/api/statusPropagation.test.ts
cd api && npx vitest run src/routes/statusCodes.test.ts
```

**C5 · Cerrar las veinte lecturas sin permiso (§3.7, §6).** Dos pasos, no tres:
el cliente pide bien primero (C2), se cierra después. Rompe a cualquier rol que
no tenga el permiso, así que se comprueba contra los roles sembrados antes de
desplegar. **Y hay que escribir la excepción**: `express.static` está montado en
la raíz once líneas antes del primer `authenticate`, así que toda fotografía del
disco —eventos, postes y el retrato de cada cuenta— está servida a cualquiera sin
sesión. Este trabajo no lo abre ni lo cierra, pero no se puede declarar «toda
lectura tiene permiso» sin decirlo, porque el test que lo vigila no puede verlo:
sólo enumera rutas, y eso es un middleware sin ruta.

```
cd api && npx vitest run src/routes/routeGuards.test.ts
```

### Familia D — al final

**D1 · Los nombres y los sub-recursos (§3.2, §3.4).** Cosmético, y el que más
ficheros toca. Aquí se mueve `GET /api/solucion/evento/:id_evento` a
`GET /api/evento/:id/solucion`, y con eso sí desaparece el montaje de
`/api/solucion`. Toca `App.tsx` y `menuItems.ts`, que la sesión de roles está
tocando ahora mismo. Y el test de §3.4 hay que escribirlo sobre **la tabla
montada**, no sobre los ficheros fuente: los dos únicos segmentos con mayúsculas
de toda la API son prefijos de montaje de `app.ts`, así que un test que recorra
`src/routes/*.ts` pasa hoy sin cambiar nada y seguiría pasando aunque la tarea no
se hiciera.

```
cd api && npx vitest run src/routes/naming.test.ts
```

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
| 3.1 método | El test de contrato de los seis informes (C1), que hay que escribir antes de mover nada |
| 3.2 sub-recursos y orden de declaración | Test que recorre **las rutas montadas** y falla si un literal se declara después de un paramétrico del mismo nivel. Se escribe en B1, no en D1: las rutas de opciones son las primeras que pisan esa trampa |
| 3.3 sobre | Test con la **lista escrita a mano** de los listados. Derivarlo es imposible: `res.json(x)` no revela la forma de `x`, y ése fue el error de la primera versión. La lista se cuenta al empezar C3, no ahora: hoy ya es uno menos que ayer porque A1 borra uno |
| 3.3 techo y centinela | Test del centinela sobre una colección por encima y por debajo del tope, más un caso del valor que el servidor viejo interpretaba como `50` |
| 3.4 nombres | Test que recorre **la tabla montada** —no los ficheros— y falla si un segmento tiene mayúsculas o un verbo fuera de la lista |
| 3.5 códigos | Test por método sobre las rutas que crean y archivan |
| 3.5 `error.message` | Test que lo prohíbe **en cualquier parte del cuerpo de un `catch` que responde**, no sólo dentro del `res.json` — la forma con variable intermedia es la mayoritaria. Acotado al `500`: el generador lo devuelve a propósito en `400`/`413`/`429`, y son frases escritas para el usuario |
| 3.6 formato de error | Test de que una dirección inexistente responde JSON |
| 3.7 permisos | `routeGuards.test.ts`, que ya existe — con la excepción de `express.static` escrita, porque el test no puede verla |
| 3.8 propiedad | `routeGuards.test.ts` ya distingue el gate de propiedad del de permiso; se añade que el tercer argumento coincida con el parámetro de la ruta |
| 3.9 entrada | ✅ `requestShape.test.ts` y `responseShape.test.ts`, ya escritos |
| 4.1 / 4.2 cliente | Test en `web`: un 403, un 500 y un fallo de red producen `status` 403, 500 y 0; y el auto-logout sigue disparando con 401 |
| 5 opciones | Test por endpoint: qué bloques devuelve y con qué columnas exactas |

---

## 11. Despliegue

`api` va a Coolify y `web` a Vercel: son dos tuberías, y entre una y otra hay una
ventana. La primera versión lo despachaba con «para eso sirve desplegar los dos
repositorios juntos», que no existe. La segunda decía «los dos a la vez» para dos
tramos, que tampoco.

**Y la ventana es mucho peor de lo que parece: no dura minutos, puede durar
semanas.** `web` es una aplicación instalable, y su service worker está
configurado con `registerType: "prompt"` (`web/vite.config.ts`). Eso significa
que el navegador se descarga la versión nueva **y espera**: no la aplica hasta
que la persona pulse «Actualizar». Un técnico de campo con la aplicación
instalada en el móvil puede seguir ejecutando el paquete de hace semanas contra
la API de hoy, y nadie se entera.

De ahí la regla que gobierna la familia C entera:

> **Ningún cambio puede romper al cliente viejo.** No existe «los dos a la vez».

Y de ahí la única maniobra segura, que son tres despliegues:

1. **El servidor acepta lo viejo y lo nuevo.** Nadie se rompe: el cliente antiguo
   sigue funcionando, el nuevo ya cabe.
2. **El cliente pasa a lo nuevo.** Sigue sin romperse nadie: el servidor entiende
   las dos formas.
3. **El servidor retira lo viejo.** Éste es el único paso peligroso, y es el que
   hay que aguantar sin dar hasta saber que ya nadie usa la forma vieja.

**Cómo saber cuándo dar el paso 3 es una decisión que no está tomada.** Hoy no
hay forma de saberlo: nadie cuenta quién llama a la forma antigua. Dos salidas
razonables, y hay que elegir una en C1, que es la primera tarea que la necesita:
contar el uso de la forma vieja en la bitácora y esperar a que llegue a cero, o
fijar un plazo largo y asumirlo. Contar es más trabajo y es la respuesta
correcta; el plazo es más barato y se equivoca en silencio.

**El código de tolerancia que introduce el paso 1 se borra en el paso 3, y su
borrado es una tarea del plan, no una nota.** `Array.isArray(r.data) ? r.data :
r.data.data` es de las cosas que se quedan cinco años si nadie las apunta.

Las familias A y B no necesitan nada de esto: A no cambia ningún contrato y B
sólo añade.

---

## 12. Lo que no cambia

El formato de error `{ message }` y su manejador global. `requireSelfOrPermission`
y que la propiedad no sea un permiso. Los cuatro limitadores del generador y sus
números —cambia dónde viven, no cuánto dejan pasar (B3)—. Los `separate: true`
que evitan el producto cartesiano y la subconsulta de eventos pendientes. Los
permisos como `modulo` y `accion` en español y en la base de datos. Y
`routeGuards.test.ts`, que no se sustituye: se le quitan tres entradas en A1 y se
le vacía la lista de excepciones en C5.

De la paginación de postes y eventos no cambian el tope de 100 por página ni sus
optimizaciones. **La lectura de `limit` sí cambia** (§3.3) — la primera versión
declaraba intocable toda la paginación en una sección y la modificaba en otra.

Y no cambia nada de lo que llevan las otras dos sesiones: las catorce rutas de
autenticación, y `/api/rol` con su pantalla de roles.

---

**Fuentes.** `src/routes/*.routes.ts`, `src/app.ts`, `src/routes/routeGuards.test.ts`,
`src/controllers/*.ts`, `src/middleware/requirePermission.ts`, cruzado con
`web/src/api/*.api.ts`, `web/src/pages`, `web/src/components` y `web/vite.config.ts`.

Recuento hecho sobre el árbol de trabajo del 25 de agosto de 2026 y **revisado el
26**, cuando la segunda auditoría encontró que cinco cifras se habían movido en
veinticuatro horas por trabajo de otras sesiones. Ésa es la razón de que los
criterios de terminado de §9 sean comandos y no números: el documento no puede
seguirle el ritmo al árbol, y no debe intentarlo.

Auditado dos veces por revisores adversariales con encargos separados —cuatro el
25 de agosto sobre el diseño, cuatro el 26 sobre si se podía empezar a
construir—. Los hallazgos que cambiaron una decisión están incorporados y
señalados en el texto; los que cambiaron sólo una cifra, corregidos en silencio.
