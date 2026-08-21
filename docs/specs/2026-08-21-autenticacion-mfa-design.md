# Autenticación: sesiones revocables, passkeys y MFA — diseño

Reemplaza el login de usuario y contraseña por un sistema de sesiones que se
pueden revocar, con dos factores obligatorios y una entrada sin contraseña para
quien registre una passkey.

Cierra cuatro puntos abiertos de
[`AUDITORIA-SEGURIDAD.md`](../AUDITORIA-SEGURIDAD.md): el limitador de login
que se salta rotando una cabecera (nº 5), los tokens que no se pueden revocar,
el `JWT_SECRET` débil, la ausencia de `helmet` y la falta de política de
contraseñas (nº 10).

## 1. Por qué no basta con añadir un segundo factor

Hoy el login entrega un JWT de siete días que se guarda en `localStorage`, y
`authenticateToken` **refirma uno nuevo en cada petición**
([`app.ts:104-107`](../../src/app.ts)). Las consecuencias, comprobadas
leyendo el código:

- Un token robado **se renueva solo con usarlo**. No caduca nunca mientras se
  siga usando.
- **No hay forma de revocarlo.** `logout()` borra el `localStorage` del
  navegador propio (`web/src/context/SesionProvider.tsx:34-39`);
  el token sigue siendo válido para quien lo tenga.
- **Cambiar la contraseña no lo invalida.** No hay ningún dato en el token ni en
  la base que ate la sesión a la credencial que la creó.

Poner MFA encima de eso no protege del robo de sesión, que es el ataque
realista: el segundo factor se pide al entrar, y el atacante que roba el token
**ya entró**. Por eso el trabajo empieza por la sesión y no por el factor.

### Lo que se descartó, y por qué

**Mantener el JWT y añadir un `token_version` por usuario.** Es el parche
mínimo: un contador en la tabla `usuario` que el token lleva dentro y el
servidor compara. Revoca, pero solo en bloque —o todas las sesiones de esa
persona o ninguna—, así que no permite "cerrar la sesión de aquel portátil".
Y no ahorra la consulta a la base: `authenticateToken` ya la hace en cada
petición para releer el rol.

**Un proveedor de identidad autoalojado** (Keycloak, Authentik, Zitadel).
Resuelve la autenticación a cambio de un servicio más que mantener, actualizar y
del que depende que nadie pueda entrar. Keycloak solo pide alrededor de 1 GB de
RAM. Además obliga a reconciliar la matriz de permisos de
[`permissions/store.ts`](../../src/permissions/store.ts) con la suya. Para
un ERP interno de una empresa el coste de mantenimiento supera al problema.

**SMS como segundo factor.** No es gratis en ningún proveedor, y el NIST lo
desaconseja desde 2017 por el robo de línea. El campo `phone` de la tabla
`usuario` se queda como dato de agenda y no entra en el flujo de entrada.

**Un servidor SMTP propio en el VPS.** Parece la opción libre y es la más frágil.
Los VPS bloquean el puerto 25 saliente por defecto y hay que pedir que lo abran;
el `rDNS` solo lo puede configurar el proveedor; y la reputación de una IP se
construye con **volumen constante**, que aquí no existe: un correo al día no
genera señal, y la reputación además decae cuando el envío es escaso. Una IP
dedicada tiene sentido a partir de unos 50.000 correos al mes, tres órdenes de
magnitud por encima de lo que este sistema va a mandar. El resultado realista no
es "caer en spam" —que sería recuperable, basta mirar la carpeta— sino el
**rechazo en origen**: Outlook y Hotmail tiran las conexiones de IPs sin
reputación, y entonces no hay carpeta que mirar. Una IP compartida de un
proveedor serio entrega mejor precisamente porque está caliente todo el rato.

