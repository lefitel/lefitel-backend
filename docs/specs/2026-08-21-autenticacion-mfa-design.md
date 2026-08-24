# Autenticación: sesiones revocables, passkeys y MFA — diseño

Reemplaza el login de usuario y contraseña por un sistema de sesiones que se
pueden revocar, con dos factores obligatorios y una entrada sin contraseña para
quien registre una passkey.

Cierra cinco puntos abiertos de
[`AUDITORIA-SEGURIDAD.md`](../AUDITORIA-SEGURIDAD.md): el limitador de login que
se salta rotando una cabecera (nº 5), los tokens que no se pueden revocar, el
`JWT_SECRET` débil, la ausencia de `helmet` y la falta de política de
contraseñas (nº 10).

> **Revisión 2 (21 ago 2026).** La primera versión pasó por una auditoría
> adversarial de cuatro frentes —ofensivo, operativo, coherencia con el código y
> migraciones— que devolvió más de cuarenta defectos. Uno anulaba el propósito
> entero: la sesión creada al validar la contraseña ya abría todo el ERP, porque
> `authenticateToken` nunca miraba si se había pasado el segundo factor. Lo que
> sigue incorpora las correcciones. Los cambios de fondo respecto a la revisión 1
> están recogidos en §13.

## 1. Por qué no basta con añadir un segundo factor

Hoy el login entrega un JWT de siete días que se guarda en `localStorage`, y
`authenticateToken` **refirma uno nuevo en cada petición**
([`app.ts:104-107`](../../src/app.ts)). Las consecuencias, comprobadas leyendo el
código:

- Un token robado **se renueva solo con usarlo**. No caduca nunca mientras se
  siga usando.
- **No hay forma de revocarlo.** `logout()` borra el `localStorage` del navegador
  propio (`web/src/context/SesionProvider.tsx:35-40`); el token sigue siendo
  válido para quien lo tenga.
- **Cambiar la contraseña no lo invalida.** No hay ningún dato en el token ni en
  la base que ate la sesión a la credencial que la creó.

Poner MFA encima de eso no protege del robo de sesión, que es el ataque
realista: el segundo factor se pide al entrar, y el atacante que roba el token
**ya entró**. Por eso el trabajo empieza por la sesión y no por el factor.

### Lo que se descartó, y por qué

**Mantener el JWT y añadir un `token_version` por usuario.** Es el parche
mínimo: un contador en la tabla `usuario` que el token lleva dentro y el servidor
compara. Revoca, pero solo en bloque —o todas las sesiones de esa persona o
ninguna—, así que no permite "cerrar la sesión de aquel portátil". Y no ahorra la
consulta a la base: `authenticateToken` ya la hace en cada petición para releer
el rol.

**Un proveedor de identidad autoalojado** (Keycloak, Authentik, Zitadel).
Resuelve la autenticación a cambio de un servicio más que mantener, actualizar y
del que depende que nadie pueda entrar. Keycloak solo pide alrededor de 1 GB de
RAM. Además obliga a reconciliar la matriz de permisos de
[`permissions/store.ts`](../../src/permissions/store.ts) con la suya. Para un ERP
interno de una empresa el coste de mantenimiento supera al problema.

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
consulta por un `JOIN` de sesión y usuario **cuesta lo mismo en lecturas**, y a
cambio la revocación deja de ser un parche y pasa a ser la forma natural del
sistema — se marca la fila y la sesión murió, sin ventana de gracia.

Desaparecen tres piezas frágiles: el `JWT_SECRET` como punto único de fallo, la
cabecera `x-new-token` con toda la defensa que hubo que montarle en el
interceptor de axios, y el `getTokenExp` que decodifica el token a mano en el
navegador.

## 2. Arquitectura

```
                    www.osefi.net (Vercel)
                            │
                            │  cookie __Host-osefi_session
                            │  host-only en api.osefi.net
                            │  Path=/  SameSite=Lax  Secure  httpOnly
                            ▼
                    api.osefi.net (VPS · Coolify)
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
    sesion            credencial          factor_totp
   (opaca,             _webauthn          (secreto
   revocable)          (passkeys)          cifrado)
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                       PostgreSQL (mismo VPS)
```

### La cookie es host-only, no de dominio

La revisión 1 ponía `Domain=.osefi.net` razonando que hacía falta para que
`SameSite=Lax` funcionara entre `www` y `api`. **Ese razonamiento confundía
*same-site* con *same-origin*.** `www.osefi.net` y `api.osefi.net` comparten
dominio registrable, luego ya son same-site: una cookie **host-only** puesta por
`api.osefi.net` viaja perfectamente en las llamadas de axios desde `www` con
`SameSite=Lax`. El atributo `Domain` no compraba nada y costaba dos cosas:

- **Cookie tossing.** Cualquier host bajo `*.osefi.net` puede escribir cookies
  con `Domain=.osefi.net`. `httpOnly` impide leerlas, no impide **sombrearlas**:
  un subdominio tomado (un `staging` olvidado, un CNAME colgando) pone
  `Set-Cookie: ...; Domain=.osefi.net; Path=/api/auth`, el navegador la envía
  antes que la legítima por tener el `Path` más largo, y la víctima acaba
  operando dentro de la sesión del atacante.
- **La cookie viajaba a Vercel.** Con `Domain`, cada petición a `www.osefi.net`
  —el HTML, cada `.js`, cada imagen— llevaba la sesión a infraestructura que no
  es nuestra.

Por eso: cookie **host-only** con el prefijo **`__Host-`**, que el navegador solo
acepta si no lleva `Domain`, va con `Secure` y tiene `Path=/`. Es imposible de
sombrear por construcción. Igual para la cookie de dispositivo recordado.

En desarrollo el prefijo `__Host-` y `Secure` no funcionan sobre `http://localhost`,
así que el nombre y la bandera salen de `COOKIE_NAME` y `COOKIE_SECURE` (§9).

### El `rpID` de las passkeys es `www.osefi.net`

La revisión 1 lo ponía en el ápice `osefi.net` diciendo que así "cubre
`www.osefi.net` y `api.osefi.net` a la vez". **Es falso**: `api.osefi.net` no
sirve páginas y nunca ejecuta una ceremonia WebAuthn; solo verifica aserciones
del lado servidor, y ahí el `rpID` le da igual. El ápice no cubría nada y a
cambio hacía que el navegador aceptase ceremonias con `rpId: 'osefi.net'` desde
**cualquier** `*.osefi.net` — un subdominio comprometido podía pedir la huella
con la marca conocida y retransmitir la aserción.

Con `rpID = www.osefi.net`, el navegador rechaza esas ceremonias por sí solo y
no hay que confiar en que el servidor compare bien. `WEBAUTHN_ORIGIN` es una
**lista de orígenes exactos** y la comparación es de **igualdad, nunca de
sufijo**: comparar por sufijo con el ápice es bypass de autenticación remota.

**Este valor no se puede cambiar después**: si cambia, todas las passkeys
registradas dejan de valer y hay que volver a darlas de alta una por una. Se
acepta a cambio de la reducción de superficie. Si algún día la web se mueve de
`www.osefi.net`, hay una migración de passkeys por delante — §12 lo recoge.

## 3. Esquema

**Ocho migraciones** con Umzug. Reglas que aplican a todas, porque el directorio
[`src/migrations/`](../../src/migrations/) contiene hoy dos patrones que se
contradicen:

- **Cada migración va entera dentro de una transacción**, siguiendo
  `20260804000001-create-reporte-vista.ts` y **no** `20260818000001`. El motivo
  está escrito en la primera: sin transacción, un fallo a mitad deja la tabla
  creada pero sin registrar en `SequelizeMeta`, y el siguiente despliegue muere
  en `relation already exists` **en bucle, para siempre**, hasta que alguien
  entre por SSH.
- **`SET LOCAL lock_timeout = '5s'`.** `ALTER TABLE usuarios` toma
  `ACCESS EXCLUSIVE`, y `authenticateToken` lee esa tabla en cada petición: un
  informe largo reteniendo una conexión haría que el `ALTER` espere y **toda la
  API se cuelgue detrás de él**.
- **Todas las columnas de fecha son `TIMESTAMPTZ`**, nunca `TIMESTAMP`. El resto
  del esquema ya lo es porque `DataTypes.DATE` de Sequelize genera
  `TIMESTAMP WITH TIME ZONE`. Mezclarlos con Bolivia en UTC−4 da desfases de
  cuatro horas: un `locked_until` naive quedaría siempre en el pasado y el
  bloqueo por cuenta **no bloquearía nada, en silencio**, mientras el test pasa
  en local donde ambos relojes coinciden.
- **Los nombres de tabla se fijan explícitamente** con `tableName` en cada
  modelo. La pluralización de Sequelize ya ha mordido este esquema —`ciudads`,
  `rols`, `revicions`—: `define("sesion")` buscaría `sesions` y todo login
  devolvería 500.
