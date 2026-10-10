# Ventana de reautenticación: un método, una vez, diez minutos — diseño

Sustituye el step-up actual —que pide la contraseña en **cada** petición sensible, y
además la vuelve a pedir dentro del formulario— por una sola ceremonia: un diálogo que
pide **un** método de confirmación y abre una ventana de diez minutos durante la cual las
operaciones administrativas ordinarias no vuelven a pedir nada.

Nace de una petición de Isaias (2026-09-08): *«esa petición de contraseña debería ser un
diálogo solo, que diga que es para proteger, y que se guarde unos minutos»*.

> **Revisión 3 (8 sep 2026).** Dos rondas de auditoría adversarial de cuatro frentes cada
> una, antes de escribir una línea de código. La ronda 1 tumbó la revisión 1 entera (el
> servidor no habría arrancado). La ronda 2 tumbó tres piezas de la revisión 2: el reparto
> de rutas, el sellado por OR y la columna del plazo de gracia. §13 registra qué cambió en
> cada vuelta y por qué, para que nadie reintroduzca lo anterior creyendo que simplifica.

---

## 1. Estado real del sistema: nada de esto está desplegado

**Verificado con git, no supuesto.** Producción sirve `master`, parado en `1715571` del
**2026-05-12**: sin `requireStepUp`, sin tabla `sesiones`, sin segundo factor, autenticando
con **JWT** (`master:src/app.ts`, `master:src/controllers/login.controller.ts`). El `web`
desplegado es `478c199` del 2026-06-16 y manda `Authorization: Bearer`; la rama `isaias`
no lee esa cabecera en ningún punto.

- **Ningún hallazgo de las auditorías del 2026-09-08 es una brecha viva.** Son defectos
  reales en la rama `isaias`, que se convertirán en brechas el día del despliegue.
- **Esto no se despliega solo.** Viaja dentro del primer despliegue del arco de
  autenticación. Los dos repos salen juntos, con caída de login entre medias (§9).

❓ **Pendiente de Isaias: ¿nueve cuentas o quince?** El documento decía nueve, corroborado
por comentarios del repo. Pero [`rescueCore.ts:204`](../../src/auth/rescueCore.ts) y
[`20260826000002:164`](../../src/migrations/20260826000002-add-mfa-columns.ts) dicen
**quince**, medidas sobre la copia de producción el 2026-08-27. Importa porque el aviso del
§9 paso 9 va dirigido a esa lista.

---

## 2. El problema

### 2.1. La contraseña se teclea dos veces para una sola operación

Cambiar tu propio nombre de usuario, hoy en `isaias`: el editor pide el usuario nuevo **y**
«Confirma tu contraseña» ([`PerfilAcceso.tsx:123-137`](../../../web/src/pages/menu/perfil/PerfilAcceso.tsx));
`editUserName` lo manda como `oldPass` y **no** manda `stepup_password`
([`Usuario.api.ts:86-95`](../../../web/src/api/Usuario.api.ts)); la puerta no encuentra el
campo que ella lee y contesta 403; el interceptor abre el diálogo y pide **la misma
contraseña otra vez**.

Está escrito como deuda asumida en el propio router
([`usuario.routes.ts:294-296`](../../src/routes/usuario.routes.ts)): *«the person types
their current password twice — once in the form, once in the step-up window»*.

### 2.2. La contraseña no tiene ventana; el factor sí

`STEP_UP_WINDOW_MINUTES = 10` ([`security.ts:276`](../../src/config/security.ts)) gobierna
**solo** la prueba del factor, sellada en `sesiones.mfa_satisfied_at`. La contraseña se
compara en **cada petición** a las 20 rutas con `exigeContrasena: true`. El router lo dice:
*«And it has no window.»* ([`usuario.routes.ts:121`](../../src/routes/usuario.routes.ts))

Cada comparación es un `bcrypt` a coste 12, ~250 ms
([`security.ts:18`](../../src/config/security.ts), `:638`), en un proceso de un solo hilo.

### 2.3. Una rama que no pide nada

[`requireStepUp.ts:533-561`](../../src/middleware/requireStepUp.ts) deja pasar sin ninguna
prueba cuando la cuenta no tiene factor. Su única justificación escrita es que ningún
cliente sabía enviar la contraseña. El plan 4D cableó ese envío hace seis días.

---

## 3. Las decisiones, y de quién son

| Decisión | Elegido | Quién |
|---|---|---|
| **Qué abre la ventana** | Un solo método, el más fuerte que tenga la cuenta: llave → aplicación → correo → contraseña | Isaias, 2026-09-08 |
| **Duración** | 10 minutos fijos, sin renovarse al usarla | Isaias, 2026-09-08 |
| **Cuentas sin factor** | Misma regla, misma ventana; la contraseña ocupa el sitio del factor | Isaias, 2026-09-08 (tras plantearle la alternativa estricta tres veces) |
| **Arreglar el plazo de gracia** | Sí, dentro de este arco | Isaias, 2026-09-08 |
| **Reversión de D6** | Sí, con alcance recortado (§4.1) | Isaias delegó la decisión el 2026-09-08 tras la ronda 2 |

### 3.1. La regla uniforme y las dos premisas que se cayeron

La revisión 1 defendió esta decisión diciendo que el estado «sin factor» *«caduca solo»* a
los 14 días. **Falso por dos motivos independientes.** Se le devolvió la decisión a Isaias
con esa información; la mantuvo y añadió que este arco arregle las causas.

**(a) El sello por contraseña desactivaba el plazo.** Los cuatro agentes de la ronda 1 lo
encontraron por separado. [`sessionState.ts:428`](../../src/auth/sessionState.ts) —
`if (sesion.mfa_satisfied_at != null) return guardado;` — es la cláusula 3 de
`estadoEfectivo`, y su docstring (`:297-302`) dice que existe porque *«`mfa_satisfied_at`
is stamped only by a live proof of a factor»*. **Se arregla en §5.**

**(b) El plazo se renueva en bucle, hoy, sin este diseño.** Verificado escritor por
escritor. Los tres únicos escritores de `mfa_grace_until` son `terminarLogin`
([`finishLogin.ts:238`](../../src/auth/finishLogin.ts)), `apagarLaMecha`
([`sessionPromotion.ts:211-214`](../../src/auth/sessionPromotion.ts)) y
`restablecerSegundoFactor` ([`rescueCore.ts:565-567`](../../src/auth/rescueCore.ts)).

