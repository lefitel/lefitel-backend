# Plan 4E — El correo como segundo factor, y el correo con relevo

> ⚠️ **Nota del 2026-10-10.** Los pasajes de este documento sobre `sinVentana` y `exigeContrasena` describen lo que se decidió y se construyó entonces. Esa opción y ese campo del 403 ya no existen: toda ruta con puerta de step-up entra en la ventana de diez minutos (decisión de Isaias, ver «Revisión 4» en `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md`). El texto de abajo se conserva como historia, no como descripción del código actual.

> ## Estado — 2026-09-03
>
> **Terminado (tareas 1–10): servidor y cliente, cada tarea auditada antes y después, y cada
> test caído por mutación antes de darse por bueno. Un commit por repo en la rama `isaias`;
> nada desplegado.** Lo que sigue es de Isaias y del runbook (§9 de la spec): abrir las cuatro
> cuentas nuevas, poner sus DNS y sus claves, y desplegar. Las auditorías por tarea, íntegras,
> están en `.superpowers/sdd/2026-09-03-plan-4e/`.
>
> | Tarea | Estado | Qué quedó |
> |---|---|---|
> | 1 — migración `codigo_correo` y la restricción de `mfa_source` | ✅ | 22 tests (14 de la migración, 8 del modelo). La auditoría tumbó la afirmación sobre el bloqueo de `NOT VALID` + `VALIDATE` dentro de una transacción: `ADD CONSTRAINT` plano. El índice de pendiente es `UNIQUE`. |
> | 2 — dos preguntas en `factorInventory`; el correo verificado cuenta | ✅ | 13 tests. `tieneAlgunFactor` nueva; `estadoInicialDeSesion` devuelve `conFactor` y `conCredencial`; `finishLogin` lee `conCredencial`; `app.auth.test` gana el caso «solo correo verificado → 403 con `metodos: ["correo"]`». |
> | 3 — las colas: `verifyEmail`, los dos borrados, el cambio de dirección, el rescate | ✅ | 38 tests (18 nuevos, 20 tocados). La auditoría añadió: revocar las demás sesiones al cambiar la dirección de quien no tiene otra credencial; `EMAIL_VERIFIED` como `critical`; el verbo y la severidad del fallo de `deleteCredential`; la frase de la consola. |
> | 4 — `emailCodeStore`: emitir y gastar | ✅ | 16 tests. La auditoría posterior (tareas 4–6) encontró dos defectos graves, corregidos: la purga borraba en cada emisión las filas de las que se cuentan los topes (un código por minuto, para siempre); y el quinto intento correcto se contestaba como erróneo y bloqueaba la cuenta, porque el cobro quemaba la fila y la liquidación encontraba su propia quema. Ahora la purga barre solo lo de más de un día y `cobrarIntento` devuelve `agotado`. |
> | 5 — `POST /auth/mfa/email-code` | ✅ | 14 tests. `MFA_EMAIL_CODE_SENT` lleva `proveedor` e `id_correo`; `MFA_EMAIL_CODE_FAILED`, el `motivo` del relevo (auditoría). |
> | 6 — `verify` y `stepup` aceptan `metodo` | ✅ | 22 tests. El cubo de verificación vive en `auth/emailCodeVerifyBudget.ts`, deslizante, y no en `loginLimiters.ts` como decía este plan — el porqué, en la tarea. |
> | 7 — el relevo: adaptadores, cadena, cupos con reserva, configuración | ✅ | Cinco ficheros de test nuevos o reescritos (`mailRelay`, `mailProviders`, `mailBudget`, `mailer`, `mailConfig`), ≈85 tests; 23 mutaciones caídas. `PASSWORD_FORGOT_DAILY_LIMIT` **no** se construye — el porqué, en la tarea. Auditoría posterior: 21 hallazgos, uno rojo (un 5xx en `MAIL FROM` archivado como «destinatario» mataba el mensaje sin relevar), todos incorporados salvo dos documentados como límites; clase `configuracion` nueva, 429 de ritmo → `temporal`, el ambiguo cuenta para el disyuntor, plazos 8 s / mínimo 4 s, direcciones enmascaradas en el log, `ok: false` en producción sin cadena. `tarea-07-auditoria.md`. |
> | 8 — el segundo paso del login | ✅ | `verifySecondFactor(codigo, recordar?, metodo?)` con `intentosRestantes`; `pedirCodigoPorCorreo` y `probarStepUp(codigo, metodo?)`; `cuerpoDeCanje` en `stepUp.ts` para que el cable se fije con `toStrictEqual`. La pantalla del segundo paso gana la pestaña «Código por correo»: sin auto-envío, cuenta atrás con los segundos del servidor (200 y 429), 503 y 400 con la frase del servidor, aviso de intentos con dos o menos. ≈27 tests nuevos en cinco ficheros. |
> | 9 — el diálogo del step-up, el interceptor, el perfil y las frases | ✅ | `StepUpDialog`: el correo se ofrece sólo si `metodos` lo lista; selector de clase cuando hay dos que se teclean igual (correo con aplicación o con recuperación), y sólo entonces; `metodo: "correo"` en las dos puertas, nada en las demás; el botón de pedir el código con la espera del servidor. `describeMetodos` nombra el correo y encadena tres métodos. `/auth/mfa/email-code` excluida del interceptor. El perfil dice que el correo verificado es también el segundo factor; las dos secciones distinguen al quitar el último factor si queda el correo. 16 tests nuevos. |
> | 10 — cierre: documentación, bitácora, runbook | ✅ | Esta cabecera; la spec de autenticación (2026-08-21) remite al diseño 4E desde §3, §5 y §11; spec 4E §3.3, §3.5, §4.2, §4.3 corregidas con lo que las auditorías cambiaron; bitácora; un commit por repo. |

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que una cuenta con correo verificado tenga segundo factor sin configurar nada
más, a la par con la app, la llave y los códigos de recuperación; y que el correo salga por
cinco proveedores gratuitos con relevo automático, de forma que un proveedor caído sea un
proveedor caído y no «el correo está caído».

