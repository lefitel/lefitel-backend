# El correo como segundo factor, y el correo con relevo entre proveedores — diseño

**Fecha:** 2026-09-03 · **Revisión 2**, tras tres auditorías adversariales sobre la revisión 1
(seguridad del factor, consistencia con el código, relevo de correo: 15 + 31 + 16 hallazgos;
los que cambiaban una decisión se verificaron en el código antes de incorporarlos).
**Estado:** propuesta, pendiente de la lectura de Isaias.

**Decisiones de Isaias del 2026-09-03 que este diseño ejecuta:** el código por correo es un
segundo factor **automático** para toda cuenta con correo verificado, **a la par** con la
app TOTP, la llave y los códigos de recuperación; **sin avisos** de seguridad, la bitácora
registra el método; el correo sale por **cinco proveedores gratuitos con relevo**; SMS y
WhatsApp **descartados**.

**Tres consecuencias que Isaias debe conocer** (§1.2) y que este diseño asume salvo que diga
lo contrario: la doble ceremonia en permisos, roles y usuarios; el rescate por consola; y
que un correo pueda llegar dos veces en un caso raro.

Continúa la especificación de autenticación
([`2026-08-21-autenticacion-mfa-design.md`](./2026-08-21-autenticacion-mfa-design.md)) y
los planes 4A–4D. Donde este documento y aquélla se contradigan, manda éste, y el motivo
está escrito.

---

## 1. Por qué

Hoy el segundo factor exige o una app de autenticación en el móvil o una llave de acceso.
Nueve personas, ninguna técnica, y el plazo de catorce días cierra el ERP a quien no
configure una de las dos. Este diseño convierte la dirección de correo verificada en un
factor por sí misma, para que **verificar el correo sea la única configuración que hace
falta**, y deja la app y la llave como mejoras voluntarias.

Y el correo, que pasa a estar en el camino de cada login, no puede depender de una sola
cuenta gratuita: Resend corta a 100 al día y suspende cuentas sin avisar. Cinco proveedores
con relevo automático convierten «el correo está caído» en «un proveedor está caído».

**Lo que esto cambia de verdad:** el cupo de correo de la empresa pasa a ser la
disponibilidad del ERP. Buena parte de este documento existe para que nadie —ni un
desconocido desde fuera, ni una cuenta con la contraseña robada— pueda gastarlo.

### 1.1 Lo que este diseño acepta y hay que decir en voz alta

**El buzón ya es el canal para restablecer la contraseña. Ahora también es el segundo
factor.** Quien controle el buzón de una persona restablece su contraseña y pasa el segundo
factor, aunque esa persona tenga app o llave: elige el camino del correo. La app y la llave
protegen contra el robo de la contraseña a secas, no contra el robo del buzón. Con nueve
buzones de Google con su propia verificación en dos pasos, Isaias lo da por aceptable. Las
rutas que exigen contraseña en cada escritura (D6: permisos, roles, usuarios) siguen
exigiéndola.

**Lo que no se acepta:** que el código sea adivinable (seis cifras, cinco intentos cobrados
de forma atómica, diez minutos); que se pueda pedir sin la contraseña; que vaciar el cupo de
correo sea gratis o barato; que un fallo de un proveedor deje a todo el mundo fuera; y que
un enlace de verificación o de recuperación pase por el servidor de seguimiento de clics de
un proveedor.

### 1.2 Tres consecuencias que Isaias debe conocer

1. **Permisos, roles y usuarios piden dos cosas cada diez minutos.** Hoy nadie tiene factor
   y esas rutas piden solo la contraseña. Con el correo como factor, `requireStepUp` exige
   primero un factor reciente y después la contraseña (D6): un administrador cuyo único
   factor sea el correo pedirá un código, esperará el correo, lo teclea, y teclea la
   contraseña — una vez por ventana de diez minutos de trabajo administrativo. Es lo que
   «factor completo» significa (D3). La alternativa —que en esas rutas baste la contraseña
   cuando el único factor es el correo— deja una sesión robada más la contraseña a un paso
   de la matriz de permisos, que es lo que D6 existe para impedir. **Este diseño mantiene la
   doble ceremonia.**
2. **`--set-email` desde la consola del contenedor es, por sí solo, una toma completa de
   cualquier cuenta**, incluidas las que tienen llave: pone una dirección verificada, y con
   ella se restablece la contraseña y se pasa el segundo factor. Antes hacían falta dos
   invocaciones (`--set-email` y `--reset-mfa`, que la consola se niega a ejecutar juntas);
   ahora una. Quien tiene la consola tiene la base de datos, así que el control real siempre
   fue la traza, no la prohibición: `avisarRescate` al buzón de seguridad **antes** de
   escribir, y la línea `RESCUE_EMAIL_SET` en la bitácora. **Este diseño mantiene esa
   traza, añade a la salida de la consola la frase «esta dirección es ahora un segundo
   factor», y no añade más barreras.**
3. **Un correo puede llegar dos veces.** Cuando un proveedor corta la conexión después de
   recibir el mensaje y antes de confirmarlo, no se puede saber si lo entregó. El diseño
   **relevará al siguiente proveedor también en ese caso**: el coste es una copia duplicada
   de un mensaje que es inofensivo por duplicado (un código, un enlace de un solo uso, un
   aviso), y el coste de no relevar es una persona que no puede entrar. La garantía es «a lo
   sumo un código, a lo sumo dos copias».

---

## 2. Arquitectura

```
                       POST /api/auth/mfa/email-code            (sesión parcial, onboarding o completa)
  cliente  ──────────────────────────────────────────────►  emailCode.controller
                                                             │  1. la cuenta no está bloqueada y tiene correo verificado
                                                             │  2. hayProveedorDisponible("mfa/codigo")  ← ANTES de tocar nada
                                                             │  3. cooldown 60 s · 5 por hora · 12 por día  (codigo_correo)
                                                             │  4. emitirCodigo → fila con hash bcrypt (el anterior muere)
                                                             │  5. enviarCorreo(flujo "mfa/codigo", plazo 12 s)
                                                             ▼
                                                        mailRelay ── resend ── mailjet ── smtp2go ── mailtrap ── elastic
                                                             (orden fijo · cupo por proveedor con reserva para login y avisos
                                                              · cada fallo clasificado · disyuntor · a lo sumo dos copias)

                       POST /api/auth/mfa/verify  { codigo, metodo: "correo", recordar }
                       POST /api/auth/stepup      { codigo, metodo: "correo" }
  cliente  ──────────────────────────────────────────────►  mfa.controller
                                                             │  forma ^\d{6}$ · cubo por cuenta · cobro atómico del intento
                                                             │  bcrypt fuera de la transacción · liquidar + promover en una
                                                             ▼
                                                        sesiones.mfa_source = 'correo'
```

Tres piezas nuevas en el servidor y ninguna pantalla nueva en el cliente:

- **`auth/emailCodeStore.ts`** — emite y gasta códigos; es el único que toca la tabla
  `codigo_correo`. Sigue el molde de `recoveryCodeStore.ts` (bcrypt, `used_at`, gasto en
  una sola sentencia).
- **`controllers/emailCode.controller.ts`** — la ruta que pide un código.
- **`auth/mailRelay.ts` + `auth/mailProviders.ts`** — la cadena de proveedores detrás de
  `enviarCorreo`. La firma de `enviarCorreo` **se amplía sin romper**: el resultado gana
  `proveedor`, `id` y `motivo` opcionales.

