# Plan 2B — El cimiento de sesión, lado navegador

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el navegador deje de ver el token de sesión. Retirar las 92 cabeceras `Authorization` escritas a mano, las 106 firmas que reciben un token, las 213 referencias que lo pasan de mano en mano, y el `localStorage` donde vive — para que la única credencial sea la cookie que el navegador manda solo.

**Architecture:** el backend ya acepta la cookie (Plan 2A). Lo que queda es el otro lado, y tiene una dependencia que el diseño no vio: hoy el frontend **decodifica el JWT a mano** para dos cosas —saber cuándo vence la sesión y detectar que el rol cambió— y las dos se caen con el token. Así que el plan empieza con dos añadidos pequeños al servidor que dan esa información de forma explícita, y sigue con la retirada en el navegador.

**Tech Stack:** React 18, Vite, TypeScript, axios, react-router-dom 6, Vitest. Y en el backend, Express 4.

**Spec:** [`../specs/2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md) — implementa el §7 («Qué cambia en el frontend») y cierra lo que el §2 y §3 empezaron.

**Viene de:** [`2026-08-22-cimiento-sesion-backend.md`](2026-08-22-cimiento-sesion-backend.md) (Plan 2A, cerrado: 731 tests en `api`, 227 en `web`).
**Precede a:** el Plan 2C, que retira el camino del JWT del servidor. **Solo entonces la revocación es real** — mientras el token viejo siga valiendo, un token robado no lo alcanza ninguna revocación.

## Global Constraints

- **Un commit por tarea, y un commit por repo** cuando una tarea toque los dos. **Nunca `git commit --amend`** y **nunca `git add -A`**: el dueño del repositorio trabaja en estos árboles y commitea sin avisar. Ficheros por nombre.
- **Rama `isaias`** en los dos repos. No se aplastan los commits al final: un rebase sobre un rango que contiene commits suyos es reescribir trabajo ajeno.
- **Todo el código, los comentarios y los mensajes de commit en inglés**, con asunto `tipo(scope): frase en minúscula`. Los textos que ve el usuario, en español.
- **Cero cifras y cadenas de configuración literales.** En el backend van a `src/config/security.ts`; en el frontend, junto a donde ya vive la configuración de axios.
- **Verificación por tarea:** `npm run lint && npm run typecheck && npm test` en cada repo que la tarea toque. Base: **731 tests** en `api`, **227** en `web`.
- **Rompe el código a propósito antes de dar una tarea por buena**, y comprueba que cae un test por cada rotura. Este proyecto lleva **dieciséis** casos de tests que no cazaban lo que decían, y dos de ellos fallaron no por el assert sino porque **el dato no distinguía**. Cuenta en el informe qué rompiste y **el nombre del test que cayó**.
- **`--reporter=verbose`.** `--reporter=basic` **no existe en Vitest 4** y devuelve salida 1 sin ejecutar nada: un arnés de roturas que lo use da dieciséis «cazadas» sin haber ejecutado ninguna. Ya pasó.
- **Punto de partida:** `api` en `7a8fe7a`, `web` en `f9e0eed`.

## Lo que este plan NO hace

- **No retira el camino del JWT en el servidor.** Eso es el Plan 2C, y hasta entonces el agujero de los tokens irrevocables sigue abierto a propósito, para que ningún despliegue deje a nadie fuera.
- **No toca `src/lib/orsRoute.ts`.** Su cabecera `Authorization` es la clave de OpenRouteService, un servicio externo, y no tiene nada que ver con la sesión.
- **No toca las guardas por rol ni por permiso** (`ModuleRoute` en `App.tsx:59-69`, `PermissionGuard`). Leen `sesion.usuario.id_rol` y no el token, así que sobreviven intactas.

## Por qué las tareas traen contratos y no código escrito

Igual que en el Plan 2A, y por la misma razón empírica. Los planes anteriores
traían el código completo, los implementadores lo transcribieron con fidelidad,
y con él transcribieron **dieciséis** tests que pasaban con el código roto —
ninguno era invención suya. Donde tuvieron que pensar encontraron un bug del
cargador de migraciones, una política de seguridad que no estaba enchufada, un
test mío que era imposible de pasar, y una instrucción mía que no arreglaba lo
que decía arreglar.

Así que aquí el plan dice **qué tiene que ser verdad y cómo comprobarlo**, y deja
el cómo a quien lo escriba con el código delante. Lo que no se relaja es la
verificación.

## El orden de las tareas, que tampoco es libre

**Las tareas 3 y 4 van en este orden y no al revés**, y el motivo es que el build
no aguanta el otro. Si se quitara primero el campo `token` de `SesionInterface`,
los 38 ficheros que hacen `sesion.token` dejarían de compilar **en ese mismo
commit** y no se arreglarían hasta el siguiente: una tarea entera con el árbol
roto, sin poder verificar nada.

Al contrario sí funciona. La tarea 3 quita los usos —los 211 que pasan el token a
la capa de API— y deja el campo en su sitio, huérfano salvo por los dos del gate
de enrutado. La tarea 4 remata: se lleva esos dos últimos y el campo con ellos.
Cada una compila por su cuenta.

## El orden de despliegue, que no es libre

Las tareas 1 y 2 son del servidor y **compatibles con el frontend actual**: añaden información a respuestas que ya existen y nadie está obligado a leerla. Las tareas 3 a 7 son del navegador y **exigen que el servidor ya las dé**.

```
1. Desplegar el backend (tareas 1-2). El frontend viejo no nota nada.
2. Desplegar el frontend (tareas 3-7).
```

Y lo que ya se aprendió en el Plan 2A y sigue valiendo: **después de desplegar el frontend, el backend solo puede ir hacia adelante.** El bundle nuevo manda credenciales sin condición, y un servidor que no responda `Access-Control-Allow-Credentials` hace que el navegador falle cada petición, lecturas incluidas.

---

## Estructura de ficheros

### Backend (tareas 1-2)

| Fichero | Responsabilidad | Estado |
|---|---|---|
| `src/controllers/auth.controller.ts` | `GET /auth/me` devuelve además cuándo caduca la sesión | Modificar |
| `src/middleware/authenticate.ts` | Emitir la cabecera con el rol actual | Modificar |
| `src/config/security.ts` | El nombre de la cabecera | Modificar |
| `src/app.ts` | Exponer la cabecera nueva en el CORS | Modificar |

### Frontend (tareas 3-7)

| Fichero | Responsabilidad | Estado |
|---|---|---|
| `src/interfaces/interfaces.ts` | `SesionInterface` pierde `token`, gana `autenticado` | Modificar |
| `src/App.tsx:37,44` | El gate deja de mirar el token | Modificar |
| `src/api/*.ts` (22 ficheros) | Sin cabecera a mano, sin parámetro `token` | Modificar |
| 38 ficheros de páginas, hooks y componentes | Sin pasar `sesion.token` | Modificar |
| `src/context/SesionProvider.tsx` | Arranque desde `/auth/me`, temporizadores desde su respuesta, interceptor sin `x-new-token` | Modificar |
| `src/pages/LoginPage.tsx:78` | Sin escribir en `localStorage` | Modificar |
| `src/context/SesionProvider.test.tsx` | Rehacer: hoy fabrica un JWT decodificable | Modificar |
| 4 ficheros de test más | `token: "t"` deja de existir en el contexto | Modificar |

---

## Task 1: `GET /auth/me` dice cuándo caduca la sesión

Hoy el frontend programa el aviso de «tu sesión vence en cinco minutos» y el cierre automático **decodificando el `exp` del JWT a mano** (`SesionProvider.tsx:12-24`). Sin token no hay nada que decodificar, y perder ese aviso significa que la gente descubre que su sesión murió cuando pierde lo que estaba escribiendo.

**Files:**
- Modify: `api/src/controllers/auth.controller.ts` (el handler de `/auth/me`)
- Modify: `api/src/middleware/authenticate.ts` (para que `req.user` lleve el vencimiento)
- Modify: `api/src/controllers/auth.controller.test.ts`

**Interfaces:**
- Consumes: `findLiveSession` de `src/auth/sessionStore.ts`, que ya devuelve `expires_at`.
- Produces: `GET /api/auth/me` responde, además de lo que ya responde, **cuándo caduca esta sesión** en un campo nuevo. El nombre lo eliges tú; el frontend lo consume en la tarea 5.

- [ ] **Step 1: Decidir la forma, y hay una decisión real que tomar**

`findLiveSession` ya lee `expires_at`, y `authenticate` ya lo tiene en la mano — pero **no lo pasa a `req.user`**. Así que puedes: (a) añadirlo a `req.user`, que es el tipo que consumen unos treinta controladores, o (b) que el handler de `/auth/me` vuelva a consultar la sesión.

Elige y **escribe el por qué en un comentario**. Ten en cuenta dos cosas: `req.user.id_sesion` ya es opcional porque una petición del camino viejo no tiene fila, así que el vencimiento también lo será; y una consulta más en un endpoint que se llama una vez al cargar la página no es lo mismo que una en un middleware que corre en cada petición.

**Y el caso que no puedes olvidar:** una petición autenticada por el JWT viejo **no tiene sesión ni vencimiento**. `/auth/me` tiene que responder algo coherente, no un `undefined` que el frontend interprete como «caduca ya». Decide qué, y ponle test.

- [ ] **Step 2: El test primero**

Cubre al menos: que `/auth/me` autenticado por cookie devuelve el vencimiento de **esa** sesión; que autenticado por el camino viejo devuelve la forma que hayas decidido para «no lo sé»; y que el valor no es una fecha inventada sino la de la fila.

- [ ] **Step 3: Implementar, romper a propósito, verificar**

Rompe: devuelve una fecha calculada en el handler en vez de la de la fila; y omite el campo entero. Los dos deben caer.

```bash
cd api && npm run lint && npm run typecheck && npm test
```

Commit en `api`.

---

## Task 2: Una cabecera con el rol actual, en cada respuesta autenticada

Hoy, cuando a alguien le cambian el rol mientras trabaja, el frontend se entera así: el servidor re-firma un JWT en cada respuesta, el interceptor decodifica el `id_rol` del token nuevo, lo compara con el que tenía, y si difiere vuelve a preguntar los permisos y avisa con un `toast` («Sus permisos cambiaron. La pantalla se actualizó»). Todo eso está en `SesionProvider.tsx:186-231`.

El Plan 2A retiró la re-firma del JWT, así que **ese mecanismo ya está muerto** — es un residual conocido y aparcado. Esta tarea lo sustituye por algo mucho más pequeño y honesto: **una cabecera con un número**.

`authenticate` ya lee el rol de la base en cada petición (`authenticate.ts:153-157`), así que emitirlo no cuesta ninguna consulta nueva.

**Files:**
- Modify: `api/src/middleware/authenticate.ts`
- Modify: `api/src/config/security.ts` (el nombre de la cabecera)
- Modify: `api/src/app.ts` (`exposedHeaders`)
- Modify: `api/src/middleware/authenticate.test.ts`

**Interfaces:**
- Produces: una cabecera de respuesta con el `id_rol` actual, emitida en **los dos** caminos de autenticación. El nombre lo eliges tú y vive en `src/config/security.ts`.

- [ ] **Step 1: Lo que no puedes olvidar, y es lo que hace que esto funcione**

**La cabecera tiene que estar en `exposedHeaders` del CORS.** `api.osefi.net` y `www.osefi.net` son orígenes distintos, así que **una cabecera de respuesta que no esté expuesta es invisible para el JavaScript de la página** — la respuesta llega con ella y el navegador no deja leerla. Ese error ya se cometió una vez en este proyecto con `x-new-token`, y está documentado en el comentario de `app.ts`: el servidor re-firmaba un token en cada petición y lo tiraba a la basura porque el frontend no podía verlo.

**Emítela en los dos caminos**, cookie y JWT viejo. Si solo va en uno, el aviso funciona a medias durante toda la transición y nadie sabrá por qué.

- [ ] **Step 2: El test primero**

Cubre: que la cabecera sale en el camino de la cookie con el rol de la base; que sale también en el camino viejo; que **el valor es el de la base y no el de la credencial** —esto es lo que impide que alguien «optimice» leyéndolo del token, que es justo la regresión que un plan anterior estuvo a punto de dejar pasar—; y que **está en `exposedHeaders`**, que es lo que la hace legible.

- [ ] **Step 3: Implementar, romper a propósito, verificar**

Rompe: quítala de `exposedHeaders`; emítela solo en el camino de la cookie; lee el rol de la credencial en vez de la base. Los tres deben caer.

Commit en `api`. **Con esto el backend está listo y se puede desplegar** sin que el frontend actual note nada.

---

## Task 3: Los 22 módulos de API dejan de recibir y de mandar el token

Trabajo mecánico y masivo: **92 cabeceras** escritas a mano y **101 firmas** con un parámetro `token: string`. Es una sola tarea porque quitar el parámetro rompe a todos los llamantes: el cambio tiene que ser atómico y **el typecheck es el guardián**.

**Files:**
- Modify: los 22 ficheros de `web/src/api/` (todos menos `url.ts`, `http.ts` y los de test)
- Modify: los 38 ficheros que llaman a esas funciones pasando `sesion.token` — **211 referencias** (las 2 del gate de enrutado son de la tarea 4)

**Interfaces:**
- Produces: todas las funciones de `src/api/` sin parámetro de token. `axios.defaults.withCredentials` ya manda la cookie, así que no hay que añadir nada: solo quitar.

- [ ] **Step 1: El inventario, para que no se quede ninguno**

| Fichero | Cabeceras |
|---|---|
| `Evento.api.ts` | 11 |
| `Poste.api.ts` | 10 |
| `Usuario.api.ts` | 9 |
| `Adss.api.ts`, `Ciudad.api.ts`, `Files.api.ts`, `Material.api.ts`, `Obs.api.ts`, `Propietario.api.ts`, `reporte.api.ts`, `TipoObs.api.ts` | 6 cada uno |
| `Bitacora.api.ts`, `Permisos.api.ts`, `Revision.api.ts` | 2 cada uno |
| `AdssPoste.api.ts`, `dashboard.api.ts`, `EventoObs.api.ts`, `Login.api.ts`, `Rol.api.ts`, `Solucion.api.ts`, `Upload.api.ts` | 1 cada uno |
| `generador.api.ts` | 1 helper `auth()` reutilizado por 9 llamadas |

Los diez ficheros que más `sesion.token` pasan: `poste/index.tsx` (19), `parametros/ObsSec.tsx` (15), `dialogs/upsert/PosteSheet.tsx` (14), `evento/index.tsx` (12), `dialogs/upsert/EventoSheet.tsx` (11), y `TipoObsSec`, `PropiedadSec`, `MaterialSec`, `AdssSec` (9 cada uno) y `ReportTramoSec.tsx` (8).

- [ ] **Step 2: NO toques `src/lib/orsRoute.ts`**

Su `Authorization` es la clave de OpenRouteService. No es la sesión, no va por axios, y borrarla rompe el cálculo de rutas del mapa.

- [ ] **Step 3: Dos cosas que hay que comprobar y no son mecánicas**

- **`Upload.api.ts` manda `multipart/form-data`.** Comprueba que al quitar el objeto de cabeceras no se lleva por delante el `Content-Type` que esa llamada necesita.
- **`comprobarToken` en `Login.api.ts:42-60`** recibe el token y lo manda en la cabecera. Esa función es el arranque de sesión y **se sustituye en la tarea 5**. Aquí déjala compilando de la forma más simple que puedas y anota que la tarea 5 la reemplaza.

- [ ] **Step 4: Verificar, y aquí el typecheck vale más que los tests**

```bash
cd web && npm run typecheck
```

Un solo argumento olvidado es un error de tipo. **Cero errores es la condición de aceptación de esta tarea**, más los 227 tests en verde.

Y **una comprobación que los tests no dan:** busca en todo `src/` que no quede ninguna ocurrencia de `Authorization` fuera de `orsRoute.ts`, ni ningún `sesion.token`. Pega el resultado.

Commit en `web`.

---

## Task 4: El enrutado deja de mirar el token

Esta tarea cambia **cómo se decide si hay sesión**. No borra el campo `token` del tipo: lo borra
la Tarea 7, cuando ya nadie lo lea. El por qué está en el Step 3.

**Files:**
- Modify: `web/src/interfaces/interfaces.ts:3-12` (`SesionInterface`) — añadir, no quitar
- Modify: `web/src/App.tsx:37,44` (el gate)
- Modify: `web/src/pages/LoginPage.tsx:79` (quien pone el estado tras entrar)
- Modify: `web/src/context/SesionProvider.tsx` (el estado inicial, el logout, y el arranque)

**Interfaces:**
- Produces: `SesionInterface` con un booleano explícito que diga si hay sesión. El nombre lo
  eliges tú; el gate y la Tarea 5 lo van a leer. El campo `token` **sigue en el tipo** y sigue
  funcionando igual que hoy.

- [ ] **Step 1: La decisión de forma, que es lo importante de esta tarea**

Hoy «hay sesión» se decide con `sesion.token !== ""` en `App.tsx:37` y `:44`. Es un centinela:
una cadena vacía significa «no autenticado».

Con la cookie **el navegador no puede saber si hay sesión sin preguntar al servidor**. Así que el
estado pasa a ser un booleano explícito, y el gate tiene que distinguir **tres** estados y no
dos: comprobando, autenticado, y no autenticado. El `loading` que ya existe cubre el primero —
comprueba que lo hace bien en los dos gates, porque si el booleano arranca en `false` y `loading`
no lo tapa, **el primer render manda a todo el mundo a `/login`** antes de que la respuesta
llegue.

Ese es el fallo más probable de toda esta tarea. **Ponle test.**

- [ ] **Step 2: Quién pone el booleano a `true`**

Los dos sitios que hoy meten el token en el estado:

- `LoginPage.tsx:79` — `setSesion(responde.usuario as SesionInterface)`. **Ojo con ese `as`:**
  acepta cualquier forma, así que si te limitas a añadir el campo al tipo, el booleano se queda
  en `undefined` y **nadie puede entrar nunca**, con el typecheck a cero. Hay que ponerlo
  explícitamente aquí.
- `SesionProvider.tsx:151` — el arranque, tras `comprobarToken`. La Tarea 5 cambiará **de dónde**
  viene esa confirmación (pasará a `/auth/me`), no la forma. Deja la forma bien puesta ahora.

Y a `false`: el estado inicial (`:39`) y el `logout()` (`:97`).

- [ ] **Step 3: El orden, y por qué este es**

`SesionProvider.tsx` usa `sesion.token` en seis sitios, y tres son de tareas posteriores: los
temporizadores que decodifican el JWT (`:100-124`, Tarea 7), el arranque que lo lee de
`localStorage` (`:145-160`, Tareas 5 y 6) y el interceptor de `x-new-token` (`:190,214-215`,
Tarea 7). **Por eso el campo no se borra aquí:** quitarlo obligaría a hacer las cuatro tareas de
una vez, y perderíamos la revisión por trozos del fichero más delicado del frontend.

Los ficheros de test que rellenan `token: "t"` **no se tocan** en esta tarea: el campo sigue
existiendo, así que siguen compilando.

- [ ] **Step 4: La condición de aceptación NO es el typecheck**

Es un grep. Cuando la Tarea 7 borre el campo, el compilador **no** señalará los sitios que
quedan: `as unknown as SesionInterface`, `as never` y un literal sin anotación de tipo aceptan
campos que ya no existen. De los cinco ficheros de test que rellenan `token`, el typecheck solo
caza uno (`AppSidebar.test.tsx:12`, el único anotado). Para esta tarea:

```bash
cd web
grep -rn 'sesion\.token' src          # solo SesionProvider.tsx (tareas 5-7)
grep -rn '\.token !== ""\|\.token === ""' src   # vacío: el centinela ya no decide nada
npm run lint && npm run typecheck && npm test
```

- [ ] **Step 5: Romper a propósito y verificar**

Rompe: haz que el gate ignore el estado de carga; invierte el booleano; deja que `PublicRoutes` y
`PrivateRoutes` usen criterios distintos; quita el booleano de `LoginPage.tsx`. Los cuatro deben
caer — y si el último no cae, es que falta el test que prueba que entrar funciona.

Commit en `web`.

---

## Task 5: El arranque de sesión, y fuera el `localStorage`

**Esta tarea absorbe la que era la Tarea 6.** Eran la misma pieza y separarlas dejaba la
aplicación rota entre las dos: quitar la lectura del `localStorage` sin poner `/auth/me` en su
sitio deja el arranque sin ninguna fuente de verdad, y todo el mundo acabaría en `/login` al
recargar. La Tarea 6 ya no existe; la 7 sigue siendo la 7.

Hoy, al recargar la página, el frontend lee el token de `localStorage` y pregunta al servidor
con él. Sin token, la pregunta cambia: **«¿tengo sesión?», y la respuesta la da la cookie que el
navegador manda solo.**

**Files:**
- Modify: `web/src/context/SesionProvider.tsx` (el arranque, el `logout()`, y el `setItem` del interceptor)
- Modify: `web/src/api/Login.api.ts` (sustituir `comprobarToken`)
- Modify: `web/src/pages/LoginPage.tsx` (el `setItem` de después de entrar)

- [ ] **Step 1: El guardián que hay que quitar, y por qué es urgente**

`SesionProvider.tsx:145-146` es hoy esto:

```js
const stored = localStorage.getItem("token");
if (!stored) { setLoading(false); return; }
```

**Sin token en `localStorage` no se pregunta al servidor.** Eso tenía sentido cuando el token era
la credencial. Ahora la credencial es la cookie, y **la cookie es invisible para el JavaScript**:
la única forma de saber si hay sesión es preguntar.

Y es una bomba con fecha. El día que el servidor deje de devolver un JWT al entrar — que es
exactamente lo que hará el Plan 2C — `LoginPage.tsx:78` guardará una cadena vacía,
`!stored` será verdadero, y **todo el mundo perderá la sesión al recargar**, con la cookie
válida en el navegador. Nadie lo notaría en desarrollo, porque en desarrollo el `localStorage`
ya tiene un token de antes.

**Se pregunta siempre.** Sin guardián.

- [ ] **Step 2: La forma**

Llama a `GET /api/auth/me`, que el Plan 2A creó y que la tarea 1 amplió con el vencimiento. Con
la cookie puesta responde 200 y quién eres; sin ella, 401.

**Tres cosas que no puedes hacer mal:**
- **El `loading` tiene que cubrir toda la llamada.** Si se pone en `false` antes de la respuesta,
  las puertas de la Tarea 4 mandan a todo el mundo a `/login` durante un instante. Es el mismo
  fallo que la Tarea 4, por la otra punta.
- **Un 401 en el arranque no es un error, es la respuesta.** Significa «no hay sesión»: estado
  anónimo y a la pantalla de acceso, sin toast de error ni nada que parezca que algo se rompió.
- **El interceptor global también ve esta petición.** Un 401 aquí dispararía `logout()` — que
  ahora hace red. Comprueba qué pasa y si hace falta excluirla, como ya se excluye la de logout.
  **Este es el punto de la tarea donde más fácil es meter un bucle.**

- [ ] **Step 3: Los seis sitios del `localStorage`**

Escritura en `LoginPage.tsx:78` tras el login, y en `SesionProvider.tsx:190` dentro del
interceptor. Lectura en `:145` (el arranque). Borrado en `:95` (el logout) y `:158,161` (las dos
ramas del arranque cuando el token no vale).

**No toques** las otras claves de `localStorage`: `osefi-seen-release` (`useSeenRelease.ts`),
`osefi-theme` (`theme-provider.tsx`) y `sidebar_width` (`ui/sidebar.tsx`). No son de sesión.

Y una cosa que sí hay que conservar: el `logout()` ya llama al servidor y ya borra la cookie. Al
quitar el `removeItem`, **comprueba que sigue habiendo algo que limpie el estado local** — si no,
la interfaz se queda creyendo que hay sesión hasta que algo devuelva 401.

- [ ] **Step 4: Test, romper a propósito, verificar**

Cubre: 200 reconstruye la sesión; 401 deja estado anónimo sin ruido; `loading` es `true` hasta
que la respuesta llega; y **el arranque pregunta al servidor aunque el `localStorage` esté
vacío** — este último es el que protege contra la bomba del Step 1, y hoy no existe.

Rompe: pon `loading` en `false` antes del `await`; trata el 401 como error; devuelve el guardián
de `localStorage`; deja el `setItem` del login. Los cuatro deben caer.

```bash
cd web
grep -rn 'localStorage' src | grep -i token   # solo el test de la tarea 7, si queda
npm run lint && npm run typecheck && npm test
```

Commit en `web`.

---

## Task 7: Los temporizadores, el interceptor y rehacer su test

La última, y la que toca el fichero más delicado del frontend.

**Files:**
- Modify: `web/src/context/SesionProvider.tsx` (los temporizadores, `readToken`, `getTokenExp`, el interceptor)
- Modify: `web/src/context/SesionProvider.test.tsx` (rehacer)

- [ ] **Step 1: Los temporizadores, desde el vencimiento que da el servidor**

Borra `readToken` y `getTokenExp` (`:12-24`): decodifican un JWT que ya no existe.

**Y aquí se borra el campo `token` de `SesionInterface`** (`interfaces.ts`), que la Tarea 4 dejó
vivo a propósito porque estos temporizadores y el interceptor lo seguían leyendo. Cuando lo
quites, **el typecheck no te va a señalar todos los sitios**: los cinco ficheros de test que lo
rellenan usan `as unknown as SesionInterface`, `as never` o un literal sin anotar, y solo uno
(`AppSidebar.test.tsx:12`) está anotado y falla. Busca los otros cuatro con grep. `scheduleExpiry` (`:100-119`) pasa a tomar el vencimiento que `/auth/me` devuelve, que la tarea 5 ya trae.

**Y hay un detalle que el Plan 2A resolvió y hay que aprovechar:** la sesión **desliza**. Cada petición que cruza el umbral empuja el vencimiento y **reemite la cookie**. Así que el aviso de «vence en cinco minutos» programado al cargar la página puede quedar obsoleto: si la persona sigue trabajando, su sesión se ha ido renovando y el aviso saltaría cuando ya no toca.

Decide cómo tratarlo y **escribe el por qué**. Opciones que veo: reprogramar cuando el servidor diga que el vencimiento cambió, o aceptar un aviso que puede sobrar y que se cancele solo. Lo que no vale es un aviso que mienta.

- [ ] **Step 2: El interceptor: qué se va y qué se queda**

**Se va** todo el bloque de `x-new-token` (`:187-231`), incluida la detección de cambio de rol que lo usaba.

**Se queda, y no lo toques:**
- **La exclusión de la URL de logout en el manejo del 401** (`:250`). Sin ella vuelve el bucle que cerró la última oleada del Plan 2A: una cookie inválida también da 401 en la propia petición de logout.
- **El `logout()` ante un 401** (`:251`). Sigue siendo la señal correcta de «ya no hay sesión».
- **La distinción entre 401 y 403.** Un 403 sobre un recurso concreto no debe cerrar la sesión de nadie: eso echaría a la gente por abrir un informe que no les toca, perdiendo lo que estuvieran escribiendo.

**Se sustituye:** la detección de cambio de rol pasa a leer la cabecera que la tarea 2 emite. Compara con el rol que tienes y, si cambió, vuelve a pedir `/auth/me` y avisa. Es el mismo comportamiento con una señal más pequeña.

- [ ] **Step 3: Rehacer el test, que hoy fabrica un JWT**

`SesionProvider.test.tsx` construye JWTs falsos decodificables con `tokenFor(id_rol)` (`:27-30`) y afirma sobre `localStorage`. Nada de eso existirá.

**Rehazlo, y conserva lo que ya protegía**, porque hay cosas ahí que se ganaron a pulso:
- Que el manejador de error del interceptor **se capture y se ejerza**. Ese era el punto ciego que dejó pasar un bucle infinito en el Plan 2A: el mock capturaba solo el handler de éxito, así que la rama de error **nunca se ejecutaba en ningún test**.
- Que un 401 en la propia petición de logout **no** dispare otro logout.
- Que la limpieza local ocurra **aunque la llamada al servidor falle**.
- Que un cambio de rol refresque permisos y avise — ahora por la cabecera nueva.

- [ ] **Step 4: Verificación final del plan**

```bash
cd web && npm run lint && npm run typecheck && npm test
cd ../api && npm run lint && npm run typecheck && npm test
```

Y las comprobaciones que ningún test da:

1. **Que no queda rastro del token.** Busca en todo `web/src`: ninguna ocurrencia de `Authorization` fuera de `orsRoute.ts`, ningún `sesion.token`, ningún `localStorage` con la clave del token, ningún `atob` sobre un JWT. Pega el resultado.
2. **Que la aplicación arranca y se entra.** `npm run dev` en los dos repos, y el ciclo completo **en un navegador**: entrar, recargar (la sesión sobrevive), cerrar sesión, comprobar que no se puede volver atrás. **No con `curl`**: no aplica CORS y daría por bueno lo que un navegador rechaza. Hace falta `COOKIE_SECURE=false` en el `.env` del backend, que hoy no está.
3. **Que el aviso de expiración sigue apareciendo.** Es lo único de este plan que no se puede probar con un test razonable, y es lo que evita que alguien pierda lo que estaba escribiendo.

Commit en `web`.

---

## Cobertura contra el spec

| Requisito del §7 | Tarea |
|---|---|
| `SesionProvider` sin `localStorage`, sin decodificar el JWT, sin el interceptor de `x-new-token` | 5, 7 |
| `axios` con `withCredentials` | **Ya hecho** en el Plan 2A |
| El gate de enrutado sin el token | 4 |
| Las 92 cabeceras y las 106 firmas | 3 |
| `exposedHeaders` conserva `Content-Disposition` | **Ya hecho**; la tarea 2 añade una cabecera más |
| CSRF con cabecera propia | **Ya hecho** en el Plan 2A |
| `timeout` en las llamadas de autenticación | **Sin cubrir** — es del Plan 4, con el MFA |
| La dirección de correo visible y enmascarada | **Sin cubrir** — es del Plan 3, con el email |

## Riesgos

**El fallo más probable es el primer render.** Si `autenticado` arranca en `false` y `loading` no lo tapa, todo el mundo ve un parpadeo de la pantalla de acceso antes de entrar — o peor, acaba en `/login` con sesión válida. Aparece en la tarea 4 y en la tarea 5, por las dos puntas, y las dos lo prueban.

**El interceptor puede morderse la cola otra vez.** Ya pasó en el Plan 2A: `logout()` hace red, y un 401 en esa petición volvía al mismo interceptor. La tarea 5 añade otra petición que también puede dar 401 en el arranque. Es el sitio donde hay que pensar dos veces.

**213 referencias son 213 oportunidades de olvidar una, y el typecheck NO las caza todas.** Caza un argumento de más al instante, pero un `as unknown as X`, un `as never` o un literal sin anotación de tipo aceptan campos que ya no existen — y una cabecera `Authorization` sobrante no la ve nadie: se comprobó dejando una a propósito en `Rol.api.ts` y el typecheck y los 236 tests siguieron en verde. Por eso la condición de aceptación de estas tareas es un **grep pegado en el informe**, no el typecheck.

**El aviso de expiración puede mentir**, porque la sesión desliza y el aviso se programa una vez. Un aviso que salta cuando no toca es peor que no tenerlo: enseña a la gente a ignorarlo.

**Este plan no cierra el agujero.** Mientras el servidor siga aceptando el JWT viejo —hasta el Plan 2C— un token robado no lo alcanza ninguna revocación. La respuesta a «me han robado la cuenta» sigue siendo archivarla.