1. Verificas tu dirección → `apagarLaMecha` pone `mfa_grace_until = NULL`.
2. Pides cambiar la dirección → `email_verified_at = NULL`
   ([`email.controller.ts:381-384`](../../src/controllers/email.controller.ts)). El factor
   desaparece; el plazo sigue NULL. **Y no cuesta nada**, porque el paso 1 acaba de sellar
   la ventana.
3. Sales y vuelves a entrar.
4. [`factorInventory.ts:591-599`](../../src/auth/factorInventory.ts): sin credencial, sin
   correo verificado y con el plazo NULL → **estampa catorce días frescos**.

La vuelta más barata no es esa: es **registrar y borrar una passkey**, que no necesita
buzón — `registerOptions` no consulta `email_verified_at`
([`webauthn.controller.ts:92-133`](../../src/controllers/webauthn.controller.ts)),
`registerVerify` llama a `apagarLaMecha` (`:298`) y `deleteCredential` no toca el plazo.
**Se arregla en §6.**

### 3.2. La excepción de la passkey, verificada

`userVerification: "required"` en el registro
([`webauthn.controller.ts:118`](../../src/controllers/webauthn.controller.ts)) y
`requireUserVerification: true` en las verificaciones (`:235`, `:606`, y
[`webauthnPasswordless.controller.ts:239`](../../src/controllers/webauthnPasswordless.controller.ts)).
El fichero lo dice en `:74`: *«`userVerification` is the entire reason a passkey counts as
two factors»*.

---

## 4. El modelo: una sola regla, sin modos nuevos

La revisión 1 proponía «dos modos» en la puerta. No era implementable: `requireStepUp` solo
lee la contraseña del cuerpo, no verifica factores; y su promesa de «no sella» era
incumplible, porque el canje sella siempre.

**Lo que hace especiales a unas rutas no es que ignoren el sello: es que necesitan además
algo que no vive en el aparato.** El mecanismo ya existe y está probado. El cambio es:

1. **Borrar la rama del pase libre** (§2.3). Toda cuenta tiene algo que probar.
2. **Renombrar `exigeContrasena` → `sinVentana`** (§4.4).
3. **Dar a la contraseña la capacidad de sellar**, en columna propia y solo cuando la cuenta
   no tiene factor (§5).
4. **Apagar `sinVentana`** en las 8 rutas de §4.1.

### 4.1. Las 23 rutas, una por una

Hoy son 22. Este diseño añade una (§4.2). La tabla canónica que hay que reescribir es
`STEP_UP_OPTIONS` en [`routeGuards.test.ts:1701-1737`](../../src/routes/routeGuards.test.ts),
que compara el **objeto entero** contra los montajes reales en las dos direcciones.
`STEP_UP_GATED` (`:535-604`) **no cambia**: ninguna ruta gana ni pierde la puerta.

🔴 **Las tres opciones van en la tabla, no solo `sinVentana`.** La revisión 2 solo nombraba
una, y escribirla así habría vuelto a sellar la sala: siete de estas rutas necesitan
`permiteOnboarding: true` para que una cuenta en `onboarding` pueda salir de `onboarding`.

**Con ventana (8)** — `sinVentana: false`. Ninguna lleva otras opciones.

| Ruta | Hoy | Por qué basta la ventana |
|---|---|---|
| `PUT /api/usuario/username/:id` | `exigeContrasena` | **Es la operación que origina este trabajo.** |
| `PUT /api/usuario/:id` | `exigeContrasena` | Datos del perfil. `id_rol` sale a §4.2. |
| `PATCH /api/usuario/:id/restore` | `exigeContrasena` | Deshace un archivado. La deshacer nunca debe costar más que la acción. |
| `POST /api/rol/` | `exigeContrasena` | Los roles son etiquetas. La autoridad se reparte en `PUT /api/permiso/:id_rol` y se asigna en §4.2; las dos se quedan fuera. |
| `PUT /api/rol/:id` | `exigeContrasena` | Ídem. |
| `DELETE /api/rol/:id` | `exigeContrasena` | Ídem. |
| `PATCH /api/rol/:id/restore` | `exigeContrasena` | Ídem. |
| `DELETE /api/auth/sessions/:id` | **nada** (rama del pase libre) | Pasa a pedir una prueba, que es **más** de lo que pide hoy. |

**Sin ventana (15)** — `sinVentana: true`. La contraseña, en cada petición.

| Ruta | Opciones | Por qué |
|---|---|---|
| `POST /api/usuario/` | — | Crea una cuenta con el rol que se elija. **Sobrevive a cambiar la contraseña, a `logout-all`, al reset de factores y al rescate del panel**, porque es otra cuenta: persistencia perfecta. |
| `DELETE /api/usuario/:id` | — | 🔴 **Archivar NO es reversible.** [`usuario.controller.ts:993-1001`](../../src/controllers/usuario.controller.ts): *«The only way out left is an `UPDATE` by hand against production»* — `desarchivarUsuario` exige el permiso que se acaba de quitar, el rescate contesta 409 sobre archivadas y la consola no sabe desarchivar. Ocho peticiones dejan a todos fuera. |
| `PUT /api/usuario/userpass/:id` | — | Cambia la contraseña de **otra** persona; `requiresOwnPassword` es falso ahí (`usuario.controller.ts:140-143`) y la puerta es la única defensa. |
| `PATCH /api/usuario/:id/desbloquear` | — | Elegida por Isaias. Desactiva el freno contra adivinar contraseñas. |
| `POST /api/usuario/:id/mfa/reset` | — | Elegida por Isaias. Borra credenciales de otra cuenta. |
| **`PUT /api/usuario/:id/rol`** | — | **Nueva**, §4.2. |
| `PUT /api/permiso/:id_rol` | — | Elegida por Isaias. Se concede permisos a sí mismo. |
| `POST /api/auth/email/send` | `permiteOnboarding` | §4.3. **Hoy está en `false`: esta es la única que se enciende.** |
| `POST /api/auth/totp/setup` | `permiteOnboarding` | Registra una credencial. |
| `POST /api/auth/totp/confirm` | `permiteOnboarding` | Ídem. |
| `DELETE /api/auth/totp/` | `permiteOnboarding`, `toleraFactorIlegible` | Borra una credencial. 🔴 `requireStepUp.ts:282-287` **lanza al montar** si `toleraFactorIlegible` va sin esto: el servidor no arrancaría. |
| `POST /api/auth/recovery-codes/` | — | Emite **diez credenciales offline** en una respuesta. |
| `POST /api/auth/webauthn/register/options` | `permiteOnboarding` | Registra una credencial. |
| `POST /api/auth/webauthn/register/verify` | `permiteOnboarding` | Ídem. |
| `DELETE /api/auth/webauthn/credentials/:id` | `permiteOnboarding` | Borra una credencial. |