Lo que cambia de lo que ya existe: `factorInventory.ts` distingue dos preguntas (§3.1);
`FuenteMfa` y `MetodoReautenticacion` ganan `"correo"`; `verify` y `stepup` aceptan el
discriminador `metodo`; `verifyEmail` promueve la sesión y apaga la mecha; los dos borrados
de credencial y el cambio de dirección aprenden qué queda después; y el cliente dibuja el
correo como un método más.

---

## 3. El correo como factor — las reglas

### 3.1 Dos preguntas, no una

La revisión 1 hacía que «correo verificado» entrara en `tieneAlgunFactor` sin más. Las tres
auditorías encontraron el mismo agujero por caminos distintos: **hay código que pregunta
«¿tiene esta cuenta una credencial registrada?» y código que pregunta «¿tiene con qué
probarse?», y hoy las dos preguntas tienen la misma respuesta.** Con el correo dejan de
tenerla. `factorInventory.ts` las separa:

| Pregunta | Función | Cuenta | Quién la usa |
|---|---|---|---|
| ¿Tiene con qué probarse? | `tieneAlgunFactor` | passkeys, TOTP confirmado, **correo verificado** | `estadoInicialDeSesion`; `requireStepUp`; las guardas de códigos de recuperación (acuñar y gastar) |
| ¿Tiene una credencial registrada? | `tieneCredencialRegistrada` (la función de hoy, renombrada) | passkeys, TOTP confirmado | la red del login sin contraseña (`factor-desaparecido`); las colas de `deleteTotp` y `deleteCredential`; el texto del rescate |
| ¿Con qué puede probarse ahora? | `metodosDeReautenticacion` | `passkey`, `totp` legible, `codigo`, **`correo`** | el 403 del step-up |
| ¿Hay algo verificable? | `hayFactorVerificable` | passkeys, TOTP legible, **correo verificado** | `requireStepUp` con `toleraFactorIlegible` |

`estadoInicialDeSesion` devuelve `conFactor` **y** `conCredencial`; `terminarLogin` usa
`conCredencial` en la red del login por llave, porque esa red existe para detectar que la
llave desapareció durante la ceremonia, y una dirección verificada no dice nada de eso.

La lectura del correo verificado es `UsuarioModel.findByPk(id, { attributes:
["email_verified_at"] })`, no un `count`: `app.auth.test.ts` comparte el espía de
`UsuarioModel.count` con la comprobación de «rol en uso», y acoplar las dos preguntas a un
espía es cómo se cuelan los tests que pasan por otro motivo.

### 3.2 Consecuencias, todas deliberadas

- **Verificar el correo es el final del onboarding.** `verifyEmail` hace en una transacción
  lo mismo que `confirmTotp` y `registerVerify`: `promoverSesion(id_sesion, "correo")`, si
  devuelve `false` `sellarPruebaDeFactor`, y `apagarLaMecha`. Solo `apagarLaMecha`, como
  decía la revisión 1, dejaba a una sesión `onboarding` encerrada en `onboarding` (el estado
  guardado nunca se ensancha) y a una `completa` sin sello, rechazada en cada escritura
  protegida hasta que cerrara sesión. La línea `EMAIL_VERIFIED` dice que desde ahora el
  correo es factor.
- **Una cuenta con solo correo puede tener códigos de recuperación.** La guarda de `POST
  /recovery-codes` usa `tieneAlgunFactor`, así que deja de rechazar a esas cuentas; es la
  copia de seguridad para un buzón inaccesible, y el perfil lo dice. `stepup` gana la misma
  guarda que `verify` ya tiene en su rama de código de recuperación: hoy falta, y con
  cuentas que pueden acuñar códigos sin app ni llave, la asimetría importa.
- **Borrar la última credencial ya no es quedarse sin factor.** `deleteTotp` y
  `deleteCredential` preguntan `tieneCredencialRegistrada` para lo que trata de
  credenciales y `tieneAlgunFactor` para lo que trata de sesiones:
  - sin credencial → **se revocan los equipos recordados siempre** (la regla de
    `totp.controller.ts`: quitar una credencial invalida lo que confió en ella);
  - sin credencial **y** sin correo verificado → además se revocan las sesiones y se limpia
    la cookie, con `LAST_FACTOR_REMOVED` y «volverás a entrar solo con tu contraseña», como
    hoy;
  - sin credencial **con** correo verificado → `LAST_CREDENTIAL_REMOVED` (verbo nuevo, con
    `queda_correo: true`) y «a partir de ahora entrarás con un código a tu correo». Las
    sesiones siguen: la cuenta sigue teniendo factor.
- **Cambiar de dirección quita el factor.** `/email/send` a otra dirección pone
  `email_verified_at = NULL`. Si la anterior estaba verificada y no queda credencial, **se
  revocan los equipos recordados y todas las demás sesiones** (fueron de confianza por un
  factor que ya no existe, y una sesión `completa` nunca se estrecha sola: una cookie en
  otro equipo conservaría las escrituras protegidas sin contraseña). **Salvo la sesión que
  hace la petición**, porque la verificación de la dirección nueva la necesita — la
  auditoría de la tarea 3 encontró que la revisión 2 dejaba todas las sesiones. En el
  siguiente login, `estadoInicialDeSesion` estampa catorce días nuevos: la misma regla y la
  misma deuda que borrar la última llave.
- **Cambiar de dirección exige la contraseña, y eso no lo pone `requireStepUp`.** La
  revisión 1 atribuía la defensa a la puerta. Es falso para el caso que importa: una cuenta
  que aún no verificó nada no tiene factor, y la puerta con `permiteOnboarding` la deja
  pasar. Lo que impide que una cookie robada ponga la dirección del atacante es el campo
  `pass` que `sendVerificationEmail` exige por su cuenta. **Ese campo se queda y un test lo
  pinna.** Una vez verificada la dirección, la puerta sí exige el factor: un código al buzón
  antiguo.
- **Una llave se puede registrar sin correo verificado** (solo `setupTotp` lo exige). Esa
  cuenta tiene credencial y no tiene correo; para ella todo funciona como hoy.
- **Una cuenta con app cuya clave de cifrado se perdió** (`toleraFactorIlegible`) ahora sí
  tiene un factor verificable: el correo. Antes solo podía esperar al rescate.
- **El rescate no toca el correo.** `restablecerSegundoFactor` borra llaves, TOTP y códigos
  y deja la dirección verificada. Para la cuenta con correo verificado eso significa que el
  siguiente login pedirá un código por correo, y la gracia de 24 horas que el rescate
  calcula no se usa en ese camino. La salida de la consola (`rescue.ts`) y la respuesta del
  endpoint dejan de decir «ya puede entrar solo con su contraseña» y dicen: «sigue teniendo
  el correo como segundo factor; si perdió el buzón, `--set-email` o `--clear-email`».

### 3.3 El código