**Architecture:** una tabla nueva para los códigos; un almacén que los emite y gasta en una
sentencia; una ruta que los pide, con la disponibilidad del correo comprobada antes de tocar
nada; los dos endpoints de verificación aceptando un discriminador; y, debajo de
`enviarCorreo`, una cadena de proveedores con cada fallo clasificado y cupo por proveedor
con reserva para el login. En el cliente, ninguna pantalla nueva.

**Tech Stack:** TypeScript, Express 5, Sequelize 6 con Umzug, Postgres, Vitest. Dependencia
nueva: **una**, `nodemailer` 9.1.1 (más `@types/nodemailer`), para el adaptador SMTP genérico.

**Spec:** [`docs/specs/2026-09-03-correo-como-factor-y-relevo-de-correo-design.md`](../specs/2026-09-03-correo-como-factor-y-relevo-de-correo-design.md),
revisión 2. Donde este plan y la especificación se contradigan, manda este plan, y el
motivo está escrito.

**Auditorías de origen:** tres agentes sobre la revisión 1 de la especificación
(2026-09-03): seguridad del factor (S1–S15), consistencia con el código (C1–C31), relevo de
correo (R1–R16). Los tres informes, íntegros, están en
[`.superpowers/sdd/2026-09-03-plan-4e/preauditoria-tres-agentes.md`](../../.superpowers/sdd/2026-09-03-plan-4e/preauditoria-tres-agentes.md);
las auditorías de cada tarea, en la misma carpeta (`tarea-NN-auditoria.md`). Cada tarea cita
los suyos. **Quien ejecute una tarea lee sus hallazgos antes de escribir la primera línea.**

---

## Las decisiones, ya tomadas (Isaias, 2026-09-03)

- **D1 — Automático.** Correo verificado = segundo factor. Sin activación por persona.
- **D2 — A la par.** El segundo paso ofrece todo lo que la cuenta tiene; la persona elige.
- **D3 — Factor completo.** Apaga los catorce días y vale en el step-up. Las rutas D6
  siguen pidiendo contraseña — **y ahora piden también el factor** (especificación §1.2.1).
- **D4 — Sin avisos.** La bitácora registra el método (`fuente: "correo"`).
- **D5 — Cinco proveedores:** Resend, Mailjet, SMTP2GO, Mailtrap, Elastic Email.
- **D6 — Teléfono fuera.**

**Y tres consecuencias que este plan asume salvo que Isaias diga lo contrario**
(especificación §1.2): la doble ceremonia en permisos, roles y usuarios; `--set-email` por
consola como toma de cuenta con traza; y «a lo sumo dos copias» de un correo.

---

## Global Constraints

Las de los planes 4A–4C, que siguen vigentes:

- **Rama `isaias`.** Nunca `main` ni `development`. Ficheros **por nombre**, nunca `git add
  -A`. Nunca `git commit --amend`. **Un commit por repo al acabar el arco**, no uno por tarea.
- 🔴 **La comprobación de tipos es `npm run typecheck`**, nunca `npx tsc --noEmit`.
- **Cada test nuevo se rompe con una mutación antes de darse por bueno**, y en las dos
  direcciones. El guion de mutaciones vive en el scratchpad y restaura en `finally`.
- **Toda migración va dentro de una transacción y abre con `SET LOCAL lock_timeout = '5s'`**,
  con su test al lado.
- **Auditoría antes y después de cada tarea**, con un agente adversarial al menos; los
  hallazgos que cambian una decisión se verifican en el código antes de actuar.
- **Ninguna clave en el chat ni en el repo.** `.env.example` documenta nombres, nunca valores.
- 🔴 **`osefi_local` es una copia de producción.** Aplicar migraciones ahí es decisión de
  Isaias, tras refrescar la copia (runbook §11, paso 0).
- **Código, comentarios y nombres en inglés; mensajes al usuario en español.**
- 🔴 **Los tests que simulan `factorInventory` entero** (`totp.controller.test.ts`,
  `webauthn.controller.test.ts`, `webauthnPasswordless.controller.test.ts`) **no ven nada de
  lo que este plan cambia en él.** Cada tarea que toque una cola de esos controladores
  añade el test con el inventario real o con el simulacro de las dos preguntas por
  separado.

---

## El orden, y por qué

Las tareas 1–3 son los cimientos: la 2 cambia **qué significa tener factor** y la 3 arregla
todo lo que dependía de que solo hubiera una pregunta. Las 4–6 construyen el código y son las
que hacen que una sesión `parcial` de una cuenta con solo correo pueda salir de ahí — **sin
la 5 y la 6, la 2 encierra a esas cuentas.** Por eso el plan entero es un despliegue.

La auditoría de la tarea 2 midió cuánto encierra: no es «el siguiente login abre `parcial`»,
es **la sesión ya abierta**, porque `requireStepUp` empieza a exigir un factor que aún no
tiene con qué probarse, y todas las salidas (`/totp/setup`, `/webauthn/register`,
`/recovery-codes`, `/email/send`) están detrás de esa misma puerta. Y un punto muerto:
`setupTotp` exige correo verificado, y el correo verificado es justo lo que hace que la
puerta rechace `/totp/setup`. Con la 2 sola, **nadie puede volver a registrar un TOTP**. No
hay despliegue parcial válido.

La tarea 7 (el relevo) es independiente y se puede hacer en paralelo con las 4–6. Las 8 y 9
son el cliente y necesitan los contratos de la 5 y la 6 cerrados.

---

# FASE 0 — Cimientos

## Tarea 1 — Migración `20260903000001-create-codigo-correo`

Hallazgos: S13, C5, C6, C20, C28.

**Construir:**

- [ ] `src/migrations/20260903000001-create-codigo-correo.ts`: `createTable` con `DataTypes`
      como `20260826000003-create-factor-tables.ts` (`id` INTEGER autoincrement; FK
      `RESTRICT`, con el comentario de por qué todas lo son; `codigo_hash` VARCHAR(60);
      `intentos` SMALLINT; los `DEFAULT` en SQL crudo, ver `20260827000001:48-66`). Los tres
      índices con sufijo `_idx` (especificación §5); el parcial en SQL crudo como
      `20260825000001:59-64`.
