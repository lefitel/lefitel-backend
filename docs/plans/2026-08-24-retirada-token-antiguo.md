# Plan 2C — Retirar el token antiguo, para que la revocación sea real

**Spec:** `docs/specs/2026-08-21-autenticacion-mfa-design.md`

**Goal:** que «cerrar todas mis sesiones» signifique algo. Hoy no lo significa: el
servidor sigue aceptando un JWT firmado que no tiene fila detrás, así que un token
robado entra por una puerta que ninguna revocación alcanza. Este plan cierra esa
puerta, y con ella el defecto que originó todo el arco.

## Por qué esto no es limpieza

Es la única tarea del arco que **cambia lo que el sistema puede prometer**. Los
planes 1, 2A y 2B construyeron sesiones revocables; mientras el camino antiguo siga
en pie, esa revocación es decorativa para el único caso que importa — el de alguien
que ya tiene un token.

Y hay una razón nueva, encontrada inventariando el camino el 23 de agosto: **el
secreto con el que se firman esos tokens es una palabra de once letras minúsculas
con forma de nombre propio, y su valor estuvo escrito en un documento del repo y
sigue en el historial de git.** Ver el aviso en rojo de la sección 11 del spec.
Rotarlo es urgente e independiente de este plan; **este plan es lo que hace que deje
de importar**, porque un secreto con el que nadie firma ni verifica no abre nada.

## Prerrequisito duro, y no admite atajo

**El Plan 2B tiene que estar desplegado y verificado en producción antes de que esto
se despliegue.** No antes de escribirlo: antes de desplegarlo.

Si se despliega este plan con el frontend viejo aún en manos de alguien —una pestaña
que no se ha recargado, un navegador con el bundle en caché— esa persona se queda
fuera sin más explicación que un 401. El frontend nuevo no manda el token, así que
para él este cambio es invisible; el viejo dependía de él para todo.

## Global Constraints

- **La cookie no se toca.** Ni sus atributos, ni el deslizamiento, ni la rotación al
  entrar. Este plan quita cosas; no cambia el camino que se queda.
- **La exclusión de la URL de logout en el manejo del 401 se queda**, y la distinción
  entre 401 y 403 también. Las dos vienen de fallos reales.
- **Los nombres de cabecera siguen fijados a literales escritos a mano** en los
  tests. Ese fallo se ha reintroducido dos veces en este proyecto.
- **Nada de `git add -A`.** El dueño trabaja en el mismo árbol.
- Cada tarea deja el árbol compilando y los tests en verde. La condición de
  aceptación es un grep pegado en el informe, no el typecheck: un cast acepta lo que
  ya no existe.

---

## Task 1: Medir antes de cortar

No es código. Es el paso que convierte esto en una medición en vez de una apuesta, y
el camino antiguo se escribió con esto en mente.

Cada petición que entra por él deja una línea de log: `"petición autenticada con el
token antiguo"` (`src/middleware/authenticate.ts`, dentro de
`authenticateByLegacyToken`). El comentario de esa función lo dice explícitamente.

- [ ] **Step 1: Contar en producción**

Después de desplegar el Plan 2B y dejarlo correr un día entero de trabajo, contar
esas líneas en los logs de Coolify.

**Lo que se espera: cero.** El frontend nuevo no manda la cabecera y no hay ningún
otro cliente — se comprobó buscando scripts, tareas programadas, colecciones de
Postman y ficheros `.http`, y no existe ninguno. Lo único que hay en `web` es una
cabecera `Authorization` en `src/lib/orsRoute.ts`, que es la clave de un servicio
externo de rutas y no tiene nada que ver.

**Si no es cero, para y averigua quién.** La línea de log lleva el id de usuario.

---

## Task 2: El login deja de firmar

**Files:**
- Modify: `src/controllers/login.controller.ts` (la firma, y lo que devuelve)
- Modify: `src/controllers/login.session.test.ts`
- Modify: `src/controllers/login.controller.test.ts`

- [ ] **Step 1: Quitar la firma**

`login.controller.ts:135` es el **único** sitio del repo que firma un JWT. La
constante de la clave está en `:9`.

El campo `token` desaparece del cuerpo de la respuesta y **el frontend no lo lee**,
pero por un camino distinto del que este brief decía en su primera versión: el que lo
leía era `web/src/api/Login.api.ts`, que lo desestructuraba para tirarlo antes de que
llegara al estado de React. El `as` de `LoginPage.tsx` existe y acepta que el campo no
venga, pero **si el lector hubiera sido esa pantalla, un `as` no habría bastado** — un
cast no impide que un valor llegue, solo que el compilador se queje. Compruébalo en el
disco antes de tocar.