**Rotar entre varios proveedores gratuitos** para no tocar nunca ningún límite.
El consumo real es el 1% de la cuota de uno solo, así que protege de algo que no
va a pasar; cada proveedor añadido hay que mantenerlo y verificarlo; y sobre todo
**el SPF admite un máximo de diez consultas DNS** (RFC 7208 §4.6.4). Cada
proveedor autorizado consume al menos una, y pasarse no degrada nada: devuelve
`permerror` y tumba la autenticación de **todo** el correo del dominio, incluido
el del proveedor que funcionaba. La protección provocaría la avería.

Lo que sí se hace es dejar el envío **detrás de una interfaz propia**, de modo
que añadir un segundo proveedor el día que el volumen lo justifique sea escribir
una clase y cambiar una línea. Diseñar para poder cambiar cuesta cero; construir
el cambio por adelantado cuesta trabajo permanente y añade un riesgo nuevo.

### La decisión de fondo: fuera el JWT

La sesión pasa a ser un **token opaco** —32 bytes aleatorios— guardado
**hasheado** en Postgres y entregado en una cookie `httpOnly`.

El argumento es de coste, no de gusto: Postgres corre en la misma máquina que la
API, y `authenticateToken` ya consulta la base en cada petición. Cambiar esa
consulta por un `JOIN` de sesión y usuario **no añade un solo viaje**, y a cambio
la revocación deja de ser un parche y pasa a ser la forma natural del sistema —
se borra la fila y la sesión murió, sin ventana de gracia.

Desaparecen tres piezas frágiles: el `JWT_SECRET` como punto único de fallo, la
cabecera `x-new-token` con toda la defensa que hubo que montarle en el
interceptor de axios, y el `getTokenExp` que decodifica el token a mano en el
navegador.

## 2. Arquitectura

```
                    www.osefi.net (Vercel)
                            │
                            │  cookie osefi_session
                            │  Domain=.osefi.net  SameSite=Lax
                            │  httpOnly  Secure
                            ▼
                    api.osefi.net (VPS · Coolify)
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
         sesion       credencial      factor_totp
        (opaca,        _webauthn      (secreto
        revocable)     (passkeys)      cifrado)
             │              │              │
             └──────────────┴──────────────┘
                            │
                       PostgreSQL (mismo VPS)
```

Los tres nombres cuelgan de `osefi.net`, así que la cookie con
`Domain=.osefi.net` vale para todos y `SameSite=Lax` funciona sin recurrir a
`SameSite=None` —que Safari y los bloqueadores tratan mal—. Esto se verificó
sondeando producción: `osefi.net` redirige a `www.osefi.net` (Vercel) y la API
responde en `api.osefi.net`.

El `rpID` de las passkeys se fija en **`osefi.net`**, el dominio padre. Cubre
`www.osefi.net` y `api.osefi.net` a la vez. **Este valor no se puede cambiar
después**: si cambia, todas las passkeys registradas dejan de valer y hay que
volver a darlas de alta una por una.

## 3. Esquema

Seis migraciones nuevas con Umzug, siguiendo el patrón de
[`src/migrations/`](../../src/migrations/).

### `usuario` — campos nuevos

| Campo | Tipo | Para qué |
|---|---|---|
| `email` | `VARCHAR(255)` único, nulo | No existía. Es la vía de recuperación. |
| `email_verified_at` | `TIMESTAMP` nulo | Sin esto, un email con errata parece bueno hasta que hace falta. |
| `mfa_grace_until` | `TIMESTAMP` nulo | Fin del periodo de gracia de 14 días. |
| `pass_changed_at` | `TIMESTAMP` | Permite matar las sesiones anteriores al cambio. |
| `failed_attempts` | `INTEGER` por defecto 0 | Bloqueo por cuenta, no solo por IP. |
| `locked_until` | `TIMESTAMP` nulo | Ídem. |

### `sesion` — nueva

