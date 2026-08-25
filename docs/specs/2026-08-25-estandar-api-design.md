# Estándar de la API — diseño

Fija la convención de la superficie HTTP y del contrato de respuesta, y la aplica
a las **104 rutas que no son de autenticación**. No añade ninguna función: cierra
la puerta a que la próxima ruta se escriba de una séptima manera.

> **Segunda versión.** La primera fue auditada por cuatro revisores con enfoques
> distintos —hechos, consecuencias de diseño, seguridad y completitud— y no la
> aguantó: cuarenta y tantos hallazgos, dieciséis de los cuales cambiaban una
> decisión y no una frase. Uno de ellos no era un defecto del documento sino un
> agujero abierto en producción, y está arreglado antes que este texto (§9).
> Lo que sigue incorpora todo aquello. Los descartes de la primera versión están
> en §8 junto a los demás, porque un descarte razonado vale lo mismo que una
> regla.

**Por qué el alcance se cuenta y el total no.** Mientras se escribía esto, la
otra sesión añadió cuatro rutas de autenticación: `POST /api/auth/email/send`,
`/email/verify`, `/password/forgot` y `/password/reset`. El total pasó de 114 a
118 en unas horas. Las 104 que no son de autenticación no se movieron ni una, y
por eso son la cifra de este documento: la otra sólo mide cuándo se hizo el
recuento.

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

**104 rutas.** Las catorce de autenticación las lleva otra sesión, en el Plan 3
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

**Versionar la API o mantener alias.** No hace falta, y el argumento es
organizativo, no mecánico — la primera versión lo escribió al revés y merece la
corrección: `CORS_ORIGIN` **es una lista separada por comas**, y el comentario de
[`security.ts`](../../src/config/security.ts) dice por qué («*so a second
frontend, a preview deployment, is a variable and not a code change*»). Además
`requireSameOrigin` sólo juzga escrituras que ya llevan cookie de sesión, y la
cabecera `Origin` únicamente es infalsificable **desde un navegador**: un script
pone la que quiera. Lo que sostiene la decisión es que no hay ningún otro cliente
conocido y que los dos repositorios son nuestros — no que el mecanismo lo impida.

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
llegue el tramo del renombrado la trampa ya no existe. Lo que queda en pie es más
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
mencionó. Los dos topes conviven porque miden cosas distintas —una exportación
construye un fichero y se mete en su propio presupuesto de caudal; una lectura de
listado va a una pantalla— pero eso hay que decirlo, no dejar dos números sueltos
contradiciéndose. Y la respuesta de postes con `limit=all` ronda **0,7 MB**, no
«decenas de megas»: el argumento del techo se sostiene sin exagerar la magnitud.

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
| `/:id/desarchivar` (×9) | `/:id/restore` | Verbo de operación |
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

**`204` sólo donde el archivado no informa de nada:** el `DELETE` de las nueve
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

**Los códigos van en el mismo tramo que la capa cliente (§9), y por eso.** Trece
sitios del frontend comparan literalmente contra `200`. Desplegar `201`/`204`
antes de arreglarlos significa que cada archivado correcto muestra «No se pudo
archivar» y la fila sigue en pantalla; y en `AddRevisionSheet` el comentario del
propio fichero documenta que ese fallo ya ocurrió una vez y costó una inspección
de campo. Un tramo, un despliegue, ninguna ventana.

### 3.6 El formato de error, que casi está resuelto

`{ message }` en toda respuesta de error, garantizado por el manejador global de
`app.ts` incluso para lo que falla antes de llegar a un controlador. Esto no se
decide: se documenta. Con dos correcciones que la primera versión daba por
hechas y no lo estaban:

- **Once respuestas no llevan `message`:** nueve `res.sendStatus(401)` con cuerpo
  vacío y dos `res.status(500).send("…")` de texto plano en
  [`upload.controller.ts`](../../src/controllers/upload.controller.ts). Las dos
  de subida pasan a `{ message }`; las de `401` las lleva la otra sesión.
- **Falta el manejador de 404.** Una ruta que no existe no es un error, así que
  no llega al manejador global: cae en el `finalhandler` de Express, que responde
  **HTML**. Y el 404-de-ruta-inexistente es exactamente lo que fabrican los
  tramos que mueven direcciones. Se añade `app.use((req, res) => res.status(404)
  .json({ message: … }))` al final, y es prerrequisito del tramo 6.

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
con `archivar: false` en los diez módulos y `editar: true` en cuatro, así que la
columna `archivar` de la matriz era decorativa para quien pudiera editar.