- [ ] **Step 2: Y decidir qué queda de `POST /api/login`**

Quedan dos puertas de entrada haciendo lo mismo: esta y `POST /api/auth/login`. La
vieja abre la cookie desde el Plan 2A, así que funciona; la nueva es la que el diseño
quiere.

**Decide y escribe el por qué:** o la vieja se queda como alias y se declara, o se
retira y el frontend apunta a la nueva. Si la retiras, es un cambio en `web` y va en
la misma tarea, porque entre los dos commits nadie puede entrar.

Ojo con una asimetría ya declarada: la puerta vieja contesta **503** si no consigue
abrir la sesión, y la nueva **500**, porque su envoltorio genérico lo convierte todo.
Si unificas las puertas, unifica eso también.

- [ ] **Step 3: Romper a propósito**

Rompe: devuelve el campo `token` otra vez. Debe caer un test que afirme que la
respuesta del login no lleva ninguna credencial en el cuerpo — y si no existe,
escríbelo, porque es el corazón de esta tarea.

---

## Task 3: Fuera el segundo verificador

Hay **dos** sitios que verifican un JWT, y el segundo vive fuera del middleware:
`comprobarToken` en `login.controller.ts:163`, expuesto como `GET /api/login`. Es una
duplicación exacta de la lógica del middleware — buscar el usuario por el id del
token, comprobar que sigue existiendo, devolver rol y permisos.

**Files:**
- Modify: `src/controllers/login.controller.ts` (retirar `comprobarToken`)
- Modify: `src/routes/login.routes.ts` (retirar `GET /api/login`)
- Modify: `src/routes/permiso.routes.ts` (retirar `GET /api/permisos/mias`)
- Modify: `src/controllers/login.controller.test.ts`

- [ ] **Step 1: Comprobar que nadie lo llama**

El Plan 2B cambió el arranque del frontend a `GET /api/auth/me`. Verifica en `web` que
no queda ninguna llamada a `GET /api/login` — ni directa, ni a través de la función
que antes la envolvía.

- [ ] **Step 2: Retirar, y con ello la deuda declarada de al lado**

`GET /api/permisos/mias` (`src/routes/permiso.routes.ts:11`) tampoco lo llama nadie y
está declarado como muerto en su propio docstring desde el 23 de agosto. Retíralo en
la misma tarea: es el mismo trabajo y la misma verificación.

Retirarlo obliga a tocar su entrada en `READ_GATE_NOT_APPLICABLE` en
`src/routes/routeGuards.test.ts`. **Ese fichero tenía trabajo sin commitear del dueño
el 23**; comprueba `git status` antes y si sigue así, déjalo fuera y dilo.

- [ ] **Step 3: Romper a propósito**

Rompe: vuelve a montar la ruta. Debe caer un test que afirme que esas dos direcciones
ya no existen — un 404, no un 401, porque la diferencia importa: un 401 dice «no te
conozco», un 404 dice «esto no está».

---

## Task 4: Fuera el camino antiguo del middleware — aquí la revocación se vuelve real

Esta es la tarea del plan. Todo lo demás es preparar y limpiar.

**Files:**
- Modify: `src/middleware/authenticate.ts`
- Modify: `src/middleware/authenticate.test.ts`
- Modify: `src/controllers/auth.controller.ts` (el código que deja de ser alcanzable)
- Modify: `src/app.ts` (el tipo de `req.user`)

- [ ] **Step 1: Lo que se va**

`authenticateByLegacyToken` entera, y la rama de `authenticate` que la llama. Hoy
`authenticate` prueba la cookie primero y **no cae al bearer si la cookie existe pero
es inválida** — eso ya está bien y no cambia. Lo que cambia es el caso «sin cookie,
con cabecera `Authorization`»: pasa de autenticar a 401.

- [ ] **Step 2: Lo que se puede simplificar, y no es cosmético**

`req.user` declara hoy `id_sesion?` y `expires_at?` **opcionales** (`app.ts:7`), y el
motivo está escrito en `sessionStore.ts:216`: «una petición del JWT antiguo no tiene
fila de sesión». Sin ese camino, las dos pasan a ser obligatorias.

Eso deja código muerto en `src/controllers/auth.controller.ts`, en al menos seis
sitios (`:102`, `:225`, `:253`, `:264`, `:296`, `:351`): comprobaciones de existencia,
un mensaje que cambia según si había fila, y un campo de metadatos que registra si la
tenía. **Nada de eso puede volver a ocurrir.** Quítalo, y el tipo con él.