8 + 15 = 23. De los montajes existentes cambian **9**: 8 se apagan y 1 (`/auth/email/send`)
se enciende.

**Por qué las de credenciales no son negociables.**
[`requireStepUp.ts:524-527`](../../src/middleware/requireStepUp.ts): *«every route that
registers or removes a credential must be mounted with it on. It is not a hardening knob to
turn on later: on those routes, off is a permanent lockout.»* El camino si se apagaran:
alguien con la cookie espera a que el dueño abra su ventana, registra su propia passkey —lo
que además **re-sella**— y borra los factores del dueño; como queda el suyo, las sesiones no
se revocan ([`webauthn.controller.ts:912`](../../src/controllers/webauthn.controller.ts)) y
el siguiente login del dueño abre `parcial`, del que solo se sale probando el factor del
atacante.

> **Nota sobre esa regla.** Enunciada al pie de la letra alcanza a más de las siete
> «obvias»: `POST /auth/email/send` registra un factor desde el 4E, y
> `POST /usuario/:id/mfa/reset` borra credenciales ajenas
> ([`rescueCore.ts:535-539`](../../src/auth/rescueCore.ts)). Las nueve están en la tabla de
> arriba, así que el resultado no cambia — pero quien aplique la regla a una ruta futura
> tiene que contar las nueve, no siete.

### 4.2. `PUT /api/usuario/:id/rol` — el sub-recurso nuevo

**El problema.** `PUT /api/usuario/:id` escribe `id_rol` de terceros cuando el que llama
tiene `roles.editar` ([`usuario.controller.ts:417-420`](../../src/controllers/usuario.controller.ts),
`:460-462`, aplicado en `:540`). El único freno es «no cambies tu propio rol» (`:527-535`);
contra la cuenta de otro no hay ninguno. En ventana, eso es: una petición, y quien tenga tu
cookie **es administrador con sus propias credenciales** — sobrevive a que cambies la
contraseña, a `logout-all`, al reset de factores y al rescate. Es exactamente el criterio
con el que `POST /api/usuario/` se queda fuera.

**La solución elegida.** `id_rol` sale de `ROLE_ASSIGNMENT_FIELDS` y la asignación se muda a
`PUT /api/usuario/:id/rol`, con `sinVentana: true` y `requirePermission("roles","editar")`.

**Por qué esta y no dejar `PUT /api/usuario/:id` fuera de la ventana.** Esa ruta es también
con la que se editan los datos del propio perfil: dejarla fuera devuelve la doble petición
al sitio donde empezó todo — editar tu teléfono abriría el diálogo. Cuesta más trabajo, y es
la solución mantenible. El patrón de sub-recursos ya está establecido por D1.

### 4.3. Por qué `POST /api/auth/email/send` se queda sin ventana

Hoy su contraseña la pide el **controlador**, con otro nombre (`pass`), no la puerta
([`email.controller.ts:306`](../../src/controllers/email.controller.ts), comparación en
`:325`); el comentario de `:311` lo admite: *«This field is the defence, and
`requireStepUp` is not»*.

Con ventana se abriría un camino nuevo: alguien con la cookie espera a que abras tu ventana,
cambia el correo de recuperación al suyo, lo verifica desde su buzón — y una dirección
verificada **es un factor** desde el 4E
([`factorInventory.ts:172-176`](../../src/auth/factorInventory.ts)). Y el rescate del panel
**no limpia `email_verified_at`** ([`rescueCore.ts:544-555`](../../src/auth/rescueCore.ts)).

La comprobación sube del controlador a la puerta, conservando `permiteOnboarding: true`.

🔴 **El día uno.** Ninguna cuenta tiene factor y `/auth/totp/setup` contesta **409** sin
correo verificado ([`totp.controller.ts:201-202`](../../src/controllers/totp.controller.ts)).
`sinVentana` significa «la contraseña en cada petición, **más** el factor si la cuenta tiene
alguno» — nunca «hace falta un factor que no existe». Sin esa lectura, nadie podría verificar
su correo y nadie podría montar un TOTP.

> Verificado de paso: el comentario de `requireStepUp.ts:159-161` afirma que
> `/auth/webauthn/register/*` también contesta 409 sin correo verificado. **Es falso** —
> `webauthn.controller.ts` no menciona esa columna en ningún punto. Se corrige.

### 4.4. El renombrado: `exigeContrasena` → `sinVentana`

Con la rama del pase libre borrada, **la contraseña la exige la puerta siempre**. Lo único
que esa opción hace es apagar el atajo de la ventana. Conservar el nombre viejo dejaría, en
el fichero más citado del arco, una opción cuya documentación de quince líneas
(`requireStepUp.ts:180-195`) contradice su comportamiento.

El renombrado arrastra consigo la reescritura de los comentarios de §12, que es la mitad
del valor: obliga a tocarlos.

---

## 5. El sello por contraseña

`sesiones.mfa_satisfied_at` **conserva su significado**: «esta sesión probó un factor».
Cambiarlo era el error de la revisión 1.

La contraseña sella en **columna propia**: `sesiones.password_confirmed_at`.

🔴 **No entra en un OR con la del factor.** La revisión 2 decía «la ventana se satisface si
cualquiera de las dos está fresca», y eso degrada la protección más fuerte que hay: como
`satisfecho` se calcula **antes** de la comprobación de factor
([`requireStepUp.ts:351-355`](../../src/middleware/requireStepUp.ts) frente a `:387`), una
sesión podía probar su factor **una sola vez en la vida** y después mantener abiertas con la
contraseña las rutas de credenciales, re-sellando cada vez.