**Y ningún `include` manda más de lo que la pantalla lee.** `PosteModel` ganó
`id_usuario` con la autoría y no estaba en la lista de modelos vigilados, así que
`GET /evento/:id` y los tres informes fijos entregaban el autor de cada poste a
cualquier cuenta. La bitácora mandaba el nombre de cuenta de cada persona
saltándose la constante que existe para eso.

**Queda pendiente la mitad ancha de esta regla:** veinticinco `include` siguen
devolviendo la fila completa de ciudad, material o propietario donde la pantalla
sólo usa el nombre. Eso es peso, no fuga de datos de autoría, y va en el tramo 3.

---

## 4. Las reglas del cliente

### 4.1 El cliente lanza, no devuelve

Las 34 funciones que hacen `.then(r => r.status).catch(() => 400)` —en nueve
módulos— pasan a devolver los datos y a propagar el fallo. Hoy un `403` por
permiso, un `500` del servidor y una red caída llegan los tres como el número
400, así que la información se destruye en la capa de API antes de que la
pantalla pueda verla, y sólo cabe un mensaje.

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

Los consumidores que se migran, que son la lista completa del tramo 3:
`PosteSheet`, `ReportTramoSec`, `ReportGeneralSec`, `ReportRecorrido`,
`EventoSheet`, `AddEventoPageSheet`, `UsuarioSheet` y la edición en línea de
`poste/index.tsx`. Las cinco pantallas de Parámetros y `CiudadesPage` siguen con
los endpoints de administración, que es lo suyo.

---

## 6. Cómo quedan las veinte lecturas

**Con las direcciones de hoy**, porque este cierre es el tramo 3 y los
sub-recursos son el tramo 6 — la primera versión las nombraba ya renombradas y
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

**Dos advertencias sobre lo que este cierre no consigue**, para no vender humo:

- **`GET /api/poste/tramos` gateado no cierra nada** mientras el generador siga
  por debajo: el rol Cliente tiene `generador: TODO`, y el generador sirve
  `ciudad` con `lat`/`lng` sin marca de staff. La topología de la red ya está a
  su alcance por otra puerta. Se cierra por coherencia, no porque proteja.
- **`parametros:ver` sobre los cinco catálogos esconde poco** mientras
  `searchPoste` y `searchEvento` incluyan material, propietario y ciudades sin
  `attributes`. Por eso los veinticinco `include` de §3.9 van en el mismo tramo:
  cerrar la puerta principal y dejar la de servicio abierta no es cerrar.

---

## 7. Las diez rutas que se borran

Sin ningún cliente en `web`, con sus controladores:

```
POST   /api/solucion/       GET    /api/solucion/
PUT    /api/solucion/:id    DELETE /api/solucion/:id
PUT    /api/revision/:id    DELETE /api/revision/:id
POST   /api/rol/            PUT    /api/rol/:id
DELETE /api/rol/:id
GET    /api/files/
```

El CRUD de `solucion` quedó muerto cuando `POST /api/evento/:id/resolver` pasó a
crear la solución él mismo; el de `rol` nunca tuvo pantalla. Código que nadie
llama es código que nadie está comprobando.

**Dos cosas que la razón «nadie lo llama» no cubre:**

- **`DELETE /api/rol/:id` era un borrado duro con daño en cascada.** `RolModel`
  no es `paranoid`, y `permisos.id_rol` tiene `onDelete: "CASCADE"`: borrar un
  rol destruía sus 40 filas de permisos sin vuelta atrás. Ése es el argumento
  fuerte para quitarlo, mucho más que la falta de cliente.
- **Con `POST /api/rol/` se pierde la única forma de crear un rol.** `createRol`
  es el único llamante de `seedRolePermissions`, que existe justamente para que
  un rol nuevo nazca con sus 40 filas. Sin él, el modelo de permisos queda
  congelado en tres roles — y este mismo diseño depende de que existan roles con
  combinaciones finas. **Se borran los tres, y queda anotado que crear roles pasa
  a ser trabajo pendiente de producto**, no un efecto que nadie previó.

Recuento final: **104 − 10 borradas + 5 nuevas (cuatro de opciones y `autores`)
= 99 rutas en 20 montajes.** El manejador de 404 de §3.6 no entra en la cuenta:
no es una ruta, es lo que responde cuando no hay ninguna.