- **`ON DELETE RESTRICT`** en todas las FK a `usuarios`, siguiendo
  `20260804000001`. Las 17 FK existentes son `CASCADE`, y como `rol` es el único
  modelo sin borrado lógico, un `DELETE /api/rol/:id` arrastraría también todas
  las passkeys y secretos TOTP de sus usuarios, sin rastro.
- **Todas las columnas declaran `allowNull` explícito.** Un `token_hash`
  nullable es una fila que casa con cualquier cosa según cómo se escriba la
  consulta.

### `usuario` — campos nuevos

| Campo | Tipo | Para qué |
|---|---|---|
| `email` | `VARCHAR(255)` NULL | No existía. Es la vía de recuperación. Se normaliza a minúsculas al entrar. |
| `email_verified_at` | `TIMESTAMPTZ` NULL | Sin esto, un email con errata parece bueno hasta que hace falta. |
| `mfa_grace_until` | `TIMESTAMPTZ` NULL | Fin del periodo de gracia. **Nace NULL**; ver §4. |
| `pass_changed_at` | `TIMESTAMPTZ` NOT NULL DEFAULT `now()` | Permite matar las sesiones anteriores al cambio. |
| `failed_attempts` | `INTEGER` NOT NULL DEFAULT 0 | Bloqueo por cuenta, no solo por IP. |
| `locked_until` | `TIMESTAMPTZ` NULL | Ídem. |

`pass_changed_at` es `NOT NULL` con relleno a propósito. Si se dejara nullable y
la comprobación se escribiera en positivo (`sesion.created_at >= u.pass_changed_at`),
con NULL la comparación da NULL, la consulta no devuelve fila y **todo el mundo
recibe 401 en la primera petición**: bucle de login infinito el sábado por la
noche.

**El índice de `email` es parcial**, no un `UNIQUE` a secas:

```sql
CREATE UNIQUE INDEX usuarios_email_verificado_uniq
  ON usuarios (lower(email))
  WHERE email_verified_at IS NOT NULL AND "deletedAt" IS NULL;
```

Tres motivos, los tres verificados contra el código. Uno: con `UNIQUE` simple,
una reclamación **sin verificar** bloquea al dueño legítimo del buzón — alguien
escribe `isaias@osefi.net` por error, no lo verifica, y cuando Isaias llega a su
propio paso de email choca contra la unicidad. Dos: `usuario` es `paranoid: true`,
así que la fila del ex-empleado archivado retiene su email para siempre y esa
dirección no se puede reasignar. Tres: `lower()` porque el `UNIQUE` de Postgres
distingue mayúsculas y los buzones no, y `Isaias@` e `isaias@` acabarían siendo
dos cuentas contra el mismo correo real.

**Novena migración, de propina y de una línea:** `usuarios.user` sigue sin índice
único —lo dejó abierto la auditoría anterior— y `createUsuario` no comprueba
colisión. El login resuelve la identidad por ese campo, y ahora además cuelgan de
él las sesiones y los factores: una segunda fila `isaias` con contraseña conocida
competiría por el login.

```sql
CREATE UNIQUE INDEX usuarios_user_uniq
  ON usuarios (lower("user")) WHERE "deletedAt" IS NULL;
```

### `sesion`

Una fila por dispositivo con sesión abierta.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `UUID` NOT NULL, `defaultValue: DataTypes.UUIDV4` | Lo genera la aplicación, no la base. |
| `id_usuario` | `INTEGER` NOT NULL, FK RESTRICT | |
| `token_hash` | `CHAR(64)` NOT NULL, único | SHA-256 del token opaco. **El token en claro no se guarda nunca.** |
| `mfa_satisfied_at` | `TIMESTAMPTZ` NULL | **Solo lo escribe una prueba viva de factor.** Ver más abajo. |
| `mfa_source` | `VARCHAR(20)` NULL | `passkey`, `totp`, `codigo`, o `dispositivo`. |
| `estado` | `VARCHAR(20)` NOT NULL | `parcial`, `onboarding` o `completa`. Ver §4. |
| `webauthn_challenge` | `VARCHAR(255)` NULL | Reto en curso. Ver más abajo. |
| `challenge_expires_at` | `TIMESTAMPTZ` NULL | Dos minutos. |
| `user_agent` | `VARCHAR(255)` NULL | Para que la persona reconozca la sesión en su perfil. |
| `ip_address` | `VARCHAR(45)` NULL | |
| `created_at`, `last_used_at`, `expires_at` | `TIMESTAMPTZ` NOT NULL | |
| `revoked_at` | `TIMESTAMPTZ` NULL | |

Índices: único en `token_hash`, y por `id_usuario` y por `expires_at` — los pide
`/auth/logout-all`, `/auth/sessions`, el script de rescate y la purga.

SHA-256 y no bcrypt a propósito: el token ya son 32 bytes aleatorios, no tiene
entropía que reforzar, y esta consulta corre en **cada petición**. Bcrypt aquí
sería pagar 100 ms por petición sin ganar nada.

**`mfa_satisfied_at` y el dispositivo recordado son cosas distintas.** Un login
que entra por dispositivo recordado deja `estado = completa` y `mfa_source =
dispositivo`, pero **`mfa_satisfied_at` a NULL**. Si se pusiera —como hacía
implícitamente la revisión 1— cada login recordado abriría diez minutos de
step-up ya satisfecho, y bastaría robar esa cookie y la contraseña para editar la
matriz de permisos sin tocar un solo factor. El documento afirmaba justo lo
contrario de lo que su propio diseño producía.

**El reto de WebAuthn vive en la fila de sesión**, no en memoria del proceso. En
memoria se pierde al reiniciar el contenedor y se rompe con dos réplicas; y si
viajara de vuelta en el cuerpo de la petición, el atacante elegiría el reto y
podría reproducir una aserción capturada. Para el login con passkey, donde aún no
hay sesión, se crea antes una fila `estado = parcial` sin `id_usuario`.

**Cuánto dura una sesión.** Siete días sin usarla y caduca; cada petición empuja
`last_used_at` y estira el vencimiento otros siete. Con un tope absoluto de
**treinta días desde `created_at`**, se use lo que se use. Al llegar al tope se
vuelve a pedir la contraseña, no el segundo factor —para eso está el dispositivo
recordado—.

**`last_used_at` se escribe como mucho una vez cada cinco minutos.** Escribirlo
en cada petición convierte cada lectura en una escritura: una sola exportación de
reportes hace unas 2.000 peticiones secuenciales, y serían 2.000 `UPDATE` y 2.000
tuplas muertas sobre la misma fila. La revisión 1 afirmaba que el cambio "no
añade un solo viaje a la base", y era falso: la lectura cuesta lo mismo, la
escritura es nueva.

### `credencial_webauthn`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `INTEGER` autoIncrement | |
| `id_usuario` | `INTEGER` NOT NULL, FK RESTRICT | |
| `credential_id` | `TEXT` NOT NULL, único | base64url |
| `public_key` | `BYTEA` NOT NULL | |
| `counter` | `BIGINT` NOT NULL DEFAULT 0 | Ver la regla de abajo |
| `transports` | `VARCHAR(255)` NULL | |
| `nombre` | `VARCHAR(100)` NOT NULL | Lo pone la persona: "mi móvil", "PC oficina" |
| `created_at`, `last_used_at` | `TIMESTAMPTZ` | |

Varias filas por usuario: el mismo técnico entra desde el móvil en campo y desde
el PC en la oficina, y cada aparato tiene su propia passkey.

**La regla del contador, escrita para que nadie la implemente mal.** Solo se
compara cuando `guardado > 0 && recibido > 0`; si el autenticador reporta 0, se
acepta y se anota. Las passkeys sincronizadas —iCloud Keychain, Google Password
Manager, que es exactamente lo que van a usar los técnicos desde el móvil—
devuelven `signCount = 0` **siempre**, y la comprobación ingenua `recibido >
guardado` da `0 > 0` = falso: la passkey funcionaría la primera vez y **nunca
más**. Con la presión del lunes eso se arregla desactivando la comprobación
entera, y el test queda como prueba de algo que no ocurre.

**Opciones de ceremonia, en registro y en autenticación:**

```js
authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
```

`residentKey: 'required'` porque sin credencial descubrible no existe la entrada
sin escribir el usuario, que es la razón de ser de la passkey aquí. Si faltara,
la salida improvisada sería pedir el usuario para construir `allowCredentials`,
y eso es un oráculo perfecto: quien tiene passkey devuelve lista, quien no,
vacío.

