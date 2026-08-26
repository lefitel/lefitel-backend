# Plan 3 — Correo verificado y recuperación de contraseña

**Spec:** [`2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md)
— §3 (campos nuevos de `usuario`, `token_uso_unico`, limpieza), §4 (el email no
bloquea la entrada), §5 (endpoints y respuestas uniformes), §6 (limitadores),
§10 (tests).

**Rama:** `isaias`, en los dos repos. **Precede a:** Plan 4 (passkeys, TOTP,
códigos de recuperación).

---

## Por qué esto va antes que el MFA

El encargo era entrar más rápido y con más seguridad. Nada de eso puede
desplegarse sin una vía de vuelta: en cuanto el segundo factor sea obligatorio,
cualquier fallo —un móvil roto, un cambio de teléfono, una app desinstalada— deja
a una persona fuera de su propio sistema. Hoy la única vía de vuelta es que un
administrador le cambie la contraseña a mano, y eso exige que el administrador
esté disponible, tenga el portátil delante, y no sea él el afectado.

El correo verificado es el canal que hace posible todo lo demás. No es una
función que el usuario pida: es la infraestructura que permite que el Plan 4 avise
de un alta de factor, y que quien se quede fuera vuelva a entrar sin llamar a
nadie.

**El servidor obliga el orden.** El spec fija que `/auth/totp/*` y
`/auth/webauthn/register/*` respondan 409 si el email no está verificado. Así que
esto no es una preferencia de calendario: sin el Plan 3, el Plan 4 no arranca.

## Prerrequisito ya resuelto, y conviene que quede escrito

El envío de correo estaba bloqueado en una decisión que no era técnica: qué
proveedor y con qué claves. **Resuelto el 24 de agosto**, y verificado de punta a
punta antes de escribir este plan:

```
proveedor      Resend, capa gratuita permanente (3.000/mes, 100/día, sin tarjeta)
dominio        osefi.net verificado — DKIM + return-path en send.osefi.net
región         São Paulo (sa-east-1)
DNS            Namecheap. El SPF de la raíz intacto: los registros de Resend son CNAME
DMARC          v=DMARC1; p=none;
clave de API   restringida a solo envío — comprobado: un GET a /emails responde 401
entrega        un envío real llegó a la bandeja de Gmail, no a spam
```

**Lo que esto significa para las tareas de abajo:** el envío se puede verificar de
verdad, no simular. Una tarea que dice «manda un correo» se acepta con un correo
recibido y su `id` de Resend pegado, no con un test que espía la función.

Las variables ya están en `api/.env` y en `api/.env.docker`: `RESEND_API_KEY` y
`MAIL_FROM` (hoy `info@osefi.net`). **En Coolify todavía no** — eso va en el
despliegue, no en el desarrollo.

---

## Lo que este plan NO hace, y por qué

Tres piezas del spec caen del lado del Plan 4 aunque aparezcan junto al email.
Están aquí escritas para que nadie las añada «de paso», y para que nadie las eche
de menos creyendo que se olvidaron.

**Los tres estados de sesión (`parcial` / `onboarding` / `completa`) no entran.**
Existen para acorralar a alguien hasta que configure un segundo factor. Sin
factores que configurar, `onboarding` es un estado del que no se puede salir: su
condición de salida es «tiene factor», y no hay ninguno que registrar. Meter la
columna ahora es una máquina de estados con un sumidero.

Hay además un coste medido: `req.user` es hoy `{ id, id_rol, id_sesion,
expires_at }` y **lo consumen 24 ficheros**. Cada campo nuevo es un tipo que toca
en 24 sitios. Se paga cuando compre algo.

**`requireStepUp` no entra.** El step-up exige reafirmar un factor reciente, y no
hay factor con el que reafirmar. Lo que sí existe ya, del Plan 2C: las dos
operaciones sensibles sobre la cuenta propia —cambiar la contraseña y cambiar el
nombre de usuario— **exigen la contraseña actual, comprobada en el servidor**. Ese
es el step-up que este sistema puede ofrecer hoy, y ya está puesto.

**`pass_changed_at` no entra**, y esta merece explicación porque el spec la lista
entre los campos nuevos de `usuario`.

No se olvidó: se aplazó a propósito, y el motivo está escrito en
[`usuario.controller.ts:678-683`](../../src/controllers/usuario.controller.ts#L678-L683)
— *«una columna que nadie escribe es peor que ninguna columna, así que llega junto
con su escritura y la consulta que la lee, o no llega»*. Y no hace falta para nada
de este plan: **cambiar la contraseña ya revoca las demás sesiones hoy**, con una
llamada explícita a `revokeAllSessionsOf`, no comparando fechas. La columna era el
cinturón además de los tirantes.

`Ruling: pass_changed_at se queda fuera. — El mecanismo que protegería ya funciona
por otra vía y está probado; añadir la columna sin lector reproduce exactamente el
defecto que su propio comentario advierte. — Coste si me equivoco: una defensa en
profundidad de menos frente a un camino de cambio de contraseña que se olvidara de
revocar, que hoy no existe.`

---

## El agujero que abre este plan, y lo que se hace al respecto

Esto es lo más importante del documento y no va escondido al final.

**Hoy, robar el Gmail de alguien no da acceso al ERP.** En cuanto exista «he
olvidado mi contraseña», ese Gmail robado **es** la cuenta del ERP. El buzón pasa
a valer lo mismo que la contraseña.

El spec tiene respuesta: *«el reset de contraseña no crea sesión; devuelve a la
pantalla de login y obliga a pasar el segundo factor»*. Correcta, e **inaplicable
hasta el Plan 4**, porque ese factor todavía no existe. Entre este plan y el
siguiente hay una ventana en la que el buzón personal de cada técnico —cuentas de
Gmail que nadie ha endurecido y que la empresa no controla— es una llave completa.

Conviene el contexto justo: el sistema **ya** es de un solo factor de punta a
punta, así que esto no baja el listón general. Lo que hace es abrir **un camino
nuevo** hacia él, y hay que decirlo así.

Dos mitigaciones, obligatorias, parte de la definición de terminado:

1. **Cada reset por correo escribe una línea `critical` en la bitácora**, visible
   desde el ERP sin entrar al servidor.
2. **Cada reset avisa a una dirección fija de la empresa**, además de a la del
   usuario. Avisar solo al buzón del usuario no vale nada cuando es el atacante
   quien lo lee; avisar a un tercero significa que un secuestro lo ve alguien que
   no es el atacante.

### 🔴 Y la ventana no se acepta: se elimina. Este plan NO se despliega solo

Decisión de Isaias, el 2026-08-25: **nada de esto llega a producción hasta que
esté acabado.** Eso disuelve el riesgo en vez de aceptarlo — si el Plan 3 no se
despliega sin el Plan 4, el momento en que un buzón vale una cuenta **no existe
nunca en producción**.

Está escrito aquí, y no solo en la cabeza de nadie, porque es la clase de cosa que
se pierde: dentro de seis meses alguien —yo mismo, después de compactar el
contexto— puede ver el Plan 3 terminado y verificado en la rama y desplegarlo
suelto, reabriendo la ventana sin saber que existía.

**Regla:** el Plan 3 y el Plan 4 se despliegan juntos, o el Plan 4 después del 3
sin que el 3 haya pasado por producción. Ver §11 del spec.

`Ruling: la recuperación por correo entra completa en este plan, con las dos
mitigaciones como parte de su definición de terminado. — Isaias resolvió el
compromiso por una vía que yo no había planteado: no desplegar. Las mitigaciones
se construyen igual, porque no eran solo para la ventana: una línea critical y un
aviso a un tercero valen lo mismo el día que el MFA esté puesto, cuando un reset
legítimo tiene que ser visible para alguien que no sea quien lo pidió. — Coste si
me equivoco: se construyen dos avisos que nadie mira, por unas pocas líneas.`

---

## Global Constraints

Vinculan a todas las tareas. Un revisor las usa como lente de atención.

1. **`POST /auth/email/send` y `POST /auth/password/forgot` responden siempre lo
   mismo**, exista la cuenta o no, esté el email verificado o no, funcione el
   proveedor o no. Mismo cuerpo, mismo código, mismo tiempo aproximado. Si no, son
   buscadores de quién tiene cuenta en la empresa.

2. **Ningún token viaja a los registros.** Ni al log de la aplicación, ni a la
   bitácora, ni al cuerpo de una respuesta de error. En la base se guarda su hash,
   nunca el token.

3. **Los tokens son opacos, hasheados y de un solo uso. No son JWT.** Acabamos de
   dedicar el Plan 2C entero a retirar un JWT porque no se podía revocar; un token
   de reset irrevocable es peor que el que quitamos.

4. **Ningún endpoint de canje acepta identificador de usuario ni de email en el
   cuerpo.** Todo sale de la fila del token. Esta es del spec y es literal: sin
   ella se pide un reset de la cuenta propia y se canjea contra la del
   administrador.

5. **Todo correo lleva versión en texto plano además de HTML.** Un mensaje solo
   HTML es señal de spam y no se lee en clientes que no pintan HTML.

6. **El cupo de correo es un recurso compartido y finito.** 100 al día para toda la
   empresa. Todo endpoint que provoque un envío lleva limitador propio, y agotarlo
   deja a la empresa entera sin recuperación.

7. **Cambiar el email pone `email_verified_at` a NULL** y **anula los tokens
   pendientes** de esa cuenta.

8. **`/auth/password/forgot` solo opera sobre emails verificados** — y responde
   igual cuando no lo están.

9. **El reset revoca todas las sesiones de la cuenta, sin excepción, y no crea
   sesión.** Devuelve al login.

10. **Nada de `error.message` en el cuerpo de una respuesta** en el código nuevo.
    Hay ~20 controladores que lo hacen, son deuda declarada, y este plan no añade
    el veintiuno.

11. 🔴 **No hay harness de base de datos compartido.** Los 48 ficheros de test
    mockean los modelos **a mano, uno por uno**. Eso significa que **un camino
    nuevo que use un método de modelo que el fichero no haya mockeado escribe en
    la base local de verdad — que es una copia de producción**. Ya pasó en este
    arco: un test usó `UsuarioModel.increment`, que nadie había sustituido, y
    dejó cinco `UPDATE` reales. Todo implementador dice en su informe qué métodos
    de modelo toca su código y confirma que están mockeados en los tests que lo
    ejercitan.

12. **Lenguaje:** código, comentarios, nombres y mensajes de commit en inglés.
    Este documento y la bitácora, en español.

13. **El cuerpo de la petición se lee a la defensiva, y hay dos casos medidos que
    conviene conocer.** Con `express.json()` montado como está en
    [`app.ts:109`](../../src/app.ts#L109), sobre **Express 4.22.2**, que es lo que
    hay instalado:

    ```
    POST sin Content-Type ni cuerpo   → req.body === {}     (200, llega al handler)
    POST con Content-Type: text/plain → req.body === {}     (200, llega al handler)
    POST con JSON {}                  → req.body === {}
    POST con JSON mal formado         → HTTP 400 de body-parser, cuerpo HTML,
                                        y el handler NO se ejecuta
    ```

    **Historial, porque afecta a lo que este plan puede prometer:** durante unas
    horas del 25 de agosto otra sesión tuvo Express **5.2.1** instalado, donde los
    dos primeros casos dan `req.body === undefined` — y entonces
    `const { token } = req.body` lanza un TypeError y devuelve **500** donde ahora
    da un 400 limpio. Esa migración se revirtió, pero **volverá**, y cuando vuelva
    no habrá ningún aviso.

    Así que: **el cuerpo se lee con la forma defensiva, que funciona en las dos
    versiones.** Ya existe en el repo y se imita literalmente —
    [`auth.controller.ts:160-161`](../../src/controllers/auth.controller.ts#L160-L161):

    ```ts
    (req.body as { token?: unknown } | undefined)?.token
    ```

    Y **todo endpoint público de este plan lleva un test de `POST` sin cuerpo
    exigiendo 400.** Hoy pasaría igualmente; su valor es que **el día que Express 5
    vuelva, ese test se pone rojo en vez de que un 500 aparezca en producción**.

    **Lo que este plan NO puede prometer, y se dice en vez de fingirlo:** un JSON
    mal formado no llega al handler, así que su respuesta no es la uniforme que
    promete la constante nº 1 — es el 400 en HTML de body-parser. No rompe la
    propiedad de seguridad, porque **no depende de que la cuenta exista**, así que
    no enumera nada. Pero los tests de respuesta uniforme **no deben ejercitar ese
    camino esperando JSON**: se romperían por un motivo que no es el suyo.

---

## Task 1: Las dos columnas y los dos índices, ensayados contra la copia de producción

Los índices son la parte que puede fallar, y fallan **en producción y no en la
copia**, así que el ensayo va primero y su salida se pega en el informe.

```sql
ALTER TABLE usuarios ADD COLUMN email VARCHAR(255) NULL;
ALTER TABLE usuarios ADD COLUMN email_verified_at TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX usuarios_email_verificado_uniq
  ON usuarios (lower(email))
  WHERE email_verified_at IS NOT NULL AND "deletedAt" IS NULL;
```

🔴 **CORREGIDO durante la ejecución (2026-08-25).** Este bloque pedía además
`usuarios_user_uniq` sobre `lower("user")`, copiado del spec §3, que lo llama «la
novena migración, de propina y de una línea». **Ese índice ya existe:** lo creó el
Plan 1 en
[`20260821000001-add-account-lockout.ts:52`](../../src/migrations/20260821000001-add-account-lockout.ts#L52).

El error no era inocuo. Todo va en una transacción, así que un segundo `CREATE
UNIQUE INDEX` con el mismo nombre **no habría sido un no-op: habría fallado con
«relation already exists» y se habría llevado las dos columnas de email en la
reversión.** La migración entera no habría aplicado nunca.

Lo encontró el implementador mirando el disco. Yo copié la afirmación del spec sin
comprobar si seguía siendo cierta — y el spec la escribió el 21 de agosto, el mismo
día que el Plan 1 la resolvió.

**El índice de email es parcial y no un `UNIQUE` a secas**, por tres motivos que
el spec ya razonó y que hay que dejar en un comentario del fichero, porque el
siguiente que lo lea querrá simplificarlo: (1) una reclamación **sin verificar**
bloquearía al dueño legítimo del buzón; (2) `usuario` es `paranoid`, así que la
fila del ex-empleado archivado retendría su dirección para siempre y nadie podría
reasignarla; (3) `lower()` porque Postgres distingue mayúsculas en el `UNIQUE` y
los buzones no.

**La consulta de duplicados se corre igual, y no es ceremonia.** El índice de
nombres de usuario ya está escrito, pero **el Plan 1 no está desplegado**: ese
`CREATE UNIQUE INDEX` se estrena contra producción el día que salga. Y
`createUsuario` sigue sin comprobar colisión, así que un duplicado puede nacer
entre hoy y ese día. Si hay dos filas vivas con el mismo `user`, la transacción
revierte, `SequelizeMeta` no se marca, y el despliegue reintenta con el mismo error
hasta que alguien lo mire.

Correrla ahora contra la copia local es la única forma de saber si ese problema
existe **antes** de la noche del despliegue.

**Criterio de aceptación, sin sustituto:**

1. Correr esto contra la base local y **pegar la salida literal**, aunque sean
   cero filas:

   ```sql
   SELECT lower("user"), count(*), array_agg(id)
   FROM usuarios WHERE "deletedAt" IS NULL
   GROUP BY 1 HAVING count(*) > 1;
   ```

2. Si devuelve alguna fila: **parar y decirlo.** Decidir qué cuenta sobrevive es
   de Isaias, no del implementador.

3. Aplicar la migración contra la copia, comprobar con `\d usuarios` que las dos
   columnas y los dos índices existen, y **pegar la salida**. El repo no tiene
   ninguna prueba automática de que un DDL sea válido: correrlo es la única
   verificación que hay.

Los campos van también a `UsuarioModel`. El email se normaliza a minúsculas
**al escribir**, en un solo sitio, nunca al leer.

**`USUARIO_AS_AUTHOR` no se toca:** el email no es dato de autoría y no debe
viajar en las respuestas que dicen quién registró algo.

---

## Task 2: `token_uso_unico` — y por qué el cuerpo de la petición no dice a quién

La tabla y su nombre son del spec, no invención de este plan.

```
token_uso_unico
  id             UUID PK
  id_usuario     INTEGER NOT NULL  → usuarios(id)
  email_destino  VARCHAR(255) NOT NULL
  token_hash     VARCHAR(64) NOT NULL UNIQUE   -- SHA-256 hex, indexado
  proposito      VARCHAR(32) NOT NULL          -- 'verify_email' | 'reset_password'
  expires_at     TIMESTAMPTZ NOT NULL
  used_at        TIMESTAMPTZ NULL
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
```

**`id_usuario` y `email_destino` son NOT NULL, y ahí está la propiedad de
seguridad entera.** El spec lo dice literal: *«el endpoint no acepta ningún
identificador de usuario ni de email en el cuerpo: todo sale de la fila»*. Sin
dueño en la fila, el endpoint tendría que sacar el usuario del cuerpo de la
petición — y entonces se pide un reset de la cuenta propia y se canjea contra la
del administrador.

**Valores exactos, y son los del spec:**

| Cosa | Valor |
|---|---|
| Entropía | 32 bytes (`crypto.randomBytes(32)`), base64url |
| Guardado | **SHA-256 del token**, nunca el token |
| Vida de `verify_email` | **1 hora** |
| Vida de `reset_password` | **15 minutos** |

**Esa criptografía ya existe y no se duplica.**
[`src/auth/sessionToken.ts`](../../src/auth/sessionToken.ts) hace exactamente esto
para las sesiones: 32 bytes, base64url, SHA-256 en hexadecimal, con el razonamiento
de por qué SHA y no bcrypt ya escrito. Pero sus funciones se llaman
`newSessionToken` y `hashSessionToken`, y un módulo de recuperación de contraseña
importando «token de sesión» es un nombre que miente.

**Se extrae la primitiva, no se copia ni se renombra:** un módulo nuevo
`src/auth/opaqueToken.ts` con `newOpaqueToken()` y `hashOpaqueToken()`, y
`sessionToken.ts` **conserva sus dos funciones delegando** en él. Así:

- La criptografía vive en un solo sitio.
- Los llamadores y tests existentes de `sessionToken` **no se tocan** — sigue
  exportando lo mismo. El Plan 2C acabó de estabilizar ese código hace un día y
  renombrar sus funciones públicas mueve seis ficheros de test para no ganar nada.
- El comentario sobre el coste de bcrypt en el camino de cada petición **se queda en
  `sessionToken.ts`**, porque es razonamiento de sesiones, no de tokens en general.

`Ruling: extraer en vez de copiar o renombrar. — Copiar cuatro líneas de
criptografía deja dos sitios donde arreglar el mismo fallo; renombrar arrastra seis
ficheros de test de código recién estabilizado. Delegar cuesta un fichero nuevo y
dos líneas. — Coste si me equivoco: una indirección más en el camino de cada
petición autenticada, que es una llamada a función.`

**Por qué tabla y no columnas en `usuarios`:** con columnas, «un solo uso» se
implementa borrando el valor, no queda rastro de que se usó, y no puede haber dos
pendientes. Con tabla, «usado» es una escritura, la invalidación al cambiar de
email es un `DELETE` de una línea, y queda historial. Es además el patrón ya
probado en este repo con `sesiones`.

**El canje es atómico y no se parte en leer-y-luego-escribir:**

```sql
UPDATE token_uso_unico SET used_at = now()
WHERE token_hash = $1 AND proposito = $2
  AND used_at IS NULL AND expires_at > now()
RETURNING id_usuario, email_destino;
```

Cero filas significa «no valía», y **no hay que distinguir por qué**: caducado,
gastado e inexistente contestan lo mismo. Partirlo en un `SELECT` y un `UPDATE`
abre la puerta a que dos peticiones simultáneas canjeen el mismo token.

**La limpieza va aquí, no en una tarea futura.** El spec la pide: los usados y
caducados se purgan. Se hace de forma **oportunista en el login** —una sentencia,
sin job ni cron— porque un job diario es una pieza móvil más que puede dejar de
correr sin que nadie lo note.

**Esta tarea es dueña del canje Y de la acuñación, no solo de la tabla.** Las dos
funciones viven en este módulo y las Tasks 4 y 5 las llaman. No se copia ninguna de
las dos sentencias en un controlador: es donde vive toda la seguridad del mecanismo,
y dos copias divergen a la primera corrección.

```
consumirToken(token, proposito, transaction?)         → { id_usuario, email_destino } | null
crearToken({ id_usuario, email_destino, proposito })  → el token en claro, una sola vez
```

**La `transaction` opcional del canje también se añadió durante la ejecución**, y la
levantó el implementador. Sin ella, `/password/reset` tiene un estado en el que el
token está gastado y la contraseña sin cambiar: la secuencia es canjear, hashear,
escribir, limpiar el bloqueo y revocar sesiones, y un fallo en cualquier paso
posterior al canje **encierra a la persona** con un token de quince minutos y tres
peticiones por hora de cupo.

🔴 **Y va con una regla de uso que se olvida:** quien la llame dentro de una
transacción **hashea la contraseña ANTES de abrirla**. bcrypt con coste 12 son unos
250 ms de CPU que no necesitan la base para nada, y meterlos dentro deja la fila del
token bloqueada todo ese rato. `/password/reset` no es un camino caliente, pero una
transacción abierta por trabajo de CPU es un patrón que se copia.

En `/email/verify` la transacción importa mucho menos, y conviene saber por qué: el
caso que este plan **espera** ahí es que el índice único rechace la dirección porque
otra cuenta ya la verificó, y en ese caso **quemar el token es lo correcto** —
reintentar no arreglaría nada, esa dirección es de otro.

🔴 **`crearToken` se añadió durante la ejecución: el brief original solo especificaba
quién canjea y se olvidó de quién acuña.** Lo levantó el implementador. Sin él, las
Tasks 4 y 5 escriben cada una su generar+hashear+insertar y **las dos caducidades
acaban dentro de dos controladores distintos** — exactamente la divergencia que el
ruling de `consumirToken` existía para evitar, dejada abierta por el otro lado.

**Las dos caducidades viven en este módulo, no en el llamador.** Que la duración la
elija el módulo y no quien lo llama es lo que impide que un endpoint futuro pida «un
token de reset de tres días».

**Y acuñar invalida los anteriores del mismo propósito** para ese usuario, en la
misma transacción. Un enlace de reset que sigue valiendo después de haber pedido
otro es una credencial viva con una vida efectiva mucho mayor que quince minutos:
dos peticiones seguidas dejan dos llaves en dos correos, y la primera se puede leer
mañana. El coste —pulsar un enlace viejo y que no funcione— ya está cubierto: la
pantalla dice «este enlace ya no vale, pide otro», el mismo mensaje que para
caducado e inexistente.

**Nombre del fichero de migración: `20260825000002-create-token-uso-unico.ts`.**
El de la Task 1 es `20260825000001-add-email-fields.ts`. Se fijan aquí porque las
migraciones se ordenan por nombre y dos implementadores distintos eligiendo el
mismo sello es un choque silencioso.

**Criterio de aceptación, y cada test se demuestra rompiendo el código:**

- Consumir el mismo token dos veces y ver fallar la segunda. Después: **quitar
  `used_at IS NULL` del `UPDATE` y demostrar que el test se pone rojo.** Si sigue
  verde, el test no prueba nada.
- Un token caducado no vale. Después: quitar `expires_at > now()` y verlo fallar.
- Un token de propósito `verify_email` **no** sirve en el canje de
  `reset_password`. Después: quitar `proposito = $2` y verlo fallar.
- **El token en claro no está en la base:** buscarlo literal y exigir cero filas.

---

## Task 3: El envío de correo, detrás de una sola función

Todo el correo del sistema sale por una función. Ni el controlador de email ni el
de contraseñas hablan con Resend.

**Por qué una sola:** si algún día hace falta un segundo proveedor —porque Resend
suspenda la cuenta o el cupo diario muerda— se cambia un fichero y no se busca por
el repo. Hoy **no se escribe ese segundo proveedor**: el cupo son 3.000 al mes
contra un tráfico real de decenas, y la vía de escape para «el correo no funciona»
es la cuenta de rescate del §8 del spec, no otro SMTP.

**Contrato:**

```
enviarCorreo({ para, asunto, html, texto }) → Promise<{ ok: boolean }>
```

**`texto` es obligatorio en el tipo, no opcional.** Que el tipo lo exija es lo que
impide que se olvide. Se comprobó en un envío real el 24 de agosto que un mensaje
de dos líneas sin texto plano **llega** — pero llega por cortesía de un dominio sin
historial, no por estar bien hecho.

**Configuración**, siguiendo el patrón de [`src/config/security.ts`](../../src/config/security.ts):
`RESEND_API_KEY` y `MAIL_FROM`. En producción **obligatorias**: sin ellas el
proceso no arranca, igual que ya pasa con las variables de la cookie. En
desarrollo, si faltan, la función registra el destinatario y el asunto de lo que
habría mandado y devuelve `{ ok: true }`, **diciendo en el log de forma
inequívoca que no se mandó nada** — para que el resto se pueda desarrollar sin
gastar cupo y sin que nadie crea que el correo salió.

### 🔴 El módulo se niega a mandar bajo tests, y no por disciplina

Añadido durante la ejecución, tras medir el entorno. El riesgo no es gastar cupo: es
que **un test que manda a una dirección inventada provoca un rebote, y los rebotes
dañan la reputación del dominio** — que se estrenó ayer y no tiene ninguna. Unos
pocos, y los correos de recuperación de todo el mundo empiezan a caer en spam.

Medido en este repo, no supuesto:

```
Bajo vitest:  NODE_ENV === "test"  y  VITEST === "true"
dotenv.config() corre en src/database/sequelize.ts:9
  → cualquier test que importe la capa de base de datos
    TIENE RESEND_API_KEY en el entorno
```

Así que confiar en que cada autor de test recuerde mockear el módulo no basta. **El
módulo comprueba las dos señales y se niega**, lo registra, y devuelve el mismo
`{ ok: true }` que en desarrollo sin claves. **Un mock olvidado tiene que ser
inofensivo por construcción, no por disciplina.**

**Y de ahí se sigue que el envío real no es un test:** es una verificación manual, un
comando de una vez fuera de vitest, cuyo `id` de Resend se pega en el informe. Un
test que manda correo de verdad gasta cupo cada vez que alguien corre la suite.

`Ruling: el guardián va dentro del módulo y no hay variable para saltárselo. — Un
override es una puerta que alguien acaba dejando abierta en CI, y el caso legítimo
—verificar que el envío funciona— no es un test: es una comprobación manual que se
hace una vez. — Coste si me equivoco: para probar el envío hay que salir de vitest,
que es exactamente lo que se quiere.`

**Lo demás que nunca pasa:**

- **Un token no entra en el log.** Se registra destinatario y asunto; el cuerpo,
  jamás — ni en modo desarrollo, que es precisamente donde apetece imprimirlo.
- **Un fallo no propaga como error visible.** Si Resend responde 4xx o 5xx, se
  registra y se devuelve `{ ok: false }`. El llamante **no cambia su respuesta al
  cliente por eso**: manda la constante nº 1.

**Criterio de aceptación:**

- Test de que la llamada lleva `text` además de `html`. Después: **borrar `texto`
  del cuerpo y verlo rojo.**
- Test de que un 500 de Resend no lanza y devuelve `{ ok: false }`.
- **Un envío real recibido en un buzón, con el `id` de Resend pegado en el
  informe.** Un test que espía la función no demuestra que el correo sale.
- Grep pegado demostrando que ningún fichero fuera de este módulo importa
  `resend`.

---

## Task 4: `POST /auth/email/send` y `POST /auth/email/verify`

El usuario registra su dirección y la confirma. Las dos rutas van **detrás de
`authenticate`**: es tu propia cuenta, y para eso ya has entrado.

**`/email/send`** recibe la dirección, la normaliza a minúsculas, la guarda en
`usuarios.email` **con `email_verified_at` a NULL**, crea un token
`verify_email` de una hora y manda el correo. **Responde siempre lo mismo**,
incluso si el envío falló.

**Sobre el email ajeno ya verificado:** el índice parcial permite que dos cuentas
reclamen la misma dirección **sin verificar**, y solo una la verifique. Así que
`/email/send` **no comprueba colisión** —comprobarla sería decir «esa dirección ya
es de alguien», que es enumeración— y el choque salta **en el canje**, contra el
índice. El canje contesta el mismo error genérico que cualquier otro fallo.

**`/email/verify`** recibe **solo el token**. Nada más. Canjea con el `UPDATE`
atómico de la Task 2, y con el `id_usuario` y `email_destino` de la fila pone
`email_verified_at = now()`. **Si el email actual de la cuenta ya no coincide con
`email_destino`, el token no vale**: alguien cambió de dirección entre la petición
y el canje, y verificar la anterior dejaría verificada una dirección que el usuario
ya abandonó.

**Cambiar el email pone `email_verified_at` a NULL y borra los tokens pendientes
de esa cuenta**, en la misma transacción. Constante nº 7.

**Criterio de aceptación:**

- Un token de A no verifica a B. **Demostrarlo con el test, y después quitar el
  `id_usuario` de la fila del camino y ver el test rojo.**
- `/email/verify` **ignora** cualquier `id_usuario` o `email` que se le mande en
  el cuerpo. El test manda los dos, apuntando a otra cuenta, y exige que se
  verifique la del token.
- Un envío con Resend caído responde 200 igual. Test con la función mockeada
  devolviendo `{ ok: false }`.
- Cambiar el email invalida el token que estaba pendiente.

---

## Task 5: `POST /auth/password/forgot` y `POST /auth/password/reset`

Las dos son **públicas** — sin sesión, por definición. Y por eso son las dos rutas
más delicadas del plan.

**`/password/forgot`** recibe una dirección. Si existe una cuenta viva con ese
email **y verificado**, crea un token `reset_password` de 15 minutos y manda el
correo. En cualquier otro caso **no hace nada**. En los dos casos **responde
exactamente lo mismo**: mismo cuerpo, mismo código, mismo tiempo.

### 🔴 Y «mismo tiempo» exigía una inversión que este plan no tenía

Este apartado decía «sin diferencia de tiempo apreciable» y a continuación describía
una implementación **incapaz de cumplirlo**:

```
cuenta existe y verificada  →  consulta + INSERT del token + llamada HTTP a Resend  ≈ cientos de ms
no existe                   →  consulta                                              ≈ pocos ms
```

No es una diferencia sutil: es un canal de enumeración que se mide con un cronómetro
desde fuera. Quien quiera saber qué direcciones tienen cuenta en la empresa las
prueba una por una y lee el tiempo de respuesta. **La respuesta uniforme habría sido
decorativa** — exactamente el tipo de defensa que parece puesta y no está.

**Se cierra invirtiendo el orden: responder primero, trabajar después.** Se construye
la respuesta, se manda, y **solo entonces** se acuña el token y se manda el correo,
sin que el cliente espere. Los dos caminos devuelven en el mismo tiempo porque los
dos devuelven **antes de hacer nada caro**.

El patrón ya existe dos veces en el repo y no hay que inventarlo: la purga de tokens
tras el login (`purgeExpiredTokens().catch(...)`) y el propio `mailer.ts`, escrito
para que el llamador no pueda ramificar su respuesta según si el envío salió.

**Y el fallo posterior a la respuesta no se traga:** se registra. Un `/forgot` que
dejó de mandar correos tiene que verse en el log, no descubrirse cuando alguien se
queda fuera.

**En `/password/reset` no aplica**, y la asimetría es correcta: ahí el cliente
necesita saber si su contraseña cambió, y el trabajo *es* la respuesta.

`Ruling: /forgot responde antes de trabajar. — Sin eso la respuesta uniforme es
decorativa y el endpoint es un buscador de quién tiene cuenta, medible con curl y un
reloj. — Coste si me equivoco: un fallo de envío ya no puede cambiar la respuesta,
que es justo lo que la constante nº 1 exige de todas formas.`

Estas rutas van en `routeGuards.test.ts`, en la lista de excepciones de
autenticación, **con su motivo escrito**: son las que se usan cuando no puedes
entrar, así que no pueden pedir haber entrado.

**`/password/reset`** recibe **el token y la contraseña nueva. Ningún
identificador.** Canjea, valida la contraseña contra la regla del servidor (12
caracteres mínimo, recortando espacios y contando puntos de código — la regla ya
existe y no se reescribe), la hashea, y en la misma transacción:

- escribe la contraseña,
- pone `failed_attempts = 0` y `locked_until = NULL` — **esto es deliberado: una
  cuenta bloqueada tiene que poder salir del bloqueo por esta vía**, o el bloqueo
  y el olvido de contraseña se convierten en una trampa cerrada,
- **revoca TODAS las sesiones de la cuenta, sin excepción** (`revokeAllSessionsOf`
  sin `except`) — a diferencia del cambio de contraseña desde dentro, aquí no hay
  sesión propia que preservar y quien pide el reset no está dentro,
- marca el token usado.

**No crea sesión.** Devuelve al login. El spec insiste y tiene razón: si el reset
dejara sesión abierta, quien controle el buzón entra directo, y cuando llegue el
Plan 4 el segundo factor quedaría reducido a «tener acceso al email».

**Criterio de aceptación:**

- El token de A no resetea a B. Test del spec, §10.
- La respuesta de `/forgot` es idéntica con cuenta y sin cuenta. **Comparar los
  dos objetos completos, no solo el código.**
- Un email **no verificado** no recibe correo, y responde igual.
- Una cuenta bloqueada sale del bloqueo al resetear. **Y después: quitar el
  `locked_until = NULL` y ver el test rojo** — si sigue verde, no estaba probando
  el desbloqueo.
- Tras el reset, una petición con la cookie de la sesión anterior recibe 401.
- `/password/reset` ignora cualquier `id` o `email` del cuerpo.

---

## Task 6: Los limitadores — reutilizando el molde que ya existe

Sin esto, **un anónimo con un `curl` gasta los 100 correos del día y deja a la
empresa entera sin recuperación**. Es el riesgo más barato de explotar de todo el
plan.

**Ya existe el patrón de reembolso** en
[`loginLimiters.ts`](../../src/middleware/loginLimiters.ts) — `costsNothing` /
`confirmCostsNothing` vía `requestWasSuccessful`. **Se reutiliza ese molde, no se
inventa otro.**

| Ruta | Clave | Cupo |
|---|---|---|
| `/auth/password/forgot` | por email **y** por IP | 3 / hora por email · 20 / hora por IP |
| `/auth/email/send` | por cuenta (hay sesión) | 5 / hora |
| `/auth/password/reset` | **por IP (primaria)** y por token | 20 / hora por IP · 5 intentos por token |
| `/auth/email/verify` | por cuenta | 10 / hora |

**Las claves de `/forgot` son las dos, no una.** Solo por email, un atacante rota
direcciones y gasta el cupo global. Solo por IP, rota IPs y machaca un buzón
concreto a base de correos de reset — que no le da acceso, pero acosa a una
persona y quema cuota.

🔴 **En `/password/reset` la clave por IP es la primaria, y esto no es un detalle
de orden.** Un cubo cuya clave la elige el atacante no es un limitador: si la clave
fuera el token, quien prueba tokens inventados **estrena un cubo en cada intento** y
ninguno se agota jamás. Adivinar 32 bytes es inviable, así que no abre ninguna
cuenta — lo que abre es un **generador de carga gratis contra la ruta más cara del
sistema**, la que hashea con bcrypt de coste 12. Agotar la CPU del servidor con
`curl` y sin credenciales.

Y por lo mismo: **la contraseña nueva se valida ANTES de llegar al bcrypt**, no
después. Una petición con una contraseña de tres caracteres no debe costar un hash.

La clave por token es la secundaria y protege una cosa distinta y menor: que quien
ya tiene un token válido no reintente cincuenta veces con contraseñas que la regla
rechaza.

**Un 5xx no cobra el intento.** Un fallo del servidor no es un intento fallido del
usuario. Esto ya se aprendió por las malas en este arco: un 503 cobrando en el
cubo compartido dejó a la oficina entera fuera quince minutos por un parpadeo de
la base.

**Criterio de aceptación:**

- Test que agota el cupo de `/forgot` por email y comprueba que la 4ª responde
  429.
- Test que agota por IP rotando emails.
- **Test de que un 5xx no cobra**, y su demostración: quitar el reembolso y verlo
  rojo.
- **El nombre de cada limitador y su cupo se pinean en el test contra literales
  escritos a mano**, no contra la constante que están probando. Renombrar una
  constante y construir el valor esperado desde ella deja el test verde mientras
  producción se rompe — pasó en este arco con la cabecera de CSRF: 1.021 tests
  verdes y todas las escrituras del ERP en 403.

---

## Task 7: La bitácora y el aviso a un tercero — la mitigación de la ventana

Esto es lo que hace asumible el agujero de arriba. **No es una mejora posterior:
sin esta tarea el plan no está terminado.**

**Reparto de propiedad, para que esta tarea no reescriba lo que hicieron las dos
anteriores:** las Tasks 4 y 5 escriben **sus propias** llamadas a `logAction` para
sus propias acciones —quien escribe el camino escribe su registro— y esta tarea es
dueña de tres cosas que ninguna de las dos puede tener: la variable
`MAIL_SECURITY_TO`, el aviso al tercero, y **la auditoría del conjunto**: que las
cinco acciones estén, que las severidades sean las de la tabla, y que ninguna
lleve un token en su `metadata`.

`logAction` no tiene enum central — las acciones son cadenas libres. Se añaden,
con el mismo estilo que las existentes:

| Acción | Cuándo | Severidad |
|---|---|---|
| `EMAIL_SEND` | Se pide verificación | normal |
| `EMAIL_VERIFIED` | Se confirma una dirección | normal |
| `EMAIL_CHANGED` | Se sustituye una verificada | **critical** |
| `PASSWORD_FORGOT` | Se pide un reset y **existía** la cuenta | normal |
| `PASSWORD_RESET` | Se consuma un reset | **critical** |

**`bitacoras.id_usuario` es NOT NULL**, así que un `/forgot` contra una dirección
sin cuenta **no se puede registrar contra un usuario**. No se fuerza un id
inventado ni se relaja la columna: **no se escribe línea**, y eso se dice en el
comentario. Que un `/forgot` sin cuenta no deje rastro en la bitácora es
consistente con que tampoco deba dejar rastro en la respuesta.

**El aviso al tercero.** Variable nueva `MAIL_SECURITY_TO`. En `PASSWORD_RESET` y
en `EMAIL_CHANGED` sale un correo a esa dirección con quién, cuándo y desde qué
IP. **Si la variable no está puesta, no se manda y se registra que no se mandó** —
no se arranca a la fuerza, porque un despliegue sin ella tiene que seguir
funcionando, pero tampoco se calla.

**Al usuario también se le avisa** de que su contraseña cambió. Sirve de poco
contra quien controla el buzón, y sirve mucho contra el caso corriente: alguien te
resetea la contraseña por error y te enteras.

**Criterio de aceptación:**

- Test de que un reset escribe la línea `critical`. Después: **borrar la llamada a
  `logAction` y ver el test rojo.**
- Test de que un `/forgot` sin cuenta **no** escribe línea y **no** revienta.
- Test de que sin `MAIL_SECURITY_TO` el reset funciona igual.

---

## Task 8: El email en el perfil, y su verificación

Frontend. El campo no existe: **`UsuarioInterface` no tiene `email`** — cero
coincidencias en todo `web/src`. Hay que añadirlo al tipo y a las tres pantallas
de usuario.

`PerfilPage.tsx` gana un bloque de correo con tres estados visibles, y **los tres
tienen que distinguirse de un vistazo**: sin dirección · con dirección **sin
verificar** (con botón de reenviar) · verificada.

**El estado que importa es el de en medio.** Una dirección guardada y sin
verificar es exactamente igual de inútil que ninguna, y si la pantalla la pinta
como un dato más, el usuario cree que ya está.

Las funciones nuevas van en `Login.api.ts`, siguiendo el patrón que existe: axios
pelado, URL desde `urlApi`, `.then().catch()` que **no rechaza** y devuelve
`{ status, message }`. Y ahí hay una trampa conocida: ese patrón **aplana
cualquier respuesta inesperada a un 500**, así que un 429 del limitador llegaría a
la pantalla como error rojo genérico. **Un 429 se distingue y se dice en cristiano:
«has pedido demasiados correos; espera un rato».**

Validación manual con `useState` + `if` + `toast`, que es lo que usa el repo. **No
se introduce `zod` ni `react-hook-form`** en este plan: meter una librería de
formularios en la pantalla más delicada del sistema, en el mismo cambio que la
lógica nueva, es dos riesgos por el precio de uno.

Tests de la capa API con `vi.spyOn(axios, ...)`, que es el patrón de los 27 tests
existentes.

---

## Task 9: «He olvidado mi contraseña» y «Poner contraseña nueva»

Dos pantallas públicas nuevas, con react-router-dom v7, declaradas como
`/login` — que es el único ejemplo de ruta pública que hay.

**El enlace ya existe.** `web/src/pages/LoginPage.tsx:240-247` es un `<button>`
que dice «¿Olvidaste tu contraseña?» y cuyo `onClick` (línea 242) lanza
`toast.info("Contacte con el administrador del sistema para restablecer su
acceso.")`. **Ese `onClick` se sustituye por navegación real** — no se añade un
enlace nuevo al lado, y el `<button>` pasa a ser un enlace de router.

**Pantalla 1 — pedir el correo.** Un campo, un botón. Y al enviar, **el mismo
mensaje siempre**: «si esa dirección tiene cuenta, te hemos mandado un enlace».
Nunca «no existe esa cuenta». La pantalla no puede filtrar lo que el servidor se
cuida de no filtrar.

**Pantalla 2 — la contraseña nueva.** Llega con el token en la URL. Dos campos y
la regla de contraseña **reutilizando `src/lib/password.ts`**, que ya exporta
`PASSWORD_MIN_LENGTH` y `passwordLengthError()` y cuyo test **lee el fichero de
configuración del servidor desde el disco** y falla si los dos números divergen.
No se reescribe la regla: se importa.

Al terminar, **al login**, con un aviso de que la contraseña cambió y hay que
entrar. No se navega a la aplicación: no hay sesión, y fingir que sí la hay
produce una pantalla en blanco con un 401 detrás.

**El token va en el fragmento de la URL, no en la query.** Es decir
`…/nueva-contrasena#t=XXXX`, no `…/nueva-contrasena?t=XXXX`. La diferencia no es
estética:

- **Un fragmento no se manda nunca a ningún servidor.** El navegador lo resuelve en
  local. Una query sí viaja, y acaba en los registros de acceso de quien sirva esa
  página — hoy Vercel.
- **Un fragmento no aparece en la cabecera `Referer`.** Una query sí, así que
  cualquier recurso externo que cargue esa pantalla —una fuente, un icono, un
  script de analítica— se lleva el token de reset a un tercero. Y `helmet` está en
  la API, no en Vercel: no protege las páginas del frontend.

Cuesta lo mismo, porque la pantalla lee el valor y lo manda por `POST` de todas
formas. La única pega es que un fragmento no llega al servidor **por diseño**, así
que el enlace del correo **no puede** ser un enlace que el servidor procese: tiene
que abrir la pantalla y que la pantalla haga la petición. Que es exactamente lo que
hace.

**Y el token no se registra ni se pinta.** Está en la URL porque tiene que estarlo;
no se copia al estado global, ni a un `console.log`, ni a un mensaje de error, ni al
título de la pestaña. Al leerlo, **se limpia el fragmento** (`history.replaceState`)
para que no quede en la barra de direcciones ni en el historial del navegador.

**Estados que hay que dibujar, y son los que se olvidan:** token caducado, token
ya usado, token inexistente. **Los tres dicen lo mismo** —«este enlace ya no
vale, pide otro»— con un botón que vuelve a la pantalla 1. El servidor no
distingue entre los tres a propósito; la pantalla tampoco puede.

---

## Task 10: La dirección verificada tiene que verse

El spec lo pide con un motivo que conviene no perder: *un email con errata que
alguien verificó por reenvío no falla el día que se pone — falla meses después,
cuando ese buzón se cierra y es el único canal de recuperación.*

Dos sitios en este plan, y el tercero **no se puede construir todavía**:

1. **En el perfil, completa.** Ya va en la Task 8.
2. **Una columna en la lista de Seguridad**, con el estado de verificación. Es lo
   que permite a un administrador ver de un vistazo quién no ha pasado por aquí,
   sin ir cuenta por cuenta.

**Lo que el spec pide y aquí no cabe:** *«enmascarada en el flujo de entrada — tu
correo de recuperación es `j***z@osefi.net`, ¿es tuyo?»*. Eso vive en el momento
en que el servidor **ya sabe quién eres pero todavía no te ha dejado entrar** —
la sesión `parcial` del Plan 4. En el Plan 3 ese momento no existe: antes del
login el servidor no sabe quién eres, y decir el correo enmascarado a cambio de un
nombre de usuario es **un buscador de direcciones de correo de la empresa**;
después del login ya estás dentro y lo ves completo en tu perfil.

`Ruling: el enmascarado en el flujo de entrada se mueve al Plan 4. — No es que
sobre: es que en este plan solo se podría poner donde convierte una pantalla
pública en un enumerador. La función de enmascarado sí se escribe aquí, porque la
usa la columna de Seguridad. — Coste si me equivoco: la confirmación «¿es tuyo?»
llega una versión más tarde, y hasta entonces una errata en la dirección se
descubre en el perfil y no en la entrada.`

El enmascarado va en **una sola función con su test**, no repetido en tres
pantallas. Casos que el test fija: direcciones de una letra antes de la arroba,
sin punto en el dominio, y con varias arrobas — porque una función de enmascarado
escrita a ojo revienta o filtra en los tres.

---

## Verificación final

Antes de dar el plan por terminado:

1. `npm run lint` y `npx tsc --noEmit` limpios en los dos repos.
2. Los dos conjuntos de tests verdes, **con el recuento anotado** antes y después.
3. 🔴 **Consulta directa a la base local comprobando que los tests no la
   escribieron:** cero filas en `token_uso_unico`, ningún `email` ni
   `email_verified_at` inesperado, ninguna cuenta con `failed_attempts > 0`, y el
   recuento de líneas de bitácora de las últimas horas. La constante nº 11 explica
   por qué esto no es paranoia.
4. **Un ciclo completo contra un buzón real**, hecho a mano y con los `id` de
   Resend pegados: registrar dirección → recibir → verificar → pedir reset →
   recibir → cambiar contraseña → comprobar que la sesión anterior está muerta.
   Esto es lo único que demuestra que el plan funciona.
5. `routeGuards.test.ts` reconoce las rutas nuevas y su lista de excepciones sigue
   siendo honesta.

## Riesgos

**El cupo diario es el punto único de fallo del plan.** 100 correos al día para
toda la empresa. La Task 6 lo protege de un abuso externo, pero no de un día de
altas masivas: si veinte personas registran su dirección y la mitad pide reenvío,
se llega a la mitad del cupo sin que nadie haga nada raro. **Hay que mirar el
contador de Resend los primeros días.** Quien se quede sin cupo puede seguir
trabajando; no puede verificar hasta el día siguiente.

**El correo puede llegar a spam a partir de cierto volumen.** El envío de prueba
del 24 de agosto entró en bandeja, pero desde un dominio con cero historial: eso
es cortesía, no reputación. Si empieza a caer en spam, se nota en el momento peor
—alguien esperando un enlace para volver a entrar— y la vía de escape es la del
§8 del spec, no reintentar.

**Un correo de recuperación puede perderse sin que nadie lo sepa, y es el precio de
cerrar el canal de tiempo.** Lo levantó el implementador de la Task 5 y pidió que se
dijera en voz alta en vez de quedar solo en un comentario del código, con razón.

`/forgot` responde **antes** de acuñar el token y mandar el correo — es lo que hace
que la respuesta uniforme sea real y no decorativa. La contrapartida: si el proceso
muere en esa ventana de unos cientos de milisegundos, **ese correo no se manda y el
único rastro es una línea de log técnico.** El caso realista es un despliegue: Coolify
reinicia el contenedor y una petición en vuelo se pierde.

**No hay forma de tener las dos cosas.** Esperar el envío antes de responder
reintroduce el canal de enumeración; responder antes acepta esta pérdida. Y no es tan
barato como perder una purga de tokens: aquí hay una persona esperando un correo.

Lo que lo hace asumible: la ventana es de milisegundios, la persona ve *«si esa
dirección tiene cuenta, te hemos mandado un enlace»* y **puede volver a pedirlo** —el
cupo son tres por hora—, y el fallo queda en el log para quien lo mire. Si algún día
esto pica de verdad, el arreglo es una tabla de salida con reintento, que es
ingeniería de verdad para un caso que con 20-60 personas no debería ocurrir nunca.

**La ventana pre-MFA** está arriba, con sus mitigaciones y su ruling. Es el riesgo
que este plan acepta a sabiendas, y se cierra con el Plan 4.

**El índice de nombres de usuario puede reventar el despliegue, y el riesgo es del
Plan 1, no de este.** Ese índice lo escribió el Plan 1 y **el Plan 1 no está
desplegado**: se estrena contra producción el día que salga, arrastrando consigo
las columnas de bloqueo de cuenta si falla.

La Task 1 comprobó que **hoy la copia local no tiene duplicados** (cero filas), y
eso es una buena noticia con fecha de caducidad: `createUsuario` sigue sin
comprobar colisión, así que un duplicado puede nacer entre hoy y el despliegue. Por
eso el spec insiste con razón en que **las consultas de diagnóstico se corren
contra producción justo antes de migrar**, no días antes.