| Parámetro | Valor | Por qué |
|---|---|---|
| Forma | 6 cifras, `crypto.randomInt(0, 1_000_000)` con ceros a la izquierda | lo que la gente sabe teclear desde un correo en el móvil |
| Validez | 10 minutos (`EMAIL_CODE_TTL_MS`) | el correo tarda; más largo alarga la ventana de adivinación |
| Intentos | 5 por código (`EMAIL_CODE_MAX_ATTEMPTS`), **cobrados antes de comparar, en una sola sentencia** | 5 de 1.000.000 por código, y que lo sea también con peticiones concurrentes |
| Reenvío | 60 s entre códigos (`EMAIL_CODE_RESEND_SECONDS`) | un clic nervioso no gasta cuota |
| Topes por cuenta | 5 por hora (`EMAIL_CODE_HOURLY_LIMIT`), **12 por día** (`EMAIL_CODE_DAILY_LIMIT`) | por hora no acota el día: 5/h son 120/día por cuenta, un cuarto del cupo de toda la empresa |
| Almacenamiento | bcrypt (`BCRYPT_COST`) en `codigo_correo.codigo_hash` | un volcado durante los diez minutos no revela el código; sha256 sobre seis cifras se invierte en milisegundos |
| Uno pendiente | emitir marca `used_at` en el anterior, **y el índice único lo garantiza** (§5) | nunca dos códigos válidos, ni con dos emisiones a la vez |
| Bloqueo | un código erróneo cobra `failed_attempts` como uno de la app | mismo `cargarIntentoFallido`, mismo `MFA_VERIFY_FAILED` |
| Coste de un intento | un `bcrypt.compare`, **también cuando no hay código pendiente** (contra `fillerHash()`) | «no hay código» y «código erróneo» tardan lo mismo; el repo ya mide y cierra esta fuga en el login |
| Cubo por cuenta | 20 intentos por cuarto de hora (`EMAIL_CODE_VERIFY_LIMIT`), en memoria, **antes de tocar la base** | acota el bcrypt que una sesión con la contraseña puede provocar; la forma `^\d{6}$` se comprueba antes |

**Por qué una tabla nueva y no `token_uso_unico`.** Esa tabla guarda sha256 del token y tiene
índice único sobre el hash. Para seis cifras, sha256 es reversible por fuerza bruta en
milisegundos, y el índice único haría fallar la emisión cuando dos personas reciban el
mismo código a la vez. Una tabla propia con bcrypt, sin unicidad sobre el hash y con
contador de intentos es lo honesto; `factor_totp` y `codigo_recuperacion` ya son tablas
propias por el mismo motivo.

**Por qué los topes de emisión viven en la base y no en memoria.** Cooldown, tope por hora y
tope por día se calculan sobre `codigo_correo.created_at` de la propia cuenta, gastadas o no.
Un reinicio no los olvida, y un segundo proceso los vería iguales. **Y por eso la purga
barre solo las filas de más de un día**, no «las gastadas o caducadas» como decía la
revisión 2: así escrita, borraba en cada emisión las filas de las que se cuentan los tres
topes, y el resultado era un código por minuto, para siempre, con solo la contraseña
(auditoría de las tareas 4–6). Una fila de más de un día está caducada muchas veces y fuera
de toda ventana. El cubo de **intentos de verificación** sí es en memoria: acota CPU, no
cuota, y un reinicio que lo olvide no regala nada que el cobro atómico no siga contando. Es
deslizante, no fijo, por la misma razón que el cupo de correo: una ventana que se reinicia
deja pasar el doble en su frontera.

### 3.4 Pedir el código — `POST /api/auth/mfa/email-code`

Bajo `/api/auth/mfa`, que ya está en la lista `PARCIAL` (`coincide` casa por segmentos, así
que `parcial`, `onboarding` y `completa` llegan sin tocar ninguna lista). Sin cuerpo.

El orden de las comprobaciones **es** el diseño:

1. Sesión → 401. Cuenta bloqueada (`estaBloqueada`) → 400 `CODIGO_MFA_INVALIDO`, como sus
   dos hermanas: una cuenta bloqueada no gasta cuota.
2. Sin correo verificado → 400 `{ message: "Tu cuenta no tiene un correo verificado." }`.
3. **`hayProveedorDisponible("mfa/codigo")` antes de tocar nada.** Si ningún proveedor puede
   enviar ahora mismo → 503 y **el código anterior sigue vivo**. La revisión 1 emitía antes
   de saber si podía enviar, que es exactamente el defecto que `mailBudget.test.ts` pinna
   para la verificación de correo («en un día agotado eso invalida el enlace pendiente y no
   manda ninguno nuevo»).
4. Cooldown, tope por hora, tope por día → 429 `{ message, reintento_en_s }`.
5. `emitirCodigo` (el anterior muere, el nuevo nace) y `enviarCorreo` con plazo de 12 s.
6. `ok: false` → 503 `{ message: "No se pudo enviar el código. Prueba otro método o inténtalo
   más tarde." }`. **El código recién emitido no se invalida:** el relevo puede haber
   entregado una copia que el servidor no pudo confirmar, y un código que llega y no vale
   cuesta cinco `failed_attempts` a quien lo teclea de buena fe. Lo mata el TTL o el
   siguiente reenvío.
7. 200 `{ message, enviado_a: "i***@gmail.com", reintento_en_s: 60 }`.

Bitácora: `MFA_EMAIL_CODE_SENT` (info) con la dirección enmascarada, `id_sesion` y el
`proveedor` que lo llevó; `MFA_EMAIL_CODE_FAILED` (warning) con el `motivo` del relevo.
Isaias no quiere avisos; estas líneas son operativas, para responder «no me llegó».
`purgarCodigosCaducados()` se lanza aquí sin esperar, como `purgeExpiredTokens` en el login:
no hay ningún planificador de purga de tokens al que sumarse. Barre solo las filas de más de
un día — §3.3 dice por qué no puede barrer «lo gastado».

### 3.5 Gastar el código — `verify` y `stepup`

Los dos endpoints aceptan `metodo?: "totp" | "codigo" | "correo"`. **Sin `metodo`, el
comportamiento es el de hoy** (seis cifras → TOTP, otra cosa → código de recuperación).
Cualquier otro valor —incluido `"passkey"`, que `MetodoReautenticacion` sí contiene pero
estas rutas no atienden— es 400 `METODO_DESCONOCIDO` sin gastar nada. La guarda
`tieneAlgunFactor` de la rama del código de recuperación se queda pegada a esa rama, se
llegue por forma o por `metodo`.

Con `"correo"`, y tras la forma y el cubo:

```
1. cobrar el intento, en UNA sentencia, sin transacción abierta:
     UPDATE codigo_correo
        SET intentos = intentos + 1,
            used_at  = CASE WHEN intentos + 1 >= :max THEN now() ELSE used_at END
      WHERE id_usuario = :u AND used_at IS NULL AND expires_at > :ahora
        AND email_destino = (SELECT email FROM usuarios WHERE id = :u
                             AND email_verified_at IS NOT NULL AND "deletedAt" IS NULL)
  RETURNING id, codigo_hash, (used_at IS NOT NULL) AS agotado
   → ninguna fila: "nada"  (compare contra fillerHash() y seguir como "invalido")
2. bcrypt.compare(codigo, codigo_hash) fuera de toda transacción
   → false: "invalido"
3. liquidar y promover, en una transacción:
     si NO agotado:
       UPDATE codigo_correo SET used_at = now() WHERE id = :id AND used_at IS NULL → 1 fila, o "nada"
     (si agotado, el cobro del paso 1 ya quemó la fila en la misma sentencia: no hay nada que
      liquidar, y liquidar encontraría su propia quema y la llamaría "nada")
     promoverSesion(id_sesion, "correo")            → false →
     sellarPruebaDeFactor(id_sesion, "correo")      → false → throw NadaQueSellar (deshace la liquidación)
```

`:ahora` es el reloj del proceso — el mismo que escribió `expires_at` en la emisión;
compararlo con el `now()` de la base, como decía la revisión 2, mezclaba dos relojes y un
desfase de diez minutos mataba cada código al nacer sin diagnóstico. `agotado` existe porque
la revisión 2 se contradecía a sí misma entre el paso 1 y el 3: el quinto intento quemaba la
fila y la liquidación la encontraba quemada, así que el quinto código **correcto** se
contestaba como erróneo y, por ser el quinto fallo, bloqueaba la cuenta. «Cinco intentos por
código» eran cuatro (auditoría de las tareas 4–6).