`userVerification: 'required'` va **también en la autenticación**, y el servidor
comprueba el flag `uv` de la respuesta. El argumento de que la passkey es doble
factor depende de que el aparato pida huella o PIN **cada vez**, no solo al dar
de alta; sin eso, una passkey en un portátil desbloqueado firma sola y el
párrafo que dice "son las dos cosas a la vez" se vuelve falso.

### Las demás

- **`factor_totp`** — `id_usuario` NOT NULL, y el secreto cifrado con AES-256-GCM
  en tres columnas: `secreto_cifrado BYTEA`, **`iv BYTEA(12)`** y
  **`auth_tag BYTEA(16)`**. Sin el nonce y el tag guardados junto al criptograma
  el secreto es **irrecuperable desde el minuto uno**, y un IV fijo compartido
  por todas las filas anula la garantía de GCM. Más `key_version SMALLINT NOT
  NULL DEFAULT 1`, sin la cual rotar la clave es imposible de hacer a medias sin
  perder de vista qué fila quedó con cuál. El cifrado usa como **AAD** el
  `id_usuario` concatenado al nombre de la tabla: sin eso, quien consiga una
  escritura en la base copia su propio criptograma sobre la fila del
  administrador y satisface el factor del administrador con su autenticador.
  Guarda también `ultimo_paso BIGINT` (anti-replay) y `confirmed_at`.
- **`codigo_recuperacion`** — `id_usuario` NOT NULL, diez por persona, **≥128
  bits de entropía cada uno**, hasheados con bcrypt (no SHA, porque aquí la
  entropía la fijamos nosotros y un código corto con hash rápido se rompe fuera
  de línea en horas a partir de una copia de la base). Un solo uso. Al regenerar,
  los diez anteriores se marcan usados en la misma transacción.
- **`dispositivo_recordado`** — **`id_usuario` NOT NULL** (la revisión 1 lo
  omitía, y sin él la comprobación es solo por hash: bastaba marcar "recordar"
  en la cuenta propia y llevarse esa cookie al login del administrador para
  saltarse su segundo factor). La condición de aceptación completa es
  `token_hash = ? AND id_usuario = ? AND revoked_at IS NULL AND expires_at > now()`.
- **`token_uso_unico`** — verificación de email y restablecimiento de contraseña.
  **`id_usuario` NOT NULL** y **`email_destino`** (la revisión 1 tampoco los
  tenía, y sin dueño en la fila el endpoint tiene que sacar el usuario del cuerpo
  de la petición: se pide un reset de la cuenta propia y se canjea contra la del
  administrador). `token_hash` único e indexado, `expires_at` de 15 minutos para
  reset y 1 hora para verificación, `used_at`. **El endpoint no acepta ningún
  identificador de usuario ni de email en el cuerpo: todo sale de la fila.**

### Limpieza

Nada de esto se borra solo. Un job diario —o un borrado oportunista en el
login— purga: sesiones caducadas o revocadas hace más de 30 días,
`token_uso_unico` usados o caducados, y `dispositivo_recordado` vencidos.
`GET /auth/sessions` filtra por `revoked_at IS NULL AND expires_at > now()`, o
acabará listando sesiones muertas.

### Cómo queda `authenticateToken`

Una sola consulta que cruza `sesion` con `usuario` por el hash de la cookie. Tres
condiciones que hay que escribir literalmente porque ninguna se hereda:

```sql
WHERE s.token_hash = $1
  AND s.revoked_at IS NULL
  AND s.expires_at > now()
  AND u."deletedAt" IS NULL          -- ← el filtro paranoid NO viene solo
  AND s.created_at >= u.pass_changed_at
```

**`u."deletedAt" IS NULL` es la línea más fácil de olvidar y la que más cuesta.**
Hoy el corte lo da `UsuarioModel.findByPk`, que es paranoid y filtra solo; una
consulta escrita a mano no hereda nada. Sin ella, archivar al técnico despedido
deja su portátil trabajando hasta que la sesión llegue al tope de 30 días. Sería
una regresión del punto 8 de la auditoría, que ya está cerrado.

Y `deleteUsuario` revoca, en la misma transacción, las sesiones y los
dispositivos recordados del usuario que archiva. El `ON DELETE CASCADE` no sirve
aquí: el borrado es lógico, la fila no se borra, y ninguna cascada se dispara
jamás.

## 4. El flujo de entrada

```
  ┌─ passkey ──────────────────▶ un toque (huella/cara) ────────▶ DENTRO
  │  sin escribir el usuario                                     completa
  │
  └─ usuario + contraseña ──┬─ ¿dispositivo recordado vigente? ─ sí ─▶ DENTRO
                            │                                    (mfa_source=dispositivo,
                            │                                     mfa_satisfied_at = NULL)
                            └─ no ──▶ segundo factor ──▶ DENTRO
                                      passkey · TOTP · código de recuperación
```

**La passkey también vale como segundo factor tras la contraseña**, no solo como
entrada sin contraseña. La revisión 1 la ponía únicamente en la rama passwordless,
y eso condenaba a quien eligiera passkey en el móvil a quemar un código de
recuperación **cada vez que se sentara en el PC de la oficina**: diez sesiones y
se quedaba sin códigos.

**La passkey entra sin contraseña y aun así es doble factor**, por
`userVerification: 'required'` en cada autenticación: algo que tienes —el
dispositivo, cuya clave privada no sale de él— y algo que eres o sabes. Aquí no
se cambia comodidad por seguridad: se gana en las dos, y es la respuesta al "más
ágil" del encargo.

### Los tres estados de una sesión, y qué abre cada uno

Esto es lo que faltaba en la revisión 1 y hacía que el MFA fuera decorativo.
`authenticateToken` **no basta con que devuelva fila**: tiene que mirar el estado.

| `estado` | Cuándo | Qué puede hacer |
|---|---|---|
| `parcial` | Contraseña validada, factor pendiente | **Solo** `/auth/mfa/*`, `/auth/webauthn/login/*`, `/auth/logout` y `/auth/me`. Todo lo demás: **401**. |
| `onboarding` | Factor pasado, falta email o factor por registrar | Lo anterior más `/auth/email/*`, `/auth/totp/*`, `/auth/webauthn/register/*`, `/auth/recovery-codes`. Todo lo demás: **403 "configura tu segundo factor para continuar"**. |
| `completa` | Todo en regla | El ERP. |

`/auth/me` en estado `parcial` u `onboarding` devuelve **estado, nunca
permisos**. La allowlist es explícita y va en una constante, no dispersa en
`if`. Y `GET /permisos/mias` y `GET /rol`, que hoy no piden permiso, quedan
detrás del mismo corte.

### El día 15 existe y no echa a nadie

La revisión 1 no decía qué pasa cuando la gracia vence sin factor configurado —el
estado más peligroso del diseño, sin comportamiento escrito—. Queda así: se entra
con `estado = onboarding`. **Nunca "no entras"**, siempre "configúralo ahora".
La diferencia importa: un técnico en campo el día 15 recibiría un toast rojo
genérico —porque `Login.api.ts` aplana cualquier respuesta inesperada a un
`status: 500`— sin botón y sin instrucción.

### La gracia se cuenta desde el primer login, no desde el despliegue

`mfa_grace_until` **nace NULL** y se fija en el **primer login exitoso posterior
al despliegue**. La revisión 1 la rellenaba en la migración con "despliegue + 14
días" para todos, y eso deja fuera a quien esté de vacaciones o de baja: vuelve
el día 30 con la sesión muerta, el dispositivo recordado vencido y una gracia que
expiró sin que él viera una sola pantalla. Tuvo cero días de los catorce.

Lo llamativo es que el propio documento ya había razonado esto correctamente para
los usuarios nuevos —"contando desde su alta, si no, quien entrara el día trece
tendría un día en vez de catorce"— y no lo aplicó a los existentes, que son el
100% de los afectados el día 0.

### El email no bloquea la entrada; bloquea lo sensible

La revisión 1 hacía el paso del email bloqueante desde el minuto cero, con la
gracia aplicando solo al factor. Como **ningún usuario tiene email hoy** —la
columna no existe—, eso ponía al 100% de la plantilla delante de una pantalla que
depende de que Resend, el DNS de `osefi.net`, el buzón del técnico y su memoria
de la contraseña de Gmail funcionen todos a la vez, el sábado por la noche.

Queda así: se entra en `onboarding` y se puede trabajar. Lo que exige email
verificado son las operaciones de la lista de step-up.

**No hay precarga posible.** Son entre 20 y 60 usuarios y la empresa no tiene sus
direcciones recogidas, así que cada uno escribirá la suya. Lo que saca a Resend
del camino crítico es lo anterior —que el email no impida entrar— más el hecho
de que la gracia arranca en el primer login de cada persona: el onboarding se
reparte solo por los días en que cada uno vuelve a entrar, en vez de concentrarse
el sábado. `--set-email` se mantiene para los casos sueltos: el correo que no
llega, la errata que hay que corregir.