Una fila por dispositivo con sesión abierta.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `UUID` | |
| `id_usuario` | `INTEGER` FK | |
| `token_hash` | `CHAR(64)` único | SHA-256 del token opaco. **El token en claro no se guarda nunca.** |
| `mfa_satisfied_at` | `TIMESTAMP` nulo | Cuándo se pasó el factor en esta sesión. Base del step-up. |
| `user_agent` | `VARCHAR(255)` | Para que la persona reconozca la sesión en su perfil. |
| `ip_address` | `VARCHAR(45)` | |
| `created_at`, `last_used_at`, `expires_at` | `TIMESTAMP` | |
| `revoked_at` | `TIMESTAMP` nulo | |

SHA-256 y no bcrypt a propósito: el token ya son 32 bytes aleatorios, no tiene
entropía que reforzar, y esta consulta corre en **cada petición**. Bcrypt aquí
sería pagar 100 ms por petición sin ganar nada.

**Cuánto dura una sesión.** Siete días sin usarla y caduca; cada petición
empuja `last_used_at` y estira el vencimiento otros siete. Pero con un tope
absoluto de **treinta días desde `created_at`**, se use lo que se use: es lo que
hoy no existe y lo que permitía que un token robado viviera indefinidamente
mientras alguien lo fuera usando. Al llegar al tope se vuelve a pedir la
contraseña, no el segundo factor —para eso está el dispositivo recordado—.

**Cómo queda `authenticateToken`.** Una sola consulta que cruza `sesion` con
`usuario` por el hash de la cookie y devuelve, de una vez: si la sesión vive, de
quién es, su rol actual y cuándo se pasó el factor. Hoy son dos pasos —verificar
el JWT y luego un `findByPk` para releer el rol— así que el número de viajes a
la base no sube. Si la consulta no devuelve fila, la respuesta es 401 y punto:
no hay nada que interpretar.

### `credencial_webauthn` — nueva

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `id_usuario` | | |
| `credential_id` | `TEXT` único | base64url |
| `public_key` | `BYTEA` | |
| `counter` | `BIGINT` | Detecta credenciales clonadas |
| `transports` | `VARCHAR(255)` | |
| `nombre` | `VARCHAR(100)` | Lo pone la persona: "mi móvil", "PC oficina" |
| `created_at`, `last_used_at` | | |

Varias filas por usuario: el mismo técnico entra desde el móvil en campo y desde
el PC en la oficina, y cada aparato tiene su propia passkey.

### `factor_totp`, `codigo_recuperacion`, `dispositivo_recordado`, `token_uso_unico`

- **`factor_totp`** — el secreto va **cifrado** con AES-256-GCM usando una clave
  nueva de entorno (`MFA_ENCRYPTION_KEY`), no en claro. Guarda también el último
  paso de tiempo consumido, para que un código interceptado no se pueda reusar
  dentro de su ventana de 30 segundos.
- **`codigo_recuperacion`** — diez códigos por persona, hasheados, de un solo
  uso. Se enseñan una vez y no se pueden volver a ver.
- **`dispositivo_recordado`** — el "recordar 30 días". Hash del token, fecha de
  caducidad, `user_agent`, y `revoked_at`. **Revocable**, que es lo que impide
  que hayamos cambiado un token irrevocable de 7 días por uno de 30.
- **`token_uso_unico`** — verificación de email y restablecimiento de
  contraseña. Con `tipo`, `token_hash`, `expires_at` y `used_at`.

## 4. El flujo de entrada

```
  ┌─ ¿tiene passkey registrada? ─── sí ──▶ un toque (huella/cara) ──▶ DENTRO
  │                                        sin usuario ni contraseña
  │
  └─ no ──▶ usuario + contraseña ──┬─ ¿dispositivo recordado y vigente? ─ sí ─▶ DENTRO
                                   │
                                   └─ no ──▶ segundo factor ──▶ DENTRO
                                             (TOTP o código de recuperación)
```

**La passkey entra sin contraseña, y aun así es doble factor.** Se registra con
`userVerification: 'required'`, lo que obliga al aparato a pedir huella, cara o
PIN antes de firmar. Eso son las dos cosas a la vez: algo que tienes —el
dispositivo, cuya clave privada no sale de él— y algo que eres o sabes. Aquí no
se cambia comodidad por seguridad: se gana en las dos, y es la respuesta al
"más ágil" del encargo.