En `stepup` el tercer paso es el `UPDATE` directo con `estado: "completa"` que ese endpoint
ya usa para el código de recuperación — **no** `sellarPruebaDeFactor`, que no filtra por
estado y dejaría a una sesión `parcial` sellarse por la puerta del step-up.

El cobro antes de comparar es lo que hace verdad «cinco intentos por código» con peticiones
concurrentes: N peticiones en el mismo instante ven N valores distintos de `intentos`, y a
partir del quinto ninguna obtiene el hash. Es la forma de `recoveryCodeStore.ts` («la
sentencia que marca usado es la misma que comprueba que no lo estaba»).

Los tres caminos que no son éxito contestan lo mismo que hoy un TOTP erróneo: 400
`CODIGO_MFA_INVALIDO` con `intentosRestantes`, y cargan `failed_attempts`. Caducado no se
distingue de erróneo, ni en la respuesta ni en el tiempo.

Éxito: `MFA_VERIFIED` / `STEP_UP_REPROVED` con `fuente: "correo"` — lo que Isaias pidió que
quedara en la bitácora, y ya existe. `CODIGO_REQUERIDO` nombra los tres orígenes.

### 3.6 Lo que el cliente necesita saber, y lo que no se le dice

La revisión 1 devolvía `metodos` en el cuerpo del login y en `/auth/me` para una sesión
`parcial`. Eso invierte tres decisiones escritas: el cuerpo del login no lleva el
inventario de factores, `/auth/me` enmascara hasta la dirección por debajo de `completa`, y
`metodos` omite cuántos códigos quedan «porque le dice a una cookie robada cuánta pista
tiene». Una sesión `parcial` es de quien tiene la contraseña y solo la contraseña; decirle
si la cuenta tiene llave, app legible o códigos es la lista de la compra del ataque.

**Se retira.** El segundo paso del login dibuja los tres métodos por código siempre —como
hoy dibuja dos sin preguntar— más el botón de la llave si el navegador la soporta. La
dirección enmascarada la tiene ya el contexto: `LoginPage` llama a `/auth/me` antes de
navegar al segundo paso, y esa respuesta la enmascara para `parcial`. Una persona sin correo
verificado que pulse «Enviar código» recibe el 400 de §3.4 y lo entiende; un atacante con la
contraseña recibe un bit que ya tenía por otros medios y un correo que avisa a la víctima.

El diálogo del step-up sí sabe qué ofrecer: el 403 lo dice, y ahí la sesión ya probó algo.

---

## 4. El relevo entre proveedores

### 4.1 Contrato

```ts
enviarCorreo(correo: CorreoAEnviar, opciones?: { plazo_ms?: number })
  : Promise<{ ok: boolean; proveedor?: string; id?: string; motivo?: MotivoDeRelevo }>
```

Ampliación **aditiva**: las siete llamadas de hoy siguen compilando y siguen sin mirar más
que `ok`. `mailer.ts` conserva sus dos primeras líneas —el guard del test runner y el modo
desarrollo— y delega lo demás en `mailRelay.enviar`. Su docblock, que hoy dice «el que llama
no cambia su respuesta HTTP según `ok`», nombra la excepción: `/mfa/email-code` contesta 503
con `ok: false` porque quien pregunta ya está autenticado y no se enumera la dirección de
nadie.

`plazo_ms` es el plazo de **toda la cadena**: 12 s en los flujos que tienen a una persona
esperando (`/mfa/email-code`, `/email/send`, el rescate — `avisarRescate` va **antes** de
escribir nada, a propósito, y no puede colgar la vía de escape) y 60 s en los que no
(`/password/forgot`, avisos tras la respuesta). Sin él, los valores por defecto de nodemailer
son dos minutos por conexión y diez por socket, por proveedor: cuarenta minutos de login.

### 4.2 La cadena

```
para cada proveedor en orden:
  apartado, o sin cupo para este flujo                    → siguiente (antes de mirar el reloj: no cuesta tiempo)
  quedan menos de 4 s (MAIL_PLAZO_MINIMO_INTENTO_MS)      → parar: { ok:false, motivo:"plazo" }
  intentar, con plazo propio de 8 s (o lo que quede)
    ok                                                     → registrar { proveedor, id, ms }, devolver
    fallo → clasificar (tabla) →
        destinatario rechazado (5xx en RCPT TO, y SOLO ahí) → devolver { ok:false, motivo:"destinatario" }: no relevar, no apartar, no cobrar
        rechazo de contenido (5xx tras DATA o a la orden DATA) → cobrar, siguiente; no apartar
        temporal (4xx: greylisting, 421, "too many recipients"; 429 de ritmo de Resend) → siguiente; ni apartar ni cobrar
        avería (DNS, conexión, TLS, saludo; red caída de Resend) → siguiente; apartar tras DOS averías seguidas
        autenticación (535; 401 de Resend)                 → siguiente; apartar HASTA REINICIAR + error con el nombre
        configuración (5xx en MAIL FROM; sin STARTTLS; 403 de Resend) → siguiente; apartar HASTA REINICIAR + error: revisar dominio remitente / puerto
        cuota (SOLO "quota" / "sending limit"; daily/monthly_quota_exceeded) → cobrar todo el cupo local; siguiente; apartar hasta que ruede la ventana
        AMBIGUO (socket muerto o vencido tras DATA)        → cobrar; siguiente (§1.2.3: a lo sumo dos copias); cuenta como avería para el disyuntor
ninguno → { ok:false, motivo:"sin-proveedor" } y UNA línea error con el estado de toda la cadena
```

**Cambios tras la auditoría de la tarea 7 (2026-09-03) respecto a la revisión 2 de esta
tabla.** `destinatario` sólo en `RCPT TO`: nodemailer marca `EENVELOPE` también en `MAIL FROM`
y en la orden `DATA`, y un remitente rechazado (dominio sin validar en ese proveedor) archivado
como destinatario mataba cada mensaje en ese proveedor sin relevar, sin apartarlo, y culpando
al buzón de la persona. Nace la clase **`configuracion`** para eso y para «sin STARTTLS»:
relevar, no cobrar, apartar hasta reiniciar, y la línea dice qué revisar en el panel del
proveedor. El **429 por ritmo** de Resend y el **421** pasan a `temporal`: escribir el día
entero de un proveedor por una señal de caudal destruía la reserva justo con el aviso que la
reserva protege — sólo `daily/monthly_quota_exceeded` y los textos de cuota agotan el cupo. El
**ambiguo cuenta para el disyuntor**: un socket que se cuelga tras `DATA` en cada mensaje es
un proveedor caído, se archive como se archive cada intento. La **red caída de Resend** llega
como `application_error` sin estado —el SDK nunca lanza— y es avería, no contenido. Los
**plazos**: 8 s por intento y un mínimo de 4 s para empezar uno; con 10 s de 12, el segundo
proveedor recibía dos segundos, se le cobraba un ambiguo que no pudo mandar nada y el tercero
no llegaba nunca. Y `close()` sobre un transporte sin pool **no aborta** el envío en vuelo: la
copia puede llegar igual, que es exactamente por lo que el vencimiento se clasifica ambiguo.
En producción, un proceso sin cadena (la consola de rescate sin las variables de correo en su
entorno) recibe `ok: false`, no el `ok: true` del modo desarrollo: un aviso que no salió no
puede quedar en la bitácora como enviado.

