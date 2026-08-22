# Plan 1 — Endurecimiento de la autenticación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cerrar los agujeros de autenticación que no dependen del rediseño de
sesión, dejando el login funcionando exactamente igual para el usuario.

**Architecture:** siete cambios independientes sobre el backend, ninguno toca el
contrato del login ni el frontend. Se despliega solo y nadie nota nada salvo que
las contraseñas nuevas piden doce caracteres. Es el primero de cuatro planes:
después vienen el cimiento de sesión, el email y los factores.

**Tech Stack:** Express 4, Sequelize 6, Postgres, Umzug, Vitest, `helmet`,
`express-rate-limit`, `bcryptjs`.

**Spec:** [`../specs/2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md)
— este plan implementa la §6 completa más la migración de unicidad de §3 y la
retirada de `DB_SYNC` de §9.

## Global Constraints

- **Un solo commit al terminar el plan entero, no uno por tarea.** Es una
  preferencia explícita del dueño del repositorio: revisa el arco como unidad.
  Los pasos "Commit" habituales de esta skill **no aplican**; en su lugar, cada
  tarea termina con los tests en verde y el trabajo se commitea una vez, en la
  tarea 8.
- **Rama `isaias`.** Nunca `main` ni `development`.
- **Ficheros por nombre al añadir al índice**, nunca `git add -A`.
- **Todo el código, los comentarios y los mensajes de commit en inglés.** La
  documentación en español. Es la convención viva del repositorio.
- **Cada migración va entera dentro de una transacción**, siguiendo
  `src/migrations/20260804000001-create-reporte-vista.ts` y **no**
  `20260818000001`. Sin transacción, un fallo a mitad deja el despliegue en
  bucle permanente.
- **Toda columna de fecha es `TIMESTAMPTZ`**, nunca `TIMESTAMP`. El resto del
  esquema ya lo es; mezclarlas da desfases de cuatro horas en Bolivia.
- **`BCRYPT_COST = 12`**, exportado desde un solo sitio. Hoy el 8 está escrito
  literal en tres lugares distintos.
- **Verificación al final de cada tarea:** `npm run typecheck && npm test` desde
  `api/`. Ambos deben estar en verde antes de pasar a la siguiente.
- **Punto de partida:** commit `4724c9d` en `api`, árbol limpio, 348 tests
  pasando en 21 ficheros.

---

## Estructura de ficheros

| Fichero | Responsabilidad | Estado |
|---|---|---|
| `src/config/security.ts` | Constantes de seguridad en un solo sitio: coste de bcrypt, política de contraseña, presupuestos de los limitadores | **Crear** |
| `src/utils/password.ts` | Validar una contraseña contra la política, y la lista de las comunes | **Crear** |
| `src/utils/password.test.ts` | | **Crear** |
| `src/middleware/loginLimiters.ts` | Los tres cubos de limitación del login | **Crear** |
| `src/middleware/loginLimiters.test.ts` | | **Crear** |
| `src/migrations/20260821000001-add-account-lockout.ts` | `failed_attempts`, `locked_until`, índice único de `user` | **Crear** |
| `src/app.ts` | Quitar el limitador viejo, montar helmet y los nuevos | Modificar |
| `src/index.ts` | Exigir `CORS_ORIGIN` en producción; borrar la rama de `DB_SYNC` | Modificar |
| `src/controllers/login.controller.ts` | Respuesta uniforme, bloqueo por cuenta, rehash oportunista | Modificar |
| `src/controllers/login.controller.test.ts` | Invertir el test que fija que los mensajes difieran | Modificar |
| `src/controllers/usuario.controller.ts` | Coste de bcrypt desde la constante; validar la política | Modificar |
| `src/models/usuario.model.ts` | Los dos campos nuevos | Modificar |
| `src/interfaces/index.ts` | `IUsuario` gana los dos campos | Modificar |

---

## Task 1: Cabeceras de seguridad

`helmet` no está instalado y `api.osefi.net` responde hoy sin `HSTS`, sin
`X-Frame-Options` y anunciando `x-powered-by: Express`. Comprobado sondeando
producción.

**Files:**
- Modify: `src/app.ts` (imports, y justo después de `app.use(httpLogger)`)
- Modify: `package.json` (dependencia)
- Test: `src/app.security.test.ts` (crear)

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: nada que otras tareas usen.

- [ ] **Step 1: Instalar helmet**

```bash
cd api && npm install helmet@^8.3.0
```

- [ ] **Step 2: Escribir el test que falla**

Crear `src/app.security.test.ts`:

```ts
// The headers a browser needs to see, and the one it must not.
//
// `helmet` defaults are right for a server that serves HTML. This one serves
// JSON and photographs to a page hosted somewhere else, so two of the defaults
// have to be overridden — and getting one of them wrong breaks every image in
// the application, silently, only in the browser.

import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";

describe("security headers", () => {
  it("does not announce what it is running", async () => {
    const res = await request(app).get("/api/login");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("refuses to be framed", async () => {
    const res = await request(app).get("/api/login");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("does not sniff content types", async () => {
    const res = await request(app).get("/api/login");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("lets another origin load the photographs", async () => {
    // helmet's default is `same-origin`, which would make every <img> in the
    // application fail: the page is served from www.osefi.net and the files
    // from api.osefi.net. Nothing on the server would report an error.
    const res = await request(app).get("/api/login");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
```

- [ ] **Step 3: Ejecutar y comprobar que falla**

```bash
cd api && npm install --save-dev supertest @types/supertest
npx vitest run src/app.security.test.ts
```

Esperado: FALLA. `x-powered-by` viene con valor `Express`, y las otras tres
cabeceras no existen.

- [ ] **Step 4: Implementar**

En `src/app.ts`, añadir el import junto a los demás:

```ts
import helmet from "helmet";
```

Y justo después de `const app = express();`:

```ts
// Express announces itself in every response. It costs nothing to remove and
// it is free reconnaissance for anyone deciding which exploits to try.
app.disable("x-powered-by");
```

Y justo después de `app.use(httpLogger);`:

```ts
/**
 * Two of helmet's defaults are wrong for this server, and one of them fails in
 * a way nothing would report.
 *
 * `crossOriginResourcePolicy` defaults to `same-origin`. The photographs are
 * served from here by `express.static` and displayed by a page hosted on
 * Vercel, so with the default every `<img>` in the application would come back
 * blocked — in the browser only, with the server logging a clean 200.
 *
 * `contentSecurityPolicy` is off because this process serves JSON and files,
 * never HTML. A policy on a JSON response governs nothing; the page's own
 * policy is Vercel's business.
 *
 * HSTS is set here as well as at the proxy. Whichever answers, the browser gets
 * told once.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: { maxAge: 63072000, includeSubDomains: true },
  }),
);
```

- [ ] **Step 5: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/app.security.test.ts
```

Esperado: PASA, los cuatro.

- [ ] **Step 6: Verificar que nada más se rompió**

```bash
cd api && npm run typecheck && npm test
```

Esperado: typecheck limpio, **352 tests** (348 + 4).

---

## Task 2: `CORS_ORIGIN` obligatorio en producción

`app.ts:64` es `process.env.CORS_ORIGIN || "http://localhost:5173"`. Un
despliegue que olvide la variable **autoriza al localhost de la máquina de quien
visite**, y cuando el Plan 2 añada `credentials: true` eso pasa de feo a
explotable.

**Files:**
- Modify: `src/index.ts:37-40` (junto a la comprobación de `JWT_SECRET`)
- Modify: `src/app.ts:64`
- Test: `src/index.boot.test.ts` (crear)

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/index.boot.test.ts`:

```ts
// What the process refuses to start without.
//
// These are the variables whose absence is silent: the server comes up, serves
// requests, and is wrong. A crash at boot is the only failure mode anyone
// notices.

import { describe, it, expect } from "vitest";
import { requiredEnv } from "./config/security.js";

describe("required configuration", () => {
  it("names CORS_ORIGIN as required in production", () => {
    expect(requiredEnv("production")).toContain("CORS_ORIGIN");
  });

  it("does not require CORS_ORIGIN outside production", () => {
    // Development falls back to the Vite port. The danger is a *deployment*
    // that forgets it, not a laptop.
    expect(requiredEnv("development")).not.toContain("CORS_ORIGIN");
  });

  it("always requires JWT_SECRET", () => {
    expect(requiredEnv("production")).toContain("JWT_SECRET");
    expect(requiredEnv("development")).toContain("JWT_SECRET");
  });
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/index.boot.test.ts
```

Esperado: FALLA con "Cannot find module './config/security.js'".

- [ ] **Step 3: Crear `src/config/security.ts`**

```ts
/**
 * The security numbers, in one place.
 *
 * They were scattered: the bcrypt cost written literally in three files, the
 * login budget inside `app.ts`, the password rules nowhere because there were
 * none. Changing one of them meant finding all of them, and the day the cost
 * went from 8 to 12 two of the three sites were missed.
 */

/**
 * bcrypt work factor. Was 8, which is roughly 25 ms — fast enough that a leaked
 * table is worth attacking offline. 12 is about 250 ms: imperceptible to a
 * person logging in, expensive enough to be worth it.
 */
export const BCRYPT_COST = 12;

/** Twelve characters, and none of the common ones. No symbol requirement: the
 * NIST guidance has advised against composition rules since 2017, because they
 * produce `Password1!` and a note stuck to the monitor. */
export const PASSWORD_MIN_LENGTH = 12;

/** Five failures and the account rests. The wait grows, with a ceiling in
 * minutes rather than hours: a long lockout is a button anyone can press
 * against a colleague whose username they know. */
export const LOCKOUT_AFTER_FAILURES = 5;
export const LOCKOUT_BASE_MINUTES = 1;
export const LOCKOUT_MAX_MINUTES = 15;

/** Login budget per IP address, counting failures only.
 *
 * The old budget was 10 per quarter hour counting successes too, keyed on the
 * address. Behind a NAT that is the whole office sharing ten attempts — and
 * with the enrolment flow of the later plans, where one person makes five or
 * six POSTs, two people would exhaust it. */
export const LOGIN_IP_LIMIT = 100;
export const LOGIN_ACCOUNT_IP_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Variables the process refuses to start without, by environment. */
export function requiredEnv(nodeEnv: string | undefined): string[] {
  const always = ["JWT_SECRET"];
  return nodeEnv === "production" ? [...always, "CORS_ORIGIN"] : always;
}
```

- [ ] **Step 4: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/index.boot.test.ts
```

Esperado: PASA, los tres.

- [ ] **Step 5: Usarlo en el arranque**

En `src/index.ts`, sustituir la comprobación de las líneas 37-40 por:

```ts
const faltan = requiredEnv(process.env.NODE_ENV).filter((v) => !process.env[v]);
if (faltan.length > 0) {
  bootLog.fatal(
    { faltan },
    `faltan variables obligatorias: ${faltan.join(", ")}. El servidor no puede arrancar.`,
  );
  process.exit(1);
}
```

Y añadir el import:

```ts
import { requiredEnv } from "./config/security.js";
```

- [ ] **Step 6: Quitar el valor por defecto en producción**

En `src/app.ts`, sustituir la línea del origen:

```ts
    // No fallback in production: `index.ts` refuses to start without the
    // variable, so reaching here without one means development. Leaving the
    // Vite port as a silent default would, once credentials are enabled in the
    // next plan, authorise whatever is listening on the visitor's own machine.
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
```

- [ ] **Step 7: Verificar**

```bash
cd api && npm run typecheck && npm test
```

Esperado: verde, **355 tests**.

---

## Task 3: Migración — bloqueo por cuenta y unicidad de `user`

Dos cosas en una migración porque tocan la misma tabla y el mismo `ALTER`.

La unicidad de `user` lleva abierta desde la auditoría anterior: `createUsuario`
no comprueba colisión y `loginUsuario` hace `findOne({where:{user}})` sin orden,
así que una cuenta con permiso de crear usuarios puede crear una segunda fila
`isaias` con contraseña conocida y competir por el login.

**Files:**
- Create: `src/migrations/20260821000001-add-account-lockout.ts`
- Modify: `src/models/usuario.model.ts`
- Modify: `src/interfaces/index.ts`
- Test: `src/migrations/20260821000001-add-account-lockout.test.ts` (crear)

**Interfaces:**
- Consumes: nada.
- Produces: los campos `failed_attempts: number` y `locked_until: Date | null`
  en `IUsuario`, que la Task 4 lee y escribe.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/migrations/20260821000001-add-account-lockout.test.ts`:

```ts
// The migration that adds the lockout columns.
//
// Tested at the level the other migrations are: that it asks the queryInterface
// for the right things, inside a transaction, with the types the rest of the
// schema uses. A migration that runs half way is the failure that costs a
// night, so the transaction is the part worth pinning.

import { describe, it, expect, vi } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260821000001-add-account-lockout.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    addColumn: record("addColumn"),
    removeColumn: record("removeColumn"),
    addIndex: record("addIndex"),
    removeIndex: record("removeIndex"),
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

describe("add-account-lockout", () => {
  it("adds both columns to usuarios", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toContainEqual(["usuarios", "failed_attempts"]);
    expect(added).toContainEqual(["usuarios", "locked_until"]);
  });

  it("gives locked_until a timezone", async () => {
    // TIMESTAMP without a zone against a server in UTC and a database in
    // Bolivia puts every lockout four hours in the past, so it never locks —
    // silently, while the test that checks locking passes locally.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "locked_until");
    expect((col?.args[2] as { type: unknown }).type).toBe(DataTypes.DATE);
  });

  it("counts failures from zero rather than from null", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const col = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "failed_attempts");
    const spec = col?.args[2] as { allowNull: boolean; defaultValue: number };
    expect(spec.allowNull).toBe(false);
    expect(spec.defaultValue).toBe(0);
  });

  it("makes usernames unique, case-insensitively, among the living", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/lower\("user"\)/i);
    expect(sql).toMatch(/"deletedAt" IS NULL/i);
  });

  it("runs everything inside one transaction", async () => {
    const qi = fakeQueryInterface();
    const spy = vi.spyOn(qi.sequelize, "transaction");
    await up({ context: qi as never });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("can be undone", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const removed = qi.calls.filter((c) => c.fn === "removeColumn").map((c) => c.args[1]);
    expect(removed).toContain("failed_attempts");
    expect(removed).toContain("locked_until");
  });
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/migrations/20260821000001-add-account-lockout.test.ts
```

Esperado: FALLA, el módulo no existe.

- [ ] **Step 3: Escribir la migración**

Crear `src/migrations/20260821000001-add-account-lockout.ts`:

```ts
import { QueryInterface, DataTypes } from "sequelize";

// Per-account lockout, and the unique index on `user` that the previous audit
// left open.
//
// They travel together because they are the same ALTER on the same table, and
// because they answer the same question from two sides: who is allowed to try,
// and which row they are trying against.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  // One transaction for the whole migration. Postgres supports transactional
  // DDL, and without it a failure on the index would leave the columns added
  // but the migration unrecorded in SequelizeMeta: the next deploy re-runs
  // `up`, hits "column already exists" and crash-loops until someone
  // intervenes by hand.
  await queryInterface.sequelize.transaction(async (transaction) => {
    // ALTER TABLE takes ACCESS EXCLUSIVE, and `authenticateToken` reads this
    // table on every request. A long-running report holding a connection would
    // make the ALTER wait, and every request would queue behind it. Better to
    // fail fast and retry when the database is quiet.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "usuarios",
      "failed_attempts",
      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      { transaction },
    );

    // DataTypes.DATE is TIMESTAMP WITH TIME ZONE in Postgres, which is what the
    // rest of this schema uses. A naive TIMESTAMP compared against a server in
    // UTC would be four hours out and the lockout would never bite.
    await queryInterface.addColumn(
      "usuarios",
      "locked_until",
      { type: DataTypes.DATE, allowNull: true },
      { transaction },
    );

    // Case-insensitive because `Isaias` and `isaias` are the same person to
    // everyone except a byte comparison, and partial because the model is
    // paranoid: an archived account keeps its row, and its username has to
    // become available again.
    //
    // Raw SQL rather than addIndex: the expression index on lower("user") and
    // the WHERE clause are both beyond what queryInterface expresses.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX usuarios_user_uniq
         ON usuarios (lower("user"))
         WHERE "deletedAt" IS NULL`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("DROP INDEX IF EXISTS usuarios_user_uniq", { transaction });
    await queryInterface.removeColumn("usuarios", "locked_until", { transaction });
    await queryInterface.removeColumn("usuarios", "failed_attempts", { transaction });
  });
}
```

- [ ] **Step 4: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/migrations/20260821000001-add-account-lockout.test.ts
```

Esperado: PASA, los seis.

- [ ] **Step 5: Añadir los campos al modelo y a la interfaz**

En `src/models/usuario.model.ts`, dentro del objeto de definición, después de
`id_rol`:

```ts
  failed_attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  locked_until: {
    type: DataTypes.DATE,
    allowNull: true,
  },
```

En `src/interfaces/index.ts`, añadir a `IUsuario`:

```ts
  failed_attempts?: number;
  locked_until?: Date | null;
```

- [ ] **Step 6: Ensayar la migración contra la copia local de producción**

```bash
cd api && npm run migrate
```

Esperado: la migración corre sin error.

**Si el índice único falla** con `could not create unique index`, hay usuarios
duplicados por nombre en los datos reales. Es información valiosa, no un
problema del plan. Localizarlos y decidir qué hacer con ellos antes de seguir:

```sql
SELECT lower("user"), count(*), array_agg(id)
FROM usuarios WHERE "deletedAt" IS NULL
GROUP BY 1 HAVING count(*) > 1;
```

- [ ] **Step 7: Verificar**

```bash
cd api && npm run typecheck && npm test
```

Esperado: verde, **361 tests**.

---

## Task 4: El login responde lo mismo, tarde lo que tarde

Hoy `login.controller.ts:42` responde `"Usuario inexistente"` y `:47`
`"Contraseña incorrecta"`. Son dos canales de enumeración a la vez: el mensaje y
el tiempo, porque el camino del usuario inexistente **no ejecuta bcrypt** y
responde en un milisegundo frente a doscientos cincuenta.

Y hay un test que fija esa diferencia a propósito, con la nota de borrarlo el día
que se cierre. Hoy es ese día.

**Files:**
- Modify: `src/controllers/login.controller.ts`
- Modify: `src/controllers/login.controller.test.ts:154-173`
- Modify: `src/config/security.ts` (añadir el hash de relleno)

**Interfaces:**
- Consumes: `BCRYPT_COST` de la Task 2.
- Produces: `CREDENCIALES_INVALIDAS`, el mensaje único, que la Task 5 reutiliza.

- [ ] **Step 1: Escribir el test que falla**

En `src/controllers/login.controller.test.ts`, **sustituir** el test
`"says the same thing whether the user is unknown or the password is wrong"`
entero por:

```ts
  it("says the same thing whether the user is unknown or the password is wrong", async () => {
    // Two different messages tell an attacker which usernames exist. This used
    // to be a known gap pinned as such; it is closed now and the assertion is
    // the other way round.
    const bcryptjs = (await import("bcryptjs")).default;

    findOne.mockResolvedValue(null);
    const unknown = call({ user: "nadie", pass: "x" });
    await loginUsuario(unknown.req, unknown.res);

    findOne.mockResolvedValue(storedUser());
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never);
    const wrong = call({ user: "isaias", pass: "x" });
    await loginUsuario(wrong.req, wrong.res);

    expect(unknown.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(unknown.message).toBe(wrong.message);
  });

  it("hashes even when the account does not exist", async () => {
    // The message being equal is half of it. Without a comparison against a
    // filler hash the unknown path returns in a millisecond and the known one
    // in two hundred and fifty, and a stopwatch enumerates the payroll.
    const bcryptjs = (await import("bcryptjs")).default;

    findOne.mockResolvedValue(null);
    const c = call({ user: "nadie", pass: "x" });
    await loginUsuario(c.req, c.res);

    expect(bcryptjs.compare).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/controllers/login.controller.test.ts
```

Esperado: FALLAN los dos nuevos. El primero porque los mensajes difieren, el
segundo porque `compare` no se llama cuando no hay usuario.

- [ ] **Step 3: Añadir el mensaje único y el hash de relleno**

En `src/config/security.ts`, **los dos imports arriba del todo**, antes de
cualquier otra cosa:

```ts
import bcryptjs from "bcryptjs";
import { randomBytes } from "node:crypto";
```

Y el resto **al final del fichero**, después de `requiredEnv`:

```ts
/**
 * One answer for every way of failing to log in.
 *
 * "Usuario inexistente" and "Contraseña incorrecta" are a directory of who
 * works here, answered to anyone who asks. So is a distinct message for a
 * locked account.
 */
export const CREDENCIALES_INVALIDAS = "Usuario o contraseña incorrectos.";

/**
 * A real hash of a value nobody knows, to compare against when the account does
 * not exist or is locked.
 *
 * Equal messages are not enough: without this, the failing paths that never
 * reach bcrypt answer in a millisecond while a wrong password takes two
 * hundred and fifty, and the difference is a two-order-of-magnitude oracle.
 *
 * Computed once at import, which costs one bcrypt round at boot.
 */
export const HASH_RELLENO = bcryptjs.hashSync(randomBytes(32).toString("hex"), BCRYPT_COST);
```

- [ ] **Step 4: Usarlo en el controlador**

En `src/controllers/login.controller.ts`, sustituir el bloque desde
`const TempUsuario = await UsuarioModel.findOne(...)` hasta el `return` de la
contraseña incorrecta por:

```ts
    const TempUsuario = await UsuarioModel.findOne({ where: { user } });

    // The account not existing and the password being wrong must be
    // indistinguishable: same message, same status, same time. Comparing
    // against the filler hash costs the same as a real comparison and is what
    // makes the third of those true.
    if (!TempUsuario) {
      await bcryptjs.compare(pass, HASH_RELLENO);
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }

    const data = TempUsuario.dataValues;
    const confirmPass = await bcryptjs.compare(pass, data.pass);
    if (!confirmPass) {
      logAction({
        id_usuario: data.id,
        action: "LOGIN_FAILED",
        entity: "Usuario",
        entity_id: data.id,
        detail: `Login fallido para @${user}`,
        metadata: { user },
        severity: "warning",
        ip_address: req.ip ?? null,
      });
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }
```

Y añadir el import:

```ts
import { CREDENCIALES_INVALIDAS, HASH_RELLENO } from "../config/security.js";
```

- [ ] **Step 5: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/controllers/login.controller.test.ts
```

Esperado: PASA todo el fichero.

- [ ] **Step 6: Verificar**

```bash
cd api && npm run typecheck && npm test
```

Esperado: verde, **362 tests**.

---

## Task 5: Bloqueo por cuenta, y los cubos que cuentan bien

El limitador actual (`app.ts:111-117`) tiene tres defectos a la vez: clave por
`req.ip` sin plegar IPv6, **cuenta también los aciertos**, y un presupuesto de
diez que detrás de un NAT es diez para toda la oficina. Comprobado en la
auditoría anterior: rotando `X-Forwarded-For`, `RateLimit-Remaining` se queda
en 9 para siempre.

El patrón bueno ya existe en `src/routes/generador.routes.ts:35-36`.

**Files:**
- Create: `src/middleware/loginLimiters.ts`
- Create: `src/middleware/loginLimiters.test.ts`
- Modify: `src/app.ts:111-124`
- Modify: `src/controllers/login.controller.ts`

**Interfaces:**
- Consumes: `LOGIN_IP_LIMIT`, `LOGIN_ACCOUNT_IP_LIMIT`, `LOGIN_WINDOW_MS`,
  `LOCKOUT_*`, `CREDENCIALES_INVALIDAS`, `HASH_RELLENO` de las Tasks 2 y 4.
  Los campos `failed_attempts` y `locked_until` de la Task 3.
- Produces:
  - `loginIpLimiter: RequestHandler`
  - `loginAccountIpLimiter: RequestHandler`
  - `estaBloqueada(u: { failed_attempts?: number; locked_until?: Date | null }): boolean`
  - `siguienteBloqueo(fallosPrevios: number): { failed_attempts: number; locked_until: Date | null }`

- [ ] **Step 1: Escribir el test que falla**

Crear `src/middleware/loginLimiters.test.ts`:

```ts
// How much room somebody gets to be wrong.
//
// Three budgets that do different jobs: the address bucket stops a flood, the
// account bucket stops a guess, and the pair stops one machine grinding one
// account. The arithmetic of the third is the part that goes wrong quietly —
// an escalation with no ceiling is a button for locking a colleague out.

import { describe, it, expect } from "vitest";
import { estaBloqueada, siguienteBloqueo } from "./loginLimiters.js";
import { LOCKOUT_AFTER_FAILURES, LOCKOUT_MAX_MINUTES } from "../config/security.js";

describe("estaBloqueada", () => {
  it("is false for an account that has never failed", () => {
    expect(estaBloqueada({ failed_attempts: 0, locked_until: null })).toBe(false);
  });

  it("is false once the wait has passed", () => {
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(estaBloqueada({ failed_attempts: 9, locked_until: ayer })).toBe(false);
  });

  it("is true while the wait is running", () => {
    const luego = new Date(Date.now() + 60_000);
    expect(estaBloqueada({ failed_attempts: 5, locked_until: luego })).toBe(true);
  });
});

describe("siguienteBloqueo", () => {
  it("does not lock before the threshold", () => {
    const r = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 2);
    expect(r.failed_attempts).toBe(LOCKOUT_AFTER_FAILURES - 1);
    expect(r.locked_until).toBeNull();
  });

  it("locks on reaching the threshold", () => {
    const r = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 1);
    expect(r.failed_attempts).toBe(LOCKOUT_AFTER_FAILURES);
    expect(r.locked_until).toBeInstanceOf(Date);
  });

  it("grows the wait with each further failure", () => {
    const primero = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 1).locked_until!.getTime();
    const despues = siguienteBloqueo(LOCKOUT_AFTER_FAILURES + 1).locked_until!.getTime();
    expect(despues).toBeGreaterThan(primero);
  });

  it("never waits longer than the ceiling", () => {
    // Everybody in a company of sixty knows the boss's username. Without a
    // ceiling, five wrong passwords a day keep that account shut indefinitely.
    const r = siguienteBloqueo(40);
    const minutos = (r.locked_until!.getTime() - Date.now()) / 60_000;
    expect(minutos).toBeLessThanOrEqual(LOCKOUT_MAX_MINUTES + 0.1);
  });
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/middleware/loginLimiters.test.ts
```

Esperado: FALLA, el módulo no existe.

- [ ] **Step 3: Escribir el módulo**

Crear `src/middleware/loginLimiters.ts`:

```ts
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import {
  LOGIN_IP_LIMIT,
  LOGIN_ACCOUNT_IP_LIMIT,
  LOGIN_WINDOW_MS,
  LOCKOUT_AFTER_FAILURES,
  LOCKOUT_BASE_MINUTES,
  LOCKOUT_MAX_MINUTES,
} from "../config/security.js";

/** The username a login attempt is about, normalised the way the lookup does. */
function usuarioDe(req: Request): string {
  const u = (req.body as { user?: unknown } | undefined)?.user;
  return typeof u === "string" ? u.trim().toLowerCase() : "";
}

/**
 * By address, counting failures only.
 *
 * The budget it replaces was ten per quarter hour counting successes as well,
 * which behind a NAT is ten for the whole office. It also keyed on the raw
 * address: `ipKeyGenerator` folds IPv6 into its /56 block, without which one
 * holder of a prefix walks through billions of distinct keys.
 *
 * A hundred is deliberately generous. This bucket exists to stop a flood; the
 * per-account bucket below is what stops a guess, and it is the one with teeth.
 */
export const loginIpLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_IP_LIMIT,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "")}`,
  message: { message: "Demasiados intentos desde esta red. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * By address and account together, so one machine cannot grind one name even
 * while the address budget still has room.
 */
export const loginAccountIpLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: LOGIN_ACCOUNT_IP_LIMIT,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `ipu:${ipKeyGenerator(req.ip ?? "")}:${usuarioDe(req)}`,
  message: { message: "Demasiados intentos. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Whether this account is resting right now. */
export function estaBloqueada(u: { failed_attempts?: number; locked_until?: Date | null }): boolean {
  if (!u.locked_until) return false;
  return new Date(u.locked_until).getTime() > Date.now();
}

/**
 * The account's state after one more failure.
 *
 * The wait doubles, and stops doubling at the ceiling. Without a ceiling, an
 * escalation reaches hours, and in a company where everybody knows everybody's
 * username that is a button for locking a colleague out of their day.
 */
export function siguienteBloqueo(fallosPrevios: number): {
  failed_attempts: number;
  locked_until: Date | null;
} {
  const fallos = fallosPrevios + 1;
  if (fallos < LOCKOUT_AFTER_FAILURES) {
    return { failed_attempts: fallos, locked_until: null };
  }
  const exceso = fallos - LOCKOUT_AFTER_FAILURES;
  const minutos = Math.min(LOCKOUT_BASE_MINUTES * 2 ** exceso, LOCKOUT_MAX_MINUTES);
  return { failed_attempts: fallos, locked_until: new Date(Date.now() + minutos * 60_000) };
}
```

- [ ] **Step 4: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/middleware/loginLimiters.test.ts
```

Esperado: PASA, los siete.

- [ ] **Step 5: Montarlos en `app.ts`**

Borrar el bloque `const loginLimiter = rateLimit({...})` de las líneas 111-117 y
el import de `rateLimit`. Sustituir el montaje del login por:

```ts
app.use("/api/login", (req, res, next) => {
  if (req.method !== "POST") return next();
  loginIpLimiter(req, res, (err) => (err ? next(err) : loginAccountIpLimiter(req, res, next)));
}, loginRoutes);
```

Con el import:

```ts
import { loginIpLimiter, loginAccountIpLimiter } from "./middleware/loginLimiters.js";
```

- [ ] **Step 6: Aplicar el bloqueo por cuenta en el controlador**

En `src/controllers/login.controller.ts`, después de obtener `data` y **antes**
de comparar la contraseña:

```ts
    // A locked account answers exactly like a wrong password, filler hash
    // included. Answering differently — or faster — turns the lockout into the
    // oracle the uniform message was meant to close.
    if (estaBloqueada(data)) {
      await bcryptjs.compare(pass, HASH_RELLENO);
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }
```

Y en la rama de contraseña incorrecta, justo antes del `return`:

```ts
      await UsuarioModel.update(siguienteBloqueo(data.failed_attempts ?? 0), {
        where: { id: data.id },
      });
```

Y en la rama de éxito, antes de firmar el token:

```ts
    // A good password clears the slate. Otherwise yesterday's four failures and
    // today's one lock an account whose owner never got anything wrong twice
    // in a row.
    if ((data.failed_attempts ?? 0) > 0 || data.locked_until) {
      await UsuarioModel.update({ failed_attempts: 0, locked_until: null }, { where: { id: data.id } });
    }
```

Con los imports:

```ts
import { estaBloqueada, siguienteBloqueo } from "../middleware/loginLimiters.js";
```

- [ ] **Step 7: Verificar**

```bash
cd api && npm run typecheck && npm test
```

Esperado: verde, **369 tests**.

---

## Task 6: bcrypt de 8 a 12, y el rehash que no molesta a nadie

El coste 8 está escrito literal en `usuario.controller.ts:67` y `:233`. Cambiar
solo el login dejaría cada contraseña cambiada desde el perfil volviendo al 8.

**Files:**
- Modify: `src/controllers/usuario.controller.ts:67` y `:233`
- Modify: `src/controllers/login.controller.ts`
- Test: `src/controllers/login.controller.test.ts` (añadir)

**Interfaces:**
- Consumes: `BCRYPT_COST` de la Task 2.
- Produces: nada.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `src/controllers/login.controller.test.ts`, dentro de
`describe("what comes back", ...)`:

```ts
  it("quietly re-hashes a password stored at the old cost", async () => {
    // Raising the cost only helps passwords hashed after the change. Every
    // existing account would keep its cost-8 hash for as long as nobody changed
    // it — which, for an internal ERP, is forever. So a successful login pays
    // one extra hash and the account moves up.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);

    const c = call({ user: "isaias", pass: "secreta" });
    await loginUsuario(c.req, c.res);

    expect(c.status).toBe(200);
    expect(bcryptjs.hash).toHaveBeenCalledWith("secreta", 12);
  });
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/controllers/login.controller.test.ts -t "re-hashes"
```

Esperado: FALLA, `hash` no se llama.

- [ ] **Step 3: Implementar el rehash**

En `src/controllers/login.controller.ts`, en la rama de éxito, junto al reseteo
de intentos:

```ts
    // The stored hash carries its own cost in the prefix: `$2a$08$` is the old
    // one. Re-hashing here is the only moment the plaintext is in hand.
    if (data.pass.startsWith(`$2a$0`) || data.pass.startsWith(`$2b$0`)) {
      const nuevo = await bcryptjs.hash(pass, BCRYPT_COST);
      await UsuarioModel.update({ pass: nuevo }, { where: { id: data.id } });
    }
```

Con el import de `BCRYPT_COST` añadido a la línea que ya importa de
`../config/security.js`.

- [ ] **Step 4: Cambiar los dos sitios de `usuario.controller.ts`**

Línea 67 y línea 233: sustituir el `8` literal por `BCRYPT_COST`, y añadir el
import:

```ts
import { BCRYPT_COST } from "../config/security.js";
```

- [ ] **Step 5: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/controllers/login.controller.test.ts
```

Esperado: PASA todo el fichero.

- [ ] **Step 6: Verificar**

```bash
cd api && npm run typecheck && npm test
```

Esperado: verde, **370 tests**.

---

## Task 7: Política de contraseña

Hoy no hay ninguna: `createUsuario` acepta una contraseña de un carácter.

**Files:**
- Create: `src/utils/password.ts`
- Create: `src/utils/password.test.ts`
- Modify: `src/controllers/usuario.controller.ts` (en `createUsuario` y en
  `updateUserPass`)

**Interfaces:**
- Consumes: `PASSWORD_MIN_LENGTH` de la Task 2.
- Produces: `validarPassword(pass: string): string | null` — devuelve el motivo
  del rechazo, o `null` si la contraseña vale.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/utils/password.test.ts`:

```ts
// What counts as a password here.
//
// Length and a blocklist, and nothing else. Composition rules — one capital,
// one digit, one symbol — have been advised against since 2017 because of what
// they actually produce: `Password1!`, and a sticky note on the monitor.

import { describe, it, expect } from "vitest";
import { validarPassword } from "./password.js";

describe("validarPassword", () => {
  it("accepts a long ordinary passphrase", () => {
    expect(validarPassword("el poste de la esquina")).toBeNull();
  });

  it("rejects one that is too short", () => {
    expect(validarPassword("corta1")).toMatch(/12/);
  });

  it("counts characters, not bytes", () => {
    // Twelve accented characters are twelve characters. Counting bytes would
    // let a shorter password through, and would be nobody's intent.
    expect(validarPassword("ñññññññññññí")).toBeNull();
  });

  it("rejects a common password even when it is long enough", () => {
    expect(validarPassword("contraseña123")).not.toBeNull();
    expect(validarPassword("qwertyuiop123")).not.toBeNull();
  });

  it("ignores case when checking the blocklist", () => {
    expect(validarPassword("CONTRASEÑA123")).not.toBeNull();
  });

  it("does not demand symbols or capitals", () => {
    expect(validarPassword("caballo bateria grapa")).toBeNull();
  });

  it("rejects whitespace-only padding", () => {
    // Twelve spaces is twelve characters and no secret at all.
    expect(validarPassword("            ")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/utils/password.test.ts
```

Esperado: FALLA, el módulo no existe.

- [ ] **Step 3: Escribir el módulo**

Crear `src/utils/password.ts`:

```ts
import { PASSWORD_MIN_LENGTH } from "../config/security.js";

/**
 * The passwords that are tried first, and the ones this workforce would pick.
 *
 * A short embedded list rather than a dependency: the value is in blocking what
 * a guesser starts with, and that is a few dozen strings, not a package with a
 * megabyte of them. Spanish entries because the users are Spanish-speaking and
 * an English-only list would let `contraseña123` straight through.
 */
const COMUNES = new Set([
  "123456789012", "contraseña", "contrasena", "password", "passw0rd",
  "qwertyuiop", "administrador", "administrator", "1234567890",
  "osefi", "osefisrl", "lefitel", "telecomunicaciones",
  "bienvenido", "welcome", "iloveyou", "abcdefghijkl",
  "contraseña1", "password1", "password123", "contraseña123",
  "qwerty123", "qwertyuiop123", "123456", "12345678",
]);

/**
 * Why this password is not acceptable, or null if it is.
 *
 * Length is the only rule with teeth. Composition rules are absent on purpose:
 * they push people toward one predictable shape and toward writing the result
 * down, which trades an attack nobody was running for one that works.
 */
export function validarPassword(pass: string): string | null {
  // Spread rather than `.length`: a string's length counts UTF-16 code units,
  // so an emoji or some accented forms would count as two.
  const caracteres = [...pass];

  if (caracteres.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }

  if (pass.trim().length === 0) {
    return "La contraseña no puede ser solo espacios.";
  }

  const normalizada = pass.trim().toLowerCase();
  if (COMUNES.has(normalizada)) {
    return "Esa contraseña es demasiado común. Elija otra.";
  }

  return null;
}
```

- [ ] **Step 4: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/utils/password.test.ts
```

Esperado: PASA, los siete.

- [ ] **Step 5: Aplicarlo en los dos sitios que fijan contraseñas**

En `src/controllers/usuario.controller.ts`, en `createUsuario`, **antes** del
`bcryptjs.hash` de la línea 67:

```ts
    const motivo = validarPassword(req.body.pass ?? "");
    if (motivo) return res.status(400).json({ message: motivo });
```

Y en `updateUserPass`, antes del `bcryptjs.hash` de la línea 233:

```ts
    const motivo = validarPassword(pass ?? "");
    if (motivo) return res.status(400).json({ message: motivo });
```

Con el import:

```ts
import { validarPassword } from "../utils/password.js";
```

- [ ] **Step 6: Verificar**

```bash
cd api && npm run typecheck && npm test
```

Esperado: verde, **377 tests**.

**Si algún test de `usuario.controller.test.ts` falla** porque usa una
contraseña corta, actualizar esa contraseña de prueba a una de doce caracteres.
Es el test reflejando la regla nueva, no un fallo.

---

## Task 8: Fuera `DB_SYNC`, y commit

`sequelize.sync({ alter: true })` **elimina toda columna que el modelo no
declare**. La guarda actual exige que la conexión venga de las `PG_*`, y eso no
protege a esta instalación: Postgres corre en el mismo VPS, que es exactamente
la forma de una base local.

Con las tablas que traen los planes siguientes, un arranque con la bandera
puesta borraría sesiones y factores enteros. Un ERP con migraciones no necesita
`sync`.

**Files:**
- Modify: `src/index.ts:82-83` y el bloque de `main()` en las líneas 91-102
- Modify: `api/.env` (quitar la variable)
- Modify: `api/.env.docker` (si la tiene)

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Borrar la rama de sincronización**

En `src/index.ts`, borrar el comentario largo y las dos constantes de las líneas
82-83, y sustituir el bloque de `main()` que va desde
`if (syncRequested && !shouldSyncSchema)` hasta el cierre del `else` por:

```ts
  await sequelize.authenticate();
```

Añadir en su lugar, sobre esa línea:

```ts
  // The schema comes from the migrations and only from them. `sync({ alter:
  // true })` used to live here behind a flag; it drops any column the model
  // does not declare, which for a model written with default timestamps
  // against a table with explicit ones means dropping real data on boot. The
  // flag was one careless line away from pointing at production, and with the
  // session and factor tables coming, what it would take with it grew.
```

- [ ] **Step 2: Comprobar que no queda ninguna referencia**

```bash
cd api && grep -rn "DB_SYNC\|shouldSyncSchema\|syncRequested\|sequelize.sync" src/ || echo "limpio"
```

Esperado: `limpio`.

- [ ] **Step 3: Quitar la variable de los ficheros de entorno**

Borrar la línea `DB_SYNC=false` y su comentario de `api/.env`. Comprobar
`api/.env.docker` por si la tuviera. **No están en git**, así que este paso no
entra en el commit; es limpieza del árbol de trabajo.

- [ ] **Step 4: Verificar el plan entero**

```bash
cd api && npm run typecheck && npm test && npm run lint
```

Esperado: typecheck limpio, **377 tests en verde**, lint sin errores.

- [ ] **Step 5: Comprobar las cabeceras contra el servidor local**

```bash
cd api && npm run dev
# en otra terminal:
curl -sI http://localhost:3000/api/login | grep -i "x-powered-by\|x-frame\|nosniff\|cross-origin"
```

Esperado: `x-frame-options`, `x-content-type-options: nosniff` y
`cross-origin-resource-policy: cross-origin` presentes; **`x-powered-by`
ausente**. (`strict-transport-security` no aparece sobre HTTP; es correcto.)

- [ ] **Step 6: Commit — uno solo, todo el plan**

```bash
cd api && git add \
  package.json package-lock.json \
  src/config/security.ts \
  src/utils/password.ts src/utils/password.test.ts \
  src/middleware/loginLimiters.ts src/middleware/loginLimiters.test.ts \
  src/migrations/20260821000001-add-account-lockout.ts \
  src/migrations/20260821000001-add-account-lockout.test.ts \
  src/app.security.test.ts src/index.boot.test.ts \
  src/app.ts src/index.ts \
  src/controllers/login.controller.ts src/controllers/login.controller.test.ts \
  src/controllers/usuario.controller.ts \
  src/models/usuario.model.ts src/interfaces/index.ts \
  docs/plans/2026-08-21-endurecimiento-auth.md \
  docs/specs/2026-08-21-autenticacion-mfa-design.md
```

Mensaje:

```
fix(security): close the gaps that did not need the session rewrite

Seven changes that harden the front door without touching what a user sees.
The first of four plans; the session, the email and the factors follow.

The login used to answer "Usuario inexistente" or "Contraseña incorrecta",
which is a directory of who works here answered to anyone who asks. Worse, the
first answer skipped bcrypt entirely and came back in a millisecond against two
hundred and fifty for the second: a stopwatch enumerated the payroll whether or
not you read the message. Both channels are closed, the locked-account path
included -- it pays the same filler hash, or it becomes the oracle the uniform
message was meant to shut.

The rate limiter was three things wrong at once. Keyed on the raw address, so
rotating X-Forwarded-For walked past it; counting successes, so the budget was
spent by people getting it right; and set to ten per quarter hour, which behind
the office NAT is ten for everybody. Now failures only, folded IPv6, a hundred
per address, and the bucket with teeth is the per-account one -- with a ceiling
on the wait, because in a company of sixty everybody knows the boss's username
and an uncapped escalation is a button for locking him out.

bcrypt goes from 8 to 12, from a constant instead of the three literals it was
written as, and a successful login quietly re-hashes an old-cost password: the
raise would otherwise only ever help accounts created after today.

`DB_SYNC` is gone rather than guarded. `sync({ alter: true })` drops any column
the model does not declare, and the guard -- that the connection come from the
PG_* variables -- does not protect an installation whose Postgres runs beside
the API, which is this one.

Also: helmet, with two defaults overridden. `crossOriginResourcePolicy` has to
be `cross-origin` or every photograph in the application stops loading, in the
browser only, with the server logging a clean 200.

Verified: typecheck clean, 377 tests passing, migration rehearsed against the
local copy of production.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

---

## Cobertura contra el spec

Lo que este plan cierra de la §6, y lo que deja para los siguientes:

| Requisito del spec | Tarea |
|---|---|
| `helmet`, HSTS, fuera `x-powered-by` | 1 |
| `CORS_ORIGIN` sin valor por defecto | 2 |
| Índice único de `user` (§3, novena migración) | 3 |
| Campos de bloqueo por cuenta | 3 |
| Respuesta uniforme: mensaje y tiempo | 4 |
| Cubos por IP, por cuenta, y por cuenta+IP | 5 |
| bcrypt 8 → 12 en los tres sitios, con rehash | 6 |
| Política de contraseña | 7 |
| Retirada de `DB_SYNC` (§9) | 8 |
| **Cubo de `/auth/mfa/verify`** | Plan 4 — la ruta no existe todavía |
| **Límite de `/auth/email/send` y `/forgot`** | Plan 3 — ídem |
| **Tolerancia de reloj en TOTP** | Plan 4 |

## Riesgos de este plan

**El índice único puede fallar contra datos reales.** Si hay dos usuarios cuyo
nombre difiere solo en mayúsculas, o duplicados exactos, la migración aborta. Se
descubre en el ensayo local del paso 6 de la Task 3, que es exactamente para lo
que sirve. No es un fallo del plan: es información que hacía falta.

**La política de contraseña puede romper tests existentes** que usan claves
cortas. Se arregla alargando la clave del test.

**Nadie queda fuera.** Ningún cambio de este plan invalida una sesión, una
contraseña ni un token. Las contraseñas existentes siguen valiendo aunque no
cumplan la política nueva — se les exige al cambiarlas, no al usarlas.
