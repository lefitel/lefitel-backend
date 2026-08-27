# Permisos por módulo — Diseño

**Fecha:** 2026-08-27
**Estado:** pendiente de aprobación
**Repos:** `api` y `web`, rama `isaias`

---

## 1. Objetivo

Que cada módulo declare **las acciones que necesita**, en vez de heredar las mismas cuatro que
todos los demás.

Hoy el vocabulario de permisos del sistema entero son cuatro verbos —`ver`, `crear`, `editar`,
`archivar`— y **todos los módulos tienen los cuatro**, los usen o no. Eso tiene dos consecuencias:
hay casillas que no significan nada, y un permiso que no sea uno de esos cuatro verbos no se puede
expresar.

**Criterio de éxito:** después de este cambio, añadir un permiso nuevo —con el nombre que le
corresponda, no forzado a uno de los cuatro verbos— es **una línea en una constante y una fila de
sembrado**. Y mientras no se añada, no existe ni aparece en ninguna pantalla.

Este trabajo entrega el mecanismo. **No añade ningún permiso nuevo.**

---

## 2. El problema, medido

La matriz es una rejilla estricta de **10 módulos × 4 acciones = 40 celdas**, definida en
`api/src/permissions/matrix.ts:12-25`.

De esas 40, **8 no se preguntan nunca** — ni en el servidor ni en el navegador:

| Módulo | Casillas muertas |
|---|---|
| `bitacora` | `crear`, `editar`, `archivar` |
| `reportes` | `crear`, `editar`, `archivar` |
| `archivos` | `crear`, `editar` |

Verificado sobre las rutas (`grep requirePermission` en `api/src/routes/`): `bitacora` solo usa
`ver` (`bitacora.routes.ts:12,19`); las seis rutas de `reportes` piden todas `reportes.ver`
(`reporte.routes.ts:14-19`); `archivos` solo usa `ver` y `archivar` (`files.routes.ts:18-24`). Y
sobre el front: los únicos `can()` sobre esos tres módulos son `archivos.archivar` en
`FilesPage.tsx` y `"ver"` para el menú lateral.

**Y no están apagadas: están concedidas.** En `osefi_local`, las 8 valen `true` para el rol 1
(Administrador), que tiene las 40 en «sí». La pantalla de Seguridad le está prometiendo al
administrador una autoridad que no se aplica en ningún sitio.

El reparto completo de hoy, por rol: Administrador 40 de 40, Coordinador 17 de 40, Cliente 8 de 40.

**El segundo problema es el que de verdad bloquea.** Un permiso que no sea uno de los cuatro verbos
no cabe. Ejemplos reales que hoy no se pueden expresar:

- **Exportar.** El botón de exportar de postes y eventos no comprueba nada. «Exportar» no es
  ninguno de los cuatro verbos.
- **Ver los datos de todos los clientes**, para la separación de datos por cliente que está
  pendiente de diseño aparte.

Meterlos de calzador en un verbo que no significa eso es peor que no tenerlos, porque la pantalla
miente sobre lo que concede.

---

## 3. La forma nueva

Una sola constante. Todo lo demás se deriva de ella.

```ts
export const PERMISOS = {
  postes:     ["ver", "crear", "editar", "archivar"],
  eventos:    ["ver", "crear", "editar", "archivar"],
  ciudades:   ["ver", "crear", "editar", "archivar"],
  parametros: ["ver", "crear", "editar", "archivar"],
  generador:  ["ver", "crear", "editar", "archivar"],
  seguridad:  ["ver", "crear", "editar", "archivar"],
  roles:      ["ver", "crear", "editar", "archivar"],

  archivos:   ["ver", "archivar"],
  reportes:   ["ver"],
  bitacora:   ["ver"],
} as const;
```

De 40 celdas a **32**.

`MODULES` pasa a derivarse de las claves. `ACTIONS` **se queda**, pero cambia de significado: ya no
es «las acciones que tiene cada módulo», sino **el vocabulario completo del sistema** — la lista de
todos los nombres de acción que existen, que es lo que necesita `ACTION_LABELS` para traducirlos a
la pantalla. Cuando se añada `exportar`, entra ahí y en el módulo que la use.

Y aparece la función que hoy no existe y que es la pieza clave:

```ts
isActionOf(modulo, accion)   // ¿este módulo tiene esta acción?
```

Sustituye a `isAction(accion)` en los dos sitios donde se decide algo. La diferencia entre las dos
es toda la seguridad de este diseño: `isAction("crear")` dice que sí siempre, aunque el módulo sea
`bitacora`.

---

## 4. Qué cambia

Once puntos. Ni uno más.

### En `api`

| Fichero | Qué |
|---|---|
| `src/permissions/matrix.ts` | La constante `PERMISOS`. `MODULES` derivado. `isActionOf()`. `emptyPermissions()` recorre las acciones de cada módulo, no el producto cartesiano |
| `src/permissions/store.ts:37` | `buildMatrix` valida el **par** con `isActionOf`, no la acción suelta. **Ver §5.1** |
| `src/permissions/store.ts:112-118` | `seedRolePermissions` deja de hacer `MODULES × ACTIONS`. **Ver §5.3** |
| `src/controllers/permiso.controller.ts:33` | `getPermisos` añade `acciones` a cada entrada de `modulos`. **Aditivo** — ver §6 |
| `src/controllers/permiso.controller.ts:70` | `changesFrom` valida el par. **Ver §5.1** |
| `src/migrations/20260826000004-drop-dead-permission-cells.ts` | Nueva. Ese número está libre hoy, pero hay otras sesiones creando migraciones en este mismo repo: comprobarlo antes de escribirla. **Ver §7** |

### En `web`

| Fichero | Qué |
|---|---|
| `src/lib/permissions.ts:39-53` | Espejo de la constante. El tipo `Permisos` admite huecos. `sinPermisos()` por módulo |
| `src/api/Permisos.api.ts` | El tipo de `modulos` gana `acciones` |
| `src/components/PermisosPanel.tsx:184-215` | Dibuja **hueco** donde el módulo no tiene esa acción |

### Lo que NO se toca, y por qué

- **La tabla `permisos`.** Ya soporta esto: es `(id_rol, modulo, accion, permitido)`, **una fila por
  casilla**. No hay ningún `CHECK` ni restricción que exija que existan las 40. Verificado contra el
  esquema real. La rigidez está entera en el código.
- **La firma de `can(rol, modulo, accion)`**, y los 72 sitios que la llaman.
- **Tipos mapeados de TypeScript.** Se descartaron a propósito: ver §10.2.

---

## 5. Las tres trampas, y por qué van en el mismo commit

Estas tres salieron de una auditoría con cuatro agentes adversariales el 2026-08-26 (la auditoría previa). Las tres
convierten este cambio en algo peor que no hacerlo si se dejan a medias.

### 5.1 La trampilla — la más grave

`store.ts:37` y `permiso.controller.ts:70` validan hoy con `isAction()`, que solo mira si el nombre
de la acción existe **en algún sitio**.

Si la constante cambia pero esas dos validaciones no, aparece este camino: alguien con `roles.editar`
manda `PUT /api/permisos/2` con `{"archivos": {"crear": true}}`. La acción `crear` existe, así que
pasa la validación. Se crea la fila. **Hoy no la lee nadie.** El día que `archivos` recupere `crear`
—para cerrar la ruta de subida, que está abierta— esa fila ya dice que sí, y nadie recuerda haberla
marcado.

Un permiso concedido que nadie recuerda conceder es exactamente el fallo que esta pantalla existe
para evitar.

**Por eso las dos validaciones y la constante van en el mismo commit.** No es preferencia de estilo:
separarlas abre la trampilla durante la ventana que las separe.

El test que hoy parece cubrir esto —`store.test.ts:84-97`, «ignores rows naming something the code
no longer knows about»— **no lo cubre**: prueba nombres desconocidos globalmente, no un par ilegal
formado por dos nombres legales. Hace falta uno nuevo (§8).

### 5.2 La migración se deshacía sola

`permiso.controller.ts:120` compara cada celda contra su valor anterior para saber si cambió. Para
una celda que la migración acaba de borrar, ese valor anterior es «no existe» — que nunca coincide
con lo que se envía. La celda cuenta como cambiada, el `update` no encuentra fila, y el `create` de
la línea 132 **reinserta la fila que la migración borró**.