Aviso: al hacer los campos obligatorios, **el typecheck no te va a señalar todos los
sitios**. Los tests que construyen un `req.user` con un cast aceptan un objeto sin
esos campos. Búscalos con grep.

- [ ] **Step 3: Los tests, que son la mitad del trabajo**

Hay entre quince y dieciocho casos que fijan el camino antiguo, repartidos en siete
ficheros. La mitad vive en `authenticate.test.ts` — un bloque entero titulado «with
the old bearer token, during the transition» (`:311`), más tres tests sueltos en otros
bloques (`:299`, `:390`, `:441`). El resto está en `login.controller.test.ts`
(`:612-675`), `login.session.test.ts` (mock de la librería en `:52`),
`auth.controller.test.ts` (`:359`, qué contesta `/auth/me` a un llamante sin fila),
`csrf.test.ts` (`:241` y `:389`, que un bearer no exime del guardián) y menciones
incidentales en `sessionStore.test.ts` y `logger.test.ts`.

**No los borres sin más.** Los que afirman que el camino antiguo funciona se van; los
que afirman que **no exime de otra protección** hay que convertirlos en que la
cabecera ya no autentica en absoluto. Y los de `csrf.test.ts` merecen pensarse dos
veces: comprobaban que un bearer no se salta el CSRF, y lo que tienen que comprobar
ahora es que una cabecera `Authorization` no abre nada, ni con guardián ni sin él.

El de `logger.test.ts` **se queda tal cual**: comprueba que la cabecera no aparece en
claro en un log, y eso sigue haciendo falta mientras alguien pueda mandarla, aunque ya
no autentique.

- [ ] **Step 4: Romper a propósito, y esta rotura es la prueba del plan**

Rompe: vuelve a poner la rama del bearer. Debe caer un test que afirme que una
petición con `Authorization: Bearer <token válido y bien firmado>` y sin cookie recibe
401. **Firma el token de verdad en el test, con la clave real de la configuración de
pruebas** — un token mal formado daría 401 por el motivo equivocado y el test no
probaría nada. Es la misma trampa que los identificadores de solo dígitos que no
discriminaban en el Plan 1.

---

## Task 5: La clave de firma deja de hacer falta

**Files:**
- Modify: `src/config/security.ts` (la lista de variables obligatorias)
- Modify: `package.json` (si la librería queda sin uso)
- Modify: `src/index.boot.test.ts`

- [ ] **Step 1: Quitarla de las obligatorias**

`src/config/security.ts:77` incluye `JWT_SECRET` en las que se exigen **siempre**, en
todos los entornos, y `src/index.ts:36-50` hace que el proceso muera al arrancar si
falta. Con nadie firmando ni verificando, eso es exigir una variable que no se usa —
y peor: convierte en obligatorio conservar el secreto débil.

- [ ] **Step 2: Y la librería, si no queda nada**

Comprueba si queda algún uso de `jsonwebtoken` después de las tareas 2, 3 y 4. Si no
queda ninguno, fuera de `package.json`.

- [ ] **Step 3: Romper a propósito**

Rompe: arranca sin `JWT_SECRET` en el entorno. **No debe pasar nada.** Y comprueba que
sí sigue muriendo sin las variables que de verdad hacen falta — la de la cookie, la de
la base de datos — porque ese arranque que falla cerrado se ganó en el Plan 1 y sería
fácil aflojarlo por accidente al tocar la lista.

---

## Task 6: Lo que el spec puede prometer ahora

**Files:**
- Modify: `docs/specs/2026-08-21-autenticacion-mfa-design.md`

- [ ] **Step 1: La sección que deja de aplicar**

«Mientras el token antiguo siga valiendo: si roban una cuenta, se archiva» describe un
procedimiento contraintuitivo que existía solo por la coexistencia. Reescríbela en
pasado, diciendo qué era y por qué ya no hace falta: **ahora «cerrar todas mis
sesiones» echa de verdad a quien tenga la credencial.**

No la borres. Que quede escrito que hubo un periodo en que archivar era la única
respuesta, porque el siguiente que lea el documento tiene que poder entender los
commits de ese periodo.

- [ ] **Step 2: El aviso del secreto**

El aviso en rojo de la sección 11 sigue en pie mientras el secreto viva en el historial
de git, pero cambia de significado: ya no es una puerta abierta, es un secreto muerto
en un sitio donde no debería estar. Dilo así.

**Y una cosa que no se decide en este plan:** sacarlo del historial exige reescribirlo,
y eso es destructivo en un repositorio con varias ramas y varias sesiones trabajando a
la vez. **Esa decisión es de Isaias.** El plan la nombra y no la toma.

---