Aun así, **hay que mirar el contador de Resend durante los primeros días**. El
tope son 100 al día y los reenvíos —"no me ha llegado", "míralo en spam"— son la
mayor parte del tráfico real de este tipo de flujo. Si se agota, quien falte se
queda sin poder verificar hasta el día siguiente; puede seguir trabajando, pero
no puede tocar nada de la lista de step-up.

### Step-up: dónde no vale el dispositivo recordado

Estas operaciones exigen `mfa_satisfied_at` de hace menos de **10 minutos** —y el
dispositivo recordado no lo escribe, así que no cuenta—:

- cambiar la contraseña propia
- cambiar el email propio (**y se avisa a la dirección anterior**)
- cambiar el nombre de usuario propio
- **dar de alta o de baja cualquier factor** (passkey o TOTP)
- **cerrar una sesión que no es la actual**
- regenerar los códigos de recuperación
- crear, editar o archivar usuarios
- tocar roles o la matriz de permisos

**El alta de factor es la que faltaba, y era la peor.** Sin ella, un atacante
dentro registra su propia passkey y **no existe ninguna acción que la víctima
pueda ejecutar para expulsarlo**: cambiar la contraseña no sirve porque la
passkey entra sin contraseña, y `logout-all` revoca sesiones, no credenciales. Se
añade además **aviso por correo en toda alta y baja de factor**, o el ataque es
invisible hasta que alguien mire su lista de passkeys por casualidad.

Para la **primera** alta, cuando aún no hay factor con el que hacer step-up, se
exige reintroducir la contraseña. Y un usuario en `onboarding` **no puede** hacer
las operaciones administrativas de la lista: responden 403, nunca pasan — si no,
la contraseña sola editaría la matriz de permisos durante toda la gracia.

El servidor impone el orden: `/auth/totp/*` y `/auth/webauthn/register/*`
responden 409 si el email no está verificado. En la revisión 1 el orden solo
existía en la interfaz, y un cliente que no fuera el navegador de Osefi se lo
saltaba.

### Códigos de recuperación: romper la circularidad

Se enseñan una vez. Pero **un código de recuperación autoriza a regenerar los
demás** — es el único punto de la cadena que rompe el círculo sin SSH. Sin eso,
regenerar exige el factor que precisamente has perdido.

El paso de descarga **no es saltable**: pide escribir uno de los códigos para
demostrar que están guardados fuera del móvil. Cerrar esa pantalla con guantes
después de escanear un QR es lo normal, no la excepción. Y no se termina el
onboarding con **un solo aparato**: o dos passkeys, o passkey más TOTP, o passkey
más códigos confirmados fuera. Si el móvil lleva la passkey *y* el PDF de los
códigos, romperlo se lleva las dos cosas.

Aviso por correo cuando queden menos de tres sin usar.

## 5. Endpoints

Todo cuelga de `/api/auth`. Las rutas `POST /api/login` y `GET /api/login`
**se mantienen como alias una versión más**, para que el orden de despliegue
entre Vercel y Coolify deje de importar (§11).

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/auth/login` | Usuario y contraseña. Crea sesión `parcial`. |
| `POST` | `/auth/mfa/verify` | TOTP o código de recuperación. Acepta `recordar: true`. |
| `GET` | `/auth/me` | Quién soy. En estado no `completa`, devuelve estado sin permisos. |
| `POST` | `/auth/logout` · `/auth/logout-all` | Revoca esta sesión · todas y los dispositivos recordados. |
| `GET` | `/auth/sessions` | Mis sesiones vivas. |
| `DELETE` | `/auth/sessions/:id` | Cierra una. **Step-up. Solo filas propias.** |
| `POST` | `/auth/webauthn/register/options` · `/verify` | Alta de passkey. **Step-up.** |
| `GET` · `DELETE` | `/auth/webauthn/credentials` · `/:id` | Listar · borrar. **Step-up. Solo propias.** |
| `POST` | `/auth/webauthn/login/options` · `/verify` | Entrada con passkey. |
| `POST` · `DELETE` | `/auth/totp/setup` · `/confirm` · `/auth/totp` | Alta · confirmación · baja. **Step-up.** |
| `POST` | `/auth/email/send` · `/verify` | Verificación de email. |
| `POST` | `/auth/password/forgot` · `/reset` | Recuperación. |
| `POST` | `/auth/recovery-codes/regenerate` | **Step-up**, o un código de recuperación válido. |
| `POST` | `/api/usuario/:id/mfa/reset` | **El administrador desbloquea a alguien desde la aplicación.** Ver §8. |

Los `DELETE` van explícitos porque §7 promete la pantalla que los usa, y una
ruta sin especificar en un código con historial de IDOR es cómo aparece un
`DELETE /:id` sin filtro por `id_usuario` — y con eso un rol 3 borra las passkeys
del administrador y lo empuja al camino de la contraseña.

**El step-up es un middleware `requireStepUp`**, y se monta también sobre rutas
que ya existen fuera de `/auth`: `PUT /usuario/userpass/:id`,
`PUT /usuario/username/:id`, `PUT /usuario/:id`, `POST /usuario`,
`DELETE /usuario/:id`, `PATCH /usuario/:id/desarchivar`, y todo `rol.routes.ts` y
`permiso.routes.ts`. Para eso, la declaración global de `Request` en
[`app.ts:6-8`](../../src/app.ts) pasa de `{ id, id_rol }` a incluir `id_sesion`,
`estado` y `mfa_satisfied_at` — un tipo que consumen unos 30 controladores.

**Respuestas uniformes.** `POST /auth/password/forgot` y `POST /auth/email/send`
responden **siempre lo mismo**, exista la cuenta o no; si no, son buscadores de
quién tiene cuenta.

**El reset de contraseña no crea sesión.** Devuelve a la pantalla de login y
obliga a pasar el segundo factor. Si dejara la sesión abierta —que es lo cómodo—
quien controle el buzón entra sin TOTP ni passkey, y el segundo factor completo
quedaría reducido a "tener acceso al email". Además, `/forgot` solo opera sobre
emails verificados; cambiar el email pone `email_verified_at` a NULL y anula los
tokens de reset pendientes; y reset y cambio de contraseña revocan sesiones **y
dispositivos recordados**.

**Eventos en bitácora.** Se registran con `logAction`, como ya se hace con
`LOGIN` y `LOGIN_FAILED`: alta y baja de factor, creación de dispositivo
recordado, step-up denegado, login con passkey, revocación masiva y reset por
administrador. Sin esas líneas, un atacante que registra su passkey es invisible.
Nota de implementación: `bitacora.entity_id` es `INTEGER` y `id_usuario` es
`allowNull: false`, así que el id de sesión (UUID) va en `metadata`, y los
intentos contra cuentas inexistentes no pueden registrarse contra un usuario.

## 6. Lo que se arregla de la auditoría por el camino

**El limitador que se salta rotando `X-Forwarded-For` (nº 5).** Se pasa a cuatro
cubos, y las cifras importan tanto como el diseño:

| Cubo | Presupuesto | Nota |
|---|---|---|
| Por IP, **solo fallos** | ~100 / 15 min | Presupuesto de oficina entera |
| Por cuenta | 5 fallos → espera creciente, **con tope en minutos** | En `usuario.locked_until` |
| Por cuenta + IP | 10 / 15 min | |
| `/auth/mfa/verify`, `/webauthn/login/verify`, `/password/reset`, `/email/verify` | **5 por sesión**, luego se destruye la sesión parcial | Clave por sesión y cuenta, **no por IP** |

El cuarto cubo no estaba en la revisión 1 y era un agujero directo: con la sesión
parcial en la mano, un bucle sobre seis dígitos acierta en minutos.

El límite por IP cuenta **solo fallos** y sube a ~100 porque el actual —10 cada
15 minutos, contando también los aciertos— saca a toda la oficina el día 0: el
onboarding de una persona son cinco o seis POST, y detrás de un mismo NAT dos
personas agotan el presupuesto. El patrón bueno ya existe en
`generador.routes.ts`: clave por usuario con `ipKeyGenerator` de respaldo.

`/auth/email/send` y `/auth/password/forgot` llevan límite propio por email y por
IP: sin él, un anónimo con un `curl` gasta la cuota diaria de correo y deja sin
recuperación a toda la empresa.

Y el bloqueo por cuenta **no aplica** a un login que llega con dispositivo
recordado válido — si no, cualquiera que sepa el nombre de usuario del jefe tiene
un botón de "bloquear a esta persona".

**La enumeración, por los dos canales.** La revisión 1 solo arreglaba el tiempo
(hash de relleno cuando el usuario no existe) y con eso reintroducía el problema
en espejo: una cuenta bloqueada retorna **antes** de llegar a bcrypt, así que con
coste 12 la diferencia es de dos órdenes de magnitud. La respuesta de login es
**una sola** —mismo mensaje, mismo código, misma forma— para inexistente,
contraseña mala y cuenta bloqueada, y el camino bloqueado **también paga el
bcrypt de relleno**. Hoy `login.controller.ts` responde "Usuario inexistente" y
"Contraseña incorrecta", y hay un test que fija esa diferencia con la nota
literal de borrarlo cuando cambie: hay que borrarlo.

**`helmet` y HSTS.** `helmet` en Express; el HSTS en el proxy de Coolify, que es
donde termina el TLS — comprobado en producción: `api.osefi.net` no manda
`strict-transport-security` hoy. También se apaga el `x-powered-by: Express`.

**Contraseñas.** Mínimo doce caracteres y rechazo de las más comunes. Sin obligar
a mayúsculas y símbolos: el NIST lo desaconseja desde 2017 porque produce
`Password1!` y una nota pegada al monitor. El coste de bcrypt sube de 8 a 12 —y
hay que cambiarlo en los **dos** sitios donde está escrito literal,
`usuario.controller.ts:67` y `:233`, no solo en el login— y cada usuario se
rehashea la próxima vez que entre bien.

**Reloj desincronizado.** No estaba en la revisión 1 y es la causa más común de
"código incorrecto" en TOTP. Se acepta ±1 paso como normal. Al fallar, el
servidor reintenta internamente con ±10 pasos y, si encaja con desfase, responde
*"el reloj de tu teléfono va N minutos adelantado — actívale la hora
automática"*. Un fallo por desfase **no cuenta** para el bloqueo por cuenta: si
no, un problema de reloj termina en una cuenta bloqueada, y la persona solo ve
"código incorrecto" mientras lo provoca ella misma reintentando.

## 7. Qué cambia en el frontend

**El alcance real es mucho mayor de lo que decía la revisión 1**, que hablaba de
tres ficheros. Medido sobre el código:

| Qué | Dónde | Cuánto |
|---|---|---|
| `Authorization: Bearer ${token}` a mano | `web/src/api/` | **92 sitios en 22 módulos** |
| `sesion.token` pasado como argumento | `App.tsx`, los `use*Data.ts`, los `*Sec.tsx`, los sheets | **210 referencias en 38 ficheros** |
| `import { SesionContext }` | | 46 ficheros |

**Y lo que rompe de verdad es el enrutado.** `web/src/App.tsx:34` y `:41`
deciden quién entra con `sesion.token !== ""`. Con la cookie `httpOnly` **no hay
token en el estado del navegador**: `sesion.token` es `""` para siempre, y
`PrivateRoutes` manda a todo el mundo a `/login` aunque la sesión sea válida. La
aplicación entera queda inaccesible. `SesionInterface` pierde el campo `token` y
el gate pasa a un booleano derivado de `GET /auth/me`.

Las 92 cabeceras se resuelven con `axios.defaults.withCredentials = true` y
borrando el helper `auth(token)` de cada módulo. Las 210 referencias son firmas
que pierden un parámetro: mecánico, pero hay que contarlo.

Otros puntos concretos, todos verificados:

- `AppSidebar.tsx:163` — `onClick={logout}` es hoy puramente local; pasa a ser
  una llamada asíncrona y falible a `POST /auth/logout`.
- `PerfilPage.tsx:92` y `:109` — reconstruyen la sesión **descartando
  `permisos`** (bug ya existente: cambiar tu nombre te deja sin permisos hasta
  F5). Al tocar `SesionInterface` hay que arreglarlo o se agrava.
- **`exposedHeaders` conserva `Content-Disposition`.** Al reescribir el CORS para
  quitar `x-new-token`, se va con él si nadie lo señala, y entonces todas las
  exportaciones se descargan como `reporte.xlsx` en vez de con su nombre.
- **`timeout: 15000` en las llamadas de autenticación**, con mensaje *"sin
  conexión — no es tu código"*. Hoy no hay un solo `timeout` en `web/src/api/`:
  sobre un enlace agonizante la petición se queda colgada, el código expira, el
  técnico reintenta, y esos reintentos alimentan el bloqueo por cuenta. La
  afirmación de que "TOTP funciona sin red" es cierta para **generar** el código
  y falsa para verificarlo, que es donde se decide si entra.
- **La dirección verificada tiene que ser visible**: completa en el perfil y
  enmascarada en el flujo de entrada (*"tu correo de recuperación es
  j\*\*\*z@osefi.net — ¿es tuyo?"*), más una columna en la lista de Seguridad. Un
  email con errata que alguien verificó por reenvío no falla el día que se pone:
  falla meses después, cuando ese buzón se cierra y es el único canal de
  recuperación.

**CSRF.** `SameSite=Lax` no protege de un subdominio, porque un subdominio **es
same-site**. Así que las tres barreras, y ninguna se presenta como redundante de
las otras: cookie `__Host-` (imposible de sombrear), comprobación de `Origin`
contra allowlist exacta **en el servidor** —que no depende del navegador—, y
cabecera propia `X-Osefi-Client` que fuerza el preflight. Y `CORS_ORIGIN`
**deja de tener valor por defecto**: hoy cae a `http://localhost:5173`, y con
`credentials: true` encima, un despliegue que olvide la variable habilitaría
credenciales cross-origin. En producción, sin la variable no se arranca.