Con la validación del par (§5.1) la petición se rechaza antes de llegar ahí. La trampa se cierra
sola al cerrar la primera, pero queda escrita porque explica por qué el orden importa.

### 5.3 El sembrado repoblaba las muertas

`seedRolePermissions` escribe el producto cartesiano. **El primer rol que se creara desde la
pantalla de Seguridad volvería a escribir las 40 celdas**, incluidas las 8 que la migración acaba de
borrar. Pasa a sembrar solo las que cada módulo declara: 32.

---

## 6. Compatibilidad y despliegue

**El cambio en la respuesta de la API es puramente aditivo.** Hoy `getPermisos` devuelve `modulos` y
`acciones` como dos listas separadas. Se añade `acciones` **dentro de cada módulo**, y la lista
global `acciones` **se queda** como diccionario de etiquetas.

Esto no es cortesía: es necesario, y por dos hechos verificados.

1. `web/vite.config.ts:37` monta la PWA con `registerType: "prompt"`, así que una versión nueva
   espera a que la persona pulse «Actualizar». **Alguien puede llevar días con el bundle viejo.**
2. **No hay ni un `ErrorBoundary` en todo `web/src`.** Comprobado: `grep -rn
   "ErrorBoundary|componentDidCatch|getDerivedStateFromError" src/` no devuelve nada.

Si `acciones` desapareciera, `PermisosPanel.tsx:184` haría `.map()` sobre `undefined` y —sin
`ErrorBoundary`— la pantalla en blanco sería **de la aplicación entera**, no del panel.

Siendo aditivo, el bundle viejo sigue dibujando la rejilla completa. Si alguien marca ahí una casilla
que ya no existe, el servidor la rechaza con un mensaje claro. Feo, correcto y acotado.

**Orden de despliegue: API primero.** El front viejo contra la API nueva funciona (dibuja de más); el
front nuevo contra la API vieja no recibiría `acciones` por módulo. Ninguno de los dos órdenes es
inseguro, pero solo uno es correcto.

**Nota:** el front no vuelve a preguntar los permisos salvo que cambie el id del rol
(`SesionProvider.tsx`). Una pestaña abierta desde antes del despliegue conserva la matriz vieja hasta
que alguien recargue. No afecta a la seguridad —el servidor decide— pero sí a lo que se dibuja.

---

## 7. La migración

Borra las **24 filas muertas**: las 8 casillas × 3 roles.

**`down()` reinserta las 24 en `false`, no en su valor original.** Las 8 del Administrador están hoy
en `true`, pero esas casillas no se preguntan en ningún sitio, así que ese `true` no significa nada.
Reinsertarlo sería conceder por si acaso. Deshacer hacia el lado de negar es el único seguro, y queda
dicho en el propio fichero.

Lleva su `.test.ts` al lado, siguiendo la convención de las ocho migraciones anteriores.

---

## 8. Pruebas

**Se caen exactamente 2 aserciones**, las dos en `api/src/permissions/store.test.ts`. Comprobadas
una a una contra el fichero, no estimadas:

- **`:119-121`** — recorre `MODULES × ACTIONS` exigiendo que cada celda sea booleana.
  `permissions.archivos.crear` pasa a ser `undefined`. Cambia además la premisa del test, que hoy se
  llama «fills in every module and action, granted or not».
- **`:187`** — `expect(rows).toHaveLength(MODULES.length * ACTIONS.length)`: espera 40 filas
  sembradas y serán 32.

**Sobreviven, y conviene decir por qué**, porque el instinto dice lo contrario:

- `:94`, `:132`, `:189` comparan **módulos**, y los módulos no cambian.
- `:96` compara `Object.keys(permissions.eventos)` con `ACTIONS`. Pasa porque `eventos` conserva las
  cuatro y `ACTIONS` sigue siendo la lista de los cuatro verbos.
- `permiso.controller.test.ts:100-101` hace `.map(m => m.key)` sobre `modulos` y `acciones`. El
  campo nuevo de cada módulo lo ignora, y la lista global no se toca: es la prueba de que §6 es
  aditivo de verdad.
- `:77-79` recorre el cartesiano llamando a `can()` y espera `false` en todo. **Sigue pasando**,
  porque una celda ausente se lee como `false` — pero pasa a afirmar algo sin sentido sobre 8 pares
  que ya no existen. **Se actualiza por honestidad, no porque falle.**

