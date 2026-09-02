# Plan 4D — La ventana que pide la identidad

> ## Estado: tareas 1 a 9 construidas y verificadas (2026-09-02)
>
> `api`: comprobación de tipos limpia, **1790 pruebas** en verde, eslint en sus 3
> errores preexistentes. `web`: tipos limpios, **666 pruebas** en verde, eslint en
> sus 15 avisos preexistentes.
>
> Cada arreglo se mutó a propósito después de hacerlo, **en los dos sentidos**,
> para comprobar que su prueba se pone roja de verdad. Queda la tarea 10, la
> auditoría de cierre.
>
> **Dos correcciones sobre lo que este plan decía al escribirse**, las dos
> verificadas a mano y anotadas en su tarea: la vía (a) del hallazgo A15 era
> peligrosa y se descartó, y el hallazgo A12 no se sostenía —la salida existía
> por otra puerta, así que no hubo nada que arreglar en el servidor.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que una operación delicada que el servidor no deja pasar se resuelva **sola, en una
ventana, sin perder lo tecleado**. Al terminar el 4D, las 19 rutas protegidas del ERP tienen
respuesta en el cliente, y las que se añadan después la heredan sin escribir una línea.

**Architecture:** un interceptor de axios a nivel de módulo, una cola que garantiza **una sola
ceremonia viva a la vez**, un puente sin React entre el interceptor y la interfaz, y **un solo
modal** para toda la aplicación que decide qué pedir a partir del `motivo` del 403. Más cuatro
arreglos en el servidor que el modal no puede resolver desde fuera.

**Tech Stack:** React 19, axios `^1.6.7` (singleton: no hay `axios.create` en todo `web`),
Radix `alert-dialog` (ya presente; no existe `ui/dialog.tsx`), Vitest + jsdom.
**Dependencias nuevas: ninguna.**