### Onboarding forzado

```
Día 0  · Se despliega. Ningún JWT vale ya: mueren todas las sesiones vivas.
         Todo el mundo vuelve a entrar con su contraseña.
Paso 1 · Pantalla bloqueante: escribir email → llega código → pegarlo.
         Sin esto no se llega al paso 2.
Paso 2 · Elegir factor: passkey o TOTP.  ← 14 días de gracia, con "ahora no"
         y el contador de días a la vista.
Paso 3 · Se descargan los diez códigos de recuperación.
```

**Por qué matar las sesiones vivas no es opcional.** Hoy hay tokens de siete
días que nadie puede revocar ni saber si están robados. Si se abriera el periodo
de gracia sin matarlos, quien tuviera uno robado podría entrar al perfil, poner
**su** email, verificarlo —le llega a él— y registrar **su** passkey. Resultado:
la cuenta blindada a nombre del atacante y el dueño legítimo fuera. Sería
ponerle el cerrojo a la puerta con el ladrón dentro.

Aquí no hay que hacer nada especial para conseguirlo: **sale gratis del propio
cambio**. El nuevo `authenticateToken` solo entiende cookies de sesión y no
verifica JWTs en absoluto, así que en el instante del despliegue todos los
tokens antiguos dejan de significar nada. `JWT_SECRET` se borra del `.env` y de
Coolify, y con él el secreto de once letras minúsculas que señala la auditoría.

**El periodo de gracia se rellena en la migración**: `mfa_grace_until` toma la
fecha del despliegue más catorce días para todos los usuarios que ya existen.
Los que se den de alta después lo reciben al crearse, contando desde su alta —
si no, quien entrara el día trece tendría un día en vez de catorce.

### Step-up: dónde no vale el dispositivo recordado

Estas operaciones vuelven a pedir el factor si hace más de **10 minutos** que se
pasó, aunque el dispositivo esté recordado:

- cambiar la contraseña propia
- cambiar el email propio (**y se avisa al email anterior**)
- crear, editar o archivar usuarios
- tocar roles o la matriz de permisos

Es lo que impide que una sesión robada escale a administrador. Sin step-up, el
"recordar 30 días" sería una puerta trasera de treinta días.

## 5. Endpoints