## 8. La vía de escape

**Sin esto no se despliega.** Con MFA obligatorio, un fallo deja a la persona
fuera de su propio sistema sin nadie que la desbloquee.

### Dentro de la aplicación, primero

`POST /api/usuario/:id/mfa/reset`, detrás de `requirePermission("seguridad",
"editar")` más step-up, con línea `critical` en la bitácora y botón junto a
"Cambiar contraseña" en la pantalla de usuario. **Esto no estaba en la revisión
1**, y sin ello todo el modelo operativo dependía de que el dueño tuviera
portátil y SSH a mano las 24 horas: lunes 8:00, técnico en campo sin factor,
dueño en el coche con el móvil, y nada que hacer hasta la noche. Hoy ese mismo
caso se resuelve desde el navegador en treinta segundos.

### El script, como segundo recurso

```bash
npm run auth:rescue:deploy -- --user <usuario> --reset-mfa       # borra factores + gracia de 24 h
npm run auth:rescue:deploy -- --user <usuario> --unlock
npm run auth:rescue:deploy -- --user <usuario> --revoke-sessions
npm run auth:rescue:deploy -- --user <usuario> --set-email <dir> # precarga y preverifica
npm run auth:rescue:deploy -- --user <usuario> --clear-email
```

**Tiene que poder ejecutarse en producción, y como estaba escrito no podía.**
`tsx` es `devDependency` y el `Dockerfile` hace `npm ci --omit=dev` copiando solo
`dist`; `scripts/` no viaja a la imagen. Así que vive en `src/scripts/rescue.ts`
y el comando es `node dist/scripts/rescue.js` — la misma distinción que ya existe
entre `migrate` y `migrate:deploy`. **Criterio de aceptación: se demuestra
ejecutándolo dentro del contenedor de producción antes de dar de alta a nadie.**
Si no se ha probado ahí, no existe.

`--reset-mfa` **concede siempre una gracia nueva de 24 horas** y revoca sesiones
y dispositivos recordados. Sin lo primero, el rescate deja a la persona sin
factor y con la gracia vencida: exactamente el estado del que se la quería sacar.
Sin lo segundo, deja viva la sesión del atacante que causó el incidente.

Y **el script escribe en la bitácora antes de tocar nada**, con severidad
`critical`, el usuario del sistema operativo y la marca de tiempo. Iba a ser la
operación más privilegiada del sistema y la única sin registro: un insider con
acceso al contenedor —que en Coolify es una consola del navegador, no una clave
SSH— resetea el MFA del administrador, entra con la contraseña, y en la bitácora
solo queda un `LOGIN` normal.

### Antes de desplegar

- **Una segunda cuenta de rescate**, su passkey en un aparato que se queda en la
  oficina y sus diez códigos **impresos** en un cajón.

  Esta advertencia decía que hacía falta `id_rol = 1` literal, porque
  `App.tsx` cableaba un `RoleRoute roles={[1]}` para `/app/seguridad` y una cuenta
  con un rol nuevo habría pasado todas las puertas del servidor para que **el
  router de React la echara** de la única pantalla donde administraría usuarios.

  **Ese riesgo ya no existe.** `RoleRoute` se retiró; hoy esa pantalla va detrás de
  `<ModuleRoute modulo="seguridad" />`, que pregunta por el permiso y no por el id
  del rol. Lo que hay que asegurar en su lugar es más simple y menos frágil: que el
  rol de la cuenta de rescate tenga concedido el módulo `seguridad` en la matriz de
  permisos. Un id de rol cableado en el router era exactamente la clase de cosa que
  deja a alguien fuera de su propio sistema de rescate.