**Tres que no existen y se añaden:**

1. **El par ilegal.** Una fila `('bitacora','archivar', true)` en la tabla **no concede nada**, y el
   endpoint rechaza una petición que intente crearla. Es la prueba que cierra §5.1 y hoy no hay
   ninguna que lo cubra.
2. **La migración**, con su `up` y su `down`.
3. **`web/src/components/PermisosPanel.test.tsx`**, que **no existe hoy** — y es el fichero que más
   cambia en este trabajo.

Estado de partida, medido antes de tocar nada: `api` 73 ficheros / 1.157 tests en verde; `web` 32
ficheros / 426 tests en verde.

---

## 9. Fuera de alcance

Dicho para que no se cuele:

- **No se añade ningún permiso nuevo.** Ni `exportar`, ni nada de la separación por cliente. Este
  trabajo entrega el mecanismo; los permisos se añaden cuando se necesiten, que es el punto.
- **`POST /api/upload` sigue sin comprobar permisos.** Es una excepción declarada a propósito en
  `routeGuards.test.ts:217`, y es la razón de que `archivos` nunca tuviera `crear`. Es el primer
  cliente natural del sistema nuevo, pero cerrar esa ruta cambia quién puede subir fotos de campo y
  eso merece decidirse solo, no de rebote. **Queda apuntado.**
- **`postes.ver` y `ciudades.ver` solo se comprueban en el navegador.** El servidor no las mira:
  desmarcarlas quita la entrada del menú y `GET /api/poste/` sigue devolviendo los 1.541 postes.
  Son dos casillas que **mienten**, y son peores que las 8 que no hacen nada — pero arreglarlas es
  poner puertas en rutas, no cambiar el modelo de permisos. Trabajo aparte.
- **La separación de datos por cliente.** Diseño propio, pendiente de un dato que no está en la base
  (a qué eléctrica pertenece cada cuenta Cliente).

---

## 10. Decisiones y por qué

### 10.1 `ACTIONS` se queda, con otro significado

Podría derivarse de la constante. Se conserva como lista explícita porque `ACTION_LABELS` necesita
una etiqueta por nombre de acción, y porque el conjunto de nombres válidos del sistema es una cosa
que conviene poder leer de un vistazo. Lo que cambia es que ya no implica que todos los módulos las
tengan todas.

### 10.2 Sin tipos mapeados de TypeScript

La versión ambiciosa haría que `can(rol, "bitacora", "archivar")` no compilara. Se probó con el
TypeScript real del proyecto (7.0.2) durante la auditoría, y el resultado fue que **protege el caso
que no importa y no protege los tres que importan**:

- `can(1, "bitacora", "archivar")` → error. Bien, pero nadie escribe eso.
- `can(1, m, "ver")` con `m: Module` → **compila**. Es lo que hacen `menuItems.ts` y `App.tsx`.
- `PermissionGuard.tsx:8-9` declara sus props como `Parameters<typeof can>[1]`, y eso **pierde la
  correlación por completo**: acepta `{module:"reportes", action:"archivar"}` sin una queja.

Se pagaría el coste —tocar los 72 sitios de llamada y romper la compilación de dos ficheros de
test— para no cobrar el beneficio. La validación en ejecución (§5.1) sí protege los tres casos.

### 10.3 El tipo del front admite huecos, sin ser un mapeado

`Permisos` pasa de `Record<Modulo, Record<Accion, boolean>>` a `Record<Modulo, Partial<Record<Accion,
boolean>>>`. Con esto el tipo **deja de mentir** —hoy afirma que toda celda existe— sin romper los
cinco ficheros de test que construyen matrices haciendo `p[modulo].ver = true` con el módulo en una
variable, que es lo que un mapeado sí rompería.

`can()` no necesita cambio: ya usa `?.[modulo]?.[accion] ?? false`, y `store.ts:87` usa `=== true`.
**Las dos lecturas ya fallan cerrado ante un hueco.** Ese es el motivo de que la tabla y el lector
no haya que tocarlos.

### 10.4 Hueco, no casilla en gris

Donde un módulo no tiene una acción, la celda queda **vacía**. Una casilla deshabilitada siempre
parece «desmarcada, se puede marcar», que es justo la confusión que este trabajo viene a quitar.