**El disyuntor apartado de 15 minutos (`MAIL_PROVIDER_COOLDOWN_MS`) se abre tras dos averías
seguidas, no una**, y cuando vence deja pasar **un** intento de prueba antes de volver a
confiar. Un destinatario mal escrito **no** es una avería: en la revisión 1 un `550` en
`RCPT TO` apartaba a los cuatro SMTP de golpe y cobraba cuatro unidades por un mensaje que
nadie podía recibir.

**Qué se cobra.** Solo lo que el proveedor cobra: intentos que llegaron a `DATA`, y los
ambiguos. Un DNS caído, un puerto 587 cerrado, una autenticación mal puesta, no mueven el
contador del proveedor y no mueven el nuestro — si lo hicieran, un cortafuegos se comería
cuatro cupos diarios en silencio.

**`hayProveedorDisponible(flujo)`** es literalmente el primer paso del bucle («no apartado y
con cupo para este flujo»), expuesto para quien tiene que decidir algo destructivo antes de
enviar. Sustituye a `hayPresupuestoDeCorreo()` en `email.controller.ts` y
`password.controller.ts`, y el test que escanea las fuentes para exigir «la comprobación
antes de acuñar» cambia de aguja y gana el controlador nuevo. La revisión 1 la definía como
«algún proveedor tiene cupo», sin mirar el disyuntor: con los cinco apartados y los cupos
llenos, `sendVerificationEmail` habría borrado la dirección verificada y quemado los enlaces
para no enviar nada — el defecto que ese código documenta haber cerrado.

### 4.3 Cupos: por proveedor, con reserva

`mailBudget.ts` deja de ser un contador único y pasa a ser una fábrica: un contador por
proveedor con su tope, ventana deslizante de 24 h como hoy, aviso al 80 %, y el `flujo` como
etiqueta del log. Y **cada contador reserva el último cuarto de su tope** (`MAIL_RESERVA`)
para dos clases de mensaje: el código de login (`mfa/codigo`) y los avisos de seguridad
(`password/aviso-restablecida`, `email/aviso-cambio`, `rescate/aviso`). Los demás flujos
—verificación, recuperación de contraseña, aviso a la dirección anterior— se detienen en
el 75 %.

Es la respuesta a dos hallazgos. Uno: hoy `MAIL_DAILY_BUDGET = 80` frente a los 100 de Resend
existe para que «un desconocido que queme el cupo nunca sea el motivo de que un aviso de
toma de cuenta no salga»; cinco cupos sin reserva perdían esa propiedad. Dos, el grave:
**`/password/forgot` no pide credencial y admite 3 correos por hora y dirección**, y las
nueve direcciones son conocibles; 9 × 3 × 24 = 648 mensajes al día, más que los 490 de toda
la cadena. Sin reserva, cualquiera dejaba al ERP sin login antes de la tarde, cada día,
gratis. Con la reserva, esa inundación se detiene en el 75 % y el login sigue. **No** se
añade un tope diario por dirección a `/password/forgot` (la revisión 2 proponía
`PASSWORD_FORGOT_DAILY_LIMIT = 6`): un cubo así ya existió y se retiró porque cuenta
peticiones, no envíos — cincuenta POST con una dirección sin cuenta lo agotaban sin gastar un
correo, y su `RateLimit-Remaining` era además un oráculo. La reserva es la respuesta completa
a este hallazgo; lo que sí acota el día es el tope de 12 códigos por cuenta de §3.3.

Los contadores siguen en memoria y por proceso: es la deuda ya anotada, y con cinco
proveedores el peor caso de un reinicio es relevar antes de tiempo.

### 4.4 Proveedores y adaptadores

Dos adaptadores, no cinco: `resendProvider` (el código de hoy, movido a `mailProviders.ts`;
el test que escanea las fuentes para que nadie más importe `resend` cambia su lista de
excepciones) y `smtpProvider` con nodemailer, instanciado una vez por proveedor SMTP. Un
proveedor nuevo son variables, no código.

| Proveedor | Cómo | Usuario / contraseña | Cupo gratis verificado (2026-09-03) | Tope configurado | Rastreo de clics |
|---|---|---|---|---|---|
| Resend | API, SDK `resend` | `RESEND_API_KEY` | 100/día, 3.000/mes | 80 | apagado en el panel |
| Mailjet | SMTP `in-v3.mailjet.com:587` | API key **pública** / API key **privada** | 200/día, 6.000/mes | 180 | cabeceras `X-Mailjet-TrackOpen: 0`, `X-Mailjet-TrackClick: 0` en cada mensaje |
| SMTP2GO | SMTP `mail.smtp2go.com:587` | **usuario SMTP creado en el panel** (Sending → SMTP Users), no una API key | 200/día, 1.000/mes, **y 25/hora hasta verificar el dominio** | 30 | solo en el panel |
| Mailtrap | SMTP `live.smtp.mailtrap.io:587` | usuario literal **`api`** / token | 150/día, 4.000/mes | 120 | solo en el panel; **exige** el CNAME `mt-link` para dar el dominio por verificado |
| Elastic Email | SMTP `smtp.elasticemail.com:587` | correo de la cuenta / **credencial SMTP generada en el panel**, no la API key | 100/día, 3.000/mes; registro de envíos solo 3 días | 80 | cabeceras `trackopens: false`, `trackclicks: false` en cada mensaje |

**El rastreo de clics es un 🔴 del despliegue, no una preferencia.** Los enlaces de
verificación y de recuperación llevan el token en el fragmento (`#t=…`) precisamente para
que ningún servidor lo vea. Un proveedor con rastreo reescribe el `href` hacia su propio
dominio con la URL original —fragmento incluido— dentro: el token acaba en el registro de
clics de un tercero y en los escáneres de enlaces de Gmail. El adaptador manda las cabeceras
de «sin rastreo» en **todos** los mensajes de los dos proveedores que las tienen, y el
runbook exige apagarlo en el panel de los otros dos **antes** del primer envío real.

**El adaptador SMTP**, fijado y con test sobre el objeto que recibe `createTransport`:

```
secure: false · requireTLS: true · tls: { minVersion: "TLSv1.2" } · pool: false
connectionTimeout: 4000 · greetingTimeout: 4000 · socketTimeout: 8000 · dnsTimeout: 3000
+ plazo externo de 10 s por intento (los de nodemailer son por fase, no por intento)
```

`requireTLS` es obligatorio porque su valor por defecto es «cifra si el servidor lo ofrece,
si no sigue en claro»: un DNS secuestrado o un intermediario que borre `STARTTLS` recibiría la
contraseña del proveedor y el código en texto plano, con nodemailer informando de éxito.

**El guard del test runner se queda como primera línea de `enviarCorreo` y se repite en la
fábrica de transportes SMTP.** `sequelize.ts` carga `.env` en cada proceso de test; el día
que `MAIL_SMTP_*` esté en un `.env` de desarrollo, un `vi.mock` olvidado abriría sockets
reales con dos minutos de espera. La fábrica es inyectable para que los tests ejerciten el
relevo sin tocar el entorno.

**nodemailer 9.1.1** (publicada 2026-09-01), `import nodemailer from "nodemailer"` (CJS sin
mapa `exports`; los imports con nombre dependen del detector de CJS). `@types/nodemailer`
8.x, un major por detrás pero suficiente; **y hay que instalarlo**: con `strict: false`, sin
tipos el objeto de opciones es `any` y `connectionTimeOut` mal escrito compila.

**Los cuatro SMTP se eligieron** porque tienen plan gratis permanente, sin tarjeta, sin pie
publicitario (Elastic Email: no verificado en su web; se comprueba en el envío de prueba) y
con DKIM en dominio propio. Descartados: SendGrid (prueba de 60 días), ZeptoMail (crédito
único), Mailgun (cinco destinatarios sin tarjeta), Brevo y Loops (pie publicitario), Amazon
SES y MailerSend (tarjeta).