- **Probar el rescate desde el móvil** (consola web de Coolify), no desde el
  portátil, y dejar apuntado cómo se entra.
- **Regla de prueba:** el primer usuario que pase por el flujo completo es uno de
  prueba. La cuenta de administrador, la última — pero **su email se verifica el
  primero**, para que el tope de correo no la deje colgada al final.

## 9. Dependencias y configuración

Todas MIT y verificadas contra npm:

| Paquete | Versión | Para qué |
|---|---|---|
| `@simplewebauthn/server` | 13.3.2 | Passkeys, lado servidor |
| `@simplewebauthn/browser` | 13.3.0 | Passkeys, lado navegador |
| `otpauth` | 9.5.1 | TOTP |
| `helmet` | 8.3.0 | Cabeceras de seguridad |
| `resend` | 6.21.0 | Envío de correo |
| **`cookie-parser`** | 1.4.x | **En Express 4, `req.cookies` no existe sin él.** Escribir la cookie es nativo; leerla, no. |
| **`qrcode`** | 1.5.x | `otpauth` genera la URI `otpauth://`, **no una imagen**. |

Más una lista de contraseñas comunes para la política de §6.

**Resend**: 3.000 correos al mes gratis, tope de 100 al día, **sin tarjeta**, y
es plan permanente. Si se pasa el límite corta el envío, no factura. Hay que
verificar `osefi.net` con SPF y DKIM **días antes del despliegue**, con un envío
de prueba real registrado como requisito previo — la propagación DNS es de horas
y descubrirla el sábado por la noche deja a todo el mundo, dueño incluido, sin
código de verificación.

Variables nuevas en Coolify: `MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `MAIL_FROM`,
`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` (lista de orígenes exactos), `COOKIE_NAME`,
`COOKIE_SECURE`.

**`MFA_ENCRYPTION_KEY` es material de copia de seguridad, igual que el dump.** 32
bytes en hexadecimal, **validados por longitud al arrancar** — que la variable
exista no es que sea válida: una clave de 20 caracteres pasa la comprobación y
revienta en el primer alta de TOTP. Junto a los datos se guarda una **huella de
la clave** (HMAC de una constante conocida) y el servidor **se niega a arrancar
si no coincide**: sin eso, cambiarla por descuido convierte todos los secretos
TOTP en basura, el servidor levanta tan contento, y cada usuario recibe "código
incorrecto" para siempre sin diagnóstico posible. Un fallo de descifrado GCM se
registra como tal y no se confunde con un código mal escrito.

**`JWT_SECRET` no se borra el día del despliegue.** La revisión 1 lo mandaba
borrar de Coolify, y eso destruye la vuelta atrás: `index.ts:37-40` de la imagen
**actual** hace `process.exit(1)` sin esa variable, así que el rollback entraría
en bucle de reinicio con la API entera caída. Se queda toda la semana y se borra
cuando el sistema nuevo esté probado. Mientras el código nuevo la ignora, tenerla
puesta no aporta ningún riesgo.

**`DB_SYNC` se elimina.** La rama `shouldSyncSchema` de `index.ts` se borra
entera. `sync({ alter: true })` **elimina toda columna que el modelo no declare**,
y la guarda actual —que exige conexión por `PG_*`— no protege a esta producción,
porque Postgres corre en el mismo VPS y esa es justamente la forma de una base
local. Un modelo `sesion` escrito con los `timestamps` por defecto contra una
tabla con `created_at` haría `DROP` de cuatro columnas y `ADD` de dos vacías: se
irían todas las sesiones y todas las fechas de caducidad. Un ERP con migraciones
no necesita `sync`.

## 10. Pruebas

El proyecto tiene 21 ficheros de test con Vitest en `api/src` y 6 en `web/src`.
Se sigue el patrón de
[`requirePermission.test.ts`](../../src/middleware/requirePermission.test.ts) y
[`routeGuards.test.ts`](../../src/routes/routeGuards.test.ts).

### Tests nuevos

- **Una sesión `parcial` recibe 401 en `/api/usuario`.** El más importante: es el
  que fija que el MFA no sea decorativo.
- Seis códigos TOTP incorrectos matan la sesión parcial.
- Una sesión revocada no vale, ni con el token correcto.
- Una sesión muere a los treinta días por mucho que se use.
- **Un usuario archivado no puede seguir usando su sesión.**
- Cambiar la contraseña mata las demás sesiones y **conserva la actual**.
- Un token de reset del usuario A no resetea al usuario B.
- Una cookie de dispositivo recordado de A no salta el factor de B.
- **Login con dispositivo recordado + `PUT /permisos/:id_rol` inmediato → 403.**
- Un código TOTP no se reusa dentro de su ventana.
- Un código de recuperación gastado no vale una segunda vez.
- Una cuenta bloqueada, una inexistente y una con contraseña mala tardan lo mismo
  **y dicen lo mismo**.
- El bloqueo por cuenta aguanta aunque rote la IP.
- `password/forgot` y `email/send` responden igual exista la cuenta o no.
- **Una passkey que reporta `signCount = 0` entra la segunda vez.**
- Una aserción con `origin` de otro subdominio se rechaza.
- Una escritura sin `X-Osefi-Client` se rechaza.
- Registrar un factor sin step-up se rechaza.

### Tests existentes que hay que modificar

No basta con añadir; estos fallan el día del despliegue:

- `routeGuards.test.ts:103-108` — la excepción está cableada a `/api/login`; las
  rutas de `/api/auth` que no pueden llevar `authenticateToken` aparecerán como
  abiertas.
- `routeGuards.test.ts:118-151` — `GATE_NOT_APPLICABLE` queda obsoleta y el test
  *"keeps the exception list honest"* falla.
- `login.controller.test.ts` — mockea `jsonwebtoken`, que desaparece; y fija que
  los mensajes de "usuario inexistente" y "contraseña incorrecta" **difieran**,
  con la nota literal de borrarlo cuando cambie.
- `logger.test.ts:48-51` — pinnea la redacción de `x-new-token`.
- `web/src/pages/menu/generador/page.test.tsx:86-87,139` — monta el contexto con
  `token: "t0"` y comprueba que no refetchea al renovar el token.

## 11. Despliegue y vuelta atrás

**El rollback real no es `down`, es el dump.** Las tres migraciones existentes
tienen `down`, pero `runMigrations()` solo llama a `up()` y no hay ningún
`migrate:down` expuesto; y aunque lo hubiera, deshacer `removeColumn("usuarios",
"email")` **se lleva todos los emails verificados durante el fin de semana**.

```
0. ENSAYO EN LOCAL. La base local de desarrollo es una copia de producción,
   así que las nueve migraciones se prueban ahí primero, contra datos reales:
   emails duplicados, usuarios archivados que retienen su dirección, filas
   antiguas sin pass_changed_at. Es el ensayo general y es gratis.
   Refrescar la copia desde producción antes de empezar, para no ensayar
   contra un estado de hace semanas.
1. pg_dump -Fc de PRODUCCIÓN  →  RESTAURAR en otra base y verificar recuentos.
   Un dump sin restauración probada es una suposición, no una copia.
   Guardar también MFA_ENCRYPTION_KEY: sin ella el dump es inservible para MFA.
2. Verificar SPF/DKIM de osefi.net en Resend. Envío de prueba real. (Días antes.)
3. Añadir las variables nuevas. NO borrar JWT_SECRET.
4. Probar auth:rescue:deploy DENTRO del contenedor.
5. Crear la cuenta de rescate (rol 1) y guardar sus códigos impresos.
6. migrate:deploy
7. Desplegar la API. Desplegar la web. (Da igual el orden: /api/login sigue vivo.)
8. Probar el flujo completo con la cuenta de prueba.
9. Si falla → volver a la imagen anterior en Coolify. Arranca porque JWT_SECRET
   sigue puesto. DEJAR EL ESQUEMA NUEVO: el código viejo lo ignora.
   Solo si el esquema es el problema, restaurar el dump del paso 1.
10. Una semana después, si todo va bien: borrar JWT_SECRET y los alias de
    /api/login.