---

## 8. Lo que se descartó, y por qué

**El sello multi-permiso para un catálogo único.** Ver §5.1. Habría tocado la
infraestructura de permisos —lo que gobierna las 104 rutas a la vez— para
resolver un problema creado al juntar ocho listas en una puerta.

**Todo en inglés.** Era la lectura literal de la regla de la casa, y llevaba a
dos sitios malos: traducir el vocabulario del negocio empeora los nombres (§3.4),
y los permisos son datos, así que el estándar nacía con una excepción forzosa.

**Todo en español.** Obliga a pelearse con Sequelize por `createdAt` y
`deletedAt` en diecisiete modelos para no ganar nada que nadie note.

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

## 9. Orden del trabajo

Por lo que cuesta **no** hacerlo. Los dos primeros ya están hechos.

| | Qué | Estado / riesgo |
|---|---|---|
| **0a** | El cuerpo de la petición deja de poder archivar filas (§3.9) | ✅ `ce91b1b` — 10 ficheros |
| **0b** | Autoría de postes, nombre de cuenta en bitácora, presupuesto de subidas | ✅ `64431bf` — 11 ficheros |
| **1** | Los seis `PUT`→`POST`; las 10 rutas muertas; el manejador de 404; `ARCHITECTURE.md` | **Riesgo medio, sin red** |
| **2** | Los 97 sitios que filtran `error.message`, con el reparto esperado / inesperado | Bajo, mecánico |
| **3** | Los cuatro endpoints de opciones; cerrar las veinte lecturas; `bitacora/autores`; los 25 `include` anchos | Medio. Toca pantallas |
| **4** | El sobre único en los 23 listados; `limit=all` y su techo | Medio. Cambio de contrato |
| **5** | `201`/`204` **y** la capa cliente, en un solo despliegue | Medio. Las dos orillas |
| **6** | Los nombres (§3.4) y los sub-recursos (§3.2) | El que más ficheros toca |

**El tramo 1 no es «riesgo ninguno», que es lo que decía la primera versión.** No
existe un solo test que ejercite `/api/reporte`: `grep` de esa ruta en los tests
devuelve vacío, y `routeGuards.test.ts` acepta `PUT` y `POST` por igual, así que
el cambio le es invisible. Si al mover las seis se olvida una de las seis
funciones de `reporte.api.ts`, la ruta no existe, Express responde 404 y **CI
sigue verde** con seis pantallas de informes rotas. Su primer entregable es el
test que hoy falta.

**Y «reutilizando el limitador del generador» no se puede.** `perUser` y los
cuatro limitadores son `const` **sin `export`** dentro de `generador.routes.ts`.
Se mudan a `src/middleware/reportLimiters.ts` sin cambiar sus números, y los seis
informes fijos comparten un cubo con el mismo presupuesto que `consulta`, porque
cuestan lo mismo.

**Terminado significa**, por tramo:

- **1** — las seis rutas responden a `POST` con la misma primera fila que
  devolvían por `PUT`, hay test que lo comprueba, `/api/solucion` no existe, una
  dirección inventada responde `404` con `{message}` en JSON.
- **2** — `grep` de `error.message` dentro de un `catch` que responde no
  encuentra nada en los 18 ficheros; una criticidad fuera de rango sigue
  diciendo qué está mal.
- **3** — `READ_GATE_NOT_APPLICABLE` vacía de lo que no es autenticación; las
  ocho pantallas migradas hacen una petición de opciones cada una; ningún
  `include` sin `attributes`.
- **4** — los 23 listados responden el sobre; `PostePaginatedResponse` y
  `EventoPaginatedResponse` son un `Paginated<T>`; ninguna llamada pasa
  `export=true`.
- **5** — las 34 funciones propagan; los 13 sitios que comparan con `200` están
  migrados; el auto-logout de `SesionProvider` sigue disparando con 401.
- **6** — ninguna ruta con mayúsculas ni verbo en español; los tests que citan
  direcciones, actualizados.

---

## 10. Cómo se verifica

Una regla sin forma de comprobarse es una recomendación. La primera versión
dejaba seis reglas sin verificación, incluida la orilla del cliente entera.