Todo cuelga de `/api/auth`. Las rutas actuales `POST /api/login` y
`GET /api/login` desaparecen.

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/auth/login` | Usuario y contraseña. Responde `dentro`, `falta_factor` o `falta_onboarding`. |
| `POST` | `/auth/mfa/verify` | Código TOTP o de recuperación. Acepta `recordar: true`. |
| `GET` | `/auth/me` | Quién soy, mi rol y mis permisos. Sustituye a `GET /api/login`. |
| `POST` | `/auth/logout` | Revoca **esta** sesión. |
| `POST` | `/auth/logout-all` | Revoca todas y todos los dispositivos recordados. |
| `GET` | `/auth/sessions` | Mis sesiones abiertas, para poder cerrarlas. |
| `POST` | `/auth/webauthn/register/options` · `/verify` | Alta de passkey. |
| `POST` | `/auth/webauthn/login/options` · `/verify` | Entrada con passkey. |
| `POST` | `/auth/totp/setup` · `/confirm` | Alta de TOTP. `setup` devuelve el QR. |
| `POST` | `/auth/email/send` · `/verify` | Verificación de email. |
| `POST` | `/auth/password/forgot` · `/reset` | Recuperación real. |
| `POST` | `/auth/recovery-codes/regenerate` | Requiere step-up. |

`POST /auth/password/forgot` **responde siempre lo mismo**, exista el email o no.
Si no, se convierte en un buscador de quién tiene cuenta.

## 6. Lo que se arregla de la auditoría por el camino

**El limitador que se salta rotando `X-Forwarded-For` (nº 5).** Hoy la clave es
`req.ip` con `trust proxy: 1`, así que basta rotar la cabecera. Se pasa a tres
límites a la vez: por IP plegando el prefijo IPv6, por cuenta —cinco fallos y
bloqueo con espera creciente, guardado en `usuario.locked_until`— y por la pareja
cuenta+IP. El limitador del generador ya lo hace bien y es el patrón a copiar.

**El usuario inexistente responde más rápido** que la contraseña incorrecta,
porque no llega a ejecutar bcrypt. Eso deja enumerar quién tiene cuenta con un
cronómetro. Se arregla comparando siempre contra un hash de relleno.

**`helmet` y HSTS.** `helmet` en Express; el HSTS en el proxy de Coolify, que es
donde termina el TLS. Comprobado en producción: `api.osefi.net` no manda
`strict-transport-security` hoy. También se apaga el `x-powered-by: Express`,
que anuncia gratis qué se está corriendo.

**Contraseñas.** Mínimo doce caracteres y rechazo de las más comunes. Sin
obligar a mayúsculas y símbolos: el NIST lo desaconseja desde 2017 porque
produce `Password1!` y una nota pegada al monitor. El coste de bcrypt sube de 8
a 12, y cada usuario se rehashea solo la próxima vez que entre bien.

## 7. Qué cambia en el frontend

- **`SesionProvider`** pierde el `localStorage`, el `getTokenExp` que decodifica
  el JWT a mano y el interceptor de `x-new-token` con toda su defensa contra
  hosts falsos. La sesión la lleva la cookie; `GET /auth/me` dice si sigue viva y
  cuándo caduca. Es una simplificación grande, no solo un cambio.
- **`axios`** pasa a `withCredentials: true`, y el CORS del servidor a
  `credentials: true` con origen fijo `https://www.osefi.net`.
- **`LoginPage`** gana el botón de passkey —arriba, antes del formulario— y la
  pantalla de segundo factor.
- **Pantallas nuevas:** onboarding bloqueante de email, alta de factor con QR,
  códigos de recuperación, y en el perfil la lista de sesiones abiertas y
  passkeys registradas.
- **`¿Olvidaste tu contraseña?`** deja de ser un `toast` que dice "contacte con
  el administrador" y pasa a funcionar.

### CSRF

Con la cookie, una petición de otro sitio la llevaría automáticamente.
`SameSite=Lax` ya bloquea el caso de `evil.com`, pero se añade una segunda
barrera: **toda escritura exige una cabecera propia** (`X-Osefi-Client`). Una
cabecera no estándar obliga al navegador a pedir permiso con un preflight, y el
CORS solo autoriza `www.osefi.net`. Dos cierres independientes en vez de uno.

## 8. La vía de escape

**Sin esto no se despliega.** Con MFA obligatorio, un fallo deja a la persona
fuera de su propio sistema sin nadie que la desbloquee. Es el error más común al
desplegar MFA y hay que tener la salida montada **antes**, no después.

```bash
npm run auth:rescue -- --user <usuario> --reset-mfa      # borra sus factores
npm run auth:rescue -- --user <usuario> --unlock          # quita el bloqueo
npm run auth:rescue -- --user <usuario> --revoke-sessions # cierra sus sesiones
```

Corre en el servidor, contra la base, sin pasar por la API. Quien tiene acceso
SSH al VPS ya tiene acceso a la base: el script no abre ningún camino nuevo,
solo evita tener que escribir SQL a mano con prisa y a las once de la noche.

**Regla de prueba:** el primer usuario que pase por el flujo completo es uno de
prueba. La cuenta de administrador, la última.

## 9. Dependencias

Todas MIT y verificadas al escribir esto:

| Paquete | Versión | Para qué |
|---|---|---|
| `@simplewebauthn/server` | 13.3.2 | Passkeys, lado servidor |
| `@simplewebauthn/browser` | 13.3.0 | Passkeys, lado navegador |
| `otpauth` | 9.5.1 | TOTP |
| `helmet` | 8.3.0 | Cabeceras de seguridad |
| `resend` | 6.21.0 | Envío de correo |