### 4.5 Configuración y arranque

```
MAIL_FROM=…@osefi.net
MAIL_PROVIDERS=resend,mailjet,smtp2go,mailtrap,elastic     # el orden es el orden del relevo
RESEND_API_KEY=…            MAIL_RESEND_DAILY=80
MAIL_SMTP_MAILJET_HOST=in-v3.mailjet.com   MAIL_SMTP_MAILJET_PORT=587
MAIL_SMTP_MAILJET_USER=…    MAIL_SMTP_MAILJET_PASS=…        MAIL_SMTP_MAILJET_DAILY=180
# … igual para SMTP2GO, MAILTRAP, ELASTIC
```

`configuracionDeCorreo(env, nodeEnv)` en `config/security.ts`, **pura**, devuelve **nombres
de variables, nunca valores** (`passVar`, no `pass`), de modo que el objeto entero se puede
escribir en el log de arranque y el adaptador lee el secreto en el momento de enviar, como
hacen hoy `mailer.ts` y `securityNotice.ts`:

```ts
type ProveedorConfigurado =
  | { tipo: "resend"; nombre: "resend"; claveVar: "RESEND_API_KEY"; cupoDiario: number }
  | { tipo: "smtp"; nombre: string; host: string; puerto: number; usuarioVar: string; passVar: string; cupoDiario: number };

type ConfiguracionDeCorreo =
  | { ok: true; modo: "envia" | "desarrollo"; from: string | null; proveedores: ProveedorConfigurado[]; descartados: { nombre: string; motivo: string }[] }
  | { ok: false; errores: string[] };   // "MAIL_PROVIDERS lista \"mailjet\", pero faltan: MAIL_SMTP_MAILJET_USER, MAIL_SMTP_MAILJET_PASS."
```

**Qué pasa al arrancar, y por qué así.** La revisión 1 decía «un proveedor a medias y el
proceso no arranca». Dos auditorías lo discutieron en sentidos opuestos: una, que refusar el
arranque por una errata en una variable de correo tumba el ERP entero para nueve personas,
que es la regla en rojo que `index.ts` ya aplica a la clave de cifrado del TOTP; otra, que
arrancar sin enviar es el fallo silencioso que `requiredEnv` existe para impedir. Las dos
tienen razón y se concilian así:

- **En producción, un proveedor listado con variables incompletas o desconocido se
  descarta de la cadena con una línea `fatal` que nombra las variables que faltan**, y el
  proceso arranca **si queda al menos un proveedor completo**. La cadena degradada es
  visible en la primera pantalla del log; el ERP no se cae por una errata.
- **Si no queda ninguno, el proceso no arranca.** Eso sí es el fallo silencioso que hay que
  convertir en fallo de despliegue.
- `requiredEnv` en producción exige `MAIL_PROVIDERS` y `MAIL_FROM`; **`RESEND_API_KEY` sale
  de esa lista** (exigirla rompería un despliegue válido de cuatro SMTP) y pasa a exigirla
  `configuracionDeCorreo` cuando `resend` está en la lista. `requiredEnv` no puede hacer
  esta comprobación por sí misma: decide nombres a partir del entorno, no del valor de otra
  variable, y su docblock dice por qué.
- Fuera de producción: sin `MAIL_PROVIDERS`, si hay `RESEND_API_KEY` y `MAIL_FROM` se asume
  `resend` con un `warn` («MAIL_PROVIDERS no está; asumo resend»), para que el `.env` de hoy
  siga enviando; sin nada, modo desarrollo como hoy. Un proveedor incompleto se descarta con
  un `warn`. **Lo que no puede existir es un proceso que envíe por algunos proveedores sin
  decir cuáles**: una línea `info` nombra la cadena viva al arrancar.

### 4.6 DNS

Medido en vivo el 2026-09-03: `osefi.net` tiene un SPF con una sola consulta (el reenvío
del registrador), `_dmarc` en `p=none` **sin `rua`**, y Resend firma con DKIM
(`resend._domainkey`) y usa su propio subdominio `send.osefi.net` para el SPF del sobre — es
decir, **Resend nunca tocó el SPF de la raíz**, y añadir cuatro proveedores ahí es un cambio
a un registro que Resend no necesitaba. Que nadie lo «ordene» después.

Lo que añade cada uno, contado por su documentación:

| Proveedor | Registros | Consultas SPF que añade |
|---|---|---|
| Mailjet | 1 TXT (`mailjet._domainkey`) + `include:spf.mailjet.com` | 1 |
| SMTP2GO | 2 CNAME (`s…._domainkey`, `em…` de retorno) | 0 (su CNAME de retorno ya hace pasar el SPF del sobre; el `include` es opcional) |
| Mailtrap | **4 CNAME** (verificación, `rwmt1._domainkey`, `rwmt2._domainkey`, `mt-link`) | 0 (no pide SPF) |
| Elastic Email | 1 TXT (`api._domainkey`) + `include:_spf.elasticemail.com` | **2** (su registro usa `exists:`, que cuenta como consulta y falla en vacío para IPs ajenas) |

Unos **nueve registros** y **4–5 consultas SPF** en total: bajo el límite de diez de RFC
7208, pero no por el motivo que decía la revisión 1. DMARC gana `rua=mailto:…` antes del
despliegue: un envío de prueba es una foto; sin informes agregados nadie sabrá que el
proveedor tres empezó a fallar la alineación en octubre. **No se mueve el correo a un
subdominio**: con nueve destinatarios el aislamiento de reputación no compensa rehacer
Resend.

Las cuentas, los registros y las claves los pone Isaias. Este repo no ve ninguna clave.

---

## 5. Esquema

Una migración, `20260903000001-create-codigo-correo`, con `createTable` y `DataTypes` como
las demás (los `DEFAULT` van en SQL crudo: Sequelize 6.37 se traga `DataTypes.NOW`, medido
en `20260827000001`):

```
codigo_correo
  id             INTEGER autoincrement PK          -- nunca sale al cliente; UUID solo donde sí sale
  id_usuario     INTEGER NOT NULL → usuarios(id) RESTRICT   -- todas las FK son RESTRICT: usuarios es paranoid
  email_destino  VARCHAR(255) NOT NULL             -- si la dirección cambia, el código muere con ella
  codigo_hash    VARCHAR(60) NOT NULL              -- bcrypt; mismo nombre que codigo_recuperacion
  intentos       SMALLINT NOT NULL DEFAULT 0
  expires_at     TIMESTAMPTZ NOT NULL
  used_at        TIMESTAMPTZ NULL
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()

codigo_correo_pendiente_idx      UNIQUE (id_usuario) WHERE used_at IS NULL   -- el gasto, y la regla «uno pendiente»
codigo_correo_cuenta_creado_idx  (id_usuario, created_at)                    -- cooldown y topes
codigo_correo_expires_at_idx     (expires_at)                                -- la purga (nombre por la regla del arco)

ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_mfa_source_chk;
ALTER TABLE sesiones ADD CONSTRAINT sesiones_mfa_source_chk
  CHECK (mfa_source IS NULL OR mfa_source IN ('passkey', 'totp', 'codigo', 'dispositivo', 'correo'));
```

**El índice del pendiente es UNIQUE** (auditoría de la tarea 1): «nunca dos códigos válidos»
era una regla que solo cumplía la secuencia del emisor, y dos emisiones simultáneas —doble
clic, dos pestañas, dos procesos— insertan dos filas, el gasto cobra un intento en las dos
y devuelve dos hashes. Con el índice único, la segunda emisión falla con `23505` y el
almacén lo lee como «alguien acaba de emitir uno».