- [ ] La restricción: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT … CHECK` liso, byte a
      byte la forma de `20260826000002` más `'correo'`. ~~`NOT VALID` + `VALIDATE`~~: la
      auditoría de la tarea demostró que dentro de una transacción no cambia el bloqueo
      (se retiene hasta el commit) y `lock_timeout` no aborta un recorrido; el comentario
      de la migración lo explica. El índice del pendiente es **UNIQUE** (misma auditoría).
- [ ] `down`: borra la tabla; **antes** de reponer la restricción de cuatro valores, cuenta
      sesiones con `'correo'` y, si hay, lanza con el `DELETE` que hay que ejecutar.
- [ ] `src/models/codigoCorreo.model.ts` con `defaultScope` que excluye `codigo_hash` y el
      `toJSON` que lo omite (copiar el molde y el comentario B10 de
      `codigoRecuperacion.model.ts`); `ICodigoCorreo` en `src/interfaces/index.ts`;
      `hasMany`/`belongsTo` donde estén los de `codigo_recuperacion`.
- [ ] `usuario.controller.ts` `deleteUsuario`: borra `codigo_correo` explícitamente junto a
      las otras cuatro tablas (verificar primero que lo hace con ellas; si no, anotar y no
      inventar).

**Verificar:** el test de la migración: `up`; `down` con tabla vacía; `down` con una sesión
`'correo'` (falla con el mensaje); la restricción acepta `'correo'` y rechaza `'sms'`; los
tres índices por nombre; la FK es `RESTRICT`. El del modelo: `toJSON` sin `codigo_hash`;
`findOne` sin scope no lo trae. `npm run typecheck`.

**Auditar antes:** un agente sobre la migración escrita, con la lista de convenciones de
C28 en la mano.

## Tarea 2 — Dos preguntas en `factorInventory`; el correo verificado cuenta

Hallazgos: S10 (retirado `metodos` del login), C1, C16, C27, C30.

**Construir:**

- [ ] `sessionState.ts`: `FuenteMfa` gana `"correo"`. Los comentarios que enumeran fuentes.
- [ ] `factorInventory.ts`: `tieneAlgunFactor` (hoy) pasa a llamarse
      `tieneCredencialRegistrada`, con la misma firma y `transaction`; `tieneAlgunFactor`
      nuevo = `tieneCredencialRegistrada || correoVerificado`; `hayFactorVerificable` y
      `metodosDeReautenticacion` ganan el correo; `InventarioFactores` gana `correo: 0 | 1`;
      `MetodoReautenticacion` gana `"correo"`. La lectura: `UsuarioModel.findByPk(id, {
      attributes: ["email_verified_at"], transaction })` — **no `count`** (C16). Cabecera del
      fichero: las dos preguntas, quién usa cada una, y por qué el correo verificado sí
      cuenta y un TOTP sin confirmar no.
- [ ] `estadoInicialDeSesion` devuelve `{ estado, graceUntil, conFactor, conCredencial }`.
- [ ] `finishLogin.ts`: la red `factor-desaparecido` lee `conCredencial` (C1). Su docblock
      dice por qué.
- [ ] `requireStepUp.ts`: los comentarios de la tercera rama («sin nada que probar, pasa»)
      dicen que una cuenta con solo correo **ya no pasa** por ahí; y el bloque que documenta
      la doble ceremonia en las rutas D6 (especificación §1.2.1).
- [ ] **Nada de `metodos` en `cuerpoDeLogin` ni en `/auth/me`** (S10, C17). Si alguien lo
      añadió pensando en la revisión 1, fuera.
- [ ] Todos los sitios que enumeran fuentes o métodos (C27): `sessionState.test.ts:272,403`,
      `app.auth.test.ts:3007-3014` ganan `"correo"` en el bucle; `factorInventory.test.ts:463`
      y los `toEqual` sobre listas pasan a `toStrictEqual`.

**Verificar:** `factorInventory.test.ts` gana una **cuarta tabla falsa** (`usuarios`) en su
intérprete `coincide()` (C16: hoy simula tres y una cuarta sin simular haría un `SELECT` real
contra la base configurada); las dos preguntas responden distinto para una cuenta con solo
correo; `estadoInicialDeSesion` abre `parcial` con solo correo y devuelve `conCredencial:
false`; con correo y dispositivo recordado abre `completa`. `requireStepUp.test.ts`: cuenta
con solo correo → 403 `sin-factor-reciente` con `metodos: ["correo"]`, y con
`exigeContrasena` la doble exigencia. `finishLogin.test.ts`: llave borrada con correo
verificado → `factor-desaparecido`. `app.auth.test.ts:689-702`: los `fixtures` ganan
`email_verified_at` explícito, para que las pruebas «sin factor» dejen de pasar por accidente.
Mutaciones: quitar el `||` del correo en cada pregunta (una por función); `conCredencial`
calculado desde `tieneAlgunFactor`; `count` en vez de `findByPk` (la mutación no cambia el
resultado pero sí el espía compartido — anotar, no exigir).

**Auditar antes:** un agente con C1, C16 y C27 y la lista de llamadores de las cuatro
funciones; que confirme que ninguna llamada quedó apuntando a la pregunta equivocada.

## Tarea 3 — Las colas: `verifyEmail`, los dos borrados, el cambio de dirección, el rescate

Hallazgos: S3, S6, S8, S11, C2, C3, C4, C13, C15.

**Construir:**

- [ ] `email.controller.ts` `verifyEmail`: en una transacción con la escritura de
      `email_verified_at`: `promoverSesion(caller.id_sesion, "correo")` → si `false`,
      `sellarPruebaDeFactor` → `apagarLaMecha`. La línea `EMAIL_VERIFIED` dice que el correo es
      factor desde ahora. Copiar la forma de `totp.controller.ts:393-400`.
- [ ] `email.controller.ts` `sendVerificationEmail`: **`pass` se queda** (S6); comentario de
      por qué la puerta no lo cubre para una cuenta sin factor. Y en la transacción que pone
      `email_verified_at = NULL`: si `!tieneCredencialRegistrada` → `revokeAllRememberedDevicesOf`
      (C15). Las sesiones no.
- [ ] `totp.controller.ts` `deleteTotp` y `webauthn.controller.ts` `deleteCredential`: la
      cola de la especificación §3.2 — sin credencial: equipos recordados fuera siempre; sin
      credencial y sin correo: sesiones, cookie, `LAST_FACTOR_REMOVED`, frase de hoy; sin
      credencial con correo: `LAST_CREDENTIAL_REMOVED` con `queda_correo: true` y «a partir de
      ahora entrarás con un código a tu correo». `MENSAJE_ULTIMO_FACTOR_ELIMINADO` gana su
      hermano.
- [ ] `mfa.controller.ts` `stepup`: la rama del código de recuperación gana la guarda
      `tieneAlgunFactor` que `verify` ya tiene (S11).
- [ ] `recoveryCodes.controller.ts`: la guarda usa `tieneAlgunFactor` (ya lo hace por nombre;
      ahora incluye el correo, que es lo que se quiere: C13); `MENSAJE_SIN_FACTOR_PARA_CODIGOS`
      sigue valiendo para una cuenta sin nada.
- [ ] `rescueCore.ts` `restablecerSegundoFactor`: el `detalle` y el docblock dicen que el
      correo verificado sigue siendo factor y que la gracia no aplica a esa cuenta;
      `establecerEmailDeRescate`: una línea en el docblock y en la salida de la consola —«esta
      dirección es ahora un segundo factor» (S8, especificación §1.2.2)—; `scripts/rescue.ts:329`
      deja de decir «ya puede entrar solo con su contraseña» y distingue; `usuario.controller.ts`
      `rescatarMfaDeUsuario`: la respuesta dice lo mismo y nombra `--set-email`/`--clear-email`.

**Verificar:** `email.controller.test.ts`: las tres escrituras en la transacción; sesión
`onboarding` sale `completa`; `pass` sigue exigido (mutación: quitar la comprobación);
cambio de dirección sin credencial revoca equipos. `totp.controller.test.ts` y
`webauthn.controller.test.ts`: las tres colas **con las dos preguntas simuladas por separado**
(hoy simulan el módulo entero). `mfa.controller.test.ts`: `stepup` con código de
recuperación y sin factor → 400 sin gastar. `rescue.test.ts` y `usuario.controller.test.ts`:
las frases. Mutaciones: `promoverSesion` fuera de la transacción; `sellar` omitido; cola con
`tieneAlgunFactor` donde va `tieneCredencialRegistrada` y al revés (dos mutaciones por
controlador, y son las que importan).

**Auditar después:** un agente que recorra las tres colas con una cuenta en cada uno de los
cuatro estados (nada / solo correo / solo credencial / ambos) y compruebe qué se revoca y
qué verbo se escribe.

---

# FASE 1 — El código

## Tarea 4 — `auth/emailCodeStore.ts`

Hallazgos: S2, S9, S15, C10, C14.

**Construir:**

- [ ] Constantes en `config/security.ts`, cada una con docblock argumentado:
      `EMAIL_CODE_TTL_MS = 10 * 60_000`, `EMAIL_CODE_MAX_ATTEMPTS = 5`,
      `EMAIL_CODE_RESEND_SECONDS = 60`, `EMAIL_CODE_HOURLY_LIMIT = 5`, `EMAIL_CODE_DAILY_LIMIT =
      12`, `EMAIL_CODE_VERIFY_LIMIT = 20` (por cuarto de hora y cuenta).
- [ ] `emitirCodigo(id_usuario, email_destino, ahora = new Date())` →
      `{ codigo } | { rechazado: "cooldown" | "tope-hora" | "tope-dia"; reintento_en_s }`.
      Lee `created_at` de la cuenta para las tres cotas; en transacción marca `used_at` en
      los pendientes e inserta con `bcrypt.hash(codigo, BCRYPT_COST)`. El código:
      `randomInt(0, 1_000_000).toString().padStart(6, "0")`.
- [x] `cobrarIntento(id_usuario, ahora)` → `{ id, codigo_hash, agotado } | null`: **la sentencia
      única** de la especificación §3.5 (`UPDATE … SET intentos = intentos + 1, used_at = CASE …
      RETURNING`), con la subconsulta que exige `email_destino = usuarios.email` **y**
      `email_verified_at IS NOT NULL` (S15). Sin transacción. `agotado` (`used_at IS NOT NULL`
      en el `RETURNING`) dice si este cobro quemó la fila; `expires_at` se compara con `:ahora`,
      el reloj del proceso que la escribió, no con el `now()` de la base (auditoría 4–6).
- [ ] `liquidarCodigo(id, { transaction })` → `boolean`: `UPDATE … SET used_at = now() WHERE
      id = :id AND used_at IS NULL`, `count > 0`.
- [ ] `gastarCodigoDeCorreo` **no existe como función de tres pasos**: el controlador
      compone `cobrarIntento` → `bcrypt.compare` (o `fillerHash()` si `null`, S9) →
      `liquidarCodigo` dentro de su transacción. El docblock del almacén explica por qué el
      cobro va antes de comparar y fuera de la transacción (S2), citando
      `recoveryCodeStore.ts:26-33`.
- [x] `purgarCodigosCaducados(ahora)` → `number`, sobre **`created_at < ahora − 24 h`**, gastadas
      o no. Este plan decía `expires_at < now() OR used_at IS NOT NULL`, y así estaba escrito:
      borraba en cada emisión las filas de las que se cuentan el cooldown y los dos topes (la
      emisión quema el pendiente y la barrida se lo llevaba) — un código por minuto, para
      siempre. Corregido tras la auditoría de las tareas 4–6; la spec §3.3 dice por qué.

**Verificar:** con reloj fijo (pasar `ahora`): emitir invalida el anterior; cooldown en el
segundo 59 y libre en el 60; sexto de la hora y decimotercero del día rechazados con
`reintento_en_s` correctos; `cobrarIntento` devuelve hash cinco veces y `null` la sexta
**simulando cinco llamadas concurrentes** (el simulacro de `UPDATE` incrementa de verdad);
el quinto cobro deja `used_at`; caducado, dirección distinta y correo sin verificar → `null`;
`liquidarCodigo` sobre un id ya liquidado → `false`. Mutaciones: `>=` por `>` en el tope;
quitar `email_verified_at` de la subconsulta; `liquidarCodigo` sin `used_at IS NULL`.

**Auditar antes:** un agente con S2 y S9 sobre el SQL escrito: que la sentencia sea una y
que ningún camino compare sin cobrar.

## Tarea 5 — `POST /api/auth/mfa/email-code`

Hallazgos: S1 (la parte de la reserva va en la 7), S4, S15, C7, C9, C10, C30, R9.

**Construir:**

- [ ] `src/controllers/emailCode.controller.ts` `sendEmailCode`, **en este orden** y con un
      comentario que diga que el orden es el diseño: `callerOf`; `estaBloqueada` → 400
      `CODIGO_MFA_INVALIDO`; cuenta paranoid con `email`, `email_verified_at` → 400 sin
      verificar; **`hayProveedorDisponible("mfa/codigo")` → 503 sin tocar nada** (C10);
      `emitirCodigo` → 429 con `reintento_en_s`; `enviarCorreo({ flujo: "mfa/codigo" }, {
      plazo_ms: 12_000 })`; `ok: false` → 503 **sin invalidar el código** (R3, especificación
      §3.4.6); 200 con `enviado_a` enmascarado y `reintento_en_s`. `purgarCodigosCaducados()`
      sin esperar. Bitácora `MFA_EMAIL_CODE_SENT` con `proveedor`, `MFA_EMAIL_CODE_FAILED` con
      `motivo`.
- [ ] La plantilla: asunto «Tu código de acceso — Osefi», el código **solo en el cuerpo**,
      «caduca en 10 minutos», «si no fuiste tú, alguien tiene tu contraseña: cámbiala». **Sin
      enlaces.**
- [ ] `mailer.ts`: `FlujoDeCorreo` gana `"mfa/codigo"` (C9).
- [ ] `src/routes/mfa.routes.ts`: `router.post("/mfa/email-code", authenticate, sendEmailCode)`
      y el comentario de cabecera: por qué tampoco lleva `requireStepUp` ni cubo propio (los
      topes viven en la base, por cuenta).
- [ ] `routeGuards.test.ts`: la ruta en `GATE_NOT_APPLICABLE` **y en ninguna otra lista** (C7).
      `app.auth.test.ts`: sin cookie 401; `parcial`, `onboarding` y `completa` pasan la puerta
      de estado (C30). `sessionState.test.ts:351-361`: la lista escrita a mano de rutas gana
      ésta.
- [ ] `mailBudget.test.ts:130-149` (el escaneo «la comprobación antes de acuñar») gana el
      controlador nuevo con la aguja `hayProveedorDisponible(` antes de `emitirCodigo(`.
      **Hasta la tarea 7, `hayProveedorDisponible` es un alias de `hayPresupuestoDeCorreo`**
      exportado desde `mailBudget.ts`, para que esta tarea no dependa de la 7.

**Verificar:** cada paso del orden es un test; el que importa: con `hayProveedorDisponible`
falso, `emitirCodigo` **no se llama** y el 503 sale antes. Mutaciones: invertir el orden de
los pasos 3 y 4; invalidar el código en el camino `ok: false`; devolver 200 con `ok: false`;
quitar `estaBloqueada`.

## Tarea 6 — `verify` y `stepup` aceptan `metodo`

Hallazgos: S2, S7, S14, C19.

**Construir:**

- [ ] `mfa.controller.ts`: `CAMPO_METODO = "metodo"`; valores `"totp" | "codigo" | "correo"` o
      ausente; cualquier otro (incluido `"passkey"`) → 400 `METODO_DESCONOCIDO` sin tocar la
      base (S14). Con `"totp"` o `"codigo"`: esa rama aunque la forma diga otra cosa; la guarda
      `tieneAlgunFactor` sigue pegada a la rama `codigo` se llegue como se llegue. Sin `metodo`:
      lo de hoy.
- [x] Rama `"correo"`: forma `^\d{6}$` → si no, 400 como erróneo **sin bcrypt**; cubo en
      memoria por cuenta (`EMAIL_CODE_VERIFY_LIMIT`) → 429; `cobrarIntento`; compare (o
      `fillerHash()`); transacción: `liquidarCodigo` → `promoverSesion(…, "correo")` → `false` →
      `sellarPruebaDeFactor` → `false` → `throw NadaQueSellar` (S7: la forma de tres brazos de la
      rama del código, `:469-473`). En `stepup`, el tercer paso es el `UPDATE` directo con
      `estado: "completa"` (C19), **no** `sellarPruebaDeFactor`.
      **Dos desvíos respecto a lo escrito arriba, los dos deliberados.** (1) El cubo está en
      `auth/emailCodeVerifyBudget.ts`, deslizante, y no en `loginLimiters.ts` con clave
      `ec:<id>`: aquéllos son middleware de `express-rate-limit` por petición y corren antes
      del handler; esto se pregunta dentro del handler, tras la forma y el bloqueo, con el id
      de la cuenta — una función sobre un `Map` es la forma honesta y no arrastra middleware a
      los tests. Deslizante y no fija porque una ventana que se reinicia al cuarto de hora deja
      pasar el doble en los dos segundos que rodean el reinicio, que es justo la ráfaga que
      acota (auditoría de las tareas 4–6). (2) **En el último intento permitido no se liquida**:
      el cobro que llega al tope quema la fila en la misma sentencia que lee el hash
      (`agotado`), y liquidar después encontraba esa quema y la llamaba «nada» — el quinto
      código correcto se contestaba como erróneo y bloqueaba la cuenta (misma auditoría).
- [ ] Erróneo, caducado, sin código: `cargarIntentoFallido(…, "MFA_VERIFY_FAILED", "Código por
      correo incorrecto, caducado o ya utilizado")`.
- [ ] `CODIGO_REQUERIDO` nombra los tres orígenes.

**Verificar:** en `verify` y en `stepup`: `"correo"` bueno → 200, `fuente: "correo"`,
liquidación y promoción en la misma transacción; `promoverSesion` falso → sellar; sellar
falso → `NadaQueSellar` y el código **sigue sin liquidar**; erróneo → 400 con
`intentosRestantes` y `failed_attempts + 1`; caducado → igual y en el mismo tiempo (test de
que `compare` se llamó con `fillerHash()`); forma mala → 400 sin `compare` ni `cobrarIntento`;
cubo → 429 sin tocar la base; `metodo` desconocido → 400 sin tocar nada; **sin `metodo`, seis
cifras van a TOTP**; `metodo: "codigo"` con seis cifras → rechazo por forma **y** la guarda
`tieneAlgunFactor` consultada; `stepup` con sesión `parcial` y `"correo"` → 400 (el `UPDATE`
filtra `completa`, **y el simulacro lee el `where`**: con un `[0]` enlatado el test seguía en
verde sin el filtro); el quinto intento correcto → 200 **sin** `liquidarCodigo`. Mutaciones:
el discriminador ignorado; `promoverSesion` fuera de la transacción; `sellarPruebaDeFactor`
en `stepup`; `fillerHash` omitido; cubo omitido; liquidar también en el quinto; el filtro de
estado quitado; la ventana del cubo fija.

**Auditar después:** un agente adversarial sobre `verify`/`stepup` con la rama nueva: carreras
entre dos `verify` con el mismo código, y `metodo` cruzado con cada forma.

---

# FASE 2 — El relevo

## Tarea 7 — `mailProviders.ts`, `mailRelay.ts`, cupos con reserva, configuración

Hallazgos: S1, S5, S15, C9, C21, C22, C23, C24, R1–R16.

**Construir:**

- [ ] `npm i nodemailer@9.1.1` + `npm i -D @types/nodemailer@8` (R13). `import nodemailer from
      "nodemailer"` (default import; sin `exports` map).
- [ ] `src/auth/mailProviders.ts`: `interface ProveedorDeCorreo { nombre; enviar(correo, from,
      opciones: { plazo_ms }): Promise<ResultadoEnvio> }` con
      `ResultadoEnvio = { ok: true; id: string | null } | { ok: false; clase: ClaseDeFallo; detalle }`
      y `ClaseDeFallo = "destinatario" | "contenido" | "temporal" | "averia" | "autenticacion"
      | "configuracion" | "cuota" | "ambiguo"`, clasificada con la tabla de la especificación
      §4.2 a partir de `err.code`, `err.command`, `err.responseCode` y el texto (R10).
      `configuracion` y la lectura de `err.command` vienen de la auditoría posterior: un 5xx
      en `MAIL FROM` es nuestro remitente rechazado, no el destinatario. `resendProvider(claveVar)` (el código
      de hoy, movido; lee la clave en el momento de enviar) y `smtpProvider(nombre, { host,
      puerto, usuarioVar, passVar }, fabricaDeTransporte)` con las opciones **fijadas** de §4.4
      (`requireTLS: true`, los cuatro plazos, `pool: false`) más el plazo externo de 8 s
      (`Promise.race` + `close()`; `close()` no aborta el envío en vuelo, por eso el
      vencimiento es `ambiguo`), y las cabeceras de no-rastreo por proveedor (Mailjet:
      `X-Mailjet-TrackOpen: 0`, `X-Mailjet-TrackClick: 0`; Elastic: `trackopens: false`,
      `trackclicks: false`) en **cada** mensaje (R1). **La fábrica de transportes se niega
      bajo el test runner** (R8) y es inyectable.
- [ ] `src/auth/mailBudget.ts`: `crearPresupuesto(nombre, tope, reserva = tope / 4)` →
      `{ hay(flujo), consumir(flujo), restante(), reiniciar() }`. `hay`/`consumir` de un flujo
      **no reservado** se detienen en `tope − reserva`; los reservados (`mfa/codigo`,
      `password/aviso-restablecida`, `email/aviso-cambio`, `rescate/aviso`) llegan al tope
      (S1, R16). Ventana deslizante como hoy, aviso al 80 %, `flujo` en el log (C24).
- [ ] `src/auth/mailRelay.ts`: la cadena de §4.2. Disyuntor por proveedor: **dos averías
      seguidas** → apartado `MAIL_PROVIDER_COOLDOWN_MS` (15 min) con un intento de prueba al
      vencer; `autenticacion` → hasta reiniciar + `error` con el nombre; `cuota` → contador local
      agotado y apartado hasta que ruede la ventana (R2, R10). Cobro solo en `contenido`,
      `ambiguo` y éxito (R10). `destinatario` → devolver sin relevar, sin apartar, sin cobrar.
      `ambiguo` → cobrar y relevar (§1.2.3). Plazo de cadena (`plazo_ms`). Log por intento
      `{ flujo, proveedor, clase, code, responseCode, command, ms }`, nunca el cuerpo; éxito
      `{ flujo, para, proveedor, id, intento, ms }`; agotamiento **una** línea `error` con
      `cadena: [{ proveedor, motivo, hasta }]`. `hayProveedorDisponible(flujo)` = el primer paso
      del bucle, exportado (R6); el alias de la tarea 5 desaparece.
- [ ] `src/auth/mailer.ts`: `enviarCorreo(correo, opciones?)` → `{ ok, proveedor?, id?, motivo?
      }` (R9, aditivo); primera línea `bajoTestRunner()`, segunda el modo desarrollo; lo demás
      delega. Cabecera reescrita (C31): ya no es «la única función que habla con Resend». El
      docblock nombra la excepción de `/mfa/email-code` al «no cambies tu respuesta según `ok`».
- [ ] `src/config/security.ts`: `configuracionDeCorreo(env, nodeEnv)` con la forma de la
      especificación §4.5 (nombres de variables, nunca valores; `descartados` con motivo;
      `ok: false` solo con cadena vacía en producción); `MAIL_PROVIDER_COOLDOWN_MS`,
      `MAIL_RESERVA_FRACCION`; `requiredEnv` en producción: `MAIL_PROVIDERS` y `MAIL_FROM`,
      **sin `RESEND_API_KEY`** (R7, C22). **`PASSWORD_FORGOT_DAILY_LIMIT` no se construye**,
      aunque S1 y la especificación §4.3 lo pedían: un cubo así ya existió
      (`passwordForgotDailyLimiter`) y se retiró porque cuenta peticiones, no envíos —
      cincuenta POST con una dirección sin cuenta lo agotaban sin gastar un correo, y su
      `RateLimit-Remaining` era un oráculo. La reserva del 25 % por proveedor es la respuesta
      completa a S1: la inundación de `/password/forgot` se detiene en el 75 % y el login sigue.
- [ ] `src/index.ts`: `configuracionDeCorreo` justo después de `requiredEnv`, a nivel de
      módulo (antes de encolar nada, como el de la cookie): `fatal` por proveedor descartado
      con las variables que faltan; `exit(1)` **solo** con cadena vacía en producción; `info`
      con la cadena viva (especificación §4.5, C21 y R7 conciliados; el comentario dice por qué
      esto sale y `comprobarLlaveAlArrancar` no).
- [ ] `email.controller.ts` y `password.controller.ts`: `hayProveedorDisponible(flujo)` en vez
      de `hayPresupuestoDeCorreo()` (R6). `securityNotice.ts`: el docblock que dice que los
      avisos no gastan cupo es falso desde el 4B (R15) — corregir; «Resend no lo entregó» →
      «ningún proveedor lo entregó».
- [ ] `.env.example`: el bloque de correo reescrito con los cinco proveedores, la convención
      de usuario de cada uno (SMTP2GO: usuario SMTP del panel; Mailtrap: `api`; Elastic:
      credencial SMTP del panel; Mailjet: clave pública/privada) y el porqué de cada variable.

**Verificar:** `mailRelay.test.ts` con proveedores falsos y errores de nodemailer simulados:
cada fila de la tabla de clasificación; orden; salto por cupo y por apartado; disyuntor a la
segunda avería y prueba única al vencer; `autenticacion` hasta reiniciar; cobro solo donde
toca; `destinatario` no releva; `ambiguo` releva y cobra; la reserva detiene `email/verificar`
en el 75 % y deja pasar `mfa/codigo`; plazo de cadena; `hayProveedorDisponible` falso con
todos apartados y cupos llenos; agotamiento sin llamar a nadie con una sola línea `error`.
`mailProviders.test.ts`: el objeto de `createTransport` (con `@types/nodemailer` instalado,
o `connectionTimeOut` compila); cabeceras de no-rastreo; la fábrica se niega bajo el runner
**aunque** `MAIL_SMTP_*` esté en el entorno; `resendProvider` sigue llamando a la librería
como hoy. `configuracionDeCorreo`: cada mensaje de error de §4.5; producción con cadena
vacía; desarrollo sin `MAIL_PROVIDERS` con `RESEND_API_KEY` → `resend` con aviso.
Reescrituras (C23, R12): `mailer.test.ts` (las cuatro de Resend directo → a través del
relay con `MAIL_PROVIDERS=resend`; las cinco del contador único → por proveedor; la lista de
excepciones del escaneo gana `mailProviders.ts`); `mailBudget.test.ts:87` (el 80 de Resend →
la reserva); `securityNotice.test.ts:198` y `mailBudget.test.ts:158` **en positivo**: el
conjunto de ficheros que cobran es exactamente `["src/auth/mailRelay.ts"]`;
`index.boot.test.ts:76-91`; `email.controller.test.ts:473` gana la pareja a nivel de relay.
Mutaciones: quitar el `return` tras un `ok`; cobrar en `averia`; apartar a la primera; apartar
en `destinatario`; `requireTLS` a `false`; reserva a cero; `hayProveedorDisponible` sin mirar
el apartado.

**Auditar antes:** un agente sobre la clasificación escrita contra el código fuente de
nodemailer 9.1.1 (`smtp-connection/index.js`: `_onClose`, `_onTimeout`, `_formatError`), y
sobre el plazo externo: que un `close()` a mitad de `DATA` cuente como `ambiguo`.

---

# FASE 3 — El cliente

## Tarea 8 — El segundo paso del login

Hallazgos: S4, S10, C17, C18, C26, C27.

**Construir:**

- [x] `web/src/api/Login.api.ts`: `verifySecondFactor(codigo, recordar?, metodo?)` y el
      resultado gana `intentosRestantes` (C26). `Login.api.test.ts:150` pasa a `toStrictEqual`.
- [x] `web/src/api/Mfa.api.ts`: `pedirCodigoPorCorreo()` → `{ status, message, enviado_a,
      reintento_en_s }` con `TIMEOUT_CONFIRMACION_MS`; `probarStepUp(codigo, metodo?)` (C11).
- [x] `SegundoFactorPage.tsx`: tres pestañas siempre; la de correo con la dirección enmascarada
      de `sesion.usuario.email` (ya enmascarada por `/auth/me`, C18), botón «Enviar código» con
      cuenta atrás de `reintento_en_s`, caja de seis cifras, `verifySecondFactor(codigo,
      recordar, "correo")`. **Sin auto-envío** (S4). 429 → cuenta atrás con el valor del
      servidor; 503 → «prueba otro método»; 400 «sin correo verificado» → la frase. Tras un 400
      de código, «te quedan N intentos» cuando N ≤ 2.
- [x] `SesionInterface` **no** gana `metodos` (S10).

**Verificar:** `SegundoFactorPage.test.tsx`: tres pestañas; no hay envío al montar (mutación:
un `useEffect` que envíe); la cuenta atrás bloquea el botón y respeta el `reintento_en_s` del
429; verificar manda `metodo: "correo"`; `intentosRestantes` en pantalla; el `Harness` con la
ruta real como en `LoginPage.test.tsx`.

## Tarea 9 — El diálogo del step-up, el interceptor, el perfil y las frases

Hallazgos: C11, C25, C29.

**Construir:**

- [x] `StepUpDialog.tsx`: `ofreceCorreo = metodos !== undefined && metodos.includes("correo")`
      (sin `metodos`, no: servidor viejo). El bloque de código gana un **selector de clase**
      (app / correo / recuperación, solo las ofrecidas) con su propio estado; confirmar manda
      `metodo` en `verifySecondFactor` y en `probarStepUp` según el estado de la sesión. La
      clase «correo» lleva «Enviar código a i***@…» con cuenta atrás. `factorCubierto`,
      `sinMetodos`, `etiquetaCodigo` reescritos alrededor de tres clases (C11).
- [x] `stepUp.ts` `describeMetodos`: «pide un código a tu correo», incluida la rama
      `partes.length === 0`.
- [x] `stepUpInterceptor.ts`: `"/auth/mfa/email-code"` en `RUTAS_EXCLUIDAS` con el comentario
      (C29: el emparejamiento es por subcadena y `/auth/mfa/verify` no la cubre).
- [x] `PerfilPanel.tsx` (la fila «Correo verificado») y `PerfilAcceso.tsx`: «Tu correo
      verificado es tu segundo factor. Guarda códigos de recuperación por si pierdes el acceso
      al correo.» `TotpSection.tsx:498-500` y `PasskeysSection.tsx`: la frase de «volverás a
      entrar solo con tu contraseña» distingue si queda el correo (C25).

**Verificar:** `StepUpDialog.test.tsx`: se ofrece solo con `"correo"` en `metodos`; el
selector aparece con dos o más clases y no con una; confirmar manda `metodo` correcto en las
dos rutas; un código de correo tecleado con la clase «correo» **no** va como TOTP (la prueba
de la ambigüedad). `stepUpInterceptor.test.ts` itera el array exportado: la entrada nueva se
cubre sola. `stepUp.test.ts`: la frase. Los tests de las secciones y del perfil: las frases.
Mutaciones: ofrecer sin `metodos`; `metodo` no enviado en `probarStepUp`; quitar la exclusión.

**Auditar después:** un agente sobre el diálogo con `metodos` en sus siete combinaciones.

---

# Cierre

## Tarea 10 — Documentación, bitácora, runbook

- [x] Cabecera de estado de este plan: tarea por tarea, qué quedó, pruebas y mutaciones.
- [x] La especificación de autenticación (`2026-08-21`): §3, §5 y §11 remiten a este diseño.
- [x] `~/.claude/bitacora/Lefitel/2026-W36.md`: la entrada, en cristiano. Releer antes.
- [x] Un commit por repo, mensajes en inglés.

## Runbook del despliegue

El de la especificación §9, íntegro. Lo que no se puede olvidar:

1. 🔴 **Todo el plan es un despliegue.**
2. 🔴 **Rastreo de clics apagado en los cuatro paneles antes del primer envío real**, y las
   cabeceras en el código para los dos que las tienen. Un enlace reescrito es el token de
   recuperación en el registro de un tercero.
3. Cuentas, DNS (unos nueve registros; Mailtrap exige `mt-link`; SMTP2GO en 25/hora hasta
   verificar el dominio), `rua=` en DMARC, y un correo real de prueba desde cada proveedor.
4. Salida por 587 desde el contenedor.
5. Variables en Coolify; **la primera pantalla del log de arranque** dice la cadena viva.
6. `migrate:deploy`; `api` y `web` seguidos.
7. Las nueve personas: el código en cada login salvo equipo recordado; los administradores,
   la doble ceremonia.

**Marcha atrás:** especificación §9. **Todo el mundo cierra sesión**, y el reloj de catorce
días se mueve para quien verificó.

## Deuda que este plan NO cierra, dicha por su nombre

- **Cupos y cubos en memoria, por proceso.** Deuda ya anotada.
- **Con los cinco proveedores apartados, quince minutos sin login por correo.** Se ve en el
  log; no hay panel.
- **Cinco cuentas gratuitas que mantener vivas.** Un correo trimestral; sin automatizar.
- **`--set-email` por consola es una toma de cuenta con traza.** Decisión de §1.2.2.
- **La doble ceremonia en D6 para quien solo tiene correo.** Decisión de §1.2.1.
- **Un correo puede llegar dos veces.** Decisión de §1.2.3.
- **El código se lee en la pantalla de bloqueo del móvil.** Igual en todos los sistemas.
- **`deleteTotp` no tiene la disciplina de fallo de `deleteCredential`** (borra la fila
  antes de escribir la bitácora, sin reintento del recuento ni cierre seguro). Pre-existente,
  visto en la auditoría de la tarea 3; la tarea 3 añadió un `await` más delante del log.
- **`/mfa/verify` desde una sesión ya `completa` sella y puede emitir la cookie de equipo
  recordado**, cosa que `/stepup` se niega a hacer por diseño («re-probar dentro de una sesión
  no es llegar a una»). `PERMITIDAS.completa` es «todo», así que la ruta se alcanza. Exige un
  factor válido igual, así que no es una escalada; es un invariante escrito y no aplicado.
  Pre-existente (TOTP y códigos de recuperación llegaban igual); el 4E añade una tercera vía.
  Visto en la auditoría de las tareas 4–6; no se toca en este plan.
- **Un código correcto que no encuentra sesión que sellar cuesta un intento.** El cobro va
  fuera de la transacción a propósito (bcrypt sin conexión abierta); la liquidación se deshace
  con el sellado, el cobro no. Igual que la rama del código de recuperación; dicho aquí porque
  antes no lo decía nadie.