## Task 7: El login deja de usarse para comprobar una contraseña

Esto no estaba en el plan. Salió al ejecutar la Tarea 2 y está en producción hoy.

`web/src/pages/menu/usuario/UsuarioDetallePage.tsx:111` — para cambiar tu propio
nombre de usuario, la pantalla te pide tu contraseña actual «para confirmar». Y para
comprobarla **llama al login entero**.

**Files:**
- Add: un endpoint que compruebe una contraseña sin emitir nada
- Modify: `web/src/pages/menu/usuario/UsuarioDetallePage.tsx`
- Modify: `web/src/api/Login.api.ts` (o donde vaya el cliente del endpoint nuevo)

- [ ] **Step 1: Los cuatro efectos, y el peor no es el evidente**

1. **Abre una sesión nueva**, así que la rotación al entrar **revoca la que el
   navegador tenía**. Editar tu nombre te cambia la sesión por debajo.
2. **Escribe «Inició sesión» en la bitácora.** Un registro de entrada que no
   ocurrió, en el mismo sitio donde se audita quién entra y cuándo.
3. **Una contraseña mal escrita cuenta como intento fallido de login.** Así que
   equivocarte unas veces al cambiarte el nombre **te bloquea tu propia cuenta**, y el
   mensaje que ves dice «Contraseña incorrecta» sin avisarte de que te estás
   bloqueando.
4. Y el que da más miedo: la comprobación funciona **por accidente**. El código mira
   `auth.status === 500`, y el servidor contesta **400** a una contraseña mala. Lo que
   salva el caso es que el cliente aplana cualquier respuesta no-2xx a 500 — está
   documentado y es deliberado, pero significa que **el día que alguien haga que un
   400 llegue como 400, la confirmación deja de confirmar** y el cambio de nombre
   procede con la contraseña equivocada. Sin que nada se ponga rojo.

- [ ] **Step 2: Qué hace falta**

Un endpoint que responda «esta contraseña es la tuya, sí o no» y **no emita nada**:
ni cookie, ni fila de sesión, ni entrada en la bitácora de entradas.

Tres cosas que sí tiene que conservar, porque son de `verifyCredentials` y existen por
buenas razones:
- **El mensaje uniforme y el tiempo uniforme.** Hay un hash de relleno en cada camino
  que falla, para que no se pueda averiguar si un usuario existe midiendo lo que tarda.
- **El contador de intentos fallidos**, pero pensado para este caso: aquí el que falla
  ya está autenticado y solo se está confirmando a sí mismo, así que fallar no debería
  bloquearle la cuenta. Decide y escribe el por qué.
- **Va detrás de `authenticate`.** Solo tiene sentido para quien ya entró.

- [ ] **Step 3: Romper a propósito**

Rompe: haz que el endpoint devuelva «correcta» siempre. Debe caer un test. Y rompe la
comprobación del cliente para que acepte cualquier respuesta: debe caer otro, porque
el punto 4 de arriba existe precisamente por no tener ese test.

Commits en los dos repos.

---

## Verificación final

```bash
cd api && npm run lint && npm run typecheck && npm test
cd ../web && npm run lint && npm run typecheck && npm test
```

Y las comprobaciones que ningún test da:

1. **Que no queda rastro del camino antiguo.** Busca en `api/src`: ningún `jwt.sign`,
   ningún `jwt.verify`, ningún `JWT_SECRET`, ninguna lectura de la cabecera
   `Authorization`. Pega el resultado.
2. **Que la revocación funciona de verdad, en un navegador.** Entra en dos navegadores
   distintos con la misma cuenta, pulsa «cerrar todas mis sesiones» en uno, y comprueba
   que el otro queda fuera al recargar. **Esto es lo que el arco entero venía a
   conseguir y es la única forma de verlo.**
3. **Que un token antiguo ya no entra.** Fírmalo con la clave vieja y compruébalo con
   `curl`. Aquí `curl` **sí** vale, porque lo que se comprueba es que el servidor
   rechaza, no que un navegador acepte.

## Riesgos

**El único riesgo de verdad es el orden.** Desplegar esto antes de que el Plan 2B esté
en producción deja fuera a cualquiera con el frontend viejo en caché, y el 401 que
recibe no explica nada.

**Nadie puede volver atrás por su cuenta después.** Retirar el camino no es reversible
sin volver a desplegar, y volver a desplegarlo significa reabrir el agujero. Ese es el
punto.

**El secreto seguirá en el historial de git.** Este plan lo vuelve inofensivo, no lo
borra. Si el repositorio se comparte alguna vez con alguien de fuera, sigue estando
ahí.
