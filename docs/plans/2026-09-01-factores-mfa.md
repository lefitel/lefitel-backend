# Plan 4B — El segundo factor, de verdad

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que una persona pueda dar de alta un segundo factor, probarlo al entrar, y
recuperarse si pierde el aparato. Al terminar el 4B el ERP tiene TOTP, códigos de
recuperación y «recordar este equipo», y el esqueleto que el 4A dejó montado deja de estar
vacío.

**Architecture:** un llavero de claves que cifra y descifra el secreto del TOTP; un
almacén para ese secreto; siete endpoints nuevos bajo `/auth`; un promotor que asciende la
sesión cuando el factor queda confirmado; y la pantalla del cliente que enseña todo eso.
Las cuatro tablas ya existen desde el 4A: solo hace falta **una** migración, para el
índice que impide que verificar un código de recuperación deje el servidor parado.

**Tech Stack:** TypeScript, Express 5, Sequelize 6 con Umzug, Postgres, Vitest.
Dependencias nuevas: **una** — la librería de TOTP. `@simplewebauthn/*` es del 4C.

**Spec:** [`docs/specs/2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md)
§3, §4, §5, §6, §9 y §11. 🔴 **Esa especificación está desactualizada en veinte sitios** —
el barrido está en `.superpowers/sdd/2026-09-01-plan-4b/auditoria-cuatro-agentes.md` §D7.
Donde este plan y la especificación se contradigan, **manda este plan**, y el motivo está
escrito.

**Auditoría de origen:** `.superpowers/sdd/2026-09-01-plan-4b/auditoria-cuatro-agentes.md`
— cuatro agentes adversariales sobre HEAD `7f3d3e6`, unos 45 hallazgos. Cada tarea de este
plan cita los suyos por su código (A1, B5, C13…). **Quien ejecute una tarea lee sus
hallazgos antes de escribir la primera línea.**

---

## 🔴 Requisito de entrada: la tanda de defectos, entera

[`docs/plans/2026-09-01-defectos-previos-al-4b.md`](./2026-09-01-defectos-previos-al-4b.md)
va **antes** que este plan, completa y con su commit. No es una recomendación:

- Su **Task 7** entrega `requireStepUp({ exigeContrasena: true })`, y las Tasks 6, 8 y 10
  de este plan montan rutas que **no se pueden montar sin ella**. Montarlas con la puerta
  de hoy abre un encierro permanente: quien tenga una cookie de sesión robada y no la
  contraseña registra su propio factor, y desde ese instante la víctima no puede ni
  borrarlo.
- Sus **Tasks 3, 4 y 5** arreglan el camino del correo, y la decisión de exigir correo
  verificado antes de registrar factor (ver Decisión 5) convierte ese camino en el único
  acceso al MFA.
- Su **Task 6** impide que un rescate escriba un plazo de 24 horas sobre una cuenta que no
  tenía reloj — las nueve cuentas vivas están en ese caso.

---

## Lo que el 4B NO hace

- **Passkeys.** Enteras al 4C, por decisión de Isaias del 2026-09-01. El motivo técnico:
  un TOTP confirmado ya apaga la mecha de catorce días por sí solo (`tieneAlgunFactor`
  cuenta passkeys y TOTP confirmado), así que las passkeys no desbloquean nada que el TOTP
  no desbloquee. Y las dos columnas del reto de WebAuthn **no existen** —el 4A las aplazó a
  propósito—, así que sacarlas del 4B es lo que deja este plan con una sola migración.
- **El login sin contraseña.** Es passkeys. Al 4C.
- **Rotar `JWT_SECRET` en producción.** No es código. Es una variable de entorno en Coolify
  que solo Isaias puede cambiar, pendiente desde el 2026-08-24.
- **Desplegar.** 🔴 **Nada de este arco está en producción**, y el 4A y el 4B salen juntos
  (decisión de Isaias, 2026-09-01). Ver «El día del despliegue» al final: son siete
  bloques de cambio a la vez, no dos.

---

## Global Constraints

Las del Plan 4A, que siguen vigentes, más cuatro propias de este.

- **Rama `isaias`.** Nunca `main` ni `development`.
- **Un commit por tarea**, con mensaje semántico —nunca «tarea N»— y ninguna tarea
  repartida entre dos commits. Ficheros **por nombre**, nunca `git add -A`: hay otra sesión
  en el mismo árbol. Nunca `git commit --amend`.
- 🔴 **La comprobación de tipos es `npm run typecheck`, nunca `npx tsc --noEmit`.**
- **Los tests se rompen antes de darse por buenos, y en las dos direcciones.** Romper la
  regla pone en rojo el test cuyo *nombre* es esa regla; una reescritura equivalente lo
  deja verde.
- **Toda migración va dentro de una transacción y abre con `SET LOCAL lock_timeout = '5s'`.**
- **`TIMESTAMPTZ`, nunca `TIMESTAMP`.**
- **Nada de `error.message` en respuestas nuevas.**
- **Código, comentarios y commits en inglés.** Mensajes al usuario final en español.

Y las cuatro nuevas:

- 🔴 **Nada del 4B viaja por la cadena de consulta de una URL.** `httpLogger` serializa la
  petición **sin cuerpo**, pero registra `originalUrl` **con su query y sin redactar**
  (hallazgo B11). Un secreto, un código o un `otpauth://` en la query queda escrito en el
  registro. Todo por cuerpo, siempre.
- 🔴 **Ningún test escribe en la base.** `app.auth.test.ts` espía una lista **fija** de
  métodos, y de los modelos de factores solo espía `count` — no `create`, `destroy`,
  `bulkCreate` ni `findAll` (hallazgo D4). **El 4B es el primer plan cuyos tests escriben
  ahí.** La Task 15 amplía el arnés y **va antes del primer test de endpoint**. Precedente:
  un `increment` sin espiar disparó cinco `UPDATE` reales contra `osefi_local`, que es una
  copia de producción con datos de nueve personas reales.
- 🔴 **El `WHERE` de cada consulta nueva lleva `id_usuario`, tomado de la sesión y nunca
  del cuerpo.** El precedente correcto es `revokeSessionOf`. La tabla completa de qué
  `WHERE` lleva cada endpoint y qué pasa si falta está en el hallazgo C15; **está copiada
  en cada tarea que la necesita**, pero conviene leer el original.
- **La respuesta de un fallo criptográfico no distingue causas.** Código mal tecleado, fila
  corrupta y clave equivocada responden exactamente lo mismo (hallazgo B12). Ojo:
  `errorShape.test.ts` prohíbe filtrar `error.message` **solo en los 500**, así que un
  handler que conteste 401 con el mensaje de GCM pasa el test y filtra igual.

---

## Decisiones tomadas al escribir el plan

Ocho. Las cinco primeras las tomó Isaias el 2026-09-01 y no se rediscuten; las tres
últimas las tomé yo al escribir y **sí** se pueden discutir.

### 1. La clave se comprueba descifrando una fila real, no con una huella

La especificación (§9) quiere una huella de la clave guardada «junto a los datos». No hay
sitio donde ponerla: el inventario de la auditoría recorrió las 24 tablas y **no hay tabla
de configuración ni singleton**.

Y aunque lo hubiera, `HMAC(clave, constante)` detecta «la clave cambió», **no** «la clave
abre estos datos». El falso OK que importa: restaurar una copia vieja de `factor_totp`
sobre la base actual deja la huella cuadrando y todos los secretos ilegibles — literalmente
el fallo que la huella existe para evitar. Además el primer arranque es indistinguible de
«alguien borró la huella»: «si no hay, escríbela» permite desarmarla borrando una fila, y
«si no hay, no arranques» impide el primer despliegue.

**Se descifra la primera fila real.** Prueba lo que importa, elimina el problema del primer
arranque (sin filas no hay nada que proteger) y no necesita tabla.

### 2. Una clave equivocada corta el TOTP, no el ERP

Negarse a arrancar deja sin ERP a las nueve personas por una errata en una variable,
incluidas las que no tienen ningún factor. Y tiene un efecto de segundo orden: quien está
apagando el fuego a las ocho de la mañana tiene delante un servidor que no levanta y una
comprobación que se lo impide; el reflejo es quitar la comprobación, y una vez quitada no
vuelve.

**Las rutas `/auth/totp/*` responden 503; el resto del ERP sigue en pie**, con una línea
`fatal` en el registro. Los códigos de recuperación y la gracia siguen funcionando, que es
justo lo que hace falta mientras se arregla.

### 3. La rotación se construye entera, con llavero de verdad

Decisión de Isaias contra mi recomendación, y la construimos completa porque **la única
opción que pierde datos es dejarla a medias**: `key_version` existe en el esquema desde el
4A y hoy nada la controla, así que un script improvisado que muera a mitad deja filas con
la clave vieja que ya nadie puede leer.

Forma del llavero: `MFA_ENCRYPTION_KEY_1`, `MFA_ENCRYPTION_KEY_2`, … y
`MFA_ENCRYPTION_KEY_ACTIVE` con el número de la que cifra. Descifrar usa la que diga
`key_version` de la fila; cifrar usa siempre la activa. La Task 3 construye el comando que
reescribe las filas, y **tiene que poder morirse a mitad y retomarse sin perder nada** —
por eso reescribe fila a fila con su propia transacción, no todas en una.

### 4. «Recordar este dispositivo» se construye, sin sus dos agujeros

Decisión de Isaias. La comodidad se construye; las dos cosas que la especificación le
cuelga encima, no, porque no son parte de la comodidad:

- **§6 exime del bloqueo por cuenta a un login con cookie de dispositivo.** El problema que
  evitaba ya está resuelto: `LOCKOUT_MAX_MINUTES = 15`, así que «bloquear al jefe» dura un
  cuarto de hora. Lo que abre es peor: `estaBloqueada` es la única defensa **durable**
  contra adivinar la contraseña, y quien tenga la cookie —el portátil robado— obtiene
  intentos ilimitados, y al acertar **esa misma cookie le salta el factor**. La exención
  **no se construye** (hallazgo C4).
- **`mfa_source = 'dispositivo'` hace que `estadoEfectivo` dé la sesión por probada
  permanentemente**, treinta días, sin ventana. Y esa premisa deja de valer en cuanto la
  cuenta pierde su último factor. La Task 13 lo arregla (hallazgo C8).

Si Isaias quiere alguna de las dos, se añade; no van por omisión.

### 5. El correo verificado se exige desde el primer día

Decisión de Isaias, contra la recomendación de la auditoría. Consecuencia que hay que tener
escrita y decirle en voz alta el día del despliegue: **hoy 0 de 9 cuentas tienen correo
verificado**, así que el día del despliegue las nueve personas tienen que verificar su
dirección **antes** de poder registrar factor, con la mecha de catorce días corriendo.

Eso ata el arranque del MFA a Resend, al DNS y a que nueve personas recuerden la contraseña
de su Gmail. Por eso las Tasks 3, 4 y 5 de la tanda previa son requisito de entrada, y por
eso `/auth/email/send` tiene que estar abierto en estado `onboarding` — lo está, vía
`ONBOARDING_EXTRA`.

### 6. El AAD se ata a `factor_totp.id`, no a `id_usuario`

Mía. La especificación no dice cuál, y el evidente es el equivocado.

`factor_totp_id_usuario_fkey` es `ON UPDATE CASCADE` (verificado). Un
`UPDATE usuarios SET id = ...` —que es el arreglo que se hace al fusionar dos cuentas
duplicadas, y la §3 admite que `createUsuario` todavía no comprueba colisión— cascadea a la
tabla de factores, y a partir de ahí el AAD del descifrado ya no es el del cifrado.
**Secreto irrecuperable, sin ningún aviso.** `factor_totp.id` no cascadea (hallazgo B3).

### 7. Los códigos de recuperación entran en este arco, agrupados detrás del TOTP

Mía, después de que Isaias señalara —con razón— que el argumento del «hueco entre
despliegues» que yo usaba es falso: nada sale a producción hasta que todo está terminado,
así que no hay hueco. Lo que queda es tamaño y orden, no riesgo.

Van en el Grupo 3, detrás del núcleo del TOTP del que dependen conceptualmente, y **antes**
del cliente que los enseña. No se aplazan más allá del despliegue.

### 8. `/auth/totp/confirm` asciende la sesión, y eso merece una tarea propia

Mía, y es el hallazgo que más cerca estuvo de colarse (D2). `estadoEfectivo` abre con:

```ts
const guardado = sesion.estado;
if (guardado !== "completa") return guardado;
```

**Solo estrecha.** Una sesión guardada como `onboarding` **sigue siendo `onboarding`
después de registrar el factor**. El técnico del día 15 escanea el QR, teclea el código, y
el ERP le sigue diciendo que no. No está en la §4, ni en la §5, ni en los deberes del 4A.

Es la Task 5, es MEDIANA, y **sin ella nada de lo demás sirve**.

---

## 🔴 Un fichero de rutas por tarea, y el montaje al final

Decidido al ejecutar. El plan nombraba **un solo** `src/routes/mfa.routes.ts` para las Tasks
6, 7, 10 y 12. Con varias tareas en marcha a la vez eso es un choque garantizado, y con
tareas en serie es un fichero que cambia cuatro veces por motivos distintos.

**Cada tarea crea su propio fichero de rutas y su propio controlador** — `totp.routes.ts`,
`mfa.routes.ts`, `recoveryCodes.routes.ts` — y **nadie toca `src/app.ts`**. El montaje lo
hace una pasada final, cuando todos existen, que es además el único momento en que se puede
comprobar de una vez que las cuatro listas de `routeGuards.test.ts` cuadran con lo que hay
montado de verdad.

Efecto lateral bueno: cada fichero de rutas se lee entero sin tener que separar mentalmente
qué endpoint pertenece a qué mitad del plan.

## Orden, tamaño y camino crítico

**22 tareas.** Con el desvío real medido en el 4A —11 planeadas, 15 entregadas, +36%—
**presupuestar 30**. Una tarea de esta casa son 300-600 inserciones con tests.

| Grupo | Tareas | Depende de |
|---|---|---|
| 1 · El cifrado | 1-3 | nada |
| 2 · El núcleo del TOTP | 4-8 | Task 1 (salvo la 5, que no) |
| 3 · Los códigos | 9-11 | nada del cifrado; van con bcrypt |
| 4 · Recordar el equipo | 12-13 | nada del cifrado |
| 5 · Lo que sostiene | 14-17 | Task 15 va **antes** del primer test de endpoint |
| 6 · El cliente | 18-22 | los endpoints de los grupos 2 y 3 |

**Camino crítico: 1 → 4 → 6 → 18.** Todo lo demás cabe al lado. Los grupos 3 y 4 **no
dependen del cifrado** y pueden ir en paralelo al 2 contra la interfaz de «verificador de
factor» que define la Task 7.

🔴 **La Task 15 (el arnés de tests) va antes que el primer test que llame a un endpoint.**
Es lo único que impide que la suite escriba en `osefi_local`.

---

## File Structure

**Se crean:**

| Fichero | Responsabilidad | Task |
|---|---|---|
| `src/auth/mfaKeyring.ts` | El llavero: qué claves hay, cuál cifra, cuál abre cada fila | 1 |
| `src/auth/mfaCrypto.ts` | Cifrar y descifrar autenticado con AES-256-GCM | 1 |
| `src/auth/mfaKeyCheck.ts` | La comprobación de arranque y el interruptor del 503 | 2 |
| `src/scripts/rotateMfaKey.ts` | El comando que reescribe las filas con la clave nueva | 3 |
| `src/auth/totpStore.ts` | Leer, escribir y verificar el factor TOTP | 4 |
| `src/auth/sessionPromotion.ts` | Ascender la sesión actual cuando queda probada | 5 |
| `src/controllers/totp.controller.ts` | `setup`, `confirm`, `delete` | 6, 8 |
| `src/controllers/mfa.controller.ts` | `verify` | 7 |
| `src/migrations/20260902000001-recovery-code-prefix.ts` | El índice de prefijo | 9 |
| `src/auth/recoveryCodeStore.ts` | Generar, listar y gastar códigos | 9-11 |
| `src/controllers/recoveryCodes.controller.ts` | Los dos endpoints de códigos | 10 |
| `src/auth/rememberedDeviceIssue.ts` | Acuñar y comprobar la cookie de equipo | 12 |
| `src/routes/mfa.routes.ts` | Montaje de todo lo anterior | 6, 7, 10, 12 |

**Se modifican** (los principales): `src/config/security.ts`, `src/index.ts`,
`src/app.ts`, `src/auth/sessionState.ts`, `src/auth/factorInventory.ts`,
`src/models/factorTotp.model.ts`, `src/models/codigoRecuperacion.model.ts`,
`src/models/dispositivoRecordado.model.ts`, `src/models/credencialWebauthn.model.ts`,
`src/controllers/auth.controller.ts`, `src/middleware/requireStepUp.ts`,
`src/routes/routeGuards.test.ts`, `src/auth/purgeJob.ts`, `src/utils/logger.ts`.

En `web`: `src/api/Login.api.ts`, `src/context/SesionProvider.tsx`,
`src/pages/login/LoginPage.tsx`, `src/pages/perfil/`, y un árbol nuevo para el paso del
segundo factor.

---

# Grupo 1 — El cifrado

Sin esto no hay TOTP. Y hecho mal, el TOTP parece funcionar y no protege nada: es el único
grupo del plan donde **un test de ida y vuelta pasa con el código roto**.

---

## Task 1: El llavero y el cifrado autenticado

**Hallazgos B1, B2, B3, B5.** Los cuatro son 🔴 y los cuatro se demostraron ejecutando
código, no leyéndolo.

**Files:**
- Create: `src/auth/mfaKeyring.ts`, `src/auth/mfaCrypto.ts` y sus tests
- Modify: `src/config/security.ts` (las constantes y `requiredEnv`)

**Interfaces:**
- Produces:
  ```ts
  // mfaKeyring.ts
  interface Llave { version: number; clave: Buffer }
  function llaveActiva(): Llave                    // la que cifra
  function llavePorVersion(version: number): Llave // la que abre una fila concreta
  function versionesDisponibles(): number[]

  // mfaCrypto.ts
  interface Cifrado { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number }
  function cifrar(texto: string, aad: string): Cifrado
  function descifrar(c: Cifrado, aad: string): string   // lanza si no autentica
  ```
- Consumes: nada. Es la base del grupo.

- [ ] **Step 1: Los cuatro tests que tienen que existir, en rojo**

Estos cuatro no son «cobertura». Cada uno cierra un fallo que la auditoría reprodujo:

```ts
it("throws when the tag has been tampered with")
// 🔴 B1, demostrado ejecutando: `decipher.update()` DEVUELVE EL TEXTO CLARO
// CORRECTO con un tag deliberadamente falso. Solo `final()` lanza. Un
// `descifrar` escrito como `return decipher.update(ct)` pasa todos los tests de
// ida y vuelta y NO AUTENTICA NADA: el tag y el AAD dejan de proteger.
// Es el único fallo de esta lista que un test de ida y vuelta no caza.

it("throws when decrypting with another row's AAD")
// B3. Cifrar con el AAD de la fila 7 y descifrar con el de la 8 tiene que
// lanzar. Si no lanza, el AAD no está llegando a `setAAD`.

it("uses a different IV for two encryptions of the same text")
// 🔴 B5, demostrado: dos cifrados con el mismo (clave, IV) revelan el XOR de
// los textos y permiten recuperar la subclave GHASH, con la que se FORJAN tags
// válidos, incluido para el AAD de otro usuario. No es degradación: es rotura.
// `cifrar()` genera `randomBytes(12)` en CADA llamada, sin excepción.

it("rejects a 65-character hex key")
// 🔴 B2, medido: `Buffer.from(x, 'hex')` TRUNCA en silencio.
//   64 hex válidos → 32 bytes ✔      63 hex + 'g' → 31
//   'g' + 63 hex   → 0 bytes         65 hex        → 32 ← pasa siendo errata
//   '0x' + 64 hex  → 0 bytes
// Validar por longitud del buffer NO BASTA. Regla: /^[0-9a-fA-F]{64}$/ Y 32 bytes.
```

- [ ] **Step 2: El llavero**

Lee `MFA_ENCRYPTION_KEY_1`, `_2`, … y `MFA_ENCRYPTION_KEY_ACTIVE`. Reglas:

- Cada clave pasa **las dos** validaciones del test 4: el patrón y la longitud del buffer.
- Si `_ACTIVE` apunta a una versión que no existe, es un error de configuración y se dice
  con su nombre — no se cae en la clave 1 «por si acaso».
- Con un llavero de una sola clave, todo esto se comporta exactamente como si no hubiera
  llavero. Es el caso normal y el que hay que tener suave.
- 🔴 **Solo `MFA_ENCRYPTION_KEY_ACTIVE` entra en `requiredEnv`. Nunca una versión concreta.**
  Corregido al ejecutar: pedir `MFA_ENCRYPTION_KEY_1` —que es lo que este plan decía y lo que
  parece lo seguro— **contradice el procedimiento de rotación de la Task 3**, cuyo último paso
  borra exactamente esa variable. Una rotación hecha bien dejaría el siguiente arranque de
  producción rechazado, teniendo todas las claves que de verdad hacen falta.

  Y esta lista no puede nombrar la correcta, porque decidir el **nombre** de una variable a
  partir del **valor** de otra no cabe en una función cuyo contrato es «una lista de nombres,
  dado `nodeEnv`». El reparto es el mismo que `COOKIE_NAME` ya usa: la lista prueba que la
  variable **está puesta**, y `index.ts` comprueba el **valor** por separado. Hay un test de
  regresión (`index.boot.test.ts`) que recorre las versiones 1, 2 y 3 y exige que ninguna
  aparezca en la lista.
- 🔴 **Ni una clave, ni parte de una, en ningún registro ni en ningún mensaje de error.**
  `REDACT_PATHS` no cubre nada del 4B (hallazgo B11); la Task 14 lo amplía, pero lo que no
  se escribe no hace falta redactarlo.

- [ ] **Step 3: Cifrar y descifrar**

AES-256-GCM, IV de 12 bytes nuevo en cada llamada, tag de 16. Las dos restricciones
`CHECK` de longitud ya están en la base desde el 4A (`factor_totp_iv_len_chk`,
`factor_totp_tag_len_chk`), así que una escritura mal formada rebota en Postgres.

🔴 **`descifrar` tiene que llamar a `final()` y devolver la concatenación**, nunca solo
`update()`. Escribirlo en el comentario de la función, no solo confiar en el test: el
siguiente que optimice esa línea tiene que encontrarse el motivo escrito ahí mismo.

- [ ] **Step 4: La regla de escritura de las tres columnas**

`ciphertext`, `iv` y `auth_tag` son tres columnas separadas, así que un `UPDATE` que toque
dos y no la tercera es legal para Postgres y catastrófico para GCM. **Regla que se escribe
en el comentario del módulo y que la Task 4 hace cumplir: toda escritura escribe las cuatro
columnas —las tres más `key_version`— en la misma sentencia.** No hay ningún camino que
re-cifre reutilizando el IV guardado.

- [ ] **Step 5: Romper en las dos direcciones**

Cambiar `descifrar` para que devuelva solo `update()` **tiene que** poner en rojo el primer
test y **dejar verdes** los de ida y vuelta. Si el primero sigue verde, el test no está
comprobando lo que dice.

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`feat(mfa): authenticated encryption for the TOTP secret, with a keyring`

---

## Task 2: La comprobación al arrancar, y los sitios donde no puede vivir

**Hallazgos A6, B8, B9.** Ver Decisiones 1 y 2.

**Files:**
- Create: `src/auth/mfaKeyCheck.ts` y su test
- Modify: `src/index.ts`, y el montaje de las rutas TOTP

**Interfaces:**
- Produces: `comprobarLlaveAlArrancar(): Promise<ResultadoComprobacion>` y un interruptor
  que las rutas `/auth/totp/*` consultan para responder 503.

- [ ] **Step 1: Los tests en rojo**

```
it("passes when the first row decrypts")
it("fails when the first row does not decrypt, and says which key version it tried")
it("passes when there are no rows at all")
it("does not import anything that src/scripts/rescue.ts imports")
```

El tercero es el primer despliegue: sin filas no hay nada que proteger y arrancar es
correcto. El cuarto es el importante y se explica abajo.

- [ ] **Step 2: 🔴 Dónde vive, y el test que lo vigila**

Cadena de imports verificada por la auditoría:
`scripts/rescue.ts` → `config/security.ts`, y `rescueCore.ts` → `config/security.ts`.

**`config/security.ts` es el sitio natural donde cualquiera pondría la carga de la clave.**
Si esta comprobación acaba ahí, o en cualquier módulo que `scripts/rescue.ts` alcance por
imports, **una clave equivocada mata también el único remedio para una clave equivocada**:
el comando de rescate deja de arrancar.

La comprobación se invoca desde `src/index.ts` y **de ningún otro sitio**. El cuarto test
recorre el grafo de imports de `src/scripts/rescue.ts` y comprueba que `mfaKeyCheck.ts` no
aparece. No es paranoia: es la única forma de que ese error, si alguien lo comete dentro de
seis meses, salga en rojo en vez de descubrirse el día que haga falta el rescate.

- [ ] **Step 3: El 503, acotado a `/auth/totp/*`**

Cuando la comprobación falla, el proceso **arranca igual** y escribe una línea `fatal` con
qué versión de clave intentó y sobre qué fila. Las rutas `/auth/totp/*` responden 503 con
un mensaje en español que no culpa al usuario. Todo lo demás —login, códigos de
recuperación, gracia, las 25 pantallas— sigue funcionando.

El interruptor es un valor del módulo, no una consulta por petición: la comprobación se
hace una vez, al arrancar.

- [ ] **Step 4: 🔴 Comprobar la llave también cuando NO hay filas**

Se descubrió al arreglar `requiredEnv` (Task 1). El reparto que quedó es: la lista prueba que
`MFA_ENCRYPTION_KEY_ACTIVE` **está puesta**, y **este arranque** comprueba que **vale**. Si
esta comprobación solo mira cuando hay filas, un despliegue sin ninguna clave puesta —o con el
puntero apuntando a una versión que no existe— arranca contento y nadie se entera hasta que la
primera persona intenta registrar su factor.

Así que son dos cosas, en este orden:

1. **`llaveActiva()` resuelve**, siempre, haya filas o no. El llavero ya lanza con un error
   con nombre si el puntero apunta a una versión ausente o mal formada.
2. **Si además hay filas, se descifra la primera.** Sin filas no hay nada que probar y arrancar
   es correcto — es el primer despliegue.

- [ ] **Step 5: Qué fila se elige**

La primera por `id`, con `confirmed_at IS NOT NULL`. Una fila sin confirmar puede ser un
`setup` a medias que nadie va a usar; una confirmada es un secreto que alguien está usando
de verdad, que es lo que la comprobación quiere probar.

- [ ] **Step 6: Romper y verificar en las dos direcciones**

- [ ] **Step 7: `npm run typecheck` y la suite**

- [ ] **Step 8: Commit**

`feat(mfa): the boot check decrypts a real row, and lives where the rescue cannot reach`

---

## Task 3: El comando que rota la clave

**Hallazgo B4** y Decisión 3.

**Files:**
- Create: `src/scripts/rotateMfaKey.ts` y su test
- Modify: `package.json` (dos comandos)

**Interfaces:**
- Produces: `npm run auth:rotate-mfa-key` (desarrollo, `tsx`) y
  `auth:rotate-mfa-key:deploy` (contenedor, `node dist/...`).

- [ ] **Step 1: Los tests en rojo**

```
it("re-encrypts every row that is not already on the active version")
it("skips the rows that are already on the active version")
it("can be run twice in a row and the second run does nothing")
it("leaves the rows it already converted converted when it dies half way")
it("refuses to start when the active key is not in the keyring")
it("does not run when the module is merely imported")
```

El cuarto es el que justifica la tarea: es exactamente el fallo que hace que dejar la
rotación a medias pierda datos.

- [ ] **Step 2: 🔴 Fila a fila, cada una con su transacción**

No todas en una. Una transacción única sobre 15-60 filas parece más limpia y es peor: si el
proceso muere, o se deshace todo (y no has avanzado) o —peor, si alguien la escribe con
autocommit sin darse cuenta— queda a medias sin saber por dónde iba. Fila a fila con su
propia transacción es **retomable**: el criterio de «qué falta» es
`WHERE key_version <> :activa`, que se responde solo.

Cada fila: leer, descifrar con `llavePorVersion(fila.key_version)`, cifrar con la activa
(IV nuevo, ver Task 1 Step 4), escribir **las cuatro columnas en la misma sentencia**.

- [ ] **Step 3: Las dos cosas de `migrate.ts` que hay que copiar**

Exactamente igual que en `src/scripts/rescue.ts`, y por los mismos dos motivos medidos:

1. **La guardia de ejecución directa:** `import.meta.url === pathToFileURL(process.argv[1]).href`.
   Sin ella, **importar el módulo desde un test rota las claves de verdad**.
2. **`await sequelize.close()` al terminar.** Sin eso el pool mantiene el proceso vivo y la
   consola del contenedor se queda colgada.

Y el motivo de los dos comandos: **`tsx` es dependencia de desarrollo y no viaja a la
imagen.** Cualquier variante `tsx src/...` es inejecutable en producción.

- [ ] **Step 4: La salida por pantalla**

Cuántas filas hay, cuántas faltan, y al terminar cuántas quedaron. Si murió a mitad, la
siguiente ejecución dice cuántas encontró ya convertidas — eso es lo que le dice a quien
está delante que retomar es seguro.

- [ ] **Step 5: Documentar el procedimiento de rotación**

En `docs/specs/2026-08-21-autenticacion-mfa-design.md` §9, sustituyendo lo que hoy dice de
la huella. Los pasos, en orden: añadir `MFA_ENCRYPTION_KEY_2` **sin** tocar `_ACTIVE` →
desplegar → cambiar `_ACTIVE=2` → desplegar → correr el comando → comprobar que ninguna
fila queda en la versión 1 → quitar `MFA_ENCRYPTION_KEY_1` → desplegar.

🔴 **Quitar la clave vieja antes de que el comando termine es el error que pierde los
datos.** Va escrito en mayúsculas ahí y en la ayuda del comando.

- [ ] **Step 6: Romper y verificar en las dos direcciones**

- [ ] **Step 7: `npm run typecheck`, la suite, `npx eslint src`**

- [ ] **Step 8: Commit**

`feat(mfa): rotating the encryption key, resumable because it will die half way`

---

# Grupo 2 — El núcleo del TOTP

---

## Task 4: El almacén del secreto, y el paso que llega como cadena

**Hallazgos B3, B5, C10.** Y la Decisión 6.

**Files:**
- Create: `src/auth/totpStore.ts` y su test
- Modify: `src/models/factorTotp.model.ts`

**Interfaces:**
- Produces:
  ```ts
  function guardarSecretoSinConfirmar(id_usuario: number, secreto: string): Promise<{ id: number }>
  function leerSecretoConfirmado(id_usuario: number): Promise<string | null>
  function leerSecretoSinConfirmar(id_usuario: number): Promise<{ id: number; secreto: string } | null>
  function sellarPaso(id_factor: number, paso: bigint): Promise<void>
  function pasoYaUsado(guardado: string | null, paso: bigint): boolean
  ```
- Consumes: `mfaCrypto.ts` de la Task 1.

- [ ] **Step 1: 🔴 El AAD necesita un id que todavía no existe — resuélvelo reservándolo**

La Decisión 6 ata el AAD a `factor_totp.id` y no a `id_usuario`, porque
`factor_totp_id_usuario_fkey` es `ON UPDATE CASCADE` y un `UPDATE usuarios SET id = ...`
—el arreglo que se hace al fusionar dos cuentas duplicadas— destruiría el secreto en
silencio.

Pero eso deja un huevo y una gallina: el AAD hace falta **para cifrar**, y el id no existe
**hasta escribir la fila**. Las dos salidas obvias son malas: insertar y luego actualizar
deja la fila un instante con un contenido que no autentica, y usar `id_usuario` es
exactamente lo que la Decisión 6 prohíbe.

**Se reserva el id antes de cifrar:**

```sql
SELECT nextval(pg_get_serial_sequence('factor_totp', 'id'))
```

Con ese número se calcula el AAD, se cifra, y se hace **un solo INSERT** con el `id`
explícito. Si el INSERT no llega a ocurrir, lo único que se pierde es un número de la
secuencia, que es exactamente para lo que sirven las secuencias.

`pg_get_serial_sequence` y no el nombre literal `factor_totp_id_seq`: el nombre por defecto
es correcto hoy y no es un contrato.

- [ ] **Step 2: Los tests en rojo**

```
it("round-trips a secret through the store")
it("writes ciphertext, iv, auth_tag and key_version in the same statement")
it("cannot read a row whose id was changed underneath it")
it("treats a step that arrives as a string the way a number would be treated")
it("rejects a step it has already sealed")
it("accepts any step on a factor that has never been used")
```

El tercero es la Decisión 6 puesta a prueba. El cuarto y el quinto son C10, abajo.

- [ ] **Step 3: 🔴 `ultimo_paso` es BIGINT y llega como CADENA**

`pg` devuelve BIGINT como cadena, no como número. Cómo se rompe exactamente, medido:

| Escritura | Con el valor `"58012345"` | Veredicto |
|---|---|---|
| `paso <= ultimo_paso` | coerciona, funciona | seguro |
| `paso === ultimo_paso` | **false siempre** | 🔴 agujero |
| `ultimo_paso + 1` | da `"580123451"` | 🔴 agujero |

🔴 **La regla anti-repetición tal y como la escribe la §11** —«si el paso es el mismo que
guardé, lo rechazo», o sea igualdad estricta— **es precisamente la que falla**. Permite
reutilizar los mismos seis dígitos hasta 90 segundos, con la tolerancia de ±1.

Tres reglas, y van en el comentario de `pasoYaUsado`:

1. La comparación es `paso <= (guardado ?? -1n)`, con `<=` y no con `===`.
2. `ultimo_paso` es **NULL en la primera verificación**. El `?? -1n` hace que aceptar el
   primer paso sea intencional y no un accidente de coerción.
3. Se sella **el paso que casó de verdad**, no el que sale del reloj del servidor. Con
   tolerancia de ±1 no son el mismo número, y sellar el del servidor deja el paso vecino
   reutilizable.

- [ ] **Step 4: La escritura de las cuatro columnas**

Regla de la Task 1 Step 4: `secreto_cifrado`, `iv`, `auth_tag` y `key_version` se escriben
**siempre juntos, en la misma sentencia**. Ningún camino de este módulo re-cifra
reutilizando el IV guardado. Si alguien añade uno, el test del IV distinto de la Task 1 no
lo caza: este es el punto donde la regla se hace cumplir.

- [ ] **Step 5: Romper y verificar en las dos direcciones**

Cambiar `<=` por `===` **tiene que** poner en rojo el test del paso repetido. Si sigue
verde, el test está construyendo el paso guardado como número y no como cadena — que es
exactamente el error que hace que este defecto sobreviva a su propio test.

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`feat(totp): the secret store, with the AAD tied to a column that cannot cascade`

---

## Task 5: El promotor de sesión — sin esto nada de lo demás sirve

**Hallazgo D2** y Decisión 8. **No depende del Grupo 1**: puede ir en paralelo.

**Files:**
- Create: `src/auth/sessionPromotion.ts` y su test
- Modify: `src/auth/sessionStore.ts` si hace falta exponer la escritura

**Interfaces:**
- Produces:
  ```ts
  type FuenteMfa = "totp" | "codigo" | "dispositivo";
  function promoverSesion(id_sesion: string, fuente: FuenteMfa): Promise<boolean>
  function apagarLaMecha(id_usuario: number): Promise<void>   // limpia mfa_grace_until
  ```

- [ ] **Step 1: Entender por qué esto existe, antes de escribirlo**

`estadoEfectivo` en `src/auth/sessionState.ts` abre con:

```ts
const guardado = sesion.estado;
if (guardado !== "completa") return guardado;
```

**Solo estrecha.** Una sesión guardada como `onboarding` sigue siendo `onboarding` después
de que su dueño registre el factor: el técnico del día 15 escanea el QR, teclea el código,
y el ERP le sigue diciendo que no tiene acceso. La única forma de salir de `parcial` o de
`onboarding` es que **el endpoint que probó el factor ascienda la fila**, que es lo que
hace esta tarea.

- [ ] **Step 2: Los tests en rojo**

```
it("promotes a partial session to complete")
it("promotes an onboarding session to complete")
it("refuses to promote a session that is not the caller's own")
it("clears mfa_grace_until when the first factor is registered")
it("leaves an already complete session alone")
```

- [ ] **Step 3: 🔴 El WHERE, copiado de `revokeSessionOf`**

```sql
UPDATE sesiones
   SET estado = 'completa', mfa_satisfied_at = now(), mfa_source = :fuente
 WHERE id = :id_sesion AND estado IN ('parcial', 'onboarding')
```

`:id_sesion` sale de `req.user.id_sesion`, que `authenticate` ya deja puesto. **Nunca del
cuerpo de la petición** (hallazgo C15): si sale del cuerpo, cualquiera asciende la sesión
de otro. Y el `estado IN (...)` es lo que hace la operación idempotente y lo que impide que
una llamada repetida vuelva a sellar `mfa_satisfied_at` sobre una sesión ya completa.

Devuelve si afectó una fila, y el llamante lo comprueba.

- [ ] **Step 4: Apagar la mecha**

**Hallazgo D8.3, y es una línea que se olvida.** `mfa_grace_until` se estampa una vez y
**nunca se limpia**. El comentario de `graceUntil` en `factorInventory.ts` ya lo advierte
por escrito para el 4B: *«once a deadline is in the past it stays in the past, on every
account, including the ones that went and registered a factor afterwards»*.

Así que quien registre su factor el día 3 sigue con una fecha vencida en la columna a
partir del día 15, y cualquier código futuro que lea esa columna sin mirar los factores lo
tratará como moroso. Se limpia al confirmar el primer factor.

Va en esta tarea y **no** en «si da tiempo».

- [ ] **Step 5: Romper y verificar en las dos direcciones**

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`feat(session): registering a factor has to promote the session that registered it`

---

## Task 6: Dar de alta el factor — `setup` y `confirm`

**Hallazgos A5, C1, C11, C15, B11.** Decisiones 5 y 8. Es la tarea GRANDE del grupo.

**Files:**
- Create: `src/controllers/totp.controller.ts`, `src/routes/mfa.routes.ts` y sus tests
- Modify: `src/app.ts` (montaje)

**Interfaces:**
- Produces: `POST /api/auth/totp/setup` y `POST /api/auth/totp/confirm`.
- Consumes: Tasks 1, 4 y 5. Y `requireStepUp({ exigeContrasena: true })`, que entrega la
  tanda previa.

- [ ] **Step 1: 🔴 Las dos rutas se montan con `exigeContrasena: true`**

**Qué significa exactamente esa opción, ya construida y verificada en la tanda previa:**
la ruta exige `stepup_password` **siempre**, incluso a una sesión que acaba de probar su
factor. No es lo mismo que «solo cuando la cuenta no tiene factor», que es como se escribió
primero: así redactada, quien tuviera solo el papel de códigos de recuperación gastaría uno,
caería dentro de la ventana de diez minutos y registraría su factor **sin contraseña**,
saltándose el límite que la Task 11 Step 3 de este mismo plan dice que no se puede saltar.

**Así que en estas rutas la ceremonia son dos pasos, en este orden: probar el factor, y
después teclear la contraseña.** Una cuenta con factor y sin prueba fresca recibe
`MOTIVO_SIN_FACTOR_RECIENTE` («prueba tu factor»), no la petición de contraseña. Y una que
no manda contraseña recibe el cuarto motivo, `MOTIVO_CONTRASENA_REQUERIDA`, que el cliente
usa para pedir una contraseña en vez de acusar a alguien de haberla tecleado mal.


Sin eso, **quien tenga una cookie de sesión robada y no la contraseña registra su propio
factor** (hallazgo C1). Y desde ese instante `tieneAlgunFactor` responde `true`, así que la
puerta deja de ofrecerle a la víctima la vía de la contraseña: no puede ni borrar el factor
del atacante. Su siguiente entrada abre en `parcial`, del que solo se sale probando el
factor del atacante. Cambiar la contraseña no sirve; `logout-all` revoca sesiones, no
credenciales. **Es un encierro permanente.**

Si la tanda previa no está hecha, **esta tarea no se empieza**.

- [ ] **Step 2: Los tests en rojo**

```
it("refuses setup without the password, even on an account with no factor")
it("refuses setup when the account has no verified email")
it("answers 409 when a confirmed factor already exists")
it("replaces an unconfirmed row, with a fresh IV")
it("confirms against the row's secret, never against one sent in the body")
it("promotes the session on confirm")
it("clears the grace deadline on the first confirm")
it("never puts the secret or the otpauth URI in the query string")
```

- [ ] **Step 3: El 409 del correo verificado**

Decisión 5 de Isaias. `setup` responde 409 si `usuarios.email_verified_at IS NULL`, con un
mensaje que diga **qué hacer** y no solo que no.

**Lo que hay que tener presente al escribirlo:** hoy **0 de 9 cuentas** tienen correo
verificado. El día del despliegue las nueve personas pasan por verificar correo antes de
poder registrar factor. El mensaje de este 409 es lo que van a leer, y el enlace que
ofrezca es lo que van a pulsar.

- [ ] **Step 4: 🔴 `setup` dos veces contra el UNIQUE (id_usuario)**

`factor_totp.id_usuario` es único (verificado en la migración del 4A). Llamar a `setup` dos
veces tiene cuatro salidas posibles y **una es destructiva**:

| Escritura | Resultado |
|---|---|
| `INSERT` a secas | 500 feo |
| `upsert` o `destroy`+`create` | 🔴 **destruye un factor confirmado que funcionaba**, y la persona se queda sin factor con la gracia vencida |
| `findOrCreate` | seguro mientras la fila esté sin confirmar |
| 409 | correcto para la fila confirmada |

**Regla:** 409 si existe fila con `confirmed_at IS NOT NULL`; reemplazar —con IV nuevo— la
que lo tenga NULL. Bien resuelto ya desde el 4A: una fila sin confirmar **no** cuenta como
factor para `tieneAlgunFactor`, así que reemplazarla no cambia el estado de nadie.

- [ ] **Step 5: `confirm`**

Compara contra el secreto **de la fila**, buscada por `sesion.id_usuario` — nunca contra
nada que venga en el cuerpo (hallazgo C15: «factor ajeno satisface sesión propia»). Al
acertar: escribe `confirmed_at`, sella `ultimo_paso` con **el paso que casó de verdad**
(Task 4 Step 3), **asciende la sesión** (Task 5) y **apaga la mecha**.

- [ ] **Step 6: 🔴 El secreto va por el cuerpo, jamás por la URL**

`httpLogger` serializa la petición **sin cuerpo**, pero registra `originalUrl` **con su
query y sin redactar** (hallazgo B11). Un `otpauth://` en la query queda escrito en el
registro, y ese registro sobrevive al secreto.

- [ ] **Step 7: El aviso, y por qué es la bitácora**

Registrar un segundo factor es un cambio de credencial y merece aviso. `MAIL_SECURITY_TO`
**no está configurado hoy** y no hay decidido a quién debería ir, así que un aviso que no
sale es el caso normal, no una anomalía. La constancia real es la línea de bitácora, con
`severity: 'critical'`, **escrita esperada** — igual que hace `rescueCore.ts`.

- [ ] **Step 8: La trampa de la ceremonia, que se escribe en el comentario**

**Hallazgo A5**, con reloj: 09:00 alguien gasta un código de recuperación y su sesión pasa a
`completa`. 09:01 llama a `setup` → 409 «verifica tu correo». 09:02 pide el correo. 09:11 le
llega y verifica. 09:12 vuelve a `setup` → **403**: pasaron doce minutos, la ventana de
step-up es de diez, y `tieneAlgunFactor` sigue `true` porque su TOTP muerto sigue
registrado, así que la puerta deniega **antes** de mirar la contraseña.

La salida que nadie señala: **borrar el factor muerto primero** abre la rama de la
contraseña. Registrar antes de borrar cierra el bucle. Se escribe aquí y **la Task 19 lo
hace cumplir en la pantalla**: «quitar» va antes que «añadir», o la interfaz mete a la gente
en la trampa.

- [ ] **Step 9: Romper y verificar en las dos direcciones**

- [ ] **Step 10: `npm run typecheck` y la suite**

- [ ] **Step 11: Commit**

`feat(totp): registering a factor, behind the password and the verified address`

---

## Task 7: `/auth/mfa/verify` y el cubo que hoy no acota nada

**Hallazgos C3, C10, C12, C15.** GRANDE.

**Files:**
- Create: `src/controllers/mfa.controller.ts` y su test
- Modify: `src/routes/mfa.routes.ts`, `src/config/security.ts`

**Interfaces:**
- Produces: `POST /api/auth/mfa/verify`, que acepta un código TOTP **o** un código de
  recuperación (Task 11) y asciende la sesión.
- Consumes: Tasks 4, 5 y 11.

- [ ] **Step 1: 🔴 El cuarto cubo no acota nada: hoy el login correcto es gratis**

`costsNothing` devuelve `true` para todo `statusCode < 400`, y los dos cubos del login
llevan `skipSuccessfulRequests`. **Un login con la contraseña correcta no cuesta nada en
ningún cubo**, y `failed_attempts` solo se mueve con contraseña equivocada.

El bucle: login (coste 0) → 5 intentos de código → sesión destruida → login otra vez. Con
seis dígitos y tolerancia de ±1 hay 3 códigos válidos de un millón: unos 333.000 intentos,
unos 67.000 logins. **Horas de reloj con veinte conexiones.** Y la asimetría va al revés de
como debería: destruir la sesión parcial es gratis para el atacante y caro para el legítimo.

**Arreglo:** un `/auth/mfa/verify` fallido **incrementa `failed_attempts` y arma
`locked_until`**, exactamente igual que una contraseña equivocada. Es la misma máquina que
ya existe; se reutiliza, no se escribe otra.

- [ ] **Step 2: Los tests en rojo**

```
it("increments failed_attempts on a wrong code")
it("locks the account after the same number of failures a wrong password would")
it("looks the factor up by the session's user, never by anything in the body")
it("refuses a step it has already accepted")
it("does not accept a code that is only valid ten steps away")
it("answers the same for a wrong code, a corrupt row and a wrong key")
```

- [ ] **Step 3: 🔴 El factor se busca por `sesion.id_usuario`**

Hallazgo C15. Si el factor se busca por algo del cuerpo, un factor ajeno satisface una
sesión propia. Y como `/auth/mfa/verify` se llama desde una sesión `parcial` —que por
definición todavía no ha probado nada— es el sitio del plan donde más barato sale
equivocarse.

- [ ] **Step 4: El diagnóstico de desfase de reloj, con sus tres reglas**

La §6 pide reintentar con ±10 pasos para poder decirle a alguien «tu móvil va desfasado». Es
la primera causa real de «código incorrecto» y **no se recorta**. Pero la §6 no escribe las
tres reglas que lo convierten en un oráculo si se hace mal (hallazgo C12):

1. **El camino de diagnóstico NO acepta.** Si acepta, el espacio de códigos válidos pasa de
   3 a 21 y la fuerza bruta del Step 1 se abarata siete veces.
2. **El mensaje no distingue «válido en otro paso» de «basura».** Distinguirlo le confirma
   al atacante un acierto parcial. Al usuario se le habla del reloj **solo** cuando el
   desfase es consistente, y eso se decide en el servidor, no en la respuesta.
3. **No exime del cubo por intento.** Que exima del bloqueo por cuenta, si acaso; del cubo,
   nunca. Son los intentos más informativos que existen y regalarlos es regalar el ataque.

Y el **anti-repetición va antes** del diagnóstico, no después.

- [ ] **Step 5: La misma respuesta para tres causas distintas**

Hallazgo B12. Código mal tecleado, fila corrupta y clave equivocada responden **exactamente
lo mismo**. Ojo con el test que parece cubrirlo: `errorShape.test.ts` prohíbe filtrar
`error.message` **solo en los 500**, así que un handler que conteste 401 con el mensaje de
GCM pasa ese test y filtra igual. Hace falta un test propio, y su nombre es la regla.

- [ ] **Step 6: Romper y verificar en las dos direcciones**

- [ ] **Step 7: `npm run typecheck` y la suite**

- [ ] **Step 8: Commit**

`feat(mfa): proving the factor, and a wrong code finally costs what a wrong password costs`

---

## Task 8: Borrar el factor

**Hallazgo C11, cola.** PEQUEÑA-MEDIANA.

**Files:**
- Modify: `src/controllers/totp.controller.ts`, `src/routes/mfa.routes.ts`

**Interfaces:**
- Produces: `DELETE /api/auth/totp`, con `exigeContrasena: true`.

- [ ] **Step 1: Los tests en rojo**

```
it("deletes an unconfirmed row as well as a confirmed one")
it("refuses without the password")
it("logs deleting the last factor as critical")
```

- [ ] **Step 2: 🔴 Tiene que poder borrar la fila SIN confirmar**

Si solo borra las confirmadas, una fila sin confirmar queda **indestructible** contra el
`UNIQUE (id_usuario)` y `setup` falla para siempre en esa cuenta. Es la cola del hallazgo
C11 y es fácil dejárselo: el instinto es «borrar el factor», y una fila sin confirmar no
parece un factor.

- [ ] **Step 3: Borrar el último factor, dicho en voz alta**

Quien borre su único TOTP conservando diez códigos de recuperación **vuelve a entrar solo
con su contraseña**, porque `tieneAlgunFactor` no cuenta los códigos (verificado, y es a
propósito). No es un fallo —los códigos son un rescate, no un factor— pero **es
silencioso**, y quien lo hace cree que sigue protegido.

Línea de bitácora `critical` cuando el borrado deja la cuenta sin ningún factor, y la
pantalla de la Task 19 lo dice **antes** de hacerlo.

- [ ] **Step 4: 🔴 Borrar el último factor revoca los dispositivos recordados**

Trazado al hacer la Task 13, y no está en la auditoría. La cadena, con las piezas ya
construidas:

1. Alguien registra su factor. La Task 5 le **limpia** `mfa_grace_until`.
2. Lo borra. `tieneAlgunFactor` pasa a `false`, pero la columna sigue NULL.
3. Entra con el **dispositivo recordado** que le quedó de cuando sí tenía factor. La sesión
   abre `completa` con `mfa_source = 'dispositivo'`.

Sin la Task 13 eso era una exención **permanente y sin ventana**: treinta días de ERP
completo sobre una cookie. Con la Task 13 la sesión sí se estrecha cuando vence el plazo
nuevo — pero la cookie sigue viva y la siguiente entrada vuelve a saltarse el factor.

**Así que al borrar el último factor se revocan también sus dispositivos recordados.** La
función ya existe y ya se usa en cuatro sitios: `revokeAllRememberedDevicesOf`. Es la misma
lógica que el archivado y el cambio de contraseña ya aplican — quitar una credencial invalida
lo que colgaba de ella.

**Lo que NO hace falta:** volver a armar el plazo de catorce días a mano. Verificado leyendo
`estadoInicialDeSesion`: sin factor y con la columna a NULL, la siguiente entrada arranca un
plazo nuevo por sí sola. La única diferencia es que el reloj empieza en la siguiente entrada
y no en el borrado, y con las sesiones deslizándose eso son a lo sumo unas seis semanas de
margen — hygiene, no agujero. Se deja dicho para que nadie lo «arregle» dos veces.

- [ ] **Step 5: Romper y verificar**

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`fix(totp): an unconfirmed row has to be deletable, or setup fails forever`

---

# Grupo 3 — Los códigos de recuperación

Decisión 7. **No dependen del Grupo 1**: van con bcrypt, no cifrados. Pueden ir en paralelo
al Grupo 2.

---

## Task 9: La migración del prefijo, y por qué sin ella verificar un código es un ataque

**Hallazgo B7**, medido. 🔴 **Es la única migración del 4B.**

**Files:**
- Create: `src/migrations/20260902000001-recovery-code-prefix.ts` y su test
- Modify: `src/models/codigoRecuperacion.model.ts`

- [ ] **Step 1: El número, porque justifica la tarea entera**

Diez `bcryptjs.compare` de coste 12: **2646 ms**. Durante esos 2646 ms pasaron **31 de unos
264 ticks** de 10 ms: el servidor está parado al **88%**. Cinco intentos son 12,4 segundos
de CPU. Con el cubo de 10 logins por 15 minutos, eso son **124 segundos de servidor parado
por IP y cuarto de hora**; dos o tres IP dejan el ERP inservible.

🔴 **No hace falta acertar ningún código.** Yo mismo lo había llamado no bloqueante;
medido, lo es.

La implementación natural —`SELECT` los diez, bucle de `compare`, `UPDATE` el que casó— es
exactamente la que produce esto. Por eso el arreglo va **antes** que el código que verifica,
y no después.

- [ ] **Step 2: La columna**

`prefijo CHAR(8) NOT NULL` en `codigo_recuperacion`, más un índice sobre
`(id_usuario, prefijo)`. **Cero filas existentes**, así que no hay relleno que hacer y la
migración es de las baratas.

Qué es el prefijo: los ocho primeros caracteres del código, **en claro**. El `codigo_hash`
sigue cubriendo el **código entero, prefijo incluido**, así que quien se lleve la base no
gana nada útil con él — para usarlo le sigue haciendo falta el resto, y el resto sigue
siendo bcrypt.

Con eso, verificar es **un** `compare` en vez de diez.

- [ ] **Step 3: El corte por forma, que hace falta igualmente**

Antes de tocar bcrypt, rechazar por expresión regular lo que ni siquiera tiene forma de
código. Es gratis y corta el caso más barato de todos para el atacante.

- [ ] **Step 4: La fuga de propina que el prefijo cierra sola**

Con el bucle de diez y retorno al primer acierto, **el tiempo de respuesta revela cuántos
códigos le quedan a la cuenta**. Con un único candidato por prefijo esa fuga desaparece sin
hacer nada más. Merece estar en el comentario, porque quien vuelva a meter un bucle aquí la
reabre sin enterarse.

- [ ] **Step 5: La migración, con lo de siempre**

Dentro de una transacción, abriendo con `SET LOCAL lock_timeout = '5s'`, con su `down`, y
con el test de `queryInterface` falso que ya usan las siete migraciones anteriores.

- [ ] **Step 6: Romper y verificar**

- [ ] **Step 7: `npm run typecheck` y la suite**

- [ ] **Step 8: Commit**

`feat(recovery): a prefix index, because ten bcrypt compares stop the server for 2.6s`

---

## Task 10: Generar y regenerar los códigos

**Hallazgos A8, C14.** MEDIANA.

**Files:**
- Create: `src/auth/recoveryCodeStore.ts`, `src/controllers/recoveryCodes.controller.ts`
- Modify: `src/routes/mfa.routes.ts`, `src/auth/sessionState.ts`

**Interfaces:**
- Produces: `POST /api/auth/recovery-codes` (generar o regenerar; devuelve los diez **una
  sola vez**) y `GET /api/auth/recovery-codes` (cuántos quedan sin gastar, **nunca los
  códigos**).

- [ ] **Step 1: Los tests en rojo**

```
it("returns the ten codes exactly once and never again")
it("invalidates every previous code when regenerating")
it("counts remaining codes without ever returning one")
it("demands step-up with the password to regenerate")
it("never writes a code to the log or the bitácora")
```

- [ ] **Step 2: 🔴 Regenerar exige step-up con contraseña, no un código de recuperación**

La §5 describe `regenerate` como «step-up **o un código de recuperación válido**». **Este
plan construye solo la primera mitad**, y el motivo es el hallazgo C14: si un código
autoriza a regenerar los diez, el papel impreso en un cajón se vuelve llave maestra — quien
lo tenga regenera los diez y la víctima se queda sin ninguno, con un papel.

Consecuencia de coherencia: `/api/auth/recovery-codes` **se queda fuera de `PARCIAL`** (hoy
está en `ONBOARDING_EXTRA`, hallazgo A8). Quien esté en `parcial` no lo alcanza, y es
correcto: para regenerar hay que haber terminado de entrar.

**La §5 está equivocada en este punto y este plan la contradice a propósito.** Anotarlo en
la especificación.

- [ ] **Step 3: Los códigos**

Diez, 128 bits de entropía cada uno (lo pide la §3), en un alfabeto que se pueda leer en voz
alta por teléfono — sin `0`/`O` ni `1`/`l`. Se devuelven **en el cuerpo de la respuesta**,
una vez, y no se guardan en claro en ningún sitio.

Hash con bcrypt coste 12 sobre el código entero. El prefijo de la Task 9 se guarda aparte y
en claro; ver allí por qué eso no debilita nada.

- [ ] **Step 4: El aviso**

Regenerar invalida diez credenciales de golpe. Bitácora `critical`, escrita esperada. El
correo a `MAIL_SECURITY_TO` se intenta y no bloquea nada, como en el resto del arco: hoy ese
buzón no está configurado y eso es una decisión tomada, no un olvido.

- [ ] **Step 5: Romper y verificar en las dos direcciones**

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`feat(recovery): ten codes, shown once, and a printed sheet is not a master key`

---

## Task 11: Gastar un código, sin carrera

**Hallazgos B6, C14.** MEDIANA.

**Files:**
- Modify: `src/auth/recoveryCodeStore.ts`, `src/controllers/mfa.controller.ts`

**Interfaces:**
- Produces: `gastarCodigo(id_usuario: number, codigo: string): Promise<boolean>`, que
  `/auth/mfa/verify` usa cuando lo que llega no tiene forma de código TOTP.

- [ ] **Step 1: 🔴 La carrera, que dura 2,6 segundos**

La implementación natural —`SELECT`, bucle de `compare`, `UPDATE`— deja **2,6 segundos**
entre leer y escribir (Task 9 Step 1). Diez peticiones concurrentes con **el mismo** código
producen: un código gastado y **diez sesiones ascendidas**.

**Regla, y no hay alternativa aceptable:**

```sql
UPDATE codigo_recuperacion
   SET used_at = now()
 WHERE id = :id AND used_at IS NULL
RETURNING id
```

Si no afecta a ninguna fila, el código no vale — lo gastó otro. **Nunca `SELECT` y después
`UPDATE`.**

- [ ] **Step 2: Los tests en rojo**

```
it("marks the code used in the same statement that checks it is unused")
it("lets exactly one of ten concurrent attempts through")
it("consumes the code and seals the session in one transaction")
it("only ever looks at codes belonging to the session's own user")
```

El segundo se escribe con diez promesas lanzadas a la vez, **no en serie**. En serie pasa
siempre, incluso con el código roto — y un test que pasa con el código roto es peor que no
tenerlo.

- [ ] **Step 3: 🔴 Qué autoriza un código y qué no — decisión mía, discutible**

El hallazgo C14 recomienda que un código **no** selle `mfa_satisfied_at`, para que un papel
no abra diez minutos de autoridad total. **Este plan hace lo contrario, y explico por qué.**

Si un código no sella, quien pierde el móvil entra en un callejón sin salida: su TOTP muerto
sigue registrado, así que `tieneAlgunFactor` es `true`, así que `requireStepUp` le cierra la
vía de la contraseña, y no tiene factor que probar. **No puede ni borrar el factor muerto.**
Eso es el hallazgo A5, y convierte el rescate por uno mismo en nada.

Así que **un código sella**, como cualquier otro factor, y el límite de C14 se pone en el
otro sitio: **todas las rutas que dan de alta o quitan una credencial llevan
`exigeContrasena: true`** (Tasks 6, 8 y 10). Con eso, el papel **solo** no registra un
factor, no borra uno y no regenera los diez. Hace falta el papel **y** la contraseña.

🔴 **Ese límite solo se sostiene porque `exigeContrasena` exige la contraseña incluso dentro
de la ventana de diez minutos.** Escrito de la forma natural —exigirla solo a las cuentas
sin factor— el sellado que hace este código pasaría por delante y el papel bastaría. La
opción se construyó así a propósito en la tanda previa; **si alguien la relaja, esta decisión
deja de ser defendible y hay que volver a la recomendación del hallazgo C14.**

Lo que queda expuesto es la matriz de permisos, que sigue detrás de `requireStepUp()` sin
contraseña hasta el 4D. **No es una regresión**: hoy una cookie de sesión robada ya la
alcanza, y una cookie es más fácil de conseguir que un papel guardado en un cajón. Queda
anotado como deuda del 4D, no como agujero nuevo del 4B.

Y se compensa con constancia: gastar un código escribe bitácora `critical` nombrándolo.

- [ ] **Step 4: Consumo y sellado en la misma transacción**

Si el consumo cuaja y el sellado no, la persona gastó un código para nada y no le queda
rastro de por qué. Una transacción para las dos cosas.

- [ ] **Step 5: Romper y verificar en las dos direcciones**

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`feat(recovery): spending a code atomically, because reading then writing takes 2.6s`

---

# Grupo 4 — Recordar el equipo

Decisión 4 de Isaias. **No depende del Grupo 1.**

🔴 **Es más grande de lo que la auditoría suponía.** El 4A dejó `dispositivo_recordado`
creada y dejó dos funciones —purgar y revocar todos los de una cuenta— pero **acuñar y
comprobar no existen**, ni el nombre de la cookie, ni su caducidad, ni ninguna constante de
configuración. Verificado leyendo `src/auth/rememberedDeviceStore.ts`: sus dos únicos
`export` son `purgeExpiredRememberedDevices` y `revokeAllRememberedDevicesOf`.

---

## Task 12: Acuñar y comprobar la cookie del equipo

**Hallazgos C4, C15.** MEDIANA-GRANDE.

**Files:**
- Create: `src/auth/rememberedDeviceIssue.ts` y su test
- Modify: `src/auth/rememberedDeviceStore.ts`, `src/controllers/auth.controller.ts`,
  `src/config/security.ts`

**Interfaces:**
- Produces:
  ```ts
  function acunarDispositivo(id_usuario: number, req: Request): Promise<string>  // devuelve el token en claro, una vez
  function comprobarDispositivo(token: string, id_usuario: number): Promise<boolean>
  ```
- Consumes: `src/auth/opaqueToken.ts` (`hashOpaqueToken`), que ya existe y ya es lo que usa
  el resto del arco. No se inventa otro esquema de token.

- [ ] **Step 1: Las constantes que faltan**

`REMEMBERED_DEVICE_COOKIE_NAME` y `REMEMBERED_DEVICE_TTL_DAYS` en `config/security.ts`,
junto a las dos que ya existen. La cookie es `httpOnly`, `SameSite=Strict`, `Secure` en
producción, y con `Path` acotado a la ruta de login — no vale para nada en el resto del ERP
y no tiene por qué viajar en cada petición.

`token_hash` es `CHAR(64)`: son los 64 caracteres hex de un SHA-256, que es exactamente lo
que devuelve `hashOpaqueToken`. El esquema ya está decidido por la migración del 4A.

- [ ] **Step 2: Los tests en rojo**

```
it("mints a token that is only ever stored hashed")
it("refuses a token that belongs to another account")
it("refuses a revoked device")
it("refuses an expired device")
it("does not exempt a remembered login from the account lockout")
```

El último es la Decisión 4 puesta a prueba, y su nombre es la regla.

- [ ] **Step 3: 🔴 El `WHERE` completo, las cuatro condiciones**

```sql
WHERE token_hash = :hash
  AND id_usuario = :id_usuario
  AND revoked_at IS NULL
  AND expires_at > now()
```

Hallazgo C15. La §3 ya avisa de que buscar **solo por `token_hash`** es la omisión clásica,
y aquí es peor que en otros sitios: es el camino que salta el segundo factor.

Hay una trampa de implementación concreta y hay que nombrarla: si alguien intenta aplicar la
exención de bloqueo que la Decisión 4 **no** construye, tiene que resolver el dispositivo
antes de comparar la contraseña — y el camino cómodo para eso es buscarlo solo por
`token_hash`, porque en ese punto todavía no se sabe de quién es la sesión. No construir la
exención cierra también esa trampa.

- [ ] **Step 4: 🔴 La exención del bloqueo NO se construye**

La §6 exime del bloqueo por cuenta a un login que llega con cookie de dispositivo. **No se
construye**, y el motivo está en la Decisión 4: el problema que evitaba ya está resuelto
—`LOCKOUT_MAX_MINUTES = 15`, así que «bloquear al jefe» dura un cuarto de hora— y lo que
abre es que `estaBloqueada`, la única defensa **durable** contra adivinar una contraseña,
deja de aplicar a quien tenga la cookie. O sea: al portátil robado. Y al acertar la
contraseña, **esa misma cookie le salta el factor**.

Escribirlo en el comentario del módulo con el número de los quince minutos, o el siguiente
que lea la §6 lo añade creyendo que falta.

- [ ] **Step 5: 🔴 Quién decide el estado inicial de la sesión — auditado, y no es donde parece**

Verificado leyendo `estadoInicialDeSesion` en `src/auth/factorInventory.ts`: **con un factor
registrado devuelve siempre `parcial`**, y no sabe nada de dispositivos recordados. Así que
una entrada con la cookie del equipo, si nadie hace nada, **abre en `parcial`** y le pide el
código igual — que es exactamente lo que la comodidad venía a evitar.

La salida evidente es que el controlador del login pise el resultado. **No lo hagas.** Eso
deja dos sitios decidiendo el estado de una sesión, y ese par diverge: es la misma clase de
error que el hallazgo D2, donde una función decidía el estado y otra lo recalculaba sin
saberlo.

**`estadoInicialDeSesion` recibe un parámetro más** —si se presentó un dispositivo recordado
válido— y sigue siendo el único sitio que responde a la pregunta. Es una firma más ancha a
cambio de que la respuesta siga viviendo en un solo lugar.

Y el orden importa: el dispositivo se comprueba **después** de la contraseña, nunca antes.
Al revés, la cookie decidiría cosas sobre una petición que aún no ha demostrado nada.

- [ ] **Step 6: El login acuña, y solo si se lo piden**

`auth.controller.ts` acuña la cookie **solo** cuando el cuerpo del login lo pide
explícitamente y **solo después** de que el segundo factor quede probado. Acuñarla antes es
acuñarla para una sesión que todavía no ha demostrado nada.

- [ ] **Step 7: Romper y verificar en las dos direcciones**

- [ ] **Step 8: `npm run typecheck` y la suite**

- [ ] **Step 9: Commit**

`feat(device): remembering a machine, without the lockout exemption the spec asks for`

---

## Task 13: `dispositivo` deja de ser prueba permanente

**Hallazgo C8.** MEDIANA. Decisión 4, segunda mitad.

**Files:**
- Modify: `src/auth/sessionState.ts`
- Test: `src/auth/sessionState.test.ts`

- [ ] **Step 1: El problema, en la línea exacta**

`sessionState.ts`, cláusula 3 de `estadoEfectivo`:

```ts
if (sesion.mfa_satisfied_at != null || sesion.mfa_source != null) return guardado;
```

Un login por dispositivo recordado escribe `mfa_source = 'dispositivo'`. Esa línea lo lee
como prueba de que la sesión pasó por un factor, y la exención es **permanente y sin
ventana**: la sesión conserva el ERP entero durante 30 días.

La premisa que la justifica —«`mfa_source` solo existe para una cuenta que probó un
factor»— **deja de valer en cuanto la cuenta pierde su último factor**. Y `dispositivo` es
la peor de las cuatro fuentes precisamente porque es la única que se escribe **sin que nadie
pruebe nada en ese momento**.

- [ ] **Step 2: Los tests en rojo**

```
it("does not treat a remembered-device session as having proved a factor forever")
it("still treats a totp session as having proved one")
it("still treats a recovery-code session as having proved one")
```

- [ ] **Step 3: El arreglo**

`'dispositivo'` sale de esa cláusula. Las otras tres fuentes —`totp`, `codigo`, `passkey`—
se quedan: en las tres alguien probó algo en ese momento.

🔴 **Leer el comentario de esa cláusula entero antes de tocarla.** Explica por qué usa `!=`
y no `!==` —una columna *ausente* tiene que leerse como «no hay prueba» y dejar que la fila
se estreche— y explica que `strictNullChecks` está apagado en este proyecto, así que nada
impide construir una fila sin esa columna. El arreglo no puede romper esa propiedad: sigue
siendo `!=`.

- [ ] **Step 4: Romper y verificar en las dos direcciones**

Este es un sitio donde una reescritura equivalente tiene que dejar los tests verdes. La
suite tiene tests de contención sobre este fichero cuyo trabajo entero es ponerse rojos si
alguien rompe el estrechamiento; comprobar que siguen sirviendo.

- [ ] **Step 5: `npm run typecheck` y la suite**

- [ ] **Step 6: Commit**

`fix(session): a remembered device is a convenience, not a proof that lasts thirty days`

---

# Grupo 5 — Lo que sostiene todo lo anterior

---

## Task 14: Los modelos dejan de publicar el criptograma y los hashes

**Hallazgos B10, B11.** PEQUEÑA.

**Files:**
- Modify: los cuatro modelos de factores, `src/utils/logger.ts`
- Test: uno por modelo

- [ ] **Step 1: Lo que publican hoy, confirmado ejecutando `toJSON`**

```json
{"secreto_cifrado":{...},"iv":{...},"auth_tag":{...}}
{"codigo_hash":"$2b$12$..."}
```

Cero `defaultScope`, cero `toJSON` propio, y `hasMany` desde `usuarios` hacia los cuatro —
así que cualquier consulta con `include` los arrastra.

Importa por dos cosas que no son evidentes: **el criptograma filtrado permite recuperar el
secreto retroactivamente** el día que la clave se comprometa, y **esa fila nunca se rota**,
así que el criptograma de hoy sigue siendo el de dentro de tres años.

- [ ] **Step 2: Los tests en rojo**

```
it("never serialises the ciphertext, the iv or the tag")
it("never serialises the recovery code hash")
it("never serialises the remembered device token hash")
```

- [ ] **Step 3: `defaultScope` y `toJSON`**

Las dos cosas, no una: `defaultScope` acota lo que se lee, `toJSON` acota lo que sale. Un
`include` explícito se salta el `defaultScope`, y por eso hace falta el segundo.

- [ ] **Step 4: `REDACT_PATHS`**

Hoy no cubre `MFA_ENCRYPTION_KEY`, ni `secreto`, ni `secret`, ni `otpauth`, ni `codigo`, ni
`recovery`. Añadirlos. Es cinturón y tirantes —lo que no se escribe no hace falta
redactarlo— pero el coste es una línea.

- [ ] **Step 5: Romper, verificar, `npm run typecheck`, suite, commit**

`fix(models): the ciphertext that leaks today is readable the day the key leaks`

---

## Task 15: El arnés de tests, y las cuatro listas de rutas

🔴 **Hallazgo D4. Esta tarea va ANTES del primer test que llame a un endpoint del 4B.**
MEDIANA.

**Files:**
- Modify: `src/app.auth.test.ts`, `src/routes/routeGuards.test.ts`

- [ ] **Step 1: Por qué esto es lo primero y no lo último**

`app.auth.test.ts` espía una lista **fija** de métodos, y de los cuatro modelos de factores
espía **solo `count`** — no `create`, ni `destroy`, ni `bulkCreate`, ni `findAll`.

Hasta hoy daba igual: ningún plan había escrito en esas tablas. **El 4B es el primero.**

Y hay precedente medido: un `increment` sin espiar disparó **cinco `UPDATE` reales contra
`osefi_local`**, que es una copia de producción con los datos de nueve personas reales. No
es un riesgo teórico; ya pasó una vez en este arco.

- [ ] **Step 2: Ampliar el arnés, y que la lista deje de ser fija**

Espiar los métodos que el 4B usa. Y mejor que ampliar la lista: **hacer que el arnés falle
cuando un modelo expone un método de escritura que nadie ha espiado**, para que el siguiente
plan no herede el mismo agujero. Si eso resulta más caro de lo que parece, ampliar la lista
y **decirlo en el informe** — no dejarlo a medias en silencio.

- [ ] **Step 3: Las cuatro listas por igualdad estricta**

`routeGuards.test.ts` compara cuatro listas con igualdad estricta. Cada ruta nueva del 4B
rompe entre una y tres. **Es trabajo previsto, no efecto colateral**, y por eso está en su
propia tarea en vez de sumarse por sorpresa a cada tarea de rutas.

Las rutas que el 4B añade: `/auth/totp/setup`, `/auth/totp/confirm`, `DELETE /auth/totp`,
`/auth/mfa/verify`, `GET` y `POST /auth/recovery-codes`, y `/auth/stepup` (Task 17).

- [ ] **Step 4: `npm run typecheck` y la suite**

- [ ] **Step 5: Commit**

`test(harness): the spy list is what stands between the suite and real people's rows`

---

## Task 16: `/auth/me` deja de entregar el correo a una sesión parcial

**Hallazgo C16.** PEQUEÑA.

**Files:**
- Modify: `src/controllers/auth.controller.ts`
- Test: `src/controllers/auth.controller.test.ts`

- [ ] **Step 1: El problema, y por qué es incoherente con el resto del diseño**

Quien tenga **solo la contraseña** de otra persona entra en `parcial` y `/auth/me` le
devuelve nombre, apellido, imagen y **la dirección de correo verificada**.

El diseño gasta párrafos en que `/password/forgot` no revele quién tiene cuenta, y la §11
razona que «ese Gmail **es** la cuenta» — o sea, que la dirección de recuperación es un
dato sensible. Y luego la entrega a quien todavía no ha probado su segundo factor.

- [ ] **Step 2: El test en rojo**

```
it("masks the email for any session that is not complete")
```

- [ ] **Step 3: El arreglo, una línea**

En estado distinto de `completa`, devolver `estado` y el correo **enmascarado**, que es
exactamente lo que la §7 ya pide en otro sitio. La función de enmascarar ya existe
(`enmascarada`, usada en `email.controller.ts`); se reutiliza.

- [ ] **Step 4: Romper, verificar, `npm run typecheck`, suite, commit**

`fix(auth): a password alone should not hand over the recovery address`

---

## Task 17: Volver a acreditarse sin cerrar sesión

🔴 **Hallazgo C13**, y la auditoría lo llama **el endpoint más peligroso del 4B**. MEDIANA.

**Files:**
- Create: el handler en `src/controllers/mfa.controller.ts`
- Modify: `src/routes/mfa.routes.ts`, `src/middleware/requireStepUp.ts`

**Interfaces:**
- Produces: `POST /api/auth/stepup`, que vuelve a sellar `mfa_satisfied_at` sobre una sesión
  `completa` viva.

- [ ] **Step 1: Por qué hace falta, y por qué no es un caso de borde**

Hoy **no existe ningún endpoint que vuelva a sellar `mfa_satisfied_at`** sobre una sesión
`completa`. La ventana de step-up dura diez minutos. Así que once minutos después de entrar,
las quince rutas sensibles responden 403 y **la única salida es cerrar sesión y volver a
entrar**.

Eso no es un borde: es el caso normal. Y empeora — si vuelve a entrar con **dispositivo
recordado**, `mfa_satisfied_at` sigue NULL a propósito, así que **ese navegador no alcanza
el step-up nunca**.

- [ ] **Step 2: 🔴 Por qué es el más peligroso, y las tres reglas que lo acotan**

Este endpoint decide qué vale como prueba para las operaciones sensibles. Hacerlo generoso
borra la frontera entera de la §4:

1. **Solo TOTP o código de recuperación.** (Passkey cuando exista, en el 4C.)
2. **Nunca dispositivo recordado.** Si lo acepta, la cookie del portátil robado abre las
   quince rutas sensibles y la §4 deja de significar nada.
3. **Nunca contraseña sola en una cuenta que tiene factor.** Si la acepta, degrada el
   step-up a contraseña, que es exactamente lo que la §4 existe para evitar.

Y el mismo cubo por cuenta que la Task 7: un intento fallido aquí cuesta lo mismo que en
`/auth/mfa/verify`.

- [ ] **Step 3: La ruta tiene que estar en las listas de estados**

`/api/auth/stepup` es un prefijo nuevo. Una sesión `completa` lo alcanza —`PERMITIDAS` le da
`"todo"`—, y esa es la única que lo necesita: auditado, un estado `onboarding` implica
**cuenta sin ningún factor** (`estadoInicialDeSesion` devuelve `parcial` en cuanto hay uno),
así que quien está en `onboarding` pasa por la rama de la contraseña y no tiene nada que
re-sellar. Aun así, comprueba el razonamiento contra el código antes de darlo por bueno: si
alguna vez `onboarding` pudiera tener un factor, esta ruta le haría falta y no la alcanzaría.

- [ ] **Step 4: Los tests en rojo**

```
it("re-seals a live complete session with a totp code")
it("re-seals with a recovery code")
it("refuses a remembered device")
it("refuses a password on an account that has a factor")
it("charges a failed attempt the same way mfa/verify does")
```

- [ ] **Step 5: Romper y verificar en las dos direcciones**

- [ ] **Step 6: `npm run typecheck` y la suite**

- [ ] **Step 7: Commit**

`feat(stepup): proving the factor again without having to log out and back in`

---

# Grupo 6 — El cliente

🔴 **El frontend NO es aplazable** (hallazgo D4). En cuanto exista el primer factor, el
login abre en `parcial`, el cuerpo deja de mandar `permisos`, y `LoginPage` **da por dentro
cualquier 200** → bucle infinito. **El paso del segundo factor sale en el mismo despliegue
que el registro.**

---

## Task 18: El cliente aprende que hay estados, y el paso del segundo factor

**Hallazgos A10, D4, A13.** GRANDE. Es la tarea más grande del plan.

**Files (en `web`):**
- Modify: `src/api/Login.api.ts`, `src/context/SesionProvider.tsx`,
  `src/pages/login/LoginPage.tsx`
- Create: el árbol del paso de segundo factor

- [ ] **Step 1: 🔴 El bucle tiene DOS entradas, no una**

Además de `LoginPage.tsx:89`, **`comprobarToken` tira el `estado` igual**
(`Login.api.ts:302-318`), y el arranque de `SesionProvider` da por dentro cualquier 200 —
y `/auth/me` responde 200 en `parcial`.

**Arreglar solo el login deja el bucle vivo al recargar la página.** Las dos entradas se
arreglan en esta tarea o no se arregla ninguna.

- [ ] **Step 2: 🔴 La pantalla del segundo factor NO puede vivir dentro del shell**

Una sesión `parcial` tiene **las imágenes cerradas** (`puedeVerArchivosEstaticos` solo abre
en `onboarding` y `completa`), así que cada imagen del shell daría 403. **Va en el árbol del
login**, no dentro de la aplicación.

- [ ] **Step 3: Los tests en rojo**

```
it("does not treat a partial session as logged in")
it("does not treat a partial session as logged in after a reload")
it("sends the user to the second-factor step, not to the dashboard")
it("tells apart the CSRF 403 from the step-up 403")
```

- [ ] **Step 4: El 403 que no es el 403**

**Hallazgo A13.** El 403 del guard CSRF y el del step-up son **indistinguibles por estado**,
y el de CSRF además **borra la cookie**. El interceptor tiene que discriminar por el `code`
de la respuesta, **nunca por el estado**. Confundirlos expulsa a alguien del ERP por no
haber tecleado una contraseña.

- [ ] **Step 5: La pantalla en sí**

Un campo para el código, y **una segunda vía visible para el código de recuperación** — no
escondida detrás de «¿problemas?». Quien llega ahí con el móvil perdido es exactamente quien
la necesita.

Y el mensaje de desfase de reloj cuando el servidor lo diagnostique (Task 7 Step 4): es la
primera causa real de «código incorrecto».

- [ ] **Step 6: Romper, verificar, typecheck de `web`, suite de `web`**

**Medir la línea base al empezar** y explicar cualquier diferencia.

- [ ] **Step 7: Commit**

`feat(login): the client learns that a session can be half way in`

---

## Task 19: La pantalla de alta del TOTP

**Hallazgos A5, D4.** GRANDE.

**Files (en `web`):** una pantalla nueva alimentada **solo** desde `/auth/*`

- [ ] **Step 1: 🔴 No puede reutilizar `PerfilPage`**

Una sesión `onboarding` solo abre `/api/auth/*`, así que `GET /api/usuario/:id` responde
403. La pantalla es construible **únicamente** desde `/auth/*`. Reutilizar `PerfilPage` es
el atajo evidente y no funciona.

- [ ] **Step 2: 🔴 «Quitar» va ANTES que «añadir»**

**Hallazgo A5**, y es una decisión de disposición, no de estilo. Quien tiene un TOTP muerto
—móvil perdido— y ve «Añadir» encima de «Quitar» hace lo natural: pulsa añadir, se le pide
la contraseña, y la puerta le deniega porque `tieneAlgunFactor` sigue `true`. Se queda dando
vueltas y cada vuelta le cuesta un código de recuperación.

Borrar primero abre la rama de la contraseña. **La pantalla tiene que empujar hacia ahí.**

- [ ] **Step 3: El QR, y lo que se enseña al lado**

El código en texto para quien no pueda escanear. Y decir con qué aplicaciones funciona: la
mitad de las llamadas de soporte de un despliegue de MFA son «no sé qué aplicación
instalar».

- [ ] **Step 4: Antes de borrar el último factor, decirlo**

Task 8 Step 3: quien borre su único TOTP conservando códigos **vuelve a entrar solo con su
contraseña**, y hoy eso pasa en silencio. La confirmación lo dice con esas palabras.

- [ ] **Step 5: Tests, romper, verificar, typecheck, suite, commit**

`feat(perfil): setting up the second factor, with remove above add on purpose`

---

## Task 20: Los códigos de recuperación en pantalla

MEDIANA.

- [ ] **Step 1: Se enseñan UNA vez, y la pantalla lo dice antes de enseñarlos**

No se pueden volver a ver. Quien cierre esa pantalla sin guardarlos los ha perdido, y la
única salida es regenerar los diez.

- [ ] **Step 2: Copiar e imprimir, las dos**

El caso de uso real es un papel en un cajón.

- [ ] **Step 3: Cuántos quedan, visible**

`GET /api/auth/recovery-codes` devuelve el recuento. Que se vea sin tener que pedirlo:
enterarse de que quedan dos el día que hacen falta es tarde.

- [ ] **Step 4: Tests, romper, verificar, typecheck, suite, commit**

`feat(perfil): the recovery codes, shown once and printable`

---

## Task 21: El 403 de step-up deja de parecer una expulsión

**Hallazgos A13, C13.** MEDIANA.

- [ ] **Step 1: El cuadro que pide la contraseña**

Cuando una operación sensible responde con el código de step-up, la pantalla pide la
contraseña **sin perder lo que la persona estaba haciendo**. Reintenta con
`stepup_password` en el cuerpo.

- [ ] **Step 2: Y cuando lo que hace falta es el factor, no la contraseña**

Task 17: en una cuenta con factor, la contraseña sola no vale. El mismo cuadro pide el
código del móvil y llama a `/auth/stepup`.

- [ ] **Step 3: 🔴 Nunca cerrar sesión por esto**

Verificado en el árbol: el step-up responde **403** con `code: CODIGO_STEP_UP`, y el
interceptor de `web` solo cierra sesión ante un **401**. Así que hoy no expulsa a nadie
— pero cualquier cambio en el interceptor que discrimine por estado y no por código lo
convierte en expulsión. Un test con ese nombre.

- [ ] **Step 4: Tests, romper, verificar, typecheck, suite, commit**

`feat(web): a step-up refusal asks for the password instead of throwing you out`

---

## Task 22: El día 15 no dice «no tienes acceso»

**Hallazgo A11.** PEQUEÑA-MEDIANA, y es la que más se nota.

- [ ] **Step 1: Lo que pasa hoy, seguido paso a paso**

`/auth/me` en `onboarding` **omite `permisos` a propósito** → `can()` devuelve false →
`HomeRoute` no encuentra ninguna pantalla que enseñar → renderiza **`<SinAccesoPage />`**,
que dice que hables con administración.

O sea: a quien se le acabó el plazo de catorce días, el ERP le dice **una frase falsa** y le
manda a molestar a la persona equivocada.

- [ ] **Step 2: La puerta que ya existe sin cartel**

`/app/perfil` está **fuera de todo `ModuleRoute`** y se alimenta de `/auth/*`, que sí está
abierto en `onboarding`. O sea: la pantalla que hace falta ya es alcanzable escribiendo la
URL a mano. Lo que falta es que alguien te lleve a ella.

- [ ] **Step 3: El arreglo**

En estado `onboarding`, `HomeRoute` lleva a la pantalla de configurar el factor, con un
mensaje que diga qué pasó y qué hay que hacer. Nunca `<SinAccesoPage />`.

- [ ] **Step 4: Tests, romper, verificar, typecheck, suite, commit**

`fix(web): the fifteenth day should say what to do, not that you have no access`

---

## Self-review

Antes de dar el 4B por cerrado:

- [ ] `npm run typecheck` limpio en `api` — el script, no `npx tsc --noEmit`.
- [ ] Las dos suites enteras en verde. **Medir la línea base al empezar el arco** y explicar
      cualquier diferencia de número de ficheros.
- [ ] `npx eslint src` — 3 errores ajenos preexistentes, ni uno más.
- [ ] 🔴 **Comprobar que ningún test escribió en `osefi_local`.** La forma de comprobarlo no
      es mirar los tests: es mirar la base.
- [ ] `git status` no muestra ningún fichero ajeno en ningún commit.
- [ ] La especificación `docs/specs/2026-08-21-autenticacion-mfa-design.md` actualizada en
      los sitios donde este plan la contradice: §5 (regenerar con código), §6 (la exención
      de bloqueo), §9 (la huella de la clave y el procedimiento de rotación), §11 (la regla
      anti-repetición escrita con igualdad estricta).

---

## El día del despliegue

🔴 **Nada de este arco está en producción.** La imagen que corre hoy hace `process.exit(1)`
sin `JWT_SECRET`; `requiredEnv` ya no lo pide. **Son imágenes distintas.**

Así que el «trozo mínimo» no lo acota el 4B: sale en un despliegue que además estrena
sesiones opacas, cookie `httpOnly`, CSRF, correo, recuperación de contraseña y el esqueleto
MFA del 4A. La §12 habla de «cuatro sospechosos»; **son siete**.

Lo que hay que tener resuelto antes de pulsar:

- [ ] **Rotar `JWT_SECRET` en Coolify.** Solo Isaias. Pendiente desde el 2026-08-24.
      Producción acepta hoy tokens firmados con una palabra de diccionario que está en el
      historial de git.
- [ ] **`MFA_ENCRYPTION_KEY_1` y `MFA_ENCRYPTION_KEY_ACTIVE` puestas en Coolify**, con la
      clave generada donde no quede en ningún historial de consola.
- [ ] **La clave se custodia FUERA del archivo de la copia de seguridad** (hallazgo B13). La
      §11 manda guardarla con el dump, y eso anula el cifrado entero: la única amenaza contra
      la que este cifrado defiende es precisamente **una copia de la base que se escapa**.
      Con la clave en el mismo `.zip`, cifrar no protege de nada. Soporte distinto, y la
      restauración se prueba trayendo las dos piezas de sitios distintos.
- [ ] **La migración `20260827000001` sigue pendiente en local** (hallazgo D8.1), así que
      toda migración probada aquí se probó contra un esquema distinto del de producción.
- [ ] 🔴 **La vuelta atrás muere con la primera fila**, y eso pasa cuando la primera persona
      confirma su TOTP — no el día del despliegue. A partir de ahí, la única marcha atrás es
      el dump.
- [ ] **Decirle a las nueve personas que primero verifican su correo.** Decisión 5: hoy 0 de
      9 lo tienen, y sin él no pueden registrar factor. El plazo de catorce días corre desde
      su primer login, no desde que consigan verificarlo.
- [ ] **Que los tres administradores no compartan clase de factor** (hallazgo A12). Una
      variable de entorno equivocada mata **todos** los TOTP a la vez; los códigos de
      recuperación sobreviven porque van con bcrypt y no cifrados. Si los tres dependen de lo
      mismo, la causa común los deja fuera a los tres.
- [ ] **Probar el comando de rescate dentro del contenedor.** La §8 lo pide como condición
      de despliegue y **nadie lo ha podido hacer**: hace falta acceso a Coolify. El comando
      exacto está en `.superpowers/sdd/2026-08-26-esqueleto-mfa/rescate-B-report.md`.

---

## 🔴 Una decisión que queda abierta para Isaias: el aviso de reloj desfasado

Construido de la forma **conservadora**: el servidor reintenta con ±10 pasos, y si el código
era válido en un paso lejano **lo apunta en la bitácora y no cambia la respuesta**. Quien
está delante ve «código incorrecto», igual que si hubiera tecleado cualquier cosa.

**Es culpa de cómo redacté el encargo**, que llevaba dos reglas tirando en direcciones
opuestas: «el mensaje no distingue válido-en-otro-paso de basura» y «al usuario se le habla
del reloj cuando el desfase es consistente». El agente eligió la segura y dejó el
razonamiento escrito; el del cliente lo detectó al construir la pantalla.

**Lo que se gana cambiándolo:** el desfase de reloj del móvil es **la primera causa real** de
«código incorrecto», y hoy la única persona que puede diagnosticarlo es quien lea la bitácora
del servidor — no quien está a las ocho de la mañana mirando seis dígitos que no le valen.

**Lo que se arriesga:** que la respuesta difiera le confirma a quien esté probando códigos que
su intento casó con **algún** paso. Analizado: para llegar a esa rama hay que producir un
código del secreto real, lo que sin el secreto ocurre 1 vez de cada 47.600 en vez de 1 de cada
333.000 — siete veces más probable, y aun así **no acerca a nadie al secreto**, porque una
coincidencia entre 21 pasos no estrecha nada. Quien sí tenga el secreto no necesita el
oráculo: genera un código válido y entra.

**Mi lectura:** el riesgo es teórico y el coste es real y diario. Pero es un cambio con
implicaciones de seguridad y la versión construida es la segura, así que **no lo toqué**.
Decide tú.

Lo que **no** está en discusión y ya está bien: el camino de diagnóstico **no acepta** (si
aceptara, los códigos válidos pasarían de 3 a 21 por millón), y todo fallo cobra igual contra
el bloqueo, con diagnóstico o sin él.

## Lo que queda después

- **Plan 4C — passkeys enteras** (~7 tareas). Incluye las dos columnas del reto de WebAuthn,
  que el 4A aplazó a propósito, y el login sin contraseña. Los hallazgos C2, C6, C7 y C9 de
  la auditoría son suyos y **están escritos**: leerlos antes de planificarlo.
- **Plan 4D — el resto del step-up en el cliente.** Y con él, la deuda que la Task 11 Step 3
  deja anotada: la matriz de permisos sigue detrás de `requireStepUp()` sin contraseña.
- **Los menores que la tanda previa dejó fuera**: el tiempo de espera de Resend (A13), el
  `--id` de la consola de rescate (A9), y el mensaje de un rescate ya cometido cuya bitácora
  falló.