```

El paso 0 es la mejor noticia del procedimiento y conviene no desaprovecharla:
tener una copia de producción en local significa que las migraciones **no se
estrenan sobre datos reales el sábado por la noche**. Se estrenan un martes por
la tarde, sobre los mismos datos, sin nadie esperando.

**Pero una copia no es producción.** Los índices únicos que estas migraciones
crean —el de `user` y el de `email`— pueden encontrar en producción duplicados
que la copia no tenga: bien porque divergió, bien porque se crearon entre el
volcado y el despliegue, que es posible precisamente porque `createUsuario` no
comprueba colisión. El fallo es seguro —la transacción revierte y `SequelizeMeta`
no se marca— pero el despliegue muere y reintenta con el mismo error hasta que
alguien lo mire. Así que las consultas de diagnóstico se corren **contra
producción justo antes de migrar**, no días antes:

```sql
-- Nombres de usuario duplicados entre las cuentas vivas
SELECT lower("user"), count(*), array_agg(id)
FROM usuarios WHERE "deletedAt" IS NULL
GROUP BY 1 HAVING count(*) > 1;

-- Y, cuando llegue el plan 3, lo mismo con el correo
SELECT lower(email), count(*), array_agg(id)
FROM usuarios WHERE "deletedAt" IS NULL AND email IS NOT NULL
GROUP BY 1 HAVING count(*) > 1;
```

### 🔴 Rota `JWT_SECRET`. Es lo primero, y no depende de nada más

Esto se descubrió inventariando el camino antiguo para retirarlo, el 23 de agosto,
y es lo más grave que ha salido de todo este trabajo.

**El secreto con el que se firman los tokens de sesión antiguos es una sola palabra
de once letras minúsculas, con forma de nombre propio.** No es una contraseña
débil: es una palabra de diccionario. Un ataque con una lista de nombres y
apellidos la encuentra en minutos.

**Y su valor estuvo escrito en claro en `docs/ESTADO-GENERADOR.md`**, que está en
git. Se ha retirado del fichero, pero **sigue en el historial** — cualquiera con
acceso al repositorio lo tiene con un `git log -S`. Sacarlo del historial exige
reescribirlo, que es destructivo en un repositorio con varias ramas y varias
sesiones trabajando, así que **esa decisión es de Isaias y nadie más la toma**.

Lo que significa, en concreto: quien tenga ese secreto puede **firmar un token
válido para cualquier usuario, incluido un administrador**. Y mientras el camino
antiguo siga aceptándose, ese token entra por la puerta que **ninguna revocación
alcanza** — ni cambiar la contraseña, ni «cerrar todas mis sesiones». Solo archivar
la cuenta, y hay que saber a quién archivar.

**Rotarla es gratis y no espera a nada.** El frontend nuevo ya no usa el token para
nada, así que cambiar el valor en Coolify no echa a nadie que esté en el camino de
la cookie. Lo único que invalida son los tokens antiguos que quedaran vivos — que
es exactamente lo que se quiere. Una cadena aleatoria larga, no una palabra.

Orden recomendado: **rota primero, despliega después.** Si se rota antes del Plan
2B, cualquiera que siguiera en el camino antiguo tendría que volver a entrar, y no
hay nada malo en eso.

**Y qué cambia cuando el Plan 2C esté desplegado:** nadie firma ni verifica con esa
clave, así que deja de ser una puerta y pasa a ser un secreto muerto en un sitio
donde no debería estar. Sigue mereciendo salir del historial —un secreto expuesto
que ya no abre nada hoy puede abrir algo el día que alguien reutilice el valor en
otra parte— pero deja de ser urgente. Rotarla antes de ese despliegue sigue siendo
lo correcto: es más barato que confiar en que el orden de despliegue salga bien.

### El despliegue del cimiento de sesión, que tiene reglas propias

Esto sale de haber implementado el Plan 2A y no estaba previsto al escribir el
diseño. **El backend vive en Coolify y el frontend en Vercel, y se despliegan por
separado**, así que el orden importa y no es reversible:

```
1. COOKIE_NAME=__Host-osefi_session y COOKIE_SECURE=true en Coolify.
   ANTES del código: el proceso se niega a arrancar sin ellas, y sin arrancar
   el contenedor entra en bucle de reinicio con el ERP entero caído.
   Y conviene saber POR QUÉ se niega, porque no es por donde parece: la lista de
   variables obligatorias solo se aplica cuando NODE_ENV vale exactamente
   "production". Lo que cubre el caso de un despliegue sin NODE_ENV puesto es
   otra cosa: COOKIE_SECURE falla cerrado (ausente se lee como true) y el nombre
   por defecto no lleva el prefijo __Host-, así que la comprobación del arranque
   mata el proceso igual. Verificado el 23 de agosto. No "optimices" ese default
   pensando que la lista de obligatorias lo cubre: sin él, un despliegue sin
   NODE_ENV emitiría la cookie de sesión sin Secure y sin nadie quejándose.
2. Las dos consultas de roles contra producción (abajo).
3. migrate:deploy. Si no corre, el login sigue funcionando por el camino viejo
   y NADIE se migra: el plan parece desplegado y no lo está. Comprobar que la
   tabla `sesiones` existe después.
4. El BACKEND. A solas es compatible: el frontend viejo no manda credenciales,
   así que sigue autenticando con el token antiguo y el guard CSRF no se le
   aplica.
5. El FRONTEND, y cuanto antes mejor: cada login en la ventana entre 4 y 5
   deja una fila de sesión que nadie posee, porque el navegador descarta la
   cookie y la rotación no encuentra nada que revocar.
6. Verificar EN UN NAVEGADOR, no con curl.
```

**El orden 4 → 5 no admite el inverso ni la vuelta atrás.** El frontend a solas
rompe **todas** las peticiones, lecturas incluidas: el navegador falla una
petición en modo credenciales cuya respuesta no trae
`Access-Control-Allow-Credentials`. Y por lo mismo, **una vez desplegado el
frontend, revertir el backend es una caída total**, no una degradación. Después
del paso 5, el backend solo puede ir hacia adelante.

**`curl` no sirve para verificar esto.** No aplica CORS, así que daría por bueno
un camino de cookie que en un navegador no funciona — que es exactamente el
agujero que el Plan 2A tuvo durante seis de sus ocho tareas. Para la
verificación en local hace falta además `COOKIE_SECURE=false` en el `.env`, que
no está.

**Las dos consultas de roles**, por dos cambios de permisos que entraron en el
mismo arco. La matriz es dato editable desde la pantalla de Seguridad, así que
ningún test puede saber qué roles existen de verdad:

```sql
-- Roles que podrían perder el registro de revisiones
SELECT id_rol FROM permisos WHERE modulo='eventos' AND accion='crear' AND permitido
  AND id_rol NOT IN (SELECT id_rol FROM permisos WHERE modulo='eventos' AND accion='editar' AND permitido);

-- Roles que se quedarían con la pantalla de inicio en error
SELECT DISTINCT id_rol FROM permisos
  WHERE id_rol NOT IN (SELECT id_rol FROM permisos WHERE modulo='eventos' AND accion='ver' AND permitido);