**Las dos reglas, escritas:**

1. `password_confirmed_at` **solo se consulta dentro de la rama sin-factor**, donde
   `tieneAlgunFactor` ya respondió `false`. Nunca en el cálculo de `satisfecho`.
2. **No se re-sella mientras la ventana ya esté abierta.** El `UPDATE` lleva
   `WHERE password_confirmed_at IS NULL OR password_confirmed_at < now() - interval '10 minutes'`.
   Eso es lo que hace real el «10 minutos fijos, sin renovarse» de §3.

`estadoEfectivo` **no la mira**. El plazo de catorce días sigue cerrándose.

**No se toca `mfa_source`.** El vocabulario está cerrado por
`sesiones_mfa_source_chk` ([`20260826000002:101-102`](../../src/migrations/20260826000002-add-mfa-columns.ts),
ampliada por `20260903000001`) y por `FuenteMfa` ([`sessionState.ts:84`](../../src/auth/sessionState.ts));
un sexto valor reventaría en caliente y `esPruebaDeFactor` (`:128`) lo trataría como factor.

### 5.1. Dónde vive la escritura, y las seis piezas que tienen que aprender la columna

La convención del repositorio es que las escrituras sobre `sesiones` viven en funciones
nombradas de [`sessionPromotion.ts`](../../src/auth/sessionPromotion.ts). Se añade
`sellarContrasena(id_sesion)` allí, **con `await` antes de `next()`** — un `void` deja la
siguiente petición de la ventana contestando 403.

🔴 **`tsconfig.json` tiene `"strict": false`, así que olvidar cualquiera de estas seis falla
en silencio**: `password_confirmed_at` llega `undefined`, la ventana no se satisface nunca, y
se despliega justo la molestia que este arco quita — en verde.

1. La migración + su test (los 16 ficheros de `src/migrations/` desde 2026-08-21 llevan uno).
2. [`interfaces/index.ts:185-207`](../../src/interfaces/index.ts) — `ISesion`.
3. [`models/sesion.model.ts:32-35`](../../src/models/sesion.model.ts) (`SesionCreation`) y
   `:61-69` (el atributo).
4. [`sessionStore.ts:144-186`](../../src/auth/sessionStore.ts) — tipo de retorno,
   `attributes` y mapeo de `findLiveSession`.
5. [`authenticate.ts:377-419`](../../src/middleware/authenticate.ts) — el montaje de `req.user`.
6. [`app.ts:26-39`](../../src/app.ts) — la declaración global de `Express.Request`.

Y hay que ampliar `factorModels.test.ts:150-155`, que usa `toHaveProperty` y por tanto **no**
detecta una columna que esté en la migración y falte en el modelo.

**Migración:** `password_confirmed_at TIMESTAMPTZ NULL`. Sin CHECK, sin default, sin relleno
— NULL significa «no ha confirmado», que es correcto para toda sesión existente.

### 5.2. Cero escrituras de invalidación

La revisión 2 mandaba poner la columna a NULL en seis sitios. **Las seis son código muerto**:
los seis llaman a `revokeAllSessionsOf`, y `findLiveSession`
([`sessionStore.ts:155-161`](../../src/auth/sessionStore.ts)) ya excluye `revoked_at IS NOT NULL`.
La columna muere con la fila. Seis líneas que no hacen nada son seis oportunidades de olvidar
una y razonar sobre por qué falta.

En su lugar, una frase en el comentario de la columna: solo se lee a través de
`findLiveSession`, que ya filtra las revocadas.

---

## 6. Cerrar el bucle del plazo: borrar `apagarLaMecha`

La revisión 2 proponía una columna `mfa_grace_started_at` para recordar que el plazo ya se
gastó. **Se descarta.** Creaba una columna para recordar lo que otra acababa de olvidar a
propósito, y rompía tres cosas en silencio (§13).

**La causa raíz es `apagarLaMecha`**, que pone `mfa_grace_until = NULL` al registrar un
factor ([`sessionPromotion.ts:211-214`](../../src/auth/sessionPromotion.ts)). Si deja de
borrarlo, la fecha original sigue ahí y el siguiente login la lee: vencida → `onboarding`,
viva → `completa` **sin re-estampar**. El bucle se cierra en la primera vuelta.

**El cambio:** borrar las tres llamadas
([`email.controller.ts:586`](../../src/controllers/email.controller.ts),
[`totp.controller.ts:412`](../../src/controllers/totp.controller.ts),
[`webauthn.controller.ts:298`](../../src/controllers/webauthn.controller.ts)), la función y
su test (`sessionPromotion.test.ts:162-169`). **Sin migración, sin columna, sin relleno.**

**Qué conserva, y es lo que decide:**

- **La gracia de rescate de 24 horas sigue funcionando.** `proximaGraciaDeRescate` con una
  fecha pasada devuelve `ahora+24h` ([`rescueCore.ts:224-228`](../../src/auth/rescueCore.ts));
  con la columna nueva habría recibido NULL y devuelto NULL, dejando al administrador **sin
  ninguna palanca** — ni en el panel ni en la consola, que no tiene flag para el plazo.
- **El indulto manual documentado sigue haciendo lo que dice.**
  [`factorInventory.ts:530-541`](../../src/auth/factorInventory.ts) documenta
  `UPDATE usuarios SET mfa_grace_until = NULL;` como la palanca de emergencia que *«compra
  otro plazo completo y se puede ejecutar tantas veces como haga falta»*. Con la columna
  nueva, esa misma sentencia habría metido a toda la plantilla en `onboarding`.
- **El saldo legítimo no se confisca.** Quien registra una passkey el día 3 y la borra el
  día 4 —móvil nuevo, portátil devuelto— conserva los diez días que le quedaban.
- **`estadoEfectivo` puede seguir estrechando una sesión viva.** La cláusula 2
  (`sessionState.ts:401-402`) devuelve `completa` cuando el plazo es NULL; la población que
  la columna nueva creaba tenía NULL para siempre.