**Spec:** [`docs/specs/2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md) §7 y §8.

**Pre-auditoría de origen:** [`.superpowers/sdd/2026-09-02-preauditoria-4d/A-contrato-cliente.md`](../../.superpowers/sdd/2026-09-02-preauditoria-4d/A-contrato-cliente.md)
— 22 hallazgos, tres de ellos **medidos ejecutando axios**, no razonados. Cada tarea cita los
suyos (A1, A9, A15…). 🔴 **Quien ejecute una tarea lee sus hallazgos antes de escribir la
primera línea**, y muy en particular la sección «Lo medido»: la forma obvia de implementar
esto entra en **bucle infinito con la contraseña correcta**.

---

## Por qué esto no es opcional

Hoy el servidor pide la prueba extra en 19 sitios. El cliente sabe contestar en 4.

- **Dos rutas fallan siempre, para todo el mundo** (A8): «restablecer segundo factor ajeno» y
  «desbloquear cuenta». La interfaz enseña un toast que pide la contraseña y **no hay campo
  donde escribirla**.
- **Las trece restantes funcionan hoy y dejan de funcionar, persona por persona, en el
  instante en que esa persona registra su segundo factor.** Que es lo que va a pasar el día
  del despliegue, con las nueve. Crear roles, la matriz de permisos, editar usuarios, cerrar
  la sesión de otro: todo, y sin ninguna pantalla donde probar el factor.

O sea que el 4D no es «dos botones»: es la condición de que el despliegue del 4B no deje la
administración del ERP inservible.

---

## Decisiones de Isaias (2026-09-02)

1. **El mecanismo entero**, no parches por pantalla. Un solo sitio, y las rutas futuras lo
   heredan.
2. **Un solo modal**, y **una sola vez**: cuando hagan falta el código y la contraseña, se
   piden juntos en la misma ventana. Requiere que el servidor lo avise por adelantado (T2).
3. **Diez minutos de validez.** Se prueba el factor una vez y el resto pasa solo. Ya está en
   el servidor (`STEP_UP_WINDOW_MINUTES = 10`).
4. **Avisar antes de bloquear** (A4). El servidor dice cuántos intentos quedan y el modal lo
   enseña. Sin esto, cinco códigos mal tecleados —o un reloj desfasado— bloquean la cuenta
   del ERP sin que nadie lea nada.
5. **Arreglar los dos encierros** (A12, A15), no documentarlos como rescate por consola.
6. **Mensaje claro cuando se pasó el plazo** (A2): en vez de «no se pudo», qué pasa y un
   enlace a la pantalla del segundo factor. **No cambia quién pasa**, solo lo que se lee.

## Decisiones tomadas aquí, con su motivo

- **El disparador es exactamente `status === 403 && data.code === "STEP_UP_REQUIRED"`, y nada
  más.** Ni el 403 de CSRF —que **ya borró la cookie** (A1) y convertiría el modal en una
  contraseña tecleada al vacío—, ni el 403 de `authenticate`, ni el 429, ni el 500. `code`
  aparece en **una sola respuesta de todo el servidor**, así que el discriminante es exacto.
- **`estado-incompleto` no se reintenta jamás** (A11). No hay nada que teclear: el único
  remedio es registrar un factor. Es un mensaje con enlace y punto final. Reintentar es un
  bucle infinito garantizado, y hoy se alcanza en dos rutas reales.
- **Serialización obligatoria** (A5, A7). Una sola ceremonia viva; las demás peticiones que
  reciban 403 se encolan y se reintentan **con el resultado de la primera**, sin volver a
  preguntar nada. Es lo único que evita que un código correcto bloquee la cuenta.
- **Tope duro de dos reintentos por petición.** Incluso para los motivos con remedio: sin
  tope, un cuerpo mal serializado gira para siempre.
- **El interceptor vive en `api/http.ts`, a nivel de módulo, no en un efecto de React**
  (A16). En un efecto, `React.StrictMode` invierte el orden de registro en desarrollo y no en
  producción, así que probarlo en `npm run dev` no dice nada de lo que hará desplegado. A
  nivel de módulo el orden es determinista.
- **Se arreglan las cinco llamadas sin cuerpo en origen, Y el interceptor normaliza igual.**
  Cinturón y tirantes, y no es redundancia: arreglarlas en origen cierra el bucle medido hoy;
  normalizar en el interceptor cierra el de la función que alguien escriba mañana sin haber
  leído esto.
- **Las constantes del step-up viven en un solo módulo** (A18), hoy repartidas entre
  `Login.api.ts:390` y `Mfa.api.ts:46`. Se unifican antes de que sean tres copias.
- **`POST /auth/totp/confirm` no se reintenta automáticamente** (A22). Su cuerpo lleva un
  TOTP de 30 segundos: reenviarlo tarde manda un código muerto y culpa a la persona de un
  retraso del interceptor. Esa pantalla ya pide el código ella misma.
- **Nomenclatura del contrato:** `code` en inglés decide **si** se abre el modal; `motivo` y
  los campos nuevos, en español, deciden **cómo**. Es la convención que el 4B ya cerró; los
  campos que se añaden en T2 la siguen en vez de abrir una tercera.

---

## Tarea 1 — Los dos encierros del servidor

**Hallazgos:** A15 (🟠, verificado a mano), A12 (🔴).

Los dos comparten forma: una puerta pensada para rescatar a alguien está cerrada por la
puerta de al lado. Ninguno lo puede resolver el cliente.

- [ ] **A15 — el factor ilegible.** `totp.routes.ts:104-109`. El `DELETE /auth/totp` no lleva
      `requireTotpKeyAvailable` **a propósito** — su propio comentario (`:14-26`) dice que es
      «para que una llave equivocada no encierre a nadie en un factor muerto». Pero lleva
      `requireStepUp`, que exige probar ese mismo factor muerto, porque `tieneAlgunFactor`
      (`factorInventory.ts:79-86`) cuenta la fila confirmada **sin intentar descifrarla**.
      Salida única hoy: un código de recuperación sin gastar.

      🔴 **Verificado 2026-09-02, y descarta la vía que este plan proponía primero.** La
      opción (a) —que `tieneAlgunFactor` deje de contar un TOTP ilegible— **no se hace**:
      tiene cinco llamadores vivos y uno es `factorInventory.ts:295`,
      `estadoInicialDeSesion`, que decide en qué estado abre la sesión al entrar. Con (a),
      **una clave mal configurada haría que todas las sesiones abrieran como si nadie tuviera
      segundo factor**: un agujero mucho peor que el encierro que arregla.

      🔴 **Y arreglar la puerta tampoco basta, porque el encierro no está en la puerta.** Con
      el factor ilegible, `estadoInicialDeSesion` abre `parcial`, y de `parcial` solo se sale
      probando el factor. Esa persona **no llega ni a tener sesión**: da igual lo que haga
      `requireStepUp`, que corre mucho después. La única salida real es un código de
      recuperación — de ahí la Tarea 1b, que es el arreglo de verdad.

      **Lo que queda aquí:** que `DELETE /auth/totp` sea satisfacible con la contraseña
      cuando el servidor sabe (`totpEstaDisponible() === false`) que no puede verificar el
      factor. Sigue exigiendo la contraseña (`exigeContrasena`), así que una cookie robada no
      basta — y exigir probar un factor que el propio servidor declara ilegible es exigir lo
      imposible. Acotado a esa ruta, sin tocar `tieneAlgunFactor`.
- [x] **A12 — `onboarding` con factor. VERIFICADO 2026-09-02: el hallazgo no se sostiene, y
      no hay nada que arreglar en el servidor.** La salida existe:
      `PERMITIDAS.onboarding` es `[...PARCIAL, ...ONBOARDING_EXTRA]` (`sessionState.ts:87`) y
      `PARCIAL` incluye `/api/auth/mfa` (`:38`), así que **`POST /auth/mfa/verify` sí es
      alcanzable desde `onboarding`**; y `promoverSesion` lista ese estado entre los
      promovibles (`sessionPromotion.ts:50`), así que probar el factor por ahí levanta la
      sesión. El auditor comprobó que `/auth/stepup` está cerrado y concluyó que no había
      salida, sin mirar la ruta hermana que sí lo está.

      **Lo que queda es del cliente, y va en la Tarea 8:** elegir la puerta según el estado
      — `parcial` y `onboarding` → `/mfa/verify`; `completa` → `/stepup`. Llamar a `/stepup`
      desde `onboarding` da un 403 sin `code`: confuso, no un encierro.
- [ ] Tests que fallen antes y pasen después, **y mutarlos en los dos sentidos**: una mutación
      que no pone nada en rojo significa que el test no existe.

## Tarea 1b — La red se entrega sola

**Hallazgo propio, 2026-09-02, encontrado verificando A15.** **Decisión de Isaias:** los diez
códigos se entregan al configurar el móvil.

Confirmar el TOTP **no genera códigos de recuperación**: `grep` sobre `totp.controller.ts` no
encuentra ni una referencia a `regenerarCodigos`. Hay que acordarse de ir a otra sección
(`RecoveryCodesSection.tsx:90-95`) y teclear la contraseña otra vez.

**Por qué eso es el agujero de verdad, y no la puerta:** los códigos de recuperación van con
bcrypt, **no cifrados**, así que son lo único que sobrevive a una clave rota. Quien configure
su móvil el día del despliegue y no entre en esa sección se queda sin ninguna salida, no lo
sabe, y el botón con el que otro administrador le rescataría es uno de los dos rotos (A8).

- [ ] Al confirmar el primer factor, generar los diez códigos y devolverlos en esa misma
      respuesta. 🔴 Es la **única** vez que se pueden enseñar: `regenerarCodigos` los entrega
      en claro una sola vez y después solo queda el hash.
- [ ] La pantalla los enseña ahí mismo, con un «ya los he guardado» **obligatorio** antes de
      dar el registro por terminado.
- [ ] 🔴 Si la generación falla, **el factor no queda confirmado**: entregar un factor sin red
      es peor que no entregarlo. Y al revés, no dejar códigos huérfanos si el factor no
      confirma. Decidir la transacción, no dejarla implícita.
- [ ] Que regenerar más tarde siga funcionando igual — no se toca esa ruta.

## Tarea 2 — El contrato del 403, enriquecido

**Hallazgos:** A4 (🔴), A13 (🟠). **Decisiones de Isaias 2, 4.**

Dos campos nuevos, los dos **aditivos**: nada que los ignore se rompe.

- [ ] **`exigeContrasena: true` en el 403 de `sin-factor-reciente`**, cuando la ruta la pide.
      Sin esto el modal no puede saber que después del código vendrá la contraseña, y la
      ceremonia son dos ventanas seguidas — lo que la decisión 2 descarta. `requireStepUp.ts`
      ya tiene la opción en el ámbito; es pasarla a `denegar`.
- [ ] **`intentosRestantes`** antes del bloqueo, en la respuesta de `POST /auth/stepup` cuando
      el código falla, y en el 403 `contraseña-incorrecta` para el presupuesto de contraseña.
      No filtra nada: el umbral (5) está en el código fuente y solo se responde a una sesión
      ya autenticada. Lo que evita es que alguien se quede fuera del ERP sin haber leído un
      solo aviso.
- [ ] 🔴 **El mensaje del 429 debe decir qué más arrastra** (A6): el cubo `pc:<id>` es
      compartido con «cambiar mi contraseña» y «registrar mi correo» —las dos pantallas a las
      que esa persona iría a arreglarlo—, y el texto actual no lo dice.
- [ ] Actualizar `docs/specs/2026-08-21-autenticacion-mfa-design.md` §7 con los campos nuevos.

## Tarea 3 — Las líneas de bitácora que dejan de ser críticas

**Hallazgo:** A19 (🟡).

- [ ] `requireStepUp.ts:479-490` escribe `STEP_UP_DENIED` con `severity: "critical"` en **cada**
      negativa. Con el interceptor global, una operación legítima deja **dos** líneas críticas,
      sistemáticamente. Bajar a `warning` los motivos rutinarios (`contraseña-requerida`,
      `sin-factor-reciente`) y dejar `critical` para `contraseña-incorrecta` y
      `estado-incompleto`. Si todo es crítico, nada lo es.

## Tarea 4 — Las cinco llamadas sin cuerpo

**Hallazgos:** A8 (🔴), A9 (🔴 **medido**), A10 (🟠 **medido**).

🔴 **Leer «Lo medido» de la pre-auditoría antes de tocar esto.** `axios.post(url)` sin cuerpo
deja `Content-Type: application/x-www-form-urlencoded` escrito en `config.headers`; el servidor
solo monta `express.json()`; el reenvío sale como formulario y **el motivo vuelve idéntico,
para siempre**.

- [ ] `resetMfaUsuario` (`Usuario.api.ts:103`) y `desbloquearUsuario` (`:119`): mandar `{}`.
      Una línea cada una, y cierran los dos 403 que hoy sufre producción.
- [ ] `deleteUsuario` (`Usuario.api.ts:129`), `archiveRol` (`Rol.api.ts:52`), `endSession`
      (`Login.api.ts:443`): `axios.delete(url, { data: {} })`. **Precedente que lo valida:**
      `deleteTotp` (`Mfa.api.ts:168`) ya lo hace así contra una ruta con `exigeContrasena` y
      funciona; Express parsea el cuerpo de un DELETE con `Content-Type: application/json`.
- [ ] Un test que pine el `Content-Type` saliente de cada una. Es el único sitio donde el
      bucle es visible antes de que ocurra.

## Tarea 5 — Un solo sitio para el contrato del step-up

**Hallazgo:** A18 (🟡).

- [ ] Módulo nuevo (p. ej. `web/src/api/stepUp.ts`) con `CODIGO_STEP_UP`, el tipo de los
      cuatro motivos y `describeStepUpError`. Hoy la constante está duplicada en
      `Login.api.ts:390` y `Mfa.api.ts:46`, y la tabla de mensajes solo en `Mfa.api.ts:64-84`.
- [ ] Los dos ficheros pasan a importar de ahí. 🔴 Comparar siempre por constante, **nunca**
      por el texto en español.

## Tarea 6 — El interceptor

**Hallazgos:** A1, A3, A5, A7, A9, A10, A11, A16, A17, A20, A21, A22.

Vive en `web/src/api/http.ts`, a nivel de módulo. **No sabe nada de React.**

- [ ] **Disparador exacto:** `403` + `code === CODIGO_STEP_UP` + `isOurApi(config)`. Exportar
      `isOurApi` desde `SesionProvider.tsx:525-532` y **reutilizarlo, no copiarlo**: la razón
      por la que existe (URLs de imágenes salidas de la base de datos) aplica igual aquí.
- [ ] **Excluir por URL** `/auth/stepup` y `LOGOUT_URL` (A17), por el motivo que
      `SesionProvider.tsx:660-670` ya explica: la exclusión por URL es la barrera que aguanta.
- [ ] **Cola de una sola ceremonia** (A5, A7). La primera petición que reciba 403 abre el
      modal; las siguientes esperan **esa misma promesa** y se reintentan con su resultado.
      Sin esto, un código correcto tecleado una vez produce N−1 cargos contra el bloqueo de
      la cuenta.
- [ ] **Tope de dos reintentos por petición**, marcado en el `config`. Y **cero** para
      `estado-incompleto` (A11).
- [ ] **Normalizar el cuerpo, en las tres formas** (A9, A10) — esto es literalmente lo medido:
      - cuerpo JSON existente → `JSON.parse(config.data)`, añadir, `JSON.stringify`;
        **nunca** un spread sobre `config.data`, que es una **cadena**;
      - sin cuerpo → asignar un **objeto**, no una cadena;
      - y **forzar `Content-Type: application/json`** siempre, porque `config.headers` puede
        venir contaminado a `x-www-form-urlencoded` de la petición original.
- [ ] **No reintentar `POST /auth/totp/confirm`** (A22): su cuerpo caduca en 30 segundos.
- [ ] **Al cerrarse la sesión, rechazar explícitamente todo lo encolado** (A20) con un error
      reconocible. Si no, esas peticiones no se resuelven **ni se rechazan**: sus `await` no
      vuelven nunca y los spinners giran en componentes ya desmontados.
- [ ] Tests con el patrón que ya existe: espiar `axios.interceptors.response.use` y capturar
      los handlers (`SesionProvider.test.tsx:149`).

## Tarea 7 — El puente y el modal

**Hallazgos:** A4, A13, A14, A20. **Decisiones de Isaias 2, 3, 4.**

- [ ] **El puente:** una función de módulo que el provider registra al montarse y retira al
      desmontarse. El interceptor la llama y recibe una promesa: lo que la persona tecleó, o
      un rechazo si canceló. Cola en el módulo, **no en contexto de React** (A16).
- [ ] **El modal**, uno para toda la aplicación, sobre `ui/alert-dialog` — que no se cierra
      con Escape ni haciendo clic fuera, que es lo correcto en una confirmación de identidad.
      Qué pide según el `motivo`:

      | motivo | qué pide | a dónde va |
      |---|---|---|
      | `estado-incompleto` | nada | mensaje + enlace al segundo factor. **No reintenta.** |
      | `sin-factor-reciente` | código (**y contraseña si el 403 lo avisa**, T2) | `POST /auth/stepup`, luego reenvía |
      | `contraseña-requerida` | contraseña | reenvía con `stepup_password` |
      | `contraseña-incorrecta` | contraseña, con el error a la vista | reenvía |

- [ ] **El aviso de intentos restantes** (A4), del campo que añade T2. Sin él, cinco códigos
      mal tecleados bloquean la cuenta y el mensaje de error es idéntico al de un código
      simplemente mal escrito.
- [ ] **El ping-pong de los diez minutos** (A13): si entre probar el factor y teclear la
      contraseña pasan más de diez minutos, el servidor vuelve a pedir el factor. El modal
      tiene que saber volver atrás sin perder nada, y decir por qué.
- [ ] Montarlo **fuera del árbol que `logout()` desmonta** (A20), o aceptar que desaparezca y
      que la cola rechace lo encolado.

## Tarea 8 — La llamada que falta

**Hallazgo:** A14 (🟠).

- [ ] `POST /api/auth/stepup` no tiene función cliente: `grep` sobre `web/src` no encuentra
      ninguna. Acepta **un solo campo**, `codigo` (seis dígitos → TOTP; cualquier otra cosa →
      código de recuperación). Devuelve `200 {message}` al acertar y `400` al fallar, con el
      **mismo texto** para código erróneo, repetido, cuenta bloqueada y fallo criptográfico.
- [ ] 🔴 **Un código, una llamada.** Y no reutilizar un código dentro de su misma ventana de
      30 segundos: el paso queda sellado (`mfa.controller.ts:282-283`) y el segundo intento
      cuenta como fallo contra el bloqueo. El modal pide el siguiente.

## Tarea 9 — Lo que se lee cuando se pasó el plazo

**Hallazgo:** A2 (🟠). **Decisión de Isaias 6.**

- [ ] En `onboarding`, 15 de las 19 rutas responden 403 desde `authenticate.ts:267-274`, **sin
      `code`**, así que el interceptor no lo toca — correctamente. Pero `createRol`, `editRol`
      y `createUsuario` hacen `.catch(() => 400)` y enseñan «no se pudo» pelado.
- [ ] Mensaje que diga qué pasa y enlace a la pantalla del segundo factor. **No cambia quién
      pasa.** Un cambio, quince pantallas.

## Tarea 10 — La auditoría de cierre

- [ ] Norma de Isaias: auditar antes **y después**. Agentes adversariales sobre lo construido,
      con el foco en las costuras — que es donde estuvo casi todo lo grave del 4B.
- [ ] Verificar personalmente los hallazgos que cambien decisiones, en vez de fiarse del
      informe.
- [ ] `npm run typecheck` y la suite entera en los dos repos. Eslint en sus errores
      preexistentes (3 en `api`, 15 avisos en `web`), ni uno más.

---

## Fuera de alcance

- **Passkeys (4C).** Reabren A12: ningún registro de passkey llama a `apagarLaMecha` porque
  aún no existe. Anotado ahí, no aquí.
- **Unificar los tres nombres de la contraseña.** `stepup_password` (la puerta), `oldPass`
  (`editUserName`, `editUserPass` — legítimo: la operación necesita la contraseña vieja como
  parte de lo que hace) y `pass` (`sendVerificationEmail`). El tercero **sí** es la misma cosa
  con otro nombre: `email.controller.ts:298-305` llama a `verifyOwnPassword` como pura
  confirmación de identidad, por el ataque documentado en `:230`. Montar esa ruta con
  `exigeContrasena: true` y borrar esa comprobación dejaría **una** sola manera de pedir la
  contraseña en toda la API. Se propone; toca código recién auditado y no bloquea el 4D.