**`ADD CONSTRAINT` liso, y la revisión 2 de este documento decía otra cosa.** Decía `NOT
VALID` + `VALIDATE` «porque no puede vencer el plazo». Dentro de una transacción es falso:
`ADD CONSTRAINT … NOT VALID` toma ACCESS EXCLUSIVE, los bloqueos de tabla se retienen
hasta el commit, y el `VALIDATE` siguiente recorre la tabla bajo ese mismo bloqueo; y
`lock_timeout` aborta a quien *espera* un bloqueo, no a quien recorre teniéndolo. El par
solo ayuda con el `VALIDATE` en otra transacción, que es la forma para una tabla grande.
`sesiones` tiene decenas de filas y la restricción ampliada las cumple todas por
construcción. Dentro de una transacción, con `SET LOCAL lock_timeout = '5s'`, con su test al
lado. `down` borra la tabla y repone la restricción de cuatro valores, byte a byte la de
`20260826000002`, **solo si ninguna sesión lleva `'correo'`**; si la hay, falla con un
mensaje que dice qué borrar. La carpeta `migrations/pending/` no pinta nada aquí.

`codigoCorreo.model.ts` lleva el `defaultScope` que excluye `codigo_hash` y el `toJSON` que
lo omite, como `codigoRecuperacion.model.ts` (hallazgo B10: una fila que llega a un `res.json`
publica el hash); `ICodigoCorreo` en `interfaces/index.ts`; `hasMany`/`belongsTo` con
`UsuarioModel`. **`deleteUsuario` no borra nada aquí**, y la revisión 2 decía que sí «como
con las otras cuatro tablas»: verificado, ese endpoint archiva la cuenta y revoca sesiones y
equipos, y no toca ninguna tabla de factor. Un código vive diez minutos; la purga de la
§3.4 lo barre.

---

## 6. El cliente

Sin pantallas nuevas. Lo que cambia:

**El segundo paso del login** (`pages/login/SegundoFactorPage.tsx`). Tres pestañas siempre
—«Código de la app», «Código por correo», «Código de recuperación»— y el botón de la llave
si el navegador la soporta. La de correo muestra la dirección enmascarada del contexto, un
botón «Enviar código» con cuenta atrás de `reintento_en_s`, y la caja de seis cifras;
`verifySecondFactor(codigo, recordar, "correo")`. **No se envía solo al llegar.** La revisión
1 lo hacía cuando el correo era el único método, y con el tope por hora en la base, cuatro
recargas de la página dejaban a la persona una hora sin poder entrar. Un 429 muestra la
cuenta atrás con el `reintento_en_s` del servidor; un 503, «prueba otro método». Y
`intentosRestantes`, que hoy `verifySecondFactor` descarta, llega a la pantalla: cinco
códigos mal tecleados bloquean la cuenta, y hay que avisarlo antes del quinto.

**El diálogo del step-up** (`components/dialogs/StepUpDialog.tsx`). Hoy tiene **una** caja de
código cuya etiqueta es «app o recuperación» según lo que ofrezca el servidor, y manda el
código sin decir de qué clase es. Con tres clases, seis cifras son ambiguas: un código de
correo tecleado ahí se comprobaría como TOTP, fallaría y cobraría un intento. El bloque de
código gana un **selector de clase** (app / correo / recuperación, solo las que `metodos`
liste), y tanto `verifySecondFactor` como `probarStepUp` —que hoy manda `{ codigo }` y nada
más— envían `metodo`. La de correo lleva su botón «Enviar código» con cuenta atrás. Aquí no
se envía solo, por el mismo motivo que arriba y porque el diálogo aparece encima de una
operación. `describeMetodos` gana «pide un código a tu correo».

**El perfil** (`pages/menu/perfil/PerfilPanel.tsx`, donde vive la fila «Correo verificado»,
y `PerfilAcceso.tsx`, que hoy presenta la dirección solo como canal de recuperación): «Tu
correo verificado es tu segundo factor. Guarda códigos de recuperación por si pierdes el
acceso al correo.» Y dos frases que se vuelven falsas y se corrigen: en `TotpSection.tsx` y
`PasskeysSection.tsx`, «si no tienes otro factor volverás a entrar solo con tu contraseña»
pasa a distinguir si queda el correo.

`stepUpInterceptor.ts`: `/auth/mfa/email-code` entra en `RUTAS_EXCLUIDAS` (el emparejamiento
es por subcadena y `/auth/mfa/verify` no la cubre), por el mismo motivo que
`/auth/mfa/verify`: es una ruta que la propia ventana usa para cubrir el step-up.

---

## 7. Endpoints, resumidos

| Método y ruta | Sesión | Puerta | Nuevo |
|---|---|---|---|
| `POST /api/auth/mfa/email-code` | parcial, onboarding o completa | `authenticate` | sí |
| `POST /api/auth/mfa/verify` | parcial | `authenticate` | gana `metodo` |
| `POST /api/auth/stepup` | completa | `authenticate` | gana `metodo`; gana la guarda de `tieneAlgunFactor` en la rama del código |
| `POST /api/auth/password/forgot` | — | cubos | gana el tope diario por dirección |

`routeGuards.test.ts`: la ruta nueva entra **solo** en `GATE_NOT_APPLICABLE` (escritura sin
permiso); no en `AUTHENTICATION_NOT_APPLICABLE` (lleva `authenticate`) ni en `STEP_UP_GATED`
(no lleva `requireStepUp`, por construcción: es un medio para satisfacerlo). La revisión 1
decía «las tres listas»; dos de ellas habrían fallado.

---

## 8. Pruebas

Lo de siempre en este arco: cada test nuevo se rompe con una mutación antes de darse por
bueno, y `routeGuards` y `vocabulary` siguen siendo los que impiden que una ruta se monte
sin puerta o pida un permiso inexistente. Lo específico, incluidos **los tests que seguirían
en verde sin cubrir nada** y hay que retocar:

- **`emailCodeStore`**: el cobro es una sentencia (el test simula dos gastos concurrentes y
  exige que solo cinco reciban hash); el quinto fallo quema; el sexto es `"nada"`; `"nada"`
  compara contra `fillerHash()`; emitir invalida el anterior; cooldown, tope por hora y tope
  por día con reloj fijo; `email_destino` distinto o correo sin verificar → `"nada"`;
  liquidar es `WHERE id AND used_at IS NULL` y devuelve cuántas filas.
- **`verify`/`stepup`**: `"correo"` bueno promueve en la misma transacción; `promoverSesion`
  falso → sellar; sellar falso → `NadaQueSellar` y el código sigue sin gastar; erróneo carga
  `failed_attempts`; `metodo` desconocido → 400 sin tocar la base; **sin `metodo`, seis
  cifras siguen yendo a TOTP**; la guarda `tieneAlgunFactor` sigue en la rama del código
  llegando por `metodo: "codigo"`; `stepup` gana esa guarda.
- **`factorInventory`**: las dos preguntas responden distinto para una cuenta con solo
  correo; `estadoInicialDeSesion` devuelve `conFactor: true, conCredencial: false` para ella;
  el test gana una cuarta tabla falsa (`usuarios`) — hoy simula tres, y una cuarta sin
  simular haría un `SELECT` real contra la base configurada.
- **`finishLogin`**: la red del login por llave usa `conCredencial`.
- **`verifyEmail`**: las tres escrituras en la transacción; una sesión `onboarding` sale
  `completa`.