**El coste, entero.** Una cuenta que registró su factor arrastra una fecha vencida. La
cláusula 3 de `estadoEfectivo` la protege **salvo** las sesiones nacidas con
`mfa_source = 'dispositivo'`, que `esPruebaDeFactor` declara que no son prueba
(`sessionState.ts:127-129`): a quien marcó «recordar este equipo» se le pedirá el factor una
vez al vencer su plazo, por `/api/auth/mfa/verify`, que está abierta a `onboarding`. Es
discutiblemente lo correcto.

El propio código respalda que quitarlo es seguro: el docstring de `apagarLaMecha`
(`sessionPromotion.ts:190-199`) dice que es *«the line this task is easiest to skip, because
nothing breaks the moment it is missing»*.

### 6.1. Y el rodeo que hay que cerrar con él

**Cambiar la contraseña emite una sesión nueva sin pasar por la puerta del login.**
[`usuario.controller.ts:970`](../../src/controllers/usuario.controller.ts) llama a
`issueSession(..., loggedUser.estado)` con el estado **efectivo**, sin pasar por
`estadoInicialDeSesion`. Con `SESSION_ABSOLUTE_DAYS = 30`, una cuenta sin factor y con el
plazo vencido conservaría el ERP indefinidamente cambiando su contraseña cada 29 días. Hoy
nadie usaría ese rodeo porque el login regala catorce días; cerrado el bucle, es *el* rodeo.

`issueSession` en esa ruta pasa por `estadoInicialDeSesion` como el login.

---

## 7. Cliente

### 7.1. El diálogo

Pide **una cosa** y dice para qué sirve y cuánto dura. El título actual, «Confirma que eres
tú», no menciona ni la protección ni los minutos, y la petición de Isaias es explícita.

Cuatro arreglos entran porque son de esta pieza:

- **El límite de tiempo que falta.** `comprobarToken` es la única petición de la ceremonia
  sin `timeout` ([`Login.api.ts:323`](../../../web/src/api/Login.api.ts)). Mientras cuelga,
  los dos botones están deshabilitados
  ([`StepUpDialog.tsx:568`](../../../web/src/components/dialogs/StepUpDialog.tsx), `:583`) y
  Escape se traga (`:410`): la aplicación queda bloqueada tras una modal muerta.
  ⚠️ **Esa función la usan también el arranque de `SesionProvider` y `LoginPage`.** El
  timeout va **por llamada**, no global: un timeout en el arranque cambia el comportamiento
  de la aplicación entera y no es de este trabajo.
- **El tope de reintentos.** `MAX_REINTENTOS = 2`
  ([`stepUpInterceptor.ts:220`](../../../web/src/api/stepUpInterceptor.ts)) y el camino
  honrado gasta uno. ⚠️ «Contar reenvíos y no pasos» **no es implementable**: los dos son
  reenvíos. La regla que sí lo es: **alinear el contador con el `intentosRestantes` que el
  servidor ya manda**, y reiniciarlo cuando cambia el `motivo`.
- **La contraseña en el camino de éxito.** `limpiarPassword` se llama solo en el `catch`
  (`:538`); el `return await axios(config)` de `:518` no limpia nada.
- **Los mensajes al cancelar.** El interceptor tiene **ocho** salidas (`:454`, `:463`,
  `:467`, `:489`, `:497`, `:501`, `:513`, `:539`) y solo una emite aviso.

🔴 **Corrección a las revisiones 1 y 2.** La revisión 1 decía que agotar los reintentos en el
perfil enseña «Error al actualizar el usuario. Podría estar en uso.»: **falso**, porque
[`Usuario.api.ts:92-94`](../../../web/src/api/Usuario.api.ts) hace
`e.response?.data?.message || "Error desconocido"` y el respaldo es inalcanzable. La
revisión 2 dijo que ese fichero **no pasa por el normalizador**: también falso — el
normalizador es un interceptor global sobre el singleton de axios
([`http.ts:191`](../../../web/src/api/http.ts)) y ese fichero usa ese singleton (no hay un
solo `axios.create` en `web/src`). Lo cierto es que **no lee `error.normalized`**: se
fabrica su mensaje en su propio `.catch`. El arreglo es el mismo; la razón, no. Y la
formulación falsa contradecía §2.1 paso 4, que depende de que esas peticiones **sí** recorran
la cadena de interceptores.

El arreglo del perfil sigue el estándar de la API §4.1
([`2026-08-25-estandar-api-design.md:775-788`](2026-08-25-estandar-api-design.md)): propagar
y leer `error.normalized`, no inventar un tercer patrón.

### 7.2. C5: la ceremonia compartida — encadenar, no apilar

El discriminante **no es `motivo`**: dos rutas con carencias distintas contestan las dos
`sin-factor-reciente` y solo se diferencian por la opción
([`requireStepUp.ts:449-452`](../../src/middleware/requireStepUp.ts)). El par es
**`(motivo, sinVentana)`**.

🔴 **Y la ceremonia se encadena, no se apila.** `StepUpDialog` guarda **una sola** ceremonia
(`StepUpDialog.tsx:71`) y su resolvedor la sobrescribe sin condiciones (`:146-171`): abrir
una segunda pisa la primera y deja sus peticiones **ni resueltas ni rechazadas**, que es el
fallo que `stepUpInterceptor.ts:145-153` está escrito para evitar. La petición encolada cuyo
par no coincide **espera** a que la ceremonia viva termine y abre la suya después. No hace
falta tocar el diálogo.

🔴 **Y el servidor tiene que mandar el campo.** `denegar(..., MOTIVO_CONTRASENA_REQUERIDA)`
(`requireStepUp.ts:541`) hoy **no manda `exigeContrasena`**, así que dos rutas de modos
distintos contestarían el mismo par. Ese `denegar` gana el campo.

### 7.3. Los campos de contraseña en línea

Son **diez**. El discriminante de cuáles se retiran **no es «su ruta conserva la contraseña»**
—`PerfilAcceso.tsx:224` la conserva por §4.3 y aun así se retira— sino **qué campo del cable
alimentan**: los que alimentan `oldPass`/`pass` propios del controlador mueren cuando su
controlador deja de leerlos; los que alimentan `stepup_password` se quedan, porque su ruta
sigue sin ventana.

**Se retiran (3):**