```

### No ejecutes el conjunto de tests en la máquina de despliegue

`src/database/migrate.test.ts` corre contra la base a la que apunte el `.env` del
momento — con un `skipIf` que lo salta si no hay base alcanzable, así que allí donde
sí la hay, corre. Y hace `CREATE TABLE` y `DROP TABLE`.

**El daño real es pequeño y conviene no exagerarlo:** la tabla es una de borrador con
nombre propio, `SequelizeMetaNormaliseTest`, nunca el registro de migraciones — su
propio comentario explica que confundirlas haría que umzug repitiera todas las
migraciones jamás aplicadas. El peor caso es una tabla huérfana de nombre raro en
producción, no una pérdida de datos.

Aun así, **el conjunto se ejecuta en desarrollo, no donde vive la base de
producción**. Y hay dos cosas más que saber de él:

- **No es hermético.** Sin base alcanzable da 730 pasados, 36 saltados y **un fallo**:
  `export.integration.test.ts` tiene un test fuera de su propio `skipIf`. Un rojo ahí
  no significa que algo esté roto.
- **Un test puede escribir de verdad, y ya pasó el 23.** Un test que entraba por la
  rama de contraseña incorrecta llamó a `UsuarioModel.increment`, que no está entre los
  métodos que el arnés sustituye, y salieron unos cinco `UPDATE` reales sobre el
  contador de intentos fallidos de un usuario de la copia local. No se escribió el
  bloqueo, y un login correcto pone ese contador a cero solo. El test se retiró y quedó
  un comentario en su sitio explicando la trampa. La lección es la que importa: **el
  arnés sustituye una lista de métodos, no el acceso a la base**, así que un camino
  nuevo que use un método que no esté en la lista sale a la base de verdad.

### El Plan 2C se despliega al revés que el 2B, y por una razón concreta

El 2B tenía un orden rígido —backend primero, frontend después, sin vuelta atrás—
porque el frontend nuevo mandando credenciales contra un backend que no las acepta
rompe **todas** las peticiones. Eso se acabó en cuanto el 2B esté en producción: a
partir de ahí las dos mitades ya se entienden.

**Para el 2C conviene el orden inverso: `web` primero, o las dos a la vez.** El motivo
es el cambio de nombre de usuario, que ahora exige la contraseña actual en el
servidor:

- `web` nuevo con `api` viejo: la pantalla pide la contraseña y la manda; el servidor
  viejo la ignora. Funciona.
- `api` nuevo con `web` viejo: la pantalla **no dibuja el campo** y el servidor
  contesta 400 pidiéndolo. Quien tenga el bundle viejo en caché ve un error que **no
  puede resolver** — no hay ninguna casilla donde escribir lo que le piden.

No es una caída: el resto del ERP funciona y basta con recargar. Pero es un error sin
salida en una pantalla, y evitarlo cuesta solo elegir el orden.

### La detección de cambio de rol se rompe entre el Plan 1 y el Plan 2B

Esto se descubrió revisando el Plan 2B y **no estaba previsto**. El backend dejó
de re-firmar el JWT en cada respuesta, así que ya no emite `x-new-token` desde
ningún sitio. Y el frontend seguía leyendo esa cabecera para enterarse de que a
alguien le habían cambiado el rol.

El resultado, en cristiano: **si a una persona le cambias el rol mientras tiene
el ERP abierto, su pantalla no se entera hasta que recargue.** Antes se enteraba
sola. No aparece ningún error: simplemente sigue viendo los botones de su rol
anterior, que solo pueden devolver 403 — el servidor rechaza, porque él sí lee
el rol de la base de datos en cada petición.

La cabecera que la sustituye es `x-osefi-role` (`config/security.ts`), la emiten
las dos ramas de `authenticate`, y **la lee el frontend a partir de la última
tarea del Plan 2B**. Consecuencia de despliegue:

> **El Plan 1 no se despliega sin la última tarea del Plan 2B.** Desplegar solo
> el backend degrada esa función en silencio, y el silencio es lo peligroso:
> nadie abre un parte porque nada parece roto.

Y una nota de método, porque volverá a pasar: `exposedHeaders` en `app.ts`
siguió listando `x-new-token` mucho después de que nadie la emitiera. Una
cabecera en esa lista no prueba que exista — la lista solo dice qué puede leer
el JavaScript de la página, y `supertest` no la aplica, así que ningún test de
integración nota la diferencia. Lo único que lo caza es el test que fija la
lista por igualdad.

### Si roban una cuenta: «cerrar todas mis sesiones». Y por qué antes no valía

**Desde el Plan 2C esto ya funciona como cualquiera esperaría.** Si a alguien le
roban la cuenta: se le cierran todas las sesiones y se le cambia la contraseña. El
que tuviera la credencial queda fuera en la siguiente petición que haga.

Queda escrito lo que había antes, porque hace falta para entender los commits de
agosto y porque explica por qué este plan existía.

**Durante la coexistencia —los planes 2A y 2B— un token antiguo robado no lo
alcanzaba ninguna revocación.** El atacante no mandaba cookie, así que su petición
iba por el camino viejo, que por definición no tenía fila que marcar. Ni cambiar la
contraseña, ni «cerrar todas mis sesiones», ni nada.

Lo único que lo echaba era **archivar la cuenta**, porque entonces la consulta del
usuario devolvía vacío en los dos caminos y la sesión moría en el acto. Luego se
desarchivaba y se le ponía una contraseña nueva. Era contraintuitivo y por eso
estaba escrito antes de necesitarlo.

Eso se acabó cuando el Plan 2C retiró el camino viejo: sin un segundo camino que
autentique sin fila, **una sesión revocada es una sesión que no vuelve**. Es la
única cosa de todo este arco que cambia lo que el sistema puede prometer; el resto
lo construyó.

### Deuda declarada, para que no se descubra dos veces

- **`error.message` en el cuerpo de la respuesta, en unos veinte controladores.**
  Los tres alcanzables sin sesión están cerrados (`loginUsuario`, `comprobarToken`
  y el `catch` exterior del login); el resto va **detrás de `authenticate`**, así
  que quien los provoca ya ha entrado. Sigue siendo información del interior que
  nadie necesita — nombres de tabla y de columna de Postgres — pero es otra escala
  de trabajo y no entra en este arco.
- **`GET /api/permisos/mias`** ya no lo llama nadie. Queda declarado en el docstring
  de su ruta en vez de retirado, porque retirarlo obliga a tocar un test que estaba
  en manos de otro trabajo en curso.
- **`PerfilPage` valida la contraseña nueva con seis caracteres y el servidor exige
  doce.** Preexistente, y a tres líneas de lo que la Tarea 9 tocó. El servidor rechaza
  correctamente, así que no entra ninguna contraseña débil; lo que pasa es que la
  pantalla deja pulsar y el error llega del servidor en vez de avisar antes.
- **Un cambio de permisos de un rol no llega a quien tiene el ERP abierto.** El
  frontend compara ids de rol, no permisos, así que conceder un módulo a un rol no
  se nota hasta que la persona recarga. No es una regresión: el mecanismo anterior
  tenía el mismo punto ciego.

## 12. Riesgos

**El `rpID` es irreversible.** Se fija en `www.osefi.net`. Si algún día la web se
mueve a otro nombre, todas las passkeys mueren y hay que registrarlas otra vez.
Es el precio de no dejar el ápice abierto a todos los subdominios.

**Subdomain takeover.** La cookie `__Host-` y el `rpID` en `www` cierran las dos
vías conocidas, pero un subdominio tomado sigue siendo same-site: conviene
revisar los registros DNS de `osefi.net` y borrar los que cuelguen.

**Se despliegan los cuatro bloques a la vez**, por decisión expresa. Si algo falla
hay cuatro sospechosos. Lo compensan el procedimiento de §11, el endpoint de
reset por administrador y probar con una cuenta que no sea la de admin.

**Passkeys en navegadores viejos.** `userVerification: 'required'` con
`residentKey: 'required'` necesita navegador y sistema recientes. Quien no pueda
usa TOTP. Por eso hay dos métodos.

**Las imágenes ahora llevan la cookie.** `express.static` está montado en la raíz
antes de autenticar, y el frontend construye `<img src>` contra el origen de la
API. Como `www` y `api` son same-site, la cookie viajará en cada imagen —decenas
por pantalla—. No rompe nada y `express.static` la ignora, pero es falso decir
que este trabajo no toca el punto 9 de la auditoría: multiplica la superficie de
transmisión de la credencial. El logger ya redacta `req.headers.cookie` y excluye
las imágenes.

**El tope de 100 correos al día.** Se mitiga precargando emails (§8) y contando
la gracia por usuario, pero los reenvíos —"no me ha llegado", "míralo en spam"—
son la mayoría del tráfico real.

## 13. Qué cambió respecto a la revisión 1

Lo esencial, para quien leyera la primera versión:

1. **`authenticateToken` mira el estado de la sesión.** Antes, la cookie
   entregada al validar la contraseña ya abría todo el ERP: el MFA era un
   obstáculo de interfaz.
2. **Alta y baja de factor exigen step-up**, y hay `DELETE` para passkeys y
   sesiones. Antes, un atacante registraba su passkey y no había ninguna acción
   que la víctima pudiera ejecutar para expulsarlo.
3. **`id_usuario` en `token_uso_unico` y `dispositivo_recordado`.** Sin él se
   podía resetear la contraseña de cualquiera y trasplantar el "recordado".
4. **El dispositivo recordado no escribe `mfa_satisfied_at`.** Antes abría diez
   minutos de step-up satisfecho en cada login.
5. **Cookie host-only `__Host-`** en vez de `Domain=.osefi.net`, y **`rpID` en
   `www`** en vez del ápice. Las dos justificaciones anteriores eran técnicamente
   erróneas.
6. **El día 15 está definido** y no echa a nadie; la gracia se cuenta desde el
   primer login; el email no bloquea la entrada.
7. **Endpoint de reset de MFA para el administrador**, y el script de rescate
   compilado a `dist` — antes no habría arrancado en el contenedor.
8. **`JWT_SECRET` no se borra el día 0**, o el rollback entra en bucle.
9. **Procedimiento con `pg_dump` verificado** y vuelta atrás escrita.
10. **El alcance del frontend es 92 cabeceras y 210 referencias**, no tres
    ficheros — y `App.tsx` decide el enrutado con el token.

## 14. Lo que no entra

- **Login con Google o Microsoft.** Tiene sentido si algún día hay cuentas
  corporativas; hoy los usuarios los da de alta un administrador.
- **Arreglar `VITE_ORS_API_KEY`**, que viaja en el bundle. Es real y está en la
  auditoría, pero se arregla haciendo de proxy desde la API y es otro trabajo.
- **Autenticar las imágenes** (punto 9 de la auditoría). Mismo motivo, con el
  matiz de §12.
- **El teléfono como factor.** Cuesta dinero siempre y el NIST lo desaconseja.