| Regla | Cómo se comprueba |
|---|---|
| 3.1 método | El test de contrato de los seis informes (tramo 1) |
| 3.2 sub-recursos y orden de declaración | Test que recorre las rutas montadas y falla si un literal se declara después de un paramétrico del mismo nivel — es una propiedad del stack de Express, perfectamente asertable |
| 3.3 sobre | Test con la **lista escrita a mano** de los 23 listados. Derivarlo es imposible: `res.json(x)` no revela la forma de `x`, y ése fue el error de la primera versión |
| 3.3 techo y `limit=all` | Test de `limit=all` sobre una colección por encima y por debajo del tope |
| 3.4 nombres | Test que recorre `src/routes/*.routes.ts` y falla si un segmento tiene mayúsculas o un verbo fuera de la lista |
| 3.5 códigos | Test por método sobre las rutas que crean y archivan |
| 3.5 `error.message` | Test que lo prohíbe **en cualquier parte del cuerpo de un `catch` que responde**, no sólo dentro del `res.json` — la forma con variable intermedia es la mayoritaria. Acotado al `500`: el generador lo devuelve a propósito en `400`/`413`/`429`, y son frases escritas para el usuario |
| 3.6 formato de error | Test de que una dirección inexistente responde JSON |
| 3.7 permisos | `routeGuards.test.ts`, que ya existe |
| 3.8 propiedad | `routeGuards.test.ts` ya distingue el gate de propiedad del de permiso; se añade que el tercer argumento coincida con el parámetro de la ruta |
| 3.9 entrada | ✅ `requestShape.test.ts` y `responseShape.test.ts`, ya escritos |
| 4.1 / 4.2 cliente | Test en `web`: un 403, un 500 y un fallo de red producen `status` 403, 500 y 0; y el auto-logout sigue disparando con 401 |
| 5 opciones | Test por endpoint: qué bloques devuelve y con qué columnas exactas |

---

## 11. Despliegue

`api` va a Coolify y `web` a Vercel: son dos tuberías, y entre una y otra hay una
ventana. La primera versión lo despachaba con «para eso sirve desplegar los dos
repositorios juntos», que no existe. Los tramos 3, 4, 5 y 6 cambian el contrato,
así que cada uno necesita su orden.

| Tramo | Orden | Por qué |
|---|---|---|
| 1 | Servidor primero | El frontend no llama a lo que se borra. Los seis informes van con el frontend, en el mismo despliegue |
| 2 | Servidor solo | No cambia ningún contrato |
| 3 | Servidor primero | Los endpoints de opciones deben existir antes de que nadie los pida; el cierre de las lecturas, **después** del frontend migrado |
| 4 | **Frontend primero, tolerando las dos formas** | Ningún orden funciona solo: si sale la API antes, los consumidores de array reciben un objeto; si sale el frontend antes, hace `.data` sobre un array |
| 5 | Los dos a la vez | Es lo que hace que este tramo sea uno solo (§3.5) |
| 6 | Frontend primero, llamando a la dirección nueva con reintento a la vieja | Un renombrado produce 404 en la ventana |

**El código de tolerancia de los tramos 4 y 6 se borra en el tramo siguiente, y
su borrado es una tarea del plan, no una nota.** `Array.isArray(r.data) ? r.data
: r.data.data` es de las cosas que se quedan cinco años si nadie las apunta.

---

## 12. Lo que no cambia

El formato de error `{ message }` y su manejador global. `requireSelfOrPermission`
y que la propiedad no sea un permiso. Los cuatro limitadores del generador y su
exportación de una en una. Los `separate: true` que evitan el producto cartesiano
y la subconsulta de eventos pendientes. Los permisos como `modulo` y `accion` en
español y en la base de datos. Y `routeGuards.test.ts`, que no se sustituye: se le
vacía la lista de excepciones.

De la paginación de postes y eventos no cambian el tope de 100 por página ni sus
optimizaciones. **La lectura de `limit` sí cambia** (§3.3) — la primera versión
declaraba intocable toda la paginación en una sección y la modificaba en otra.

---

**Fuentes.** `src/routes/*.routes.ts`, `src/app.ts`, `src/routes/routeGuards.test.ts`,
`src/controllers/*.ts`, `src/permissions/matrix.ts`, `src/middleware/requirePermission.ts`,
cruzado con `web/src/api/*.api.ts`, `web/src/pages` y `web/src/components`.

Recuento hecho sobre el árbol de trabajo del 25 de agosto de 2026. Auditado el
mismo día por cuatro revisores con enfoques separados; los hallazgos que
cambiaron una decisión están incorporados y señalados en el texto, y los que
cambiaron sólo una cifra, corregidos en silencio.