| Dónde | Campo | Por qué |
|---|---|---|
| [`PerfilAcceso.tsx:124`](../../../web/src/pages/menu/perfil/PerfilAcceso.tsx) | `userPass` | `PUT /usuario/username/:id` pasa a ventana. |
| [`UsuarioDetallePage.tsx:611-616`](../../../web/src/pages/menu/usuario/UsuarioDetallePage.tsx) | `currentPassUser` | El mismo, desde la otra pantalla. Enviado como `oldPass` en `:172-175`. **La revisión 2 no lo veía.** |
| [`PerfilAcceso.tsx:224`](../../../web/src/pages/menu/perfil/PerfilAcceso.tsx) + [`Login.api.ts:195`](../../../web/src/api/Login.api.ts) | el `pass` del correo | La comprobación sube del controlador a la puerta (§4.3), y ahí el campo se llama `stepup_password`. |

**Se quedan (7):** `Mfa.api.ts:96/138/161/185` y `Webauthn.api.ts:41/63/280`. Mandan
`stepup_password` a rutas que siguen sin ventana.

**`oldPass` se queda** en el editor de contraseña: ahí «contraseña actual» es parte de lo que
se está cambiando. Decisión de Isaias.

**`updateUserName` deja de exigir su propio `oldPass`.** Consecuencia:
`chargeConfirmBudgetOnSelfChange` ([`usuario.routes.ts:96-99`](../../src/routes/usuario.routes.ts))
está montado en **dos** rutas, no una; en `/username/:id` queda sin nada que cobrar y **se
desmonta de ahí**, conservándolo en `/userpass/:id`. Sus 66 líneas de docstring se reescriben
para hablar de una ruta.

### 7.4. `StepUpDialog.tsx` se parte

594 líneas y **doce** `useState`. Sale un hook `useStepUpCeremony` con el estado y las
acciones, y el componente queda presentacional. No es refactor gratuito: §7.1 y §7.2 tocan
ese estado, y el fichero ya está por encima de lo que se sostiene.

---

## 8. El contrato entre los dos repos

**Sin cambios:** `STEP_UP_PASSWORD_FIELD`, `CODIGO_STEP_UP`, los cuatro `MOTIVO_*`.
Verificados valor por valor entre los dos repos, incluido el acento de
`"contraseña-incorrecta"`.

**Añade** un campo al 403 de `contraseña-requerida`: `exigeContrasena` (§7.2).

🔴 **NO se añade `"password"` a `metodos`.** La revisión 2 lo pedía y es doblemente erróneo:

- **El servidor no tiene dónde emitirlo.** `metodos` viaja en un solo `denegar`
  (`requireStepUp.ts:449-452`), dentro de la rama `!satisfecho && tieneAlgunFactor` — que es
  **inalcanzable** para una cuenta sin factor.
- **El contrato no lo admite.** `metodos` está documentado en
  [`stepUp.ts:82-84`](../../../web/src/api/stepUp.ts) como *«Sólo en `sin-factor-reciente`»*, y
  `"password"` no es un valor de `MetodoReautenticacion`
  ([`factorInventory.ts:294`](../../src/auth/factorInventory.ts)). Añadirlo obligaría a
  ensanchar el tipo en los dos repos para un caso que ninguna rama produce.

  🔴 **Corrección a la revisión 2 (hallazgo de la revisión de la Tarea 3).** La revisión 2
  justificaba esto diciendo que `describeMetodos(["password"])` «gana al `??`» de
  [`StepUpDialog.tsx:402`](../../../web/src/components/dialogs/StepUpDialog.tsx) y pintaría el
  texto de «método desconocido» sobre el campo de contraseña. **Es falso para este motivo:**
  esa línea vive dentro de un ternario cuya condición es `pideFactor`, y
  `pideFactor = motivo === MOTIVO_SIN_FACTOR_RECIENTE` (`:237`), así que con
  `contraseña-requerida` **`describeMetodos` no se llama nunca**. La medición de la
  pre-auditoría era correcta para `sin-factor-reciente` y se generalizó mal a este caso. La
  decisión no cambia; su motivo, sí.

**La regla real:** cuando la cuenta no tiene factor, el 403 lleva
`motivo: MOTIVO_CONTRASENA_REQUERIDA` y **`metodos` ausente**. Con eso `describeMetodos(undefined)`
devuelve `null`, cae en `describeStepUpError` y sale *«Escribe tu contraseña actual para
continuar»* ([`stepUp.ts:145`](../../../web/src/api/stepUp.ts)). **El diálogo ya funciona
hoy para ese caso**: `pideFactor` es falso con ese motivo (`:237`) y el campo se pinta.
`describeMetodos` y `MetodoReautenticacion` no se tocan.

---

## 9. Despliegue

**No hay orden entre los dos repos: salen juntos, en una ventana, con caída de login.**

1. **Confirmar qué rama sirve Coolify hoy.** Todo §1 descansa en que es `master`.
2. **Rotar `JWT_SECRET`.** La imagen desplegada firma con él y el valor de `.env` es un
   literal de once caracteres.
3. **Armar** `20260827000002-drop-sesiones-estado-default`, de `src/migrations/pending/` a
   `src/migrations/` con su test. Su cabecera (`:87-88`) dice que *«can be armed in the same
   deploy as the rest of the arc, and should be»*, y `:97-100` que su párrafo caduca aquí.
   (El glob de [`migrate.ts:12`](../../src/database/migrate.ts) no cruza separador: por eso
   `pending/` no corre.)
4. **La migración de `password_confirmed_at`** (§5). Es la única que este diseño añade.
5. `npm run migrate:deploy` como **pre-deployment**. Si falla, aborta y sigue la imagen
   anterior.
6. Desplegar `api`. [`Dockerfile:21`](../../Dockerfile) lint, `:46` test, `:48` build: un
   test rojo aborta la imagen.
7. **Inmediatamente**, desplegar `web` en **Vercel** ([`web/vercel.json`](../../../web/vercel.json)),
   que corre `lint && test && tsc && vite build`. Son dos tuberías distintas.
8. **Medir a mano**, cuenta real sin factor: entrar; abrir una operación protegida y
   comprobar que el diálogo **pinta un campo de contraseña y «Confirmar» está vivo**;
   registrar una passkey; verificar el correo desde la cuenta ya con factor.