---

## 11. Nota sobre las fechas

El fichero de la migración se llama `20260826000004-drop-dead-permission-cells` y el trabajo es del
**27**. El desfase es real y se queda así a propósito: ese nombre es la clave con la que umzug tiene
registrada la migración en `SequelizeMeta`, ya aplicada. Renombrarlo la haría aparecer como
pendiente, volvería a ejecutarse —sin efecto, porque las filas ya no están— y dejaría una fila
huérfana en el registro. El número es una clave de orden, no una afirmación sobre el calendario.

Este documento sí se renombró, porque no lo lee ninguna máquina.

---

## 12. Lo que la auditoría posterior cambió

Tres agentes adversariales revisaron el trabajo ya commiteado. El núcleo aguantó —dieciocho
mutaciones contra `isActionOf` y sus dos validaciones, todas cazadas— pero encontraron tres cosas
que este documento afirmaba y no eran ciertas, y un agujero que el propio cambio creaba.

**§6 estaba a medias.** El documento razona la dirección «bundle viejo contra API nueva» y despacha
la contraria con «ninguno de los dos órdenes es inseguro». Es falso, y se reprodujo: el panel leía
`modulo.acciones.includes(...)` sin guarda, así que contra una API anterior lanza `TypeError`
durante el dibujado y —sin `ErrorBoundary` en todo `web/src`— React desmonta la raíz. **La
aplicación entera en blanco**, barra lateral incluida. Y no es solo un error de orden: una vuelta
atrás de la API con el bundle nuevo ya en un navegador llega igual, y ahí no hay orden que acertar.
Ahora es `modulo.acciones?.includes(...) ?? true`: el peor caso pasa a ser el comportamiento
anterior al cambio, una casilla que el servidor rechaza por su nombre.

**El `satisfies` no ataba nada.** `Record<string, readonly string[]>` aceptaba
`postes: [..., "exportar"]` sin un solo error — comprobado. El resultado habría sido un permiso que
el lector honra y concede, que el endpoint se niega a cambiar porque `isAction` lo rechaza, y que la
pantalla nunca dibuja porque no tiene etiqueta. **Concedido, invisible e irrevocable desde la
interfaz** — exactamente la clase de fallo que este trabajo venía a cerrar. `ACTIONS` se declara
ahora antes que `PERMISSIONS`, y el `satisfies` va contra ella.

**El agujero que creaba el cambio, y que nada vigilaba.** Antes todos los pares existían por
construcción, así que `requirePermission("bitacora","archivar")` era solo inútil. Ahora es una
puerta que no puede abrirse nunca. Quitar `editar` de `seguridad` en la constante tumba editar una
cuenta, desbloquearla y resetear su contraseña — **y la batería entera pasaba: 1.199 de 1.199.** No
era descuido: `requirePermission` toma módulo y acción como parámetros independientes a propósito, y
doce ficheros de test simulan el lector. `permissions/vocabulary.test.ts` lo cierra recorriendo la
aplicación montada y las llamadas directas del código, y nombra los endpoints que morirían.

**Tres pruebas mías eran malas.** Una pasaba por el motivo equivocado (pulsaba la casilla del índice
0, que es `ver` haya hueco o no). Otra era vacua: `every()` sobre el objeto vacío es cierto, así que
pasaba devolviendo exactamente lo que su nombre decía descartar. Y la de la migración comprobaba las
palabras sueltas en vez de los pares, de modo que intercambiar módulo y acción en el `down()` —que
inserta filas basura permanentes que ningún `up()` limpia— la dejaba en verde.

**Y una afirmación de método que no se sostenía.** El documento citaba «`tsc --noEmit` limpio» como
prueba de que el `Partial` protegía. La API tiene `strict: false`, así que ahí el tipo es
documentación y habría compilado igual mintiendo. En `web`, con `strict: true`, sí protege.

## 13. Despliegue

Decidido: **todo de una vez al terminar**, no progresivo. Eso elimina la ventana en la que una
réplica antigua de la API vuelve a sembrar las cuarenta celdas o acepta un par muerto, que era el
único riesgo operativo que quedaba. Con despliegue atómico no hay dos versiones conviviendo.
