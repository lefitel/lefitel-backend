# Tanda previa al 4B — los ocho arreglos que van antes del primer factor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dejar el terreno en condiciones para el Plan 4B. Ocho arreglos, ninguno de
ellos funcionalidad nueva: siete son defectos medidos por la auditoría de cuatro agentes
del 2026-09-01 y el octavo es una capacidad que la puerta de step-up necesita tener
**antes** de que exista la primera ruta que registra un factor.

**Architecture:** no hay arquitectura nueva. Se toca lo que ya existe en cinco sitios —
el controlador de usuarios, el de correo, el presupuesto de correo, el núcleo de rescate
y la puerta de step-up— y en ningún caso se añade una tabla, una columna ni una
dependencia. Al terminar esta tanda el ERP se comporta exactamente igual que hoy salvo en
cuatro cosas visibles: no puedes archivarte a ti mismo, no puedes quitarte tu propio rol,
una sesión `parcial` ya no alcanza `logout-all`, y el contador de correo cuenta lo que
dice contar.

**Tech Stack:** TypeScript, Express 5, Sequelize 6, Postgres, Vitest. Ninguna dependencia
nueva.

**Spec:** [`docs/specs/2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md)
— §4 (step-up), §8 (vía de escape). Y sobre todo la auditoría que originó esta tanda:
`.superpowers/sdd/2026-09-01-plan-4b/auditoria-cuatro-agentes.md`, hallazgos A1, A2, A3,
A4, A7, C1 y C5.

---

## Por qué esto es una tanda propia y no el primer tercio del 4B

Decisión de Isaias, 2026-09-01. El motivo no es de gusto: **uno de los ocho es requisito
duro del 4B** (Task 7, la puerta que sabe exigir contraseña) y **dos más pasan a serlo por
otra decisión suya del mismo día** — exigir correo verificado antes de dejar registrar un
segundo factor. Con esa regla puesta, el camino del correo deja de ser un adorno y se
convierte en el único acceso al MFA: quien no consiga verificar su dirección no puede
registrar factor, y la mecha de catorce días sigue corriendo mientras tanto.

Así que las Tasks 3, 4 y 5 —que hoy son molestias— serían, el día del despliegue del 4B,
la diferencia entre poder configurar el segundo factor y no poder.

Y el commit sale aparte por la razón de siempre: mezclar arreglos de lo viejo con
funcionalidad nueva en un mismo rango hace la revisión más difícil y la marcha atrás
imposible de acotar.

---

## Lo que esta tanda NO hace

- **Ningún factor, ningún endpoint nuevo.** Eso es el 4B entero.
- **No toca `web`.** Ninguno de los ocho cambios tiene contrapartida visible en el
  cliente. El único que se le acerca es la Task 7, que añade una opción que **nadie usa
  todavía**.
- **No arregla los avisos por correo que no salen.** `MAIL_SECURITY_TO` sigue sin
  configurar, y eso es una decisión tomada (ver `docs/specs`, §8): la constancia real es
  la bitácora. Lo que sí se arregla aquí es que el contador **cuente** los avisos que sí
  salen, que es distinto.
- **No pone tiempo de espera a la llamada a Resend** (hallazgo A13). Está medido como
  PLAUSIBLE, no reproducido, y toca el camino de envío que las Tasks 4 y 5 ya reescriben.
  Va a la lista del 4B, no aquí, para no acumular dos cambios sin probar sobre el mismo
  código en la misma tanda.

---

## Global Constraints

Las mismas del Plan 4A, que siguen vigentes. Vinculan a todas las tareas.

- **Rama `isaias`.** Nunca `main` ni `development`.
- **Un commit por tarea**, con mensaje semántico —nunca «tarea N»— y ninguna tarea
  repartida entre dos commits. Los ficheros se añaden **por nombre**, nunca `git add -A`:
  hay otra sesión trabajando en el mismo árbol. Nunca `git commit --amend`.
- 🔴 **La comprobación de tipos es `npm run typecheck`, nunca `npx tsc --noEmit`.** El
  script del proyecto pasa `tsc` por `tsconfig.json` **y** por `tsconfig.test.json`; el
  comando suelto solo mira el primero. Durante seis tareas del 4A todo el mundo ejecutó el
  comando suelto e informó «tipos limpios» de forma veraz e incompleta, mientras se
  acumulaban 57 errores en los fixtures de test. Ninguna tarea se cierra sin que ese
  script salga limpio.
- **Los tests se rompen antes de darse por buenos**, y **en las dos direcciones**: romper
  la regla tiene que poner en rojo el test cuyo *nombre* es esa regla, y una
  reescritura equivalente tiene que dejarlo en verde. Un test que nunca se vio en rojo no
  ha demostrado nada, y uno que se pone rojo con cualquier cambio no demuestra la regla
  que dice demostrar.
- **Nada de `error.message` en respuestas nuevas.** Deuda declarada de la especificación
  (§11); no se amplía.
- **Código, comentarios y mensajes de commit en inglés.** Los mensajes dirigidos al
  usuario final, en español, como el resto de la API.
- 🔴 **Nada escribe en `osefi_local`.** Es una copia de producción con datos reales de
  personas reales. Ningún test toca la base; si un test necesita un modelo, lo espía. Ver
  el aviso del Plan 4B sobre el arnés de `app.auth.test.ts`, que espía una lista **fija**
  de métodos y ha dejado pasar escrituras reales antes.

---

## Decisiones tomadas al escribir el plan

Tres, y van aquí y no enterradas en una tarea porque quien ejecute el plan tiene que poder
discutirlas.

### 1. El step-up que deja pasar sin contraseña no se quita: se le añade un modo estricto

El hallazgo C1 dice que `requireStepUp` contradice la §4 de la especificación, y es
verdad: si la cuenta no tiene ningún factor y el cuerpo no trae `stepup_password`, la
puerta escribe una línea de bitácora y llama a `next()`.

**Pero quitar esa rama hoy es una caída.** El comentario que la justifica tiene razón:
ninguna pantalla de `web` manda `stepup_password` todavía —eso es el 4D—, así que una
puerta que lo exija sin excepción cierra la matriz de permisos, la creación de roles y el
cambio de contraseña para todo el mundo, a la vez, hoy.

Lo que sí es cierto es lo otro: **el día que exista `/auth/totp/setup`, esa rama es un
agujero de encierro permanente.** Quien tenga la cookie de sesión y no la contraseña
registra su propio factor, y desde ese instante `tieneAlgunFactor` responde `true` — así
que la puerta deja de ofrecerle a la víctima la vía de la contraseña, y la víctima no
puede ni borrar el factor del atacante. Su siguiente entrada abre en `parcial`, del que
solo se sale probando el factor del atacante. Cambiar la contraseña no sirve; `logout-all`
revoca sesiones, no credenciales.

**Decisión:** la Task 7 le da a `requireStepUp` una opción `exigeContrasena`, que **por
defecto es `false`** — comportamiento de hoy, cero rutas afectadas. El Plan 4B monta con
`exigeContrasena: true` todas las rutas que dan de alta un factor, y su plan lo dice por
escrito en la tarea que las monta. Esta tanda entrega la capacidad y su test; el 4B la usa.

Se hace aquí y no allí por una razón concreta: si la capacidad no existe cuando llega la
tarea que monta las rutas, se improvisa, y lo que se improvisa en una tarea de rutas es
una comprobación de contraseña hecha a mano dentro de un handler.

### 2. El presupuesto de correo se parte en dos: mirar es gratis, gastar cuesta

El hallazgo A3 dice que el contador cuenta peticiones y no correos, y propone moverlo
dentro de `enviarCorreo`. Correcto, y además es lo que **la cabecera del propio módulo ya
promete**: *«counting at the send site fixes both halves: a request that sends no mail
costs nothing, and a request that does send is measured against the real resource»*. El
módulo describe un diseño que no está construido.

El problema de moverlo tal cual: `/auth/email/send` **necesita decidir antes de acuñar el
token**, porque acuñarlo invalida el enlace que ya estuviera en el buzón de alguien. Si el
cobro vive en el envío, la decisión llega tarde.

**Decisión:** dos funciones. `hayPresupuestoDeCorreo()` **mira y no compromete nada** —
igual que `requireStepUp` ya hace con el cubo de confirmación, cuyo comentario explica por
qué `getKey` se pregunta y no se cobra. `consumirPresupuestoDeCorreo()` se llama **solo
desde `enviarCorreo`**, una vez por correo real. Los dos controladores dejan de cobrar y
pasan a mirar.

Efecto medible: `/auth/email/send` deja de costar 1 y mandar hasta 3; los tres avisos de
seguridad dejan de costar 0 y mandar 1 o 2.

### 3. `--unarchive` entra, aunque la Task 1 impida archivarse a uno mismo

Podría parecer redundante. No lo es: la Task 1 cierra el auto-disparo, pero **no cierra
que otra persona te archive**. El caso que queda vivo es el que importa — la última cuenta
con `seguridad.archivar` archivada por alguien que después pierde su propio acceso — y hoy
la única salida es `UPDATE usuarios SET "deletedAt" = NULL` a mano contra producción.

---

## File Structure

**Se crean:** ningún fichero de producción. Solo tests nuevos dentro de los ficheros de
test que ya existen.

**Se modifican:**

| Fichero | Qué cambia | Task |
|---|---|---|
| `src/controllers/usuario.controller.ts` | `deleteUsuario` y `updateUsuario` rechazan el propio id | 1 |
| `src/auth/rescueCore.ts` | Operación nueva: desarchivar | 2 |
| `src/scripts/rescue.ts` | Orden `--unarchive` | 2 |
| `src/controllers/email.controller.ts` | El presupuesto se mira antes de la transacción | 3 |
| `src/auth/mailBudget.ts` | Se parte en mirar y gastar | 4 |
| `src/auth/mailer.ts` | `enviarCorreo` cobra el presupuesto | 4 |
| `src/controllers/password.controller.ts` | Deja de cobrar; mira | 4 |
| `src/middleware/recoveryLimiters.ts` | `emailSendLimiter` devuelve los rechazos previos al envío | 5 |
| `src/auth/rescueCore.ts` | `proximaGraciaDeRescate` devuelve `null` sin reloj previo | 6 |
| `src/middleware/requireStepUp.ts` | Opción `exigeContrasena` | 7 |
| `src/auth/sessionState.ts` | `logout-all` sale de `PARCIAL` | 8 |

Y sus tests: `usuario.controller.test.ts`, `rescueCore.test.ts`, `rescue.test.ts`,
`email.controller.test.ts`, `mailBudget.test.ts`, `mailer.test.ts`,
`password.controller.test.ts`, `recoveryLimiters.test.ts`, `requireStepUp.test.ts`,
`sessionState.test.ts`, `routeGuards.test.ts`.

---

## Task 1: Nadie se archiva a sí mismo, ni se quita su propio rol

**Hallazgo A1.** `deleteUsuario` comprueba el permiso `seguridad.archivar` y nada más. No
mira si el `:id` de la ruta es el del que llama.

Archivarte revoca tus sesiones y tus dispositivos recordados, y `UsuarioModel` es
`paranoid`, así que el login deja de encontrarte. Las tres puertas de vuelta están
cerradas: `desarchivar` exige `seguridad.archivar` —el permiso que quizá acabas de dejar
sin titular—, el botón de rescate responde 409 «cuenta archivada», y la consola dice lo
mismo y no tiene ninguna orden para desarchivar. La salida real es SQL a mano.

Lo que delata que es un olvido y no una decisión: `rescatarMfaDeUsuario`, **treinta líneas
más abajo en el mismo fichero**, sí rechaza el auto-disparo, y con párrafo explicativo. La
ruta que borra la cuenta entera, no.

Hermano menor en el mismo fichero: `updateUsuario` no impide que te cambies tu propio
`id_rol` a uno sin permisos. `putPermisos` sí lo impide, así que el precedente correcto
también está en casa.

**Files:**
- Modify: `src/controllers/usuario.controller.ts`
- Test: `src/controllers/usuario.controller.test.ts`

**Interfaces:**
- Consumes: `req.user.id`, que `authenticate` ya deja puesto.
- Produces: dos 403 nuevos, con mensajes distintos entre sí.

- [ ] **Step 1: Escribir los tests en rojo**

Cuatro, y los nombres son la regla:

```
it("refuses to archive the caller's own account, even with the permission")
it("still archives somebody else's account")
it("refuses to change the caller's own role")
it("still changes somebody else's role")
```

Los dos negativos van primero. Un test que solo compruebe el caso prohibido pasa también
si el handler empieza rechazando a todo el mundo; los dos positivos son lo que impide que
el arreglo se pase de frenada.

- [ ] **Step 2: El rechazo, copiando el precedente de al lado**

En `deleteUsuario`, **después** de la comprobación de permiso y no antes, igual que
`rescatarMfaDeUsuario` treinta líneas más abajo. Quien no tiene permiso recibe el 403 de
permiso y no aprende nada más; quien lo tiene y apunta a sí mismo recibe el otro. Al revés
—el auto-disparo primero— quien no tuviera permiso podría distinguir por el mensaje si el
id que probó era el suyo, que es una fuga pequeña pero gratuita de evitar.

```ts
if (req.user && Number(id) === req.user.id) {
  return res.status(403).json({
    message: "No puede archivar su propia cuenta. Pídaselo a otro administrador.",
  });
}
```

Y en `updateUsuario`, la misma forma pero solo cuando el cuerpo trae un `id_rol`
**distinto** del que ya tiene: cambiar tu nombre o tu foto sigue siendo tuyo.

**Cuidado con el tipo.** `req.params.id` es una cadena y `req.user.id` un número. `Number(id)`
en ambos lados o la comparación es siempre falsa. `updateUsuario` recibe `id_rol` del
cuerpo, que también puede llegar como cadena desde un formulario.

- [ ] **Step 3: Romper el arreglo y ver los cuatro tests**

Quitar el `Number(...)` de un lado tiene que poner en rojo los dos tests negativos y dejar
verdes los dos positivos. Si un positivo también se rompe, el arreglo está rechazando de
más.

- [ ] **Step 4: `npm run typecheck` y la suite entera**

- [ ] **Step 5: Commit**

`fix(usuario): archiving and demoting yourself are the two doors with no way back`

---

## Task 2: La consola sabe desarchivar

**Hallazgo A1, segunda mitad.** Aunque la Task 1 cierre el auto-disparo, sigue vivo el
caso de que otra persona archive la última cuenta con `seguridad.archivar`. Hoy la salida
es tocar la base a mano.

**Files:**
- Modify: `src/auth/rescueCore.ts`, `src/scripts/rescue.ts`
- Test: `src/auth/rescueCore.test.ts`, `src/scripts/rescue.test.ts`

**Interfaces:**
- Produces: `desarchivarCuentaDeRescate(id_usuario: number, actor: ActorRescate)`, con la
  misma forma de retorno que sus cuatro hermanas, y la orden `--unarchive` en la consola.

- [ ] **Step 1: Leer la cabecera de `rescueCore.ts` entera antes de tocar nada**

Explica el orden obligatorio de las cuatro etapas —resolver, avisar, mutar dentro de una
transacción, registrar fuera de ella— y por qué cada una está donde está. La operación
nueva sigue ese mismo orden; no se inventa uno.

- [ ] **Step 2: Los tests en rojo**

```
it("clears deletedAt on an archived account")
it("refuses an account that is not archived, and says so")
it("writes the bitácora line before answering ok")
it("--unarchive rejects being combined with any other order")
```

El tercero es el que importa de verdad: la constancia es lo único que queda de un rescate,
y el resto del núcleo ya la escribe esperada y aborta si falla.

- [ ] **Step 3: La operación**

🔴 **`resolverCuentaDeRescate` devuelve `motivo: "archivada"` como un fallo.** Para esta
operación concreta, «archivada» es exactamente el caso que se busca. Hay que resolver la
cuenta **sin** ese rechazo — el resolvedor ya consulta con `paranoid: false` — y en cambio
rechazar la cuenta que **no** está archivada, con su propio mensaje.

Esto es lo más fácil de hacer mal de toda la tanda: copiar una de las cuatro operaciones
existentes arrastra su rechazo de archivadas y la orden nueva no funciona nunca.

- [ ] **Step 4: La orden en la consola**

`--unarchive` va sola: no se combina con `--reset-mfa` ni con nada. El script ya tiene
esa regla para `--set-email` y `--reset-mfa`; se extiende, no se reinventa.

Y la salida por pantalla sigue el tono del resto del fichero: quien la ejecuta a las ocho
de la mañana tiene que leer sobre quién actuó (el nombre resuelto, no el tecleado) y qué
tiene que contarle a la persona rescatada.

- [ ] **Step 5: Romper y verificar en las dos direcciones**

- [ ] **Step 6: `npm run typecheck`, la suite, y `npx eslint src`** (hay 3 errores ajenos
  preexistentes; no son tuyos y no se arreglan aquí)

- [ ] **Step 7: Commit**

`feat(rescue): the console can undo an archiving, which was the one door left to SQL`

---

## Task 3: El presupuesto se pide antes de destruir la dirección verificada

**Hallazgo A2.** En `sendVerificationEmail` el orden es:

1. `email.controller.ts:346-355` — transacción que pone `email_verified_at = NULL` y marca
   como usados todos los tokens pendientes de esa cuenta.
2. `:397` — se pide el presupuesto de correo, y **si no queda, se rinde ahí** con un 200 y
   la frase optimista de siempre.
3. `:405` — se acuña el token. Nunca se alcanza.

Resultado: pediste cambiar tu correo, perdiste el que tenías verificado, no recibiste
nada, y la respuesta dice que se envió el enlace.

El comentario que hay justo encima del cobro razona **solo sobre el token**: «before
minting, for the same reason `/password/forgot` asks first». Es correcto y está
incompleto — para cuando se pregunta, la dirección verificada ya se destruyó.

Con la decisión de Isaias de exigir correo verificado antes de registrar factor, esto pasa
de molestia a encierro: quien caiga aquí se queda sin poder registrar segundo factor hasta
que el presupuesto se rellene, con la mecha de catorce días corriendo.

**Files:**
- Modify: `src/controllers/email.controller.ts`
- Test: `src/controllers/email.controller.test.ts`

- [ ] **Step 1: El test en rojo**

```
it("leaves the verified address intact when there is no mail budget left")
```

Agotar el presupuesto, llamar, y comprobar que `UsuarioModel.update` **no** se llamó y que
`email_verified_at` sigue donde estaba. El test tiene que mirar la escritura, no solo la
respuesta: la respuesta es la misma en los dos casos a propósito (Constraint #1 de ese
fichero: la respuesta no se mueve por nada) y por eso no distingue nada.

- [ ] **Step 2: Mover la pregunta arriba, y que sea una pregunta**

La comprobación sube por delante de la transacción, y usa `hayPresupuestoDeCorreo()` —
mirar, no gastar (ver Decisión 2 y Task 4). Si la Task 4 aún no está hecha, esta tarea
usa el `consumir...` de hoy y la Task 4 la convierte; hacerlo al revés deja este fichero
cobrando dos veces durante una tarea.

**Orden recomendado: hacer la Task 4 antes que ésta.** Están escritas en este orden
porque A2 es el daño y A3 es la causa, pero al ejecutar conviene el otro.

- [ ] **Step 3: Romper y verificar**

- [ ] **Step 4: `npm run typecheck` y la suite**

- [ ] **Step 5: Commit**

`fix(email): asking for the budget after wiping the verified address is asking too late`

---

## Task 4: El presupuesto cuenta correos, no peticiones

**Hallazgo A3.** `consumirPresupuestoDeCorreo` se llama en dos sitios y los dos son
controladores, o sea **por petición**:

| Camino | Cuesta | Manda de verdad |
|---|---|---|
| `/auth/email/send` | 1 | hasta 3 |
| `/password/forgot` | 1 | 1 |
| `avisarPasswordRestablecida` | **0** | 2 |
| `avisarCorreoCambiado` | **0** | 1 |
| `avisarRescate` | **0** | 1 |

Con `MAIL_DAILY_BUDGET = 80` y el tope real de Resend en 100 al día, el contador puede ir
por 20 mientras Resend lleva 22. Y cuando Resend corta, `enviarCorreo` devuelve
`{ ok: false }`, que **de siete llamantes lo lee uno**. Los otros seis responden «se envió
el enlace» sin que se enviara nada.

**Files:**
- Modify: `src/auth/mailBudget.ts`, `src/auth/mailer.ts`,
  `src/controllers/email.controller.ts`, `src/controllers/password.controller.ts`
- Test: `src/auth/mailBudget.test.ts`, `src/auth/mailer.test.ts`, y los dos de controlador

- [ ] **Step 1: Los tests en rojo**

```
it("charges one unit per message sent, not per request")
it("charges the security notices, which used to be free")
it("hayPresupuestoDeCorreo does not spend anything")
it("stops sending once the ceiling is reached, and says so in the log")
```

El tercero es el que sostiene la Decisión 2: si `hay...` cobrara, `/auth/email/send`
gastaría una unidad por mirar y la Task 3 quedaría peor que antes.

- [ ] **Step 2: Partir el módulo**

```ts
export function hayPresupuestoDeCorreo(): boolean   // mira, no compromete nada
export function consumirPresupuestoDeCorreo(motivo: string): boolean  // cobra
```

Y `consumir...` pasa a llamarse **solo** desde `enviarCorreo`. La cabecera del módulo ya
describe este diseño; ahora hay que hacer que el código coincida con ella, y **corregir la
cabecera donde diga que ya es así**.

- [ ] **Step 3: `enviarCorreo` cobra, y lo dice**

Al entrar: si no queda presupuesto, no llama a Resend y devuelve `{ ok: false }` con una
línea de registro que distinga «se acabó el presupuesto» de «Resend falló». Hoy los dos
casos son el mismo `{ ok: false }` mudo.

🔴 **`mailer.ts` ya devuelve `{ ok: true }` sin enviar nada cuando faltan
`RESEND_API_KEY` o `MAIL_FROM`** — es el atajo de desarrollo, y está bien. Ese camino
**no debe cobrar presupuesto**: en desarrollo no hay cuota que gastar, y cobrar ahí haría
que la suite de tests agotara el contador entre ficheros.

- [ ] **Step 4: Los dos controladores dejan de cobrar**

`email.controller.ts:397` pasa a `hayPresupuestoDeCorreo()`. `password.controller.ts:187`
lo mismo. Ninguno de los dos vuelve a llamar a `consumir...`.

- [ ] **Step 5: Romper en las dos direcciones**

Volver a poner el cobro en un controlador tiene que poner en rojo el test que dice «una
unidad por mensaje». Y quitar el cobro de `enviarCorreo` tiene que poner en rojo el que
dice «cobra los avisos de seguridad».

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`fix(mail): the budget now counts at the send site, the way its own header says it does`

---

## Task 5: El cubo de `/auth/email/send` no cobra los rechazos previos al envío

**Hallazgo A7.** `/auth/email/send` está bajo dos cubos: `passwordConfirmLimiter` (5 cada
15 minutos, compartido con las quince rutas de step-up) y `emailSendLimiter` (5 por hora).
`emailSendLimiter` **no pone `requestWasSuccessful`**, así que cobra todas las peticiones,
respondan lo que respondan. Es deliberado y está por escrito en la cabecera del fichero, y
`recoveryLimiters.test.ts` lo demuestra volviendo a meter el reembolso y viendo el test de
agotamiento ponerse rojo.

Cinco erratas de tecleo en el móvil —dos direcciones mal escritas (400) y dos contraseñas
mal tecleadas (401)— agotan el cubo de la hora **sin haber mandado un solo correo**.

**Esto es cambiar una decisión tomada, no arreglar un descuido.** El motivo por el que se
cobra todo es correcto para `/password/forgot`, que es mudo: si se reembolsaran los
éxitos, el cubo revelaría cuáles de las direcciones probadas tienen cuenta. **`/auth/email/send`
no es mudo y no puede serlo**: exige haber iniciado sesión, y responde 400 a una dirección
con mala forma y 401 a una contraseña equivocada. Esos dos códigos hablan del **propio
tecleo de quien llama**, sobre su propia cuenta, y no revelan nada que no supiera ya.

**Files:**
- Modify: `src/middleware/recoveryLimiters.ts`
- Test: `src/middleware/recoveryLimiters.test.ts`

- [ ] **Step 1: Los tests en rojo**

```
it("refunds a malformed address and a wrong password on /email/send")
it("still charges a request that actually sent mail")
it("still charges everything on /password/forgot, which is mute")
```

El tercero es el que impide que el arreglo se derrame al cubo de al lado. Si se cae, el
arreglo tocó lo que no debía.

- [ ] **Step 2: El reembolso, acotado**

`requestWasSuccessful` **solo en `emailSendLimiter`**, devolviendo `true` (o sea, no
cobrar) para 400 y 401 y nada más. Un 200 sí se cobra, porque un 200 en esa ruta significa
o que se mandó o que el presupuesto se acabó, y los dos son consumo real de algo.

🔴 **No usar `costsNothing` de `loginLimiters.ts` tal cual.** Devuelve `true` para todo
`statusCode < 400`, que aquí es exactamente lo contrario de lo que hace falta.

- [ ] **Step 3: Actualizar la cabecera del fichero**

Las líneas 18-28 dicen que ni `passwordForgot*Limiter` ni `emailSendLimiter` ponen
`requestWasSuccessful`, «on purpose». Deja de ser verdad para uno de los dos. Un comentario
que miente sobre el código que tiene debajo es peor que ninguno.

- [ ] **Step 4: Romper y verificar en las dos direcciones**

- [ ] **Step 5: `npm run typecheck` y la suite**

- [ ] **Step 6: Commit**

`fix(limiters): five typos should not cost somebody an hour of email verification`

---

## Task 6: La gracia de rescate no inventa un reloj donde no lo había

**Hallazgo A4.** Una línea, y el agujero está justo en la rama que el comentario declara
segura:

```ts
export function proximaGraciaDeRescate(actual: Date | null, ahora: Date): Date {
  const candidata = new Date(ahora.getTime() + RESCUE_GRACE_HOURS * HORA_MS);
  if (actual === null) return candidata;   // ← aquí
  return actual.getTime() > candidata.getTime() ? actual : candidata;
}
```

Las nueve cuentas vivas tienen `mfa_grace_until` a NULL: nadie ha entrado todavía después
del despliegue del 4A, así que a nadie le ha empezado el reloj. Un rescate sobre cualquiera
de ellas le escribe un plazo de **24 horas** donde no había ninguno — y le quita los
catorce días que habría tenido en su primer login. Un segundo rescate no lo arregla, porque
`max(vencido, ahora+24h)` vuelve a dar 24 horas.

NULL aquí no significa «se le acabó el plazo». Significa «el reloj no ha empezado», que es
exactamente lo que `estadoEfectivo` ya razona sobre la misma columna: *«every account has
NULL in this column until its first login after the deploy»*. Dos funciones leen la misma
columna y solo una la entiende.

**Files:**
- Modify: `src/auth/rescueCore.ts`
- Test: `src/auth/rescueCore.test.ts`

**Interfaces:**
- El tipo de retorno pasa de `Date` a `Date | null`. `null` significa «no toques la
  columna», que es exactamente la convención que `graceUntil` en `factorInventory.ts` ya
  usa: *«a date means "write this into `usuarios.mfa_grace_until`", `null` means "leave
  that column alone"»*. Se reutiliza el mismo lenguaje, no se inventa otro.

- [ ] **Step 1: Los tests en rojo**

```
it("leaves an account that never had a clock without one")
it("still gives 24 hours to an account whose deadline already passed")
it("never shortens a deadline that is further away than 24 hours")
```

El segundo y el tercero son los que ya existen y **tienen que seguir verdes**: son la razón
por la que esta función es un `max` y no una asignación.

- [ ] **Step 2: La línea, y el llamante**

`if (actual === null) return null;`

Y en `restablecerSegundoFactor`, la escritura de la columna se salta cuando el valor es
`null`. Ojo: el `UPDATE` no debe escribir `NULL` — debe **no incluir la columna**. Escribir
NULL y no tocarla dan el mismo resultado sobre una fila que ya tenía NULL, pero no sobre
una que tuviera fecha, y esa diferencia es el tercer test.

- [ ] **Step 3: Corregir el comentario de idempotencia**

La cabecera de `restablecerSegundoFactor` dice que la operación es idempotente porque
«`proximaGraciaDeRescate` corrido dos veces dentro de la misma ventana devuelve el mismo
instante». Con el cambio sigue siendo verdad, pero por otro motivo. Reescribirla.

- [ ] **Step 4: Romper y verificar**

- [ ] **Step 5: `npm run typecheck` y la suite**

- [ ] **Step 6: Commit**

`fix(rescue): a rescue must not start a clock that had never started`

---

## Task 7: La puerta de step-up sabe exigir la contraseña

**Hallazgo C1**, y ver la Decisión 1 arriba para por qué esto es una capacidad y no la
retirada de la rama que hoy deja pasar.

**Files:**
- Modify: `src/middleware/requireStepUp.ts`
- Test: `src/middleware/requireStepUp.test.ts`

**Interfaces:**
- Produces: `requireStepUp({ exigeContrasena?: boolean })`, con `false` por defecto.
  Con `true`, una cuenta sin ningún factor que no mande `stepup_password` recibe **401**
  con el código que el cliente ya conoce, en vez de pasar.

- [ ] **Step 1: Los tests en rojo**

```
it("still lets a factor-less account through when the route does not demand a password")
it("refuses a factor-less account with no password when the route demands one")
it("accepts the right password on a route that demands one")
it("refuses the wrong password on a route that demands one, and charges the bucket")
```

El primero es el que protege a las quince rutas montadas hoy. Si se pone rojo, el valor
por defecto se cambió sin querer y el ERP se acaba de quedar sin matriz de permisos.

- [ ] **Step 2: La opción**

`requireStepUp` ya se invoca como función que devuelve middleware (`requireStepUp()`), así
que el parámetro entra sin tocar ningún sitio de montaje.

🔴 **El código de respuesta importa y no es 403.** El cliente distingue por el `code` de la
respuesta, no por el estado: el interceptor de `web` cierra sesión ante un 401 sin código
conocido. Hay que devolver **la misma forma que la puerta ya devuelve** cuando la
contraseña es incorrecta —mismo estado, mismo `code`—, o el primer usuario que caiga aquí
en el 4D se ve expulsado del ERP en vez de ver un cuadro pidiéndole la contraseña.
Comprobarlo leyendo `requireStepUp.ts` y el interceptor de `web`, no de memoria.

- [ ] **Step 3: Actualizar el comentario largo de la rama que deja pasar**

Dice que la rama «se cierra sola, sin nada que recordar», porque en cuanto la cuenta
registra un factor deja de alcanzarse. Es cierto y es justo el problema: **la ventana en
que se alcanza es la ventana en la que un atacante registra el factor**. Escribirlo ahí,
con la referencia a esta opción, para que quien lea el fichero dentro de seis meses no
vuelva a concluir que la rama es inofensiva.

- [ ] **Step 4: Romper y verificar en las dos direcciones**

Poner `true` como valor por defecto tiene que romper el primer test y **muchos otros de la
suite** — ese es el tamaño real del cambio que esta tarea deliberadamente no hace.

- [ ] **Step 5: `npm run typecheck` y la suite**

- [ ] **Step 6: Commit**

`feat(stepup): the gate can be told to demand the password, for the routes 4B will mount`

---

## Task 8: `logout-all` sale de lo que alcanza una sesión `parcial`

**Hallazgo C5.** `PARCIAL` en `src/auth/sessionState.ts:26-32` incluye
`/api/auth/logout-all`. Una sesión `parcial` es la de quien ha dado la contraseña
correcta y **todavía no ha probado su segundo factor**. `logoutAll` revoca las sesiones
**y los dispositivos recordados** del usuario que llama.

Quien tenga solo la contraseña de otra persona —filtrada, reutilizada, adivinada— puede
entrar en `parcial` y expulsarla de todos sus aparatos, en bucle. La ruta no tiene ningún
cubo propio, y por el hallazgo C3 un login con la contraseña correcta no cuesta nada en
ningún cubo, así que el bucle es gratis.

La víctima queda fuera de todas partes y sin ningún dispositivo recordado, así que cada
reentrada le exige la ceremonia completa. Eso es el paso previo clásico de una campaña de
fatiga o de un phishing en tiempo real.

**No hay ninguna razón para que esté ahí.** `logout` (cerrar *esta* sesión) sí: quien está
a medias tiene que poder abandonar. Cerrar las de todos los demás aparatos es una operación
de cuenta, y una sesión que no ha probado el factor no es la cuenta.

**Files:**
- Modify: `src/auth/sessionState.ts`
- Test: `src/auth/sessionState.test.ts`, `src/routes/routeGuards.test.ts`

- [ ] **Step 1: Los tests en rojo**

```
it("does not let a partial session reach logout-all")
it("still lets a partial session reach logout")
it("still lets a complete session reach logout-all")
```

- [ ] **Step 2: Quitar la línea, y comprobar qué más se rompe**

🔴 `onboarding` es `[...PARCIAL, ...ONBOARDING_EXTRA]`. Quitar la ruta de `PARCIAL` **se la
quita también a `onboarding`**, y eso sí es un problema distinto: quien está configurando
su factor sí es la cuenta y sí debería poder cerrar sus otras sesiones. Añadirla a
`ONBOARDING_EXTRA` para que el cambio neto afecte solo a `parcial`.

Este es el paso que se hace mal si se lee la lista deprisa.

- [ ] **Step 3: `routeGuards.test.ts`**

Ese fichero compara **cuatro listas por igualdad estricta**. Un cambio en las rutas
permitidas rompe entre una y tres. Es trabajo previsto, no efecto colateral.

- [ ] **Step 4: Romper y verificar en las dos direcciones**

- [ ] **Step 5: `npm run typecheck` y la suite**

- [ ] **Step 6: Commit**

`fix(session): a password alone should not be able to log somebody out of everywhere`

---

## Self-review

Antes de dar la tanda por cerrada:

- [ ] `npm run typecheck` limpio — el script, no `npx tsc --noEmit`.
- [ ] La suite entera de `api` en verde, con el mismo número de ficheros que al empezar
      más los que esta tanda añade. **Medir la línea base al empezar** y explicar cualquier
      diferencia.
- [ ] `npx eslint src` — 3 errores ajenos preexistentes, ni uno más.
- [ ] `git status` no muestra ningún fichero ajeno añadido al commit. Hay otra sesión en
      el mismo árbol; si un fichero mezcla trabajo de los dos, **se deja fuera y se dice**.
- [ ] Los ocho comentarios que esta tanda deja mintiendo, corregidos: la cabecera de
      `mailBudget.ts`, la de `recoveryLimiters.ts`, la de `restablecerSegundoFactor` y el
      párrafo largo de `requireStepUp`.

---

## Lo que esta tanda deja sin arreglar, a propósito

Para que el Plan 4B lo herede escrito y no lo descubra:

- **A5** — La ventana de diez minutos del step-up y el viaje de ida y vuelta de un correo
  chocan, y cada choque cuesta un código de recuperación. Es un problema de **ceremonia**,
  no de código suelto: la salida es que la pantalla ponga «añadir» antes que «quitar», y
  esa pantalla es del 4B.
- **A8** — `/api/auth/recovery-codes` está en `ONBOARDING_EXTRA` y no en `PARCIAL`, pero la
  §5 dice que un código de recuperación autoriza a regenerarlos. El 4B tiene que decidir
  cuál de las dos construye.
- **A9** — La consola se niega ante un nombre ambiguo y remite a resolver por id, y no hay
  `--id`. Hoy no está armado: cero nombres duplicados.
- **A10 / A11 / A13** — Del cliente y del envío de correo. Van al 4B, que es donde se toca
  ese código.
- **C3** — Un `/auth/mfa/verify` fallido tiene que incrementar `failed_attempts`. No se
  puede arreglar aquí: ese endpoint no existe todavía.
- **El `JWT_SECRET` de producción.** No es código: es una variable de entorno en Coolify
  que **solo Isaias puede rotar**, y lleva pendiente desde el 2026-08-24. Producción acepta
  hoy tokens firmados con una palabra de diccionario que está en el historial de git.