9. Avisar a la plantilla de que su reloj de catorce días empieza en **su** primer inicio de
   sesión, no en el despliegue. (Ver la pregunta abierta de §1 sobre cuántas son.)

🔴 **Marcha atrás: no existe como plan ejecutable, y hay que decirlo.**

- **No hay script de `down`.** `package.json` tiene `migrate` y `migrate:deploy`, y ambos
  llaman a `runMigrations()` ([`migrate.ts:129-142`](../../src/database/migrate.ts)), que solo
  hace `up()`. Deshacer exige umzug a mano o SQL crudo.
- **Armar el paso 3 convierte el rollback en caída total de login.** Su propia cabecera lo
  midió: el `createSession` de la imagen anterior no nombra `estado` en su INSERT, y sin el
  `DEFAULT 'completa'` ese INSERT **muere** con violación de NOT NULL.
- La migración de §5 lleva `down` con la convención del repositorio (transacción,
  `SET LOCAL lock_timeout = '5s'`), y es limpia: la columna es nueva y nada depende de ella.

---

## 10. Errores y estados de fallo

| Situación | Qué pasa |
|---|---|
| Se cancela el diálogo | La operación se aborta **y se dice que fue una cancelación**. |
| Confirmación en vuelo que no vuelve | Corta a los `TIMEOUT_CONFIRMACION_MS`, incluido el refresco de sesión, **por llamada**. |
| Método incorrecto | Se dice cuántos intentos quedan; el contador del cliente se alinea con `intentosRestantes`. |
| Presupuesto agotado (429) | El mensaje dice que hay que esperar y **no** manda a `logout-all`: el cubo es `pc:<id_usuario>` ([`loginLimiters.ts:99-102`](../../src/middleware/loginLimiters.ts)), por cuenta y no por sesión. |
| Cuenta sin factor | `motivo: contraseña-requerida`, sin `metodos` (§8). |
| La cuenta no puede probarse con nada | `metodos` vacío. La frase existente manda a avisar a un administrador. |

---

## 11. Cómo se prueba

**La regla del repositorio: ver el test fallar no basta — hay que comprobar por qué falla.**

**Servidor.**
- La rama del pase libre ya no existe: cuenta sin factor y sin contraseña recibe 403 en las
  23 rutas. [`app.auth.test.ts:1087`](../../src/app.auth.test.ts) cambia de expectativa; hoy
  espera 200 y **pasa en verde** (ejecutado).
- 🔴 **La prueba de aceptación que la revisión 2 no tenía**: segunda petición dentro de los
  diez minutos, **sin contraseña**, pasa. Es lo único que el usuario nota, y sin ella la
  cadena de §5.1 puede quedar rota en silencio y en verde.
- `password_confirmed_at` no se re-sella dentro de la ventana (la segunda confirmación no
  mueve la fecha).
- ⚠️ **El test del plazo va en la costura, no en la unidad.** `estadoEfectivo` recibe un
  objeto literal tipado y TypeScript rechaza la propiedad de más: escrito como unitario
  **pasaría en verde sin probar nada**. Va con `findLiveSession` simulado devolviendo
  `password_confirmed_at` fresco y plazo vencido, a través de la app montada, esperando
  `FACTOR_PENDIENTE`.
- El bucle está cerrado: registrar un factor, borrarlo, volver a entrar → conserva el saldo
  original, no catorce días nuevos.
- La gracia de rescate sigue viva: cuenta con plazo vencido + `mfa/reset` → 24 horas.
- Las 15 rutas sin ventana siguen pidiendo la contraseña **con el sello fresco** — que es lo
  único que distinguirá los dos modos. Las guardas anti-mutación de
  `totp.routes.test.ts:185-205` y `recoveryCodes.routes.test.ts:122-151` se reescriben con esa
  forma; el segundo test de `recoveryCodes.routes.test.ts:139-155` ya la tiene y sirve de
  plantilla.
- ⚠️ El test de la **fecha ilegible** que la revisión 1 daba por existente **no existe**. Se
  escribe.

**Cliente.**
- El diálogo pide **un** método.
- Con `motivo: contraseña-requerida` y sin `metodos`, pinta el campo y «Confirmar» está
  habilitado.
- La confirmación corta por timeout. Tiene que fallar antes del arreglo por *colgarse*.
- Dos peticiones con pares distintos **se encadenan**, y ninguna queda sin resolver.
- Tras un reintento con éxito, `stepup_password` no está en `response.config.data`.

**Tests que pierden su propiedad al reescribirlos**, y que hay que sustituir por otros que la
conserven: `app.auth.test.ts:1101` (404 y no 403), `:1114` (forma del UUID — pasaría en verde
por otro motivo), `:1414` (el reparto de un cubo entre dos puertas, cuyo único testigo es el
`oldPass` del renombrado; los sustitutos posibles son `PUT /userpass/:id` y
`POST /auth/email/send`), `:1821` (`LockoutPolicy`), `:2032` y `:2117-2126`
(`STEP_UP_SKIPPED`), y `routeGuards.test.ts:1770-1818` — el alambre trampa de D6, que hay que
sustituir por su versión recortada, no borrar.

---

## 12. Alcance

**Entra:** §4 (la tabla de 23 rutas, el sub-recurso, el renombrado y el borrado de la rama),
§5 (la columna y sus seis piezas), §6 (borrar `apagarLaMecha` y cerrar el rodeo de la rotación
de sesión), §7 (diálogo, C5, los tres campos, el troceo del diálogo), §8 (el contrato), §9
(las dos migraciones), y `stepup_password` en la lista de redacción de
[`logger.ts:118-180`](../../src/utils/logger.ts).

🔴 **Y entra el hallazgo 1 de §14, que es prerrequisito** (la revisión 2 se contradecía a sí
misma en esto): el cupo de contraseñas no atómico. Hoy adivinar la contraseña compra una
operación; con la ventana compra los diez minutos enteros.

**Corrección de comentarios — catorce bloques**, no cuatro:
`requireStepUp.ts:34-56`, `:112-123`, `:138`, `:159-161`, `:180-195`, `:476-561`;
`rol.routes.ts:29-43` (bloque D6 + `conContrasena()` sin uso);
`usuario.routes.ts:30-95`, `:114-131`, `:289-297`;
`usuario.controller.ts:590-660`;
`factorInventory.ts:530-541`, `:576-590`;
`sessionState.ts:318`;
`routeGuards.test.ts:540-548`;
`auth.routes.ts:114-117`.