**Resend**: 3.000 correos al mes gratis, tope de 100 al día, **sin tarjeta**, y
es plan permanente, no una prueba. Si se pasa el límite corta el envío, no
factura. El volumen real es un correo por persona una sola vez, más alguna
recuperación suelta. Hay que verificar `osefi.net` con SPF y DKIM una vez.

Variables de entorno nuevas, todas en Coolify: `MFA_ENCRYPTION_KEY`,
`RESEND_API_KEY`, `MAIL_FROM`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`.

Y una que **se borra**: `JWT_SECRET`, de `api/.env`, de `.env.docker` y de
Coolify. Con ella se va la comprobación de arranque de
[`index.ts:8-11`](../../src/index.ts), que debe pasar a exigir las nuevas.
Un arranque que no encuentre `MFA_ENCRYPTION_KEY` tiene que negarse a arrancar,
igual que hoy hace con `JWT_SECRET`: si no, los secretos TOTP se guardarían sin
cifrar y nadie se enteraría hasta que fuera tarde.

## 10. Pruebas

El proyecto ya tiene 20 ficheros de test con Vitest. Se sigue el patrón de
[`requirePermission.test.ts`](../../src/middleware/requirePermission.test.ts)
y [`routeGuards.test.ts`](../../src/routes/routeGuards.test.ts).

Lo que hay que cubrir, más allá del camino feliz:

- Una sesión revocada **no** vale, ni siquiera con el token correcto.
- Una sesión muere a los treinta días de creada por mucho que se siga usando.
- Cambiar la contraseña mata las demás sesiones y conserva la actual.
- Un código TOTP no se puede reusar dentro de su ventana de 30 segundos.
- Un código de recuperación gastado no vale una segunda vez.
- El dispositivo recordado **no** salta el step-up.
- Un usuario inexistente y una contraseña mala tardan lo mismo.
- El bloqueo por cuenta aguanta aunque rote la IP.
- `password/forgot` responde igual exista el email o no.
- El contador de la passkey detecta una credencial clonada.
- Una escritura sin la cabecera `X-Osefi-Client` se rechaza.

## 11. Riesgos

**El `rpID` es irreversible.** Se fija en `osefi.net`. Si algún día la web se
mueve a otro dominio, todas las passkeys mueren y hay que volver a registrarlas
una por una. Es la razón de fijarlo en el padre y no en `www.osefi.net`.

**El día 0 saca a todo el mundo.** Rotar el `JWT_SECRET` obliga a que todos
vuelvan a entrar. Conviene hacerlo en fin de semana o a primera hora.

**Se despliegan los cuatro bloques a la vez**, por decisión expresa. Si algo
falla el lunes hay cuatro sospechosos en vez de uno. Lo compensan el script de
rescate y probar antes con una cuenta que no sea la de administrador.

**Passkeys en navegadores viejos.** WebAuthn con `userVerification: 'required'`
necesita navegador y sistema recientes. Quien no pueda usa TOTP, que funciona en
cualquier teléfono. Por eso hay dos métodos y no uno.

**El tope de 100 correos al día** puede quedarse corto si hay más de cien
usuarios verificando el mismo día. El periodo de gracia lo reparte solo, pero
conviene tenerlo presente el día 0.

## 12. Lo que no entra

- **Login con Google o Microsoft.** Tiene sentido si algún día hay cuentas
  corporativas, pero hoy los usuarios los da de alta un administrador y no
  aporta.
- **Arreglar `VITE_ORS_API_KEY`**, que viaja en el bundle. Es real y está en la
  auditoría, pero se arregla haciendo de proxy desde la API y es otro trabajo.
- **Las imágenes servidas sin autenticar** (punto 9 de la auditoría). Mismo
  motivo: es un trabajo aparte.
- **El teléfono como factor.** Cuesta dinero siempre y el NIST lo desaconseja.