- **`deleteTotp` / `deleteCredential` / `sendVerificationEmail`**: las tres colas de §3.2,
  con los dos verbos; hoy sus tests simulan `factorInventory` entero y no verían nada.
- **`sendVerificationEmail`** sigue exigiendo `pass` (el test que lo pinna).
- **Bucles que enumeran fuentes** en `sessionState.test.ts` y `app.auth.test.ts` ganan
  `"correo"`; `factorInventory.test.ts` y `Login.api.test.ts` comparan con `toStrictEqual`,
  no con `toEqual`, que ignora claves `undefined`.
- **`mailRelay`**: cada fila de la tabla de clasificación es un test con un error de
  nodemailer simulado (`EENVELOPE` 550 en `RCPT TO` no releva ni aparta ni cobra;
  `ECONNECTION` «closed unexpectedly» tras `DATA` cobra y releva; `EAUTH` aparta hasta
  reiniciar); el disyuntor abre a la segunda avería y prueba una vez al vencer; el cupo se
  cobra solo en `DATA` y ambiguo; la reserva detiene `email/verificar` en el 75 % y deja
  pasar `mfa/codigo`; el plazo de cadena corta el bucle; `hayProveedorDisponible` es falso con
  todos apartados aunque los cupos estén llenos; ninguno disponible → `motivo:
  "sin-proveedor"` sin llamar a nadie.
- **`smtpProvider`**: el objeto que recibe `createTransport` lleva `requireTLS: true` y los
  cuatro plazos; las cabeceras de no-rastreo de Mailjet y Elastic en cada mensaje; la
  fábrica se niega bajo el test runner aunque el entorno tenga `MAIL_SMTP_*`.
- **`configuracionDeCorreo`**: proveedor listado sin variables → error con el nombre de la
  variable, nunca su valor; desconocido → error; producción con cadena vacía → `ok: false`;
  desarrollo sin `MAIL_PROVIDERS` y con `RESEND_API_KEY` → `resend` con aviso.
- **Tests que hoy están vacíos y se reescriben en positivo**: `securityNotice.test.ts` («no
  llama al presupuesto», que además es falso desde el 4B: `enviarCorreo` cobra todo) y
  `mailBudget.test.ts` («ningún controlador cobra directamente») escanean fuentes buscando
  un nombre que dejará de existir; pasan a exigir que el conjunto de ficheros que cobran sea
  exactamente `["src/auth/mailRelay.ts"]`. `index.boot.test.ts` deja de exigir
  `RESEND_API_KEY`. `mailer.test.ts` se reescribe: las cuatro pruebas que llaman a Resend
  directamente, las cinco del contador único, y la lista de excepciones del escaneo.
- **Cliente**: tres pestañas siempre; sin auto-envío; cuenta atrás; 429 respeta
  `reintento_en_s`; `intentosRestantes` en pantalla; el diálogo del step-up ofrece el correo
  solo si el 403 lo lista y manda `metodo` en las dos rutas; el selector de clase; el
  interceptor excluye la ruta por nombre.

---

## 9. Despliegue

Se suma al runbook §11 de la especificación de autenticación y a los del 4B y 4C.

1. 🔴 **Todo el plan es un despliegue.** La parte que hace del correo un factor sin la que
   permite probarlo encierra a quien tenga solo correo verificado.
2. **Antes, y a mano (Isaias):** abrir las cuatro cuentas SMTP; en cada una, verificar
   `osefi.net` (los registros de §4.6; Mailtrap no verifica sin `mt-link`), **apagar el
   rastreo de clics y de aperturas en el panel**, crear la credencial SMTP donde toque
   (SMTP2GO: usuario SMTP; Elastic: credencial SMTP; Mailtrap: token), y **enviar un correo
   real de prueba desde cada una** y verlo en Gmail sin pie publicitario y con el enlace sin
   reescribir. SMTP2GO: verificar el dominio remitente **antes** de contar con él, o se queda
   en 25 por hora. Añadir `rua=` al DMARC.
3. **Comprobar que el contenedor sale por 587** (`nc -zv in-v3.mailjet.com 587`). Si no, los
   cuatro SMTP se descartan como averías sin cobrar nada y la cadena se queda en Resend: se
   ve en el log, no en la pantalla.
4. Variables en Coolify **antes** de la imagen: `MAIL_PROVIDERS`, `MAIL_FROM`, un bloque por
   proveedor. **Mirar la primera pantalla del log de arranque**: ahí está la cadena viva y
   cualquier proveedor descartado con las variables que le faltan.
5. `migrate:deploy`.
6. `api` y `web` seguidos, en la misma ventana que el resto del arco.
7. **Decirle a las nueve personas** que, en cuanto verifiquen el correo, cada login pedirá
   un código salvo en un equipo recordado; que «recordar este equipo» es lo que lo hace
   llevadero; y a los administradores, lo de §1.2.1.

**Marcha atrás.** La imagen anterior ignora `codigo_correo` y `metodo`, y `estadoEfectivo`
acepta `mfa_source = 'correo'` (solo distingue `dispositivo`). Dos cosas que **no** son
limpias y hay que saber: (a) la imagen anterior no sabe que el correo es factor, así que
toda cuenta que verificó su correo bajo la nueva vuelve a «sin factor» y, como `verifyEmail`
apagó su mecha, `estadoInicialDeSesion` le estampa **catorce días nuevos** — el reloj del
arco entero se mueve dos semanas para todo el que verificó; (b) una sesión `parcial` abierta
bajo la nueva imagen para una cuenta con solo correo no tiene con qué probarse en la
anterior: solo llega a `logout` y `me`. **El runbook de la vuelta atrás incluye «todo el
mundo cierra sesión».**

---

## 10. Riesgos

- **El buzón es la llave.** §1.1. Aceptado por Isaias.
- **El cupo de correo es la disponibilidad del login.** §4.3 lo defiende con la reserva, el
  tope diario de `/password/forgot` y los topes por cuenta; lo que queda es que **con los
  cinco proveedores apartados a la vez, nadie cuyo único factor sea el correo entra durante
  quince minutos**. Se ve en una línea `error` con el estado de toda la cadena.
- **El correo tarda.** Diez minutos de validez; si llega muerto, la persona pide otro a los
  60 s. Se mide en el log por proveedor (`id`, `ms`).
- **Cinco cuentas gratuitas que hay que mantener vivas.** Las cuatro elegidas no publican
  caducidad por inactividad («no verificado»). Un correo trimestral desde cada una es
  barato. Elastic Email guarda el registro de envíos tres días: las investigaciones de «no
  me llegó» tienen 72 horas.
- **Los contadores de cupo y el cubo de intentos son por proceso.** Deuda ya anotada.
- **El código en un correo se lee en la pantalla de bloqueo del móvil.** Va en el cuerpo, no
  en el asunto. Igual en todos los sistemas con este método.
- **Un mensaje puede llegar dos veces.** §1.2.3.

---

## 11. Lo que no entra

- SMS y WhatsApp: decisión de Isaias del 2026-09-03; el informe de precios (Bolivia,
  0,13–0,26 USD por SMS; WhatsApp 0,0084 USD por mensaje de autenticación, no gratis a ningún
  volumen) está en la bitácora de ese día.
- Un bot de Telegram como canal gratis: descartado con el resto del teléfono.
- Activar o desactivar el correo como factor por persona: Isaias lo quiere automático.
- Avisos de seguridad al entrar por correo teniendo app o llave: Isaias no los quiere.
- Un panel de estado de los proveedores: el log dice por quién salió cada correo y cuál
  está apartado.
- Acuñar códigos de recuperación al verificar el correo: la sección del perfil ya permite
  pedirlos, y el perfil lo dice.