**No entra:** el resto de §14.

---

## 13. Qué cambió en cada vuelta

**Revisión 1 → 2** (ronda de auditoría 1):

| Rev. 1 | Rev. 2 | Motivo |
|---|---|---|
| «Dos modos» en la puerta | Sin modos nuevos | El modo «siempre» no era implementable y su «no sella» era incumplible. |
| `mfa_satisfied_at` cambia de significado | Columna propia | Los cuatro agentes: `estadoEfectivo:428` la lee y el plazo se desactivaba. |
| Valor nuevo en `mfa_source` | No se toca | CHECK en la base + `esPruebaDeFactor` lo trataría como factor. |
| `DELETE /auth/totp` a ventana | Conserva la contraseña | `requireStepUp.ts:282-287` **lanza al montar**: el servidor no habría arrancado. |
| «Servidor primero, degrada» | Los dos juntos | Medido: el cliente actual deja «Confirmar» muerto para siempre. |

**Revisión 2 → 3** (ronda de auditoría 2):

| Rev. 2 | Rev. 3 | Motivo |
|---|---|---|
| 9 rutas en ventana | **8**, y `PUT /usuario/:id/rol` nace sin ventana | `PUT /usuario/:id` asignaba el rol de terceros: una petición y el atacante es administrador con **sus propias** credenciales. |
| `DELETE /usuario/:id` en ventana, «archivado reversible» | Sin ventana | Falso: el propio controlador dice que *«la única salida es un `UPDATE` a mano contra producción»*. |
| La ventana se satisface por **OR** de las dos columnas | La de contraseña **solo** se consulta en la rama sin-factor, y no se re-sella | El OR dejaba probar el factor una vez en la vida de la sesión y mantener las rutas de credenciales con la contraseña sola. |
| `exigeContrasena` conserva el nombre | **`sinVentana`** | Tras borrar el pase libre ya no «exige la contraseña»: apaga la ventana. Su docstring decía lo contrario. |
| Columna `mfa_grace_started_at` + relleno | **Borrar `apagarLaMecha`** | La columna rompía en silencio la gracia de rescate, el indulto documentado y la capacidad de `estadoEfectivo` de estrechar; y confiscaba el saldo legítimo. |
| §4.1 solo nombraba `exigeContrasena` | Las **tres** opciones por fila | Siete rutas necesitan `permiteOnboarding`; escribir la tabla sin él volvía a sellar la sala. |
| Seis escrituras de invalidación | **Cero** | Las seis rutas ya revocan la sesión y `findLiveSession` excluye las revocadas. |
| Añadir `"password"` a `metodos` | **No** | Inalcanzable en el servidor, y emitirlo empeoraba la pantalla. Medido. |
| «Abre una ceremonia propia» | **Encadenar** | El diálogo guarda una sola ceremonia; apilar dejaba peticiones sin resolver. |
| Nueve campos de contraseña | **Diez**, con el discriminante escrito | Faltaba `UsuarioDetallePage.tsx:611-616`, y la razón dada no discriminaba. |
| «`Usuario.api.ts` no pasa por el normalizador» | **No lee `error.normalized`** | Falso: el normalizador es global sobre el singleton que ese fichero usa. |
| §12 decía «no entra §14» y §14 decía «prerrequisito» | El hallazgo 1 **entra** | Contradicción interna. |
| Marcha atrás en una línea | No existe como plan | No hay script de `down`, y armar la migración aparcada la convierte en caída total de login. |

---

## 14. Hallazgos de la auditoría que NO entran aquí

**Ninguno es una brecha viva** (§1); todos lo serán el día del despliegue.

1. **El cupo de cinco contraseñas no es atómico** (ALTO). Se lee el contador
   ([`requireStepUp.ts:584`](../../src/middleware/requireStepUp.ts)), se compara ~250 ms
   (`:601`), y se cobra después (`:628`). 🔴 **Este sí entra** (§12).
2. **Encierro permanente por buzón perdido** (ALTO, dos auditores). Verificar el correo da un
   factor y **no** emite códigos de recuperación.
3. **Los dos borrados masivos e irreversibles sin puerta** (ALTO): `DELETE /api/files/orphans`
   y `/broken-refs`.
4. **Los diez códigos de recuperación se pierden al desmontar la pantalla** (ALTO).
5. **Un permiso revocado sigue concediéndose hasta 60 s** (MEDIO).
6. **Una cookie robada vacía el cupo y cierra las pantallas de rescate** (MEDIO).
7. **`COOKIE_SECURE=false` arranca limpio y apaga dos comprobaciones** (MEDIO).
8. **`VITEST=true` en producción apaga todo el correo y contesta que salió** (MEDIO).
9. **Cambiar el correo borra el factor antes de enviar e ignora el fallo** (MEDIO).
10. **`/auth/mfa/verify` acuña «equipo recordado» desde una sesión ya completa** (MEDIO).
11. **El panel entrega el registro completo de postes con solo `eventos.ver`** (MEDIO).
12. **Registrar una passkey muere en silencio en Safari** (MEDIO).
13. **`toleraFactorIlegible` no alcanza el caso para el que se escribió** (MEDIO).
14. **La línea `critical` afirma que se aceptó la contraseña antes de mirarla** (MEDIO).
15. **El código de correo sin `metodo` se prueba contra el TOTP y carga el bloqueo**
    (BAJO-MEDIO). ⚠️ El remedio obvio **quema el código vivo**
    ([`emailCodeStore.ts:219-220`](../../src/auth/emailCodeStore.ts)) y reabre el oráculo que
    el 4E cerró. Necesita su propio diseño.
16. **El administrador en `onboarding` no puede rescatar a nadie** (MEDIO): `mfa/reset` cuelga
    de `/api/usuario`, que ninguna lista abre. Ya está escrito en `scripts/rescue.ts:10-16`.
17. Varios bajos: recuento de códigos sin puerta, código gastado contra sesión revocada,
    dispositivos recordados sin tope de filas vivas, `.env` con el `JWT_SECRET` retirado.
