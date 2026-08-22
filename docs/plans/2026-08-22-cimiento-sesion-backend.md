# Plan 2A — El cimiento de sesión, lado servidor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sustituir el JWT irrevocable por sesiones opacas en cookie `httpOnly`, guardadas en Postgres y revocables de verdad — **sin romper el frontend actual**, que sigue funcionando con el token viejo mientras dure la transición.

**Architecture:** una tabla `sesion`, un token opaco de 32 bytes guardado hasheado, y una cookie `__Host-`. `authenticateToken` pasa a aceptar **las dos credenciales**: la cookie nueva primero, y si no hay, el JWT viejo. El login viejo entrega el JWT *y además* pone la cookie, así que cada persona que entre durante la transición ya queda migrada sin notarlo.

**Tech Stack:** Express 4, Sequelize 6, Postgres, Umzug, Vitest, `cookie-parser`.

**Spec:** [`../specs/2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md) — implementa el §3 (tabla `sesion`, `authenticateToken`), el §2 (la cookie host-only) y la parte de §5 y §7 que no depende del MFA.

**Precede a:** Plan 2B (el frontend, 93 cabeceras y 210 referencias) y Plan 2C (retirar el JWT viejo). Los tres juntos son lo que el spec llama «el cimiento de sesión».

## Global Constraints

- **Un commit por tarea.** El dueño del repositorio trabaja en el mismo árbol y commitea sin avisar, así que **nunca `git commit --amend`** y **nunca `git add -A`**: ficheros por nombre, uno a uno. No se aplastan al final — un rebase sobre un rango que contiene sus commits es reescribir trabajo ajeno.
- **Rama `isaias`.** Nunca `master`.
- **Todo el código, los comentarios y los mensajes de commit en inglés**, con asunto `tipo(scope): frase en minúscula`. Los textos que ve el usuario, en español.
- **Cero cifras literales:** todo número de configuración vive en `src/config/security.ts`, que ya existe.
- **Cada migración va entera dentro de `queryInterface.sequelize.transaction`**, con `SET LOCAL lock_timeout = '5s'` como primera sentencia, en `up` **y** en `down`. El patrón bueno es `src/migrations/20260804000001-create-reporte-vista.ts`.
- **Toda columna de fecha es `TIMESTAMPTZ`** (`DataTypes.DATE`). Nunca `TIMESTAMP`: el resto del esquema lleva zona y mezclarlas da cuatro horas de desfase en Bolivia.
- **`tableName` explícito en todo modelo nuevo.** La pluralización de Sequelize ya produjo `ciudads`, `rols` y `revicions` en este esquema.
- **Verificación al final de cada tarea:** `npm run typecheck && npm run lint && npm test`. Los tres en verde.
- **Antes de dar una tarea por buena, rompe el código a propósito** y comprueba que el test falla. En el Plan 1 aparecieron **cuatro** tests que pasaban con el código roto, y uno de ellos era el que decía proteger la propiedad más importante de su tarea.
- **Punto de partida:** commit `b0d5031`, 489 tests en 29 ficheros, typecheck y lint limpios.

## Por qué las tareas 6, 7 y 8 no traen el código escrito

Las cinco primeras tareas traen el código literal. Las tres últimas traen
contratos precisos, criterios de aceptación y la lista de lo que hay que romper
a propósito — pero no el cuerpo de las funciones. Es deliberado, y la razón sale
de lo que pasó al ejecutar el Plan 1.

Ese plan traía el código completo de las ocho tareas. Los implementadores lo
transcribieron con fidelidad, y con él transcribieron **mis errores**: cuatro
tests que pasaban con el código roto, una política de contraseñas que se saltaba
con espacios de relleno, una detección de coste de hash que no generalizaba, y
un test de code points que no distinguía nada. Ninguno era invención suya: los
cuatro venían verbatim de mis briefs.

Y donde tuvieron que pensar, encontraron cosas que yo no había visto: el bug del
cargador de migraciones, que la política de contraseñas no estaba enchufada al
controlador y que ningún test lo detectaba, y que su propio arnés de
verificación era falso.

Así que en las piezas donde la forma correcta no es obvia —el contrato de seis
endpoints, la regla de CSRF que hace posible la coexistencia— el plan dice **qué
tiene que ser verdad y cómo comprobarlo**, y deja el cómo a quien lo escriba con
el código delante. Lo que no se relaja es la verificación: cada tarea sigue
exigiendo tests que fallen al romper el código a propósito.

## La decisión que gobierna este plan: coexistencia

El backend vive en Coolify y el frontend en Vercel. **Se despliegan por separado**, y no hay forma de hacerlo a la vez. Si el servidor dejara de entender el JWT en el mismo movimiento en que el navegador empieza a mandar cookies, habría una ventana en la que uno es nuevo y el otro viejo y **nadie entra** — y si el segundo despliegue falla, esa ventana no se cierra.

Así que durante este plan y el 2B, `authenticateToken` acepta las dos credenciales. Tiene un precio que hay que decir en voz alta: **mientras el JWT siga valiendo, el agujero de los tokens irrevocables sigue abierto.** No se cierra aquí; se cierra en el Plan 2C, retirando el camino viejo. Lo que se gana es que ninguno de los tres despliegues puede dejar a la empresa fuera.

Para medir cuándo se puede cerrar, el camino viejo **registra cada uso**: así el día del 2C se sabe si queda alguien usándolo o si el contador está a cero.

---

## Estructura de ficheros

| Fichero | Responsabilidad | Estado |
|---|---|---|
| `src/migrations/20260822000001-create-sesion.ts` | La tabla y sus índices | **Crear** |
| `src/models/sesion.model.ts` | El modelo, con `tableName: "sesiones"` | **Crear** |
| `src/auth/sessionToken.ts` | Generar el token opaco y hashearlo. Nada más | **Crear** |
| `src/auth/sessionStore.ts` | Crear, buscar, tocar, revocar y purgar sesiones | **Crear** |
| `src/auth/sessionCookie.ts` | Nombre, opciones y escritura/borrado de la cookie | **Crear** |
| `src/middleware/authenticate.ts` | El middleware con las dos credenciales | **Crear** (mueve lo que hoy está en `app.ts`) |
| `src/middleware/csrf.ts` | `Origin` contra allowlist más cabecera propia | **Crear** |
| `src/controllers/auth.controller.ts` | `/auth/login`, `/me`, `/logout`, `/logout-all`, sesiones | **Crear** |
| `src/routes/auth.routes.ts` | El router de `/api/auth` | **Crear** |
| `src/config/security.ts` | Duración de sesión, tope absoluto, nombre de cookie | Modificar |
| `src/controllers/login.controller.ts` | El login viejo pone también la cookie | Modificar |
| `src/controllers/usuario.controller.ts` | Cambiar contraseña y archivar revocan sesiones | Modificar |
| `src/app.ts` | `cookie-parser`, montar `/api/auth`, usar el middleware nuevo | Modificar |
| `src/index.ts` | Arrancar la purga periódica | Modificar |

---

## Task 1: La tabla `sesion`

**Files:**
- Create: `src/migrations/20260822000001-create-sesion.ts`
- Create: `src/migrations/20260822000001-create-sesion.test.ts`
- Create: `src/models/sesion.model.ts`
- Modify: `src/interfaces/index.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `SesionModel` y la interfaz `ISesion`, que las tareas 2, 3, 5 y 6 usan.

**Nota de alcance, importante.** El §3 del spec describe la tabla con columnas que este plan **no** usa: `mfa_satisfied_at`, `mfa_source`, `estado`, `webauthn_challenge`, `challenge_expires_at`. Esas son del Plan 4 y **no se crean aquí**. Una columna que nadie escribe es una trampa: el siguiente que la vea asumirá que significa algo. Añadirlas después es un `ALTER TABLE` sobre una tabla pequeña, que cuesta milisegundos.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/migrations/20260822000001-create-sesion.test.ts`:

```ts
// The session table.
//
// Tested at the level the other migrations are: that it asks the queryInterface
// for the right things, inside a transaction, with the types and the constraints
// the rest of the schema uses. The transaction is the part worth pinning: a
// migration that runs half way leaves the deploy in a crash loop.

import { describe, it, expect } from "vitest";
import { DataTypes } from "sequelize";
import { up, down } from "./20260822000001-create-sesion.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    createTable: record("createTable"),
    dropTable: record("dropTable"),
    addIndex: record("addIndex"),
    sequelize: {
      query: record("query"),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

/** The column spec the migration declared for a given column. */
function columnOf(qi: ReturnType<typeof fakeQueryInterface>, name: string) {
  const create = qi.calls.find((c) => c.fn === "createTable");
  return (create?.args[1] as Record<string, Record<string, unknown>>)[name];
}

describe("create-sesion", () => {
  it("creates the table with the plural name Sequelize expects", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const create = qi.calls.find((c) => c.fn === "createTable");
    expect(create?.args[0]).toBe("sesiones");
  });

  it("runs everything inside one transaction", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.calls.length).toBeGreaterThan(0);
    expect(qi.calls.every((c) => (c.args.at(-1) as { transaction?: unknown })?.transaction)).toBe(true);
  });

  it("takes a lock timeout before touching anything", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const first = qi.calls[0];
    expect(first.fn).toBe("query");
    expect(String(first.args[0])).toMatch(/lock_timeout/);
  });

  it("gives every date column a timezone", async () => {
    // TIMESTAMP without a zone against a server in UTC and a database in
    // Bolivia puts every expiry four hours out. Silently.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    for (const name of ["created_at", "last_used_at", "expires_at", "revoked_at"]) {
      expect(columnOf(qi, name).type, name).toBe(DataTypes.DATE);
    }
  });

  it("will not accept a session without an owner or a token", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id_usuario").allowNull).toBe(false);
    expect(columnOf(qi, "token_hash").allowNull).toBe(false);
    expect(columnOf(qi, "token_hash").unique).toBe(true);
  });

  it("refuses to cascade a user deletion into their sessions", async () => {
    // The seventeen existing foreign keys in this schema are ON DELETE CASCADE,
    // and `rol` is the only model without soft deletion — so deleting a role
    // has already been measured taking 6 users, 958 poles and 4835 revisions
    // with it. A session table on CASCADE would join that list.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(columnOf(qi, "id_usuario").onDelete).toBe("RESTRICT");
  });

  it("indexes what the queries actually filter by", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const indexed = qi.calls
      .filter((c) => c.fn === "addIndex")
      .map((c) => (c.args[1] as { fields: string[] }).fields.join(","));
    expect(indexed).toContain("id_usuario");
    expect(indexed).toContain("expires_at");
  });

  it("can be undone, inside a transaction", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    expect(qi.calls.some((c) => c.fn === "dropTable")).toBe(true);
    expect(qi.calls.every((c) => (c.args.at(-1) as { transaction?: unknown })?.transaction)).toBe(true);
  });
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/migrations/20260822000001-create-sesion.test.ts
```

Esperado: FALLA, el módulo no existe.

- [ ] **Step 3: Escribir la migración**

Crear `src/migrations/20260822000001-create-sesion.ts`:

```ts
import { QueryInterface, DataTypes } from "sequelize";

// One row per open session, so a session can be ended.
//
// The token itself is never stored: only its SHA-256. A leaked dump of this
// table therefore hands over nothing that can be used to log in — which is the
// whole difference between this and a JWT, whose bearer token *is* the thing
// the server verifies.
//
// Table name set explicitly. Sequelize's pluralisation has already produced
// `ciudads`, `rols` and `revicions` in this schema.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // `authenticateToken` reads this table on every request from the moment it
    // exists. Creating it takes no lock worth worrying about, but the timeout
    // is the house rule for every migration here and a later ALTER on this
    // table will need it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      "sesiones",
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
        },
        id_usuario: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: "usuarios", key: "id" },
          onUpdate: "CASCADE",
          // RESTRICT, not CASCADE. Deleting a role in this schema has been
          // measured taking 6 users and 4835 revisions with it through
          // seventeen cascading keys; sessions are not joining that chain.
          // Ending a user's sessions is code's job, and it is explicit.
          onDelete: "RESTRICT",
        },
        token_hash: {
          // SHA-256 in hex: always 64 characters. Not bcrypt — the token is
          // already 32 random bytes, there is no entropy to stretch, and this
          // row is read on every single request.
          type: DataTypes.CHAR(64),
          allowNull: false,
          unique: true,
        },
        user_agent: {
          // So a person recognises their own session in the list before ending
          // it. Truncated on write; browsers send absurdly long strings.
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        ip_address: {
          // 45 characters: the longest an IPv6 address gets, including a mapped
          // IPv4 tail.
          type: DataTypes.STRING(45),
          allowNull: true,
        },
        created_at: { type: DataTypes.DATE, allowNull: false },
        last_used_at: { type: DataTypes.DATE, allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );

    // Every session of one person: the profile screen lists them, logging out
    // everywhere revokes them, and the rescue script reaches them.
    await queryInterface.addIndex("sesiones", {
      fields: ["id_usuario"],
      name: "sesiones_id_usuario_idx",
      transaction,
    });

    // The purge sweeps by expiry.
    await queryInterface.addIndex("sesiones", {
      fields: ["expires_at"],
      name: "sesiones_expires_at_idx",
      transaction,
    });
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.dropTable("sesiones", { transaction });
  });
}
```

- [ ] **Step 4: Ejecutar y comprobar que pasa**

```bash
cd api && npx vitest run src/migrations/20260822000001-create-sesion.test.ts
```

Esperado: PASA, los ocho.

- [ ] **Step 5: El modelo y la interfaz**

Crear `src/models/sesion.model.ts`:

```ts
import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "./usuario.model.js";
import { ISesion } from "../interfaces/index.js";

type SesionCreation = Optional<ISesion, "revoked_at" | "user_agent" | "ip_address">;

/**
 * `tableName` and `timestamps: false` are both deliberate.
 *
 * The name because Sequelize's pluralisation is not trusted in this schema. The
 * timestamps because this table keeps its own three dates with meanings
 * Sequelize's pair does not have: `last_used_at` is not `updatedAt` (it is
 * throttled), and `expires_at` is not derived from anything.
 */
export const SesionModel: ModelDefined<ISesion, SesionCreation> = sequelize.define(
  "sesion",
  {
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    id_usuario: { type: DataTypes.INTEGER, allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
    ip_address: { type: DataTypes.STRING(45), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    last_used_at: { type: DataTypes.DATE, allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "sesiones", timestamps: false },
);

UsuarioModel.hasMany(SesionModel, { foreignKey: "id_usuario" });
SesionModel.belongsTo(UsuarioModel, { foreignKey: "id_usuario" });
```

Y en `src/interfaces/index.ts`, añadir:

```ts
export interface ISesion {
  id: string;
  id_usuario: number;
  token_hash: string;
  user_agent?: string | null;
  ip_address?: string | null;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at?: Date | null;
}
```

- [ ] **Step 6: Ensayar contra la copia local de producción**

```bash
cd api && npm run migrate
```

Esperado: corre limpia. Comprobar en la base que la tabla existe con `timestamptz` en las cuatro fechas y los dos índices creados.

- [ ] **Step 7: Verificar y commitear**

```bash
cd api && npm run typecheck && npm run lint && npm test
```

Commit con los cuatro ficheros por nombre. Asunto del estilo `feat(auth): add the session table`.

---

## Task 2: El token opaco y su hash

La pieza más pequeña del plan y la que no puede estar mal.

**Files:**
- Create: `src/auth/sessionToken.ts`
- Create: `src/auth/sessionToken.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `newSessionToken(): string` — el valor que viaja en la cookie, base64url
  - `hashSessionToken(token: string): string` — 64 caracteres hex

- [ ] **Step 1: Escribir el test que falla**

Crear `src/auth/sessionToken.test.ts`:

```ts
// The session token.
//
// Two properties and nothing else: it is unguessable, and what the database
// keeps cannot be turned back into it. Both are the kind of thing that looks
// fine when it is wrong, so they are pinned here.

import { describe, it, expect } from "vitest";
import { newSessionToken, hashSessionToken } from "./sessionToken.js";

describe("newSessionToken", () => {
  it("carries 32 bytes of entropy", () => {
    // base64url of 32 bytes is 43 characters with no padding. Fewer characters
    // than that means fewer bytes than that.
    expect(newSessionToken()).toHaveLength(43);
  });

  it("is url-safe, so a cookie never needs escaping", () => {
    for (let i = 0; i < 50; i++) {
      expect(newSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newSessionToken());
    expect(seen.size).toBe(1000);
  });
});

describe("hashSessionToken", () => {
  it("returns 64 hex characters", () => {
    expect(hashSessionToken("cualquier-cosa")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same answer every time, so a lookup can find the row", () => {
    const t = newSessionToken();
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
  });

  it("gives different answers to different tokens", () => {
    expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
  });

  it("does not contain the token", () => {
    // Obvious, and the point of the whole module: a dump of the table hands
    // over nothing that can be replayed.
    const t = newSessionToken();
    expect(hashSessionToken(t)).not.toContain(t);
  });
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/auth/sessionToken.test.ts
```

Esperado: FALLA, el módulo no existe.

- [ ] **Step 3: Escribir el módulo**

Crear `src/auth/sessionToken.ts`:

```ts
import { randomBytes, createHash } from "node:crypto";

/** Bytes of entropy in a session token. */
const TOKEN_BYTES = 32;

/**
 * A new session token: the value that travels in the cookie.
 *
 * `randomBytes` and not `Math.random`, which is not a cryptographic source and
 * whose output can be predicted from previous output.
 *
 * base64url so the value never needs escaping in a Set-Cookie header, and so
 * nothing downstream has to guess whether a `+` was a plus or a space.
 */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * What the database keeps.
 *
 * SHA-256 and not bcrypt, deliberately. bcrypt exists to make a *low-entropy*
 * secret expensive to guess; this token already has 256 bits, so there is
 * nothing to stretch — and this hash is computed on every single authenticated
 * request, where bcrypt would cost 250 ms.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

- [ ] **Step 4: Ejecutar y verificar**

```bash
cd api && npx vitest run src/auth/sessionToken.test.ts && npm run typecheck && npm run lint && npm test
```

Esperado: los ocho tests nuevos pasan y la suite completa sigue en verde. Commit.

---

## Task 3: El almacén de sesiones

**Files:**
- Create: `src/auth/sessionStore.ts`
- Create: `src/auth/sessionStore.test.ts`
- Modify: `src/config/security.ts`

**Interfaces:**
- Consumes: `SesionModel` (Task 1), `newSessionToken`/`hashSessionToken` (Task 2).
- Produces:
  - `createSession(id_usuario: number, meta: { userAgent?: string; ip?: string }): Promise<{ token: string; expiresAt: Date }>`
  - `findLiveSession(token: string): Promise<{ id: string; id_usuario: number; expires_at: Date } | null>`
  - `touchSession(id: string, lastUsedAt: Date): Promise<void>`
  - `revokeSession(id: string): Promise<void>`
  - `revokeAllSessionsOf(id_usuario: number): Promise<number>`
  - `listSessionsOf(id_usuario: number): Promise<ISesion[]>`
  - `purgeExpiredSessions(): Promise<number>`

- [ ] **Step 1: Añadir los números a `src/config/security.ts`**

Al final del fichero:

```ts
/**
 * How long a session lives.
 *
 * Seven days of not being used and it is gone; every request pushes that back
 * another seven. With an absolute ceiling of thirty days from creation, however
 * much it is used — which is the thing the old JWT did not have, and why a
 * stolen token could live forever by being used.
 */
export const SESSION_IDLE_DAYS = 7;
export const SESSION_ABSOLUTE_DAYS = 30;

/**
 * How stale `last_used_at` is allowed to get before it is worth a write.
 *
 * Writing it on every request turns every read into a write: one report export
 * makes around two thousand sequential requests, which would be two thousand
 * UPDATEs and two thousand dead tuples on one row.
 */
export const SESSION_TOUCH_THROTTLE_MINUTES = 5;
```

- [ ] **Step 2: Escribir el test que falla**

Crear `src/auth/sessionStore.test.ts`:

```ts
// Creating, finding and ending sessions.
//
// The model is mocked: what matters here is the shape of what gets written and
// the conditions of what gets read. A session that stays valid after being
// revoked, or one whose lookup forgets to check expiry, is the whole reason
// this table exists — so those are the assertions, not the happy path.

import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
const findOne = vi.fn();
const findAll = vi.fn();
const update = vi.fn();
const destroy = vi.fn();

vi.mock("../models/sesion.model.js", () => ({
  SesionModel: {
    create: (...a: unknown[]) => create(...a),
    findOne: (...a: unknown[]) => findOne(...a),
    findAll: (...a: unknown[]) => findAll(...a),
    update: (...a: unknown[]) => update(...a),
    destroy: (...a: unknown[]) => destroy(...a),
  },
}));

const {
  createSession,
  findLiveSession,
  revokeSession,
  revokeAllSessionsOf,
  purgeExpiredSessions,
} = await import("./sessionStore.js");
const { hashSessionToken } = await import("./sessionToken.js");
const { SESSION_IDLE_DAYS, SESSION_ABSOLUTE_DAYS } = await import("../config/security.js");

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ dataValues: {} });
  update.mockResolvedValue([1]);
  destroy.mockResolvedValue(0);
});

/** The row the store handed to the model. */
const written = () => create.mock.calls[0][0] as Record<string, unknown>;
/** The `where` the store used to look a session up. */
const lookedUpWith = () => (findOne.mock.calls[0][0] as { where: Record<string, unknown> }).where;

describe("createSession", () => {
  it("never writes the token itself", async () => {
    // The one property that makes this table safe to dump.
    const { token } = await createSession(7, {});
    expect(JSON.stringify(written())).not.toContain(token);
    expect(written().token_hash).toBe(hashSessionToken(token));
  });

  it("returns a token that is not what it stored", async () => {
    const { token } = await createSession(7, {});
    expect(token).not.toBe(written().token_hash);
  });

  it("expires at the idle limit, not at the absolute one", async () => {
    const { expiresAt } = await createSession(7, {});
    const dias = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(SESSION_IDLE_DAYS - 0.01);
    expect(dias).toBeLessThan(SESSION_IDLE_DAYS + 0.01);
  });

  it("truncates a browser's absurd user agent instead of failing the insert", async () => {
    await createSession(7, { userAgent: "x".repeat(400) });
    expect(String(written().user_agent).length).toBeLessThanOrEqual(255);
  });
});

describe("findLiveSession", () => {
  it("looks up by the hash, never by the token", async () => {
    findOne.mockResolvedValue(null);
    await findLiveSession("un-token");
    expect(JSON.stringify(lookedUpWith())).not.toContain("un-token");
    expect(lookedUpWith().token_hash).toBe(hashSessionToken("un-token"));
  });

  it("requires the session not to be revoked", async () => {
    findOne.mockResolvedValue(null);
    await findLiveSession("t");
    expect(lookedUpWith()).toHaveProperty("revoked_at", null);
  });

  it("requires the session not to have expired", async () => {
    findOne.mockResolvedValue(null);
    await findLiveSession("t");
    expect(JSON.stringify(lookedUpWith())).toMatch(/expires_at/);
  });

  it("returns null when there is no row, rather than something falsy-ish", async () => {
    findOne.mockResolvedValue(null);
    expect(await findLiveSession("t")).toBeNull();
  });
});

describe("revoking", () => {
  it("marks one session revoked instead of deleting the row", async () => {
    // Kept, so the profile screen can show that it was ended and when.
    await revokeSession("una-id");
    expect(update).toHaveBeenCalled();
    const [values, options] = update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(values.revoked_at).toBeInstanceOf(Date);
    expect(options.where).toMatchObject({ id: "una-id" });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("revokes every live session of one person and says how many", async () => {
    update.mockResolvedValue([3]);
    expect(await revokeAllSessionsOf(7)).toBe(3);
    const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(options.where).toMatchObject({ id_usuario: 7, revoked_at: null });
  });
});

describe("purgeExpiredSessions", () => {
  it("deletes rows that are long past being useful, and only those", async () => {
    destroy.mockResolvedValue(12);
    expect(await purgeExpiredSessions()).toBe(12);
    const where = JSON.stringify((destroy.mock.calls[0][0] as { where: unknown }).where);
    expect(where).toMatch(/expires_at|revoked_at/);
    // The absolute ceiling is the longest a row can matter for.
    expect(SESSION_ABSOLUTE_DAYS).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/auth/sessionStore.test.ts
```

Esperado: FALLA, el módulo no existe.

- [ ] **Step 4: Escribir el módulo**

Crear `src/auth/sessionStore.ts`:

```ts
import { Op } from "sequelize";
import { randomUUID } from "node:crypto";
import { SesionModel } from "../models/sesion.model.js";
import { newSessionToken, hashSessionToken } from "./sessionToken.js";
import {
  SESSION_IDLE_DAYS,
  SESSION_ABSOLUTE_DAYS,
} from "../config/security.js";
import type { ISesion } from "../interfaces/index.js";

const DAY_MS = 86_400_000;

/** Browsers send user agent strings far longer than any column wants. */
function fitUserAgent(ua?: string): string | null {
  if (!ua) return null;
  return ua.slice(0, 255);
}

/**
 * Open a session and return the token that names it.
 *
 * The token is returned once and never again: what the table keeps is its
 * hash, so nothing here or in a database dump can be replayed as a login.
 */
export async function createSession(
  id_usuario: number,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_IDLE_DAYS * DAY_MS);

  await SesionModel.create({
    id: randomUUID(),
    id_usuario,
    token_hash: hashSessionToken(token),
    user_agent: fitUserAgent(meta.userAgent),
    ip_address: meta.ip ?? null,
    created_at: now,
    last_used_at: now,
    expires_at: expiresAt,
    revoked_at: null,
  });

  return { token, expiresAt };
}

/**
 * The session this token names, if it is still good for anything.
 *
 * Three conditions, and all three have to be in the query rather than checked
 * afterwards: a revoked session, an expired one, and one past the absolute
 * ceiling are all "no". Checking them in JavaScript after the fact is how one
 * of them ends up forgotten on a later edit.
 */
export async function findLiveSession(
  token: string,
): Promise<{ id: string; id_usuario: number; expires_at: Date; last_used_at: Date } | null> {
  const now = new Date();
  const found = await SesionModel.findOne({
    where: {
      token_hash: hashSessionToken(token),
      revoked_at: null,
      expires_at: { [Op.gt]: now },
      created_at: { [Op.gt]: new Date(now.getTime() - SESSION_ABSOLUTE_DAYS * DAY_MS) },
    },
    attributes: ["id", "id_usuario", "expires_at", "last_used_at"],
  });
  if (!found) return null;
  const v = found.dataValues;
  return {
    id: v.id,
    id_usuario: v.id_usuario,
    expires_at: v.expires_at,
    last_used_at: v.last_used_at,
  };
}

/** Push the idle expiry back, and record that the session was used. */
export async function touchSession(id: string, at: Date): Promise<void> {
  await SesionModel.update(
    { last_used_at: at, expires_at: new Date(at.getTime() + SESSION_IDLE_DAYS * DAY_MS) },
    { where: { id } },
  );
}

/**
 * End one session.
 *
 * Marked rather than deleted, so the profile screen can show that it ended and
 * when, and so an audit can see it happened at all.
 */
export async function revokeSession(id: string): Promise<void> {
  await SesionModel.update({ revoked_at: new Date() }, { where: { id, revoked_at: null } });
}

/** End every live session of one person. Returns how many were ended. */
export async function revokeAllSessionsOf(id_usuario: number): Promise<number> {
  const [count] = await SesionModel.update(
    { revoked_at: new Date() },
    { where: { id_usuario, revoked_at: null } },
  );
  return count;
}

/** The sessions a person could still be using, newest first. */
export async function listSessionsOf(id_usuario: number): Promise<ISesion[]> {
  const rows = await SesionModel.findAll({
    where: { id_usuario, revoked_at: null, expires_at: { [Op.gt]: new Date() } },
    order: [["last_used_at", "DESC"]],
  });
  return rows.map((r) => r.dataValues);
}

/**
 * Delete rows that cannot matter to anyone any more.
 *
 * Nothing else deletes from this table, so without this it only grows. The
 * cutoff is the absolute ceiling: past that, a row cannot authenticate anything
 * and is not recent enough to be interesting in a session list.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - SESSION_ABSOLUTE_DAYS * DAY_MS);
  return SesionModel.destroy({
    where: {
      [Op.or]: [{ expires_at: { [Op.lt]: cutoff } }, { revoked_at: { [Op.lt]: cutoff } }],
    },
  });
}
```

- [ ] **Step 5: Ejecutar, romper a propósito, verificar**

```bash
cd api && npx vitest run src/auth/sessionStore.test.ts
```

Esperado: PASA. Luego **rompe tres cosas y comprueba que los tests las cazan**: quita `revoked_at: null` del `where` de `findLiveSession`; quita la condición de `expires_at`; escribe el token en claro en `token_hash`. Los tres deben poner un test en rojo. Restaura.

```bash
cd api && npm run typecheck && npm run lint && npm test
```

Commit.

---

## Task 4: La cookie

**Files:**
- Create: `src/auth/sessionCookie.ts`
- Create: `src/auth/sessionCookie.test.ts`
- Modify: `src/config/security.ts`
- Modify: `package.json` (`cookie-parser`)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `SESSION_COOKIE_NAME: string`
  - `setSessionCookie(res: Response, token: string, expiresAt: Date): void`
  - `clearSessionCookie(res: Response): void`
  - `readSessionCookie(req: Request): string | undefined`

- [ ] **Step 1: Instalar `cookie-parser`**

```bash
cd api && npm install cookie-parser@^1.4.7 && npm install --save-dev @types/cookie-parser
```

**Por qué hace falta:** en Express 4, `res.cookie` es nativo pero **`req.cookies` no existe** sin este paquete. Escribir la cookie funcionaría y leerla no, que es el fallo más confuso posible.

- [ ] **Step 2: Escribir el test que falla**

Crear `src/auth/sessionCookie.test.ts`:

```ts
// The cookie.
//
// Four attributes, y cada uno cierra un ataque distinto. This file exists so
// nobody "simplifies" one of them away, because three of the four fail silently
// — the application keeps working and the protection is gone.

import { describe, it, expect, vi } from "vitest";
import { setSessionCookie, clearSessionCookie, readSessionCookie, SESSION_COOKIE_NAME } from "./sessionCookie.js";
import type { Request, Response } from "express";

function fakeRes() {
  const calls: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      calls.push({ name, value, options });
      return res;
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      calls.push({ name, value: "", options });
      return res;
    },
  };
  return { res: res as unknown as Response, calls };
}

const optionsOf = (calls: { options: Record<string, unknown> }[]) => calls[0].options;

describe("setSessionCookie", () => {
  it("is not readable from JavaScript", () => {
    // Without this, one injected script takes the session.
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls).httpOnly).toBe(true);
  });

  it("never leaves the host that set it", () => {
    // No `domain`. A cookie scoped to the parent domain can be shadowed by any
    // subdomain — httpOnly stops it being read, not being overwritten — and it
    // would travel to the frontend's host on every image and script.
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls)).not.toHaveProperty("domain");
  });

  it("covers the whole host, so nothing can shadow it with a longer path", () => {
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls).path).toBe("/");
  });

  it("is not sent on a request another site started", () => {
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls).sameSite).toBe("lax");
  });

  it("expires when the session does", () => {
    const { res, calls } = fakeRes();
    const expiresAt = new Date(Date.now() + 60_000);
    setSessionCookie(res, "t", expiresAt);
    expect(optionsOf(calls).expires).toEqual(expiresAt);
  });

  it("carries the token as its value", () => {
    const { res, calls } = fakeRes();
    setSessionCookie(res, "el-token", new Date(Date.now() + 1000));
    expect(calls[0].value).toBe("el-token");
    expect(calls[0].name).toBe(SESSION_COOKIE_NAME);
  });
});

describe("clearSessionCookie", () => {
  it("clears it with the same attributes it was set with", () => {
    // A browser only drops a cookie when path and the rest match. Clearing it
    // with different attributes leaves the old one in place.
    const { res, calls } = fakeRes();
    clearSessionCookie(res);
    expect(calls[0].name).toBe(SESSION_COOKIE_NAME);
    expect(calls[0].options.path).toBe("/");
    expect(calls[0].options.httpOnly).toBe(true);
  });
});

describe("readSessionCookie", () => {
  it("finds the token when the cookie is there", () => {
    const req = { cookies: { [SESSION_COOKIE_NAME]: "abc" } } as unknown as Request;
    expect(readSessionCookie(req)).toBe("abc");
  });

  it("is undefined when there are no cookies at all", () => {
    // cookie-parser not mounted, or a client that sends none. Must not throw.
    expect(readSessionCookie({} as Request)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/auth/sessionCookie.test.ts
```

- [ ] **Step 4: Añadir la configuración**

En `src/config/security.ts`:

```ts
/**
 * The session cookie's name, and whether it must be Secure.
 *
 * In production the name carries the `__Host-` prefix, which a browser only
 * accepts on a cookie that has no `domain`, has `path=/`, and is `Secure`.
 * That makes the cookie impossible to shadow from a subdomain by construction
 * rather than by our own care.
 *
 * In development the prefix cannot be used, because `Secure` rules out
 * `http://localhost`. Hence a variable rather than a constant.
 */
export const SESSION_COOKIE_NAME = process.env.COOKIE_NAME ?? "osefi_session";
export const SESSION_COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
```

Y añadir `COOKIE_NAME` y `COOKIE_SECURE` a la lista que `requiredEnv` exige en producción — `COOKIE_NAME` tiene que ser `__Host-osefi_session` allí, y un despliegue que lo olvide dejaría la cookie sin la garantía del prefijo, en silencio.

- [ ] **Step 5: Escribir el módulo**

Crear `src/auth/sessionCookie.ts`:

```ts
import type { Request, Response, CookieOptions } from "express";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "../config/security.js";

export { SESSION_COOKIE_NAME };

/**
 * The attributes, in one place, so setting and clearing cannot disagree.
 *
 * Deliberately no `domain`. www.osefi.net and api.osefi.net share a registrable
 * domain, so they are already same-site: a host-only cookie set by the API
 * travels on the frontend's XHR with SameSite=Lax perfectly well. Adding
 * `domain` would buy nothing and cost two things — any subdomain could shadow
 * the cookie with a longer `path` (httpOnly stops reading, not overwriting),
 * and the session would ride along on every request to the frontend's host,
 * including every image.
 */
function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  };
}

/** Hand the browser a session. */
export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, token, { ...cookieOptions(), expires: expiresAt });
}

/**
 * Take it back.
 *
 * Same attributes as when it was set: a browser only drops a cookie whose name
 * and attributes match, so clearing it with a different `path` leaves the old
 * one exactly where it was.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
}

/** The token the browser sent, if it sent one. */
export function readSessionCookie(req: Request): string | undefined {
  return (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
}
```

- [ ] **Step 6: Montar `cookie-parser` y verificar**

En `src/app.ts`, junto a `express.json()`:

```ts
// `res.cookie` is native to Express; `req.cookies` is not. Without this the
// session can be handed out and never read back.
app.use(cookieParser());
```

```bash
cd api && npm run typecheck && npm run lint && npm test
```

Rompe a propósito: quita `httpOnly`, quita `path`, añade un `domain`. Los tres deben poner un test en rojo. Commit.

---

## Task 5: `authenticateToken` con las dos credenciales

La pieza central del plan, y la que decide si alguien entra.

**Files:**
- Create: `src/middleware/authenticate.ts`
- Create: `src/middleware/authenticate.test.ts`
- Modify: `src/app.ts` (quitar la función local, importar la nueva)

**Interfaces:**
- Consumes: `findLiveSession`, `touchSession` (Task 3), `readSessionCookie` (Task 4).
- Produces: `authenticate: RequestHandler`, y `req.user` gana `id_sesion?: string`.

- [ ] **Step 1: Ampliar la declaración de `Request`**

En `src/app.ts`, donde está el `declare global`:

```ts
    interface Request {
      user?: { id: number; id_rol: number; id_sesion?: string };
    }
```

`id_sesion` es opcional a propósito: una petición autenticada por el JWT viejo no tiene sesión en la tabla, y durante la transición eso es legítimo. Los endpoints que necesiten la sesión —cerrar la actual, listarlas— comprueban que existe y responden 400 si no, con un mensaje que dice que hay que volver a entrar.

- [ ] **Step 2: Escribir el test que falla**

Crear `src/middleware/authenticate.test.ts`:

```ts
// Who gets in.
//
// Two credentials during the transition: the cookie, and the old bearer token.
// The order matters and the fallback matters, but what matters most is what
// happens when a session has been revoked — that is the entire reason this
// middleware is being rewritten.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const findLiveSession = vi.fn();
const touchSession = vi.fn();
const findByPk = vi.fn();
const jwtVerify = vi.fn();

vi.mock("../auth/sessionStore.js", () => ({
  findLiveSession: (...a: unknown[]) => findLiveSession(...a),
  touchSession: (...a: unknown[]) => touchSession(...a),
}));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { findByPk: (...a: unknown[]) => findByPk(...a) },
}));
vi.mock("jsonwebtoken", () => ({
  default: { verify: (...a: unknown[]) => jwtVerify(...a) },
}));
vi.mock("../utils/logger.js", () => ({ log: () => ({ info: vi.fn(), warn: vi.fn() }) }));

const { authenticate } = await import("./authenticate.js");
const { SESSION_COOKIE_NAME } = await import("../auth/sessionCookie.js");

function call(opts: { cookie?: string; bearer?: string } = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    sendStatus(c: number) { this.statusCode = c; return this; },
  };
  const req = {
    cookies: opts.cookie ? { [SESSION_COOKIE_NAME]: opts.cookie } : {},
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    ip: "::1",
  } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res: res as unknown as Response, next, get status() { return res.statusCode; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 2 } });
  touchSession.mockResolvedValue(undefined);
});

describe("with a session cookie", () => {
  it("lets a live session through and says who it is", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    const c = call({ cookie: "buen-token" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.req.user).toMatchObject({ id: 7, id_sesion: "s1" });
  });

  it("reads the role from the database, not from anything the client sent", async () => {
    // A demoted person kept their old permissions for up to a week under the
    // old token. The role is re-read on every request for that reason.
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    findByPk.mockResolvedValue({ dataValues: { id: 7, id_rol: 3 } });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.req.user?.id_rol).toBe(3);
  });

  it("turns a revoked session away", async () => {
    // The whole point of the rewrite. `findLiveSession` returns null for a
    // revoked, expired or over-the-ceiling session.
    findLiveSession.mockResolvedValue(null);
    const c = call({ cookie: "revocado" });
    await authenticate(c.req, c.res, c.next);

    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });

  it("turns away someone whose account was archived since they logged in", async () => {
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    findByPk.mockResolvedValue(null);
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
  });

  it("does not write last_used_at on every single request", async () => {
    // One report export makes around two thousand sequential requests. Writing
    // on each one is two thousand UPDATEs on one row.
    findLiveSession.mockResolvedValue({ id: "s1", id_usuario: 7, expires_at: new Date(Date.now() + 1e6), last_used_at: new Date() });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(touchSession).not.toHaveBeenCalled();
  });

  it("does write it once the throttle has passed", async () => {
    findLiveSession.mockResolvedValue({
      id: "s1", id_usuario: 7,
      expires_at: new Date(Date.now() + 1e6),
      last_used_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const c = call({ cookie: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(touchSession).toHaveBeenCalledWith("s1", expect.any(Date));
  });

  it("never consults the old bearer path when a cookie is present", async () => {
    findLiveSession.mockResolvedValue(null);
    const c = call({ cookie: "malo", bearer: "un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    // A cookie that fails is a failure. Falling back would let anyone who can
    // forge a JWT bypass revocation by also sending a broken cookie.
    expect(jwtVerify).not.toHaveBeenCalled();
    expect(c.status).toBe(401);
  });
});

describe("with the old bearer token, during the transition", () => {
  it("still lets it through", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    const c = call({ bearer: "un.jwt.valido" });
    await authenticate(c.req, c.res, c.next);

    expect(c.next).toHaveBeenCalled();
    expect(c.req.user).toMatchObject({ id: 7 });
  });

  it("leaves id_sesion empty, because there is no row for it", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown, u: unknown) => void) => cb(null, { id: 7, id_rol: 1 }));
    const c = call({ bearer: "t" });
    await authenticate(c.req, c.res, c.next);
    expect(c.req.user?.id_sesion).toBeUndefined();
  });

  it("rejects an invalid one", async () => {
    jwtVerify.mockImplementation((_t: unknown, _s: unknown, cb: (e: unknown) => void) => cb(new Error("bad")));
    const c = call({ bearer: "malo" });
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
  });
});

describe("with nothing at all", () => {
  it("is 401, not 403", async () => {
    // The client uses the difference to decide whether to end the session. A
    // 403 over one resource must not throw somebody out of the application.
    const c = call();
    await authenticate(c.req, c.res, c.next);
    expect(c.status).toBe(401);
    expect(c.next).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Ejecutar y comprobar que falla**

```bash
cd api && npx vitest run src/middleware/authenticate.test.ts
```

- [ ] **Step 4: Escribir el middleware**

Crear `src/middleware/authenticate.ts`:

```ts
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { UsuarioModel } from "../models/usuario.model.js";
import { findLiveSession, touchSession } from "../auth/sessionStore.js";
import { readSessionCookie } from "../auth/sessionCookie.js";
import { SESSION_TOUCH_THROTTLE_MINUTES } from "../config/security.js";
import { log } from "../utils/logger.js";

const authLog = log("auth");
const SESION_EXPIRADA = "Su sesión expiró. Vuelva a iniciar sesión.";
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";

/**
 * Who the caller is, from either credential.
 *
 * Two paths on purpose, and only for as long as the transition lasts. The
 * backend deploys on one platform and the frontend on another, so they cannot
 * change at the same instant: without a period where both credentials work,
 * there is a window in which one side is new and the other old and nobody can
 * get in at all.
 *
 * The cookie is checked first and **there is no falling back from it**. A
 * cookie that fails is a failure, not an invitation to try the other door —
 * otherwise anyone who could forge a bearer token would bypass revocation by
 * sending a broken cookie alongside it.
 *
 * The bearer path logs every use, so the day it is retired the decision rests
 * on a number instead of a guess.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookieToken = readSessionCookie(req);
  if (cookieToken) {
    await authenticateBySession(cookieToken, req, res, next);
    return;
  }

  const authHeader = req.headers["authorization"];
  const bearer = authHeader && authHeader.split(" ")[1];
  if (bearer) {
    authenticateByLegacyToken(bearer, req, res, next);
    return;
  }

  // 401, not 403: unauthenticated, not forbidden. The client uses the
  // difference to decide whether to end the session, and a 403 over a single
  // resource must not throw somebody out of the application.
  res.status(401).json({ message: SESION_EXPIRADA });
}

async function authenticateBySession(
  token: string,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let sesion: Awaited<ReturnType<typeof findLiveSession>>;
  try {
    sesion = await findLiveSession(token);
  } catch (err) {
    authLog.warn({ err }, "no se pudo comprobar la sesión");
    res.sendStatus(500);
    return;
  }

  if (!sesion) {
    res.status(401).json({ message: SESION_EXPIRADA });
    return;
  }

  const usuario = await currentUser(sesion.id_usuario);
  if (!usuario) {
    res.status(401).json({ message: CUENTA_INACTIVA });
    return;
  }

  // `last_used_at` is throttled. Writing it on every request turns every read
  // into a write, and one report export makes around two thousand sequential
  // requests: that would be two thousand UPDATEs and two thousand dead tuples
  // on a single row.
  const staleAfterMs = SESSION_TOUCH_THROTTLE_MINUTES * 60_000;
  const now = new Date();
  if (now.getTime() - new Date(sesion.last_used_at).getTime() > staleAfterMs) {
    touchSession(sesion.id, now).catch((err) =>
      authLog.warn({ err }, "no se pudo actualizar el último uso de la sesión"),
    );
  }

  req.user = { id: usuario.id, id_rol: usuario.id_rol, id_sesion: sesion.id };
  next();
}

/**
 * The old path: a signed token with no row behind it.
 *
 * Kept only until the frontend stops sending it, and logged every time so that
 * retiring it is a measurement rather than a bet. Note what it cannot do: a
 * token on this path cannot be revoked, which is the entire defect this plan
 * exists to fix. Every request through here is the old hole, still open.
 */
function authenticateByLegacyToken(
  token: string,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  jwt.verify(token, process.env.JWT_SECRET as string, async (err, payload) => {
    if (err) {
      res.status(401).json({ message: SESION_EXPIRADA });
      return;
    }
    const claims = payload as { id: number };
    const usuario = await currentUser(claims.id);
    if (!usuario) {
      res.status(401).json({ message: CUENTA_INACTIVA });
      return;
    }
    authLog.info({ id_usuario: usuario.id, ruta: req.originalUrl }, "petición autenticada con el token antiguo");
    req.user = { id: usuario.id, id_rol: usuario.id_rol };
    next();
  });
}

/**
 * The user this request belongs to, as they are right now.
 *
 * The role comes from the database and not from the credential: under the old
 * token, somebody moved to another role kept the old one — and the old buttons
 * with it — for up to a week. `findByPk` is paranoid, so an archived account
 * returns nothing and the session ends here.
 */
async function currentUser(id: number): Promise<{ id: number; id_rol: number } | null> {
  const found = await UsuarioModel.findByPk(id, { attributes: ["id", "id_rol"] });
  if (!found) return null;
  return { id: found.dataValues.id as number, id_rol: found.dataValues.id_rol as number };
}
```

- [ ] **Step 5: Sustituirlo en `app.ts`**

Borrar la función `authenticateToken` local y su import de `jwt`, y sustituir las veinte referencias por `authenticate`. **Ojo:** `src/routes/routeGuards.test.ts` comprueba que toda ruta que escribe lleva el middleware, y lo hace **por el nombre de la función**. Ese test se va a romper: actualízalo al nombre nuevo.

Con la cabecera `x-new-token` desaparece también su entrada en la lista de redacción del logger (`src/utils/logger.ts`) y su test. **No la borres**: el frontend viejo todavía la espera durante la transición, y el login viejo la sigue emitiendo. Se retira en el Plan 2C.

- [ ] **Step 6: Romper a propósito y verificar**

Comprueba que los tests cazan: quitar la comprobación de `!usuario`; devolver `next()` cuando `findLiveSession` da null; caer al bearer cuando la cookie falla.

```bash
cd api && npm run typecheck && npm run lint && npm test
```

Commit.

---

## Task 6: Los endpoints de sesión

**Files:**
- Create: `src/controllers/auth.controller.ts`
- Create: `src/controllers/auth.controller.test.ts`
- Create: `src/routes/auth.routes.ts`
- Modify: `src/app.ts`
- Modify: `src/controllers/login.controller.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: las rutas de `/api/auth`.

- [ ] **Step 1: Los endpoints, con su contrato**

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/auth/login` | Usuario y contraseña. Crea sesión, pone la cookie, devuelve usuario y permisos. **Sin token en el cuerpo.** |
| `GET` | `/api/auth/me` | Quién soy, mi rol y mis permisos, leídos de la base. |
| `POST` | `/api/auth/logout` | Revoca **esta** sesión y borra la cookie. |
| `POST` | `/api/auth/logout-all` | Revoca todas las mías. |
| `GET` | `/api/auth/sessions` | Mis sesiones vivas: navegador, IP, cuándo se usó. |
| `DELETE` | `/api/auth/sessions/:id` | Cierra una. **Solo filas propias.** |

**El detalle que no se puede olvidar en el `DELETE`:** filtrar por `id_usuario` del que llama, no solo por el `id` de la ruta. Este repositorio ya tuvo un IDOR —cualquier usuario autenticado podía hacerse administrador— y una ruta `DELETE /:id` sin ese filtro es exactamente la misma forma. **Ponle test** con la sesión de otra persona.

- [ ] **Step 2: `POST /api/auth/login` reutiliza lo que ya existe**

El login nuevo **no reimplementa** la validación: `loginUsuario` en `src/controllers/login.controller.ts` ya tiene el mensaje único, el hash de relleno, el bloqueo por cuenta con contador atómico, el rehash de coste y la normalización de mayúsculas. Todo eso es de las siete tareas del Plan 1 y **no se duplica**.

Extrae de `loginUsuario` la parte que valida credenciales a una función que devuelva o el usuario o el motivo del fallo, y haz que **los dos** endpoints la usen. Si copias la lógica, las dos copias divergirán y una de ellas se quedará sin el bloqueo por cuenta.

- [ ] **Step 3: El login viejo también pone la cookie**

En `loginUsuario`, tras validar bien: crear sesión y poner la cookie **además** de devolver el JWT.

Es lo que hace la transición gradual en vez de un salto: cada persona que entre por el frontend viejo queda migrada sin notarlo, y cuando el frontend nuevo llegue ya tiene sesión. El día del Plan 2C, el contador del camino viejo debería estar cerca de cero por sí solo.

- [ ] **Step 4: Cambiar la contraseña y archivar revocan las sesiones**

En `src/controllers/usuario.controller.ts`:
- `updateUserPass` llama a `revokeAllSessionsOf(id)`. Hoy `pass_changed_at` existe pero **nada lo usa para cortar sesiones**: cambiar la contraseña no echaba a nadie.
- `deleteUsuario` (archivar) llama a `revokeAllSessionsOf(id)` **en la misma transacción**. El `ON DELETE RESTRICT` no ayuda aquí: el borrado es lógico, la fila no se borra, y ninguna cascada se dispara nunca.

Y un detalle: quien cambia **su propia** contraseña no debe quedar fuera de la sesión desde la que la cambió. Revoca todas menos la actual, usando `req.user.id_sesion` — y si es `undefined`, porque venía por el camino viejo, revócalas todas y que vuelva a entrar. Ponle test a las dos ramas.

- [ ] **Step 5: Tests, romper a propósito, verificar**

Cubre al menos: que el login nuevo no devuelve token en el cuerpo; que `logout` revoca *esta* sesión y no otras; que `DELETE /sessions/:id` con la sesión de otro responde 404 y no la toca; que cambiar la contraseña revoca las demás y conserva la actual; que archivar revoca todas.

Rompe a propósito: quita el filtro por `id_usuario` del `DELETE`; haz que `logout` revoque todas; quita la revocación del cambio de contraseña.

```bash
cd api && npm run typecheck && npm run lint && npm test
```

Commit.

---

## Task 7: CSRF

Con la cookie, el navegador manda la credencial sola. Eso es lo que hace posible el CSRF, y es un ataque que con `Authorization: Bearer` no existía.

**Files:**
- Create: `src/middleware/csrf.ts`
- Create: `src/middleware/csrf.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `requireSameOrigin: RequestHandler`

- [ ] **Step 1: El diseño, y por qué son dos comprobaciones y no una**

Dos barreras, y **ninguna se presenta como redundante de la otra**:

1. **`Origin` contra una lista de orígenes exactos**, comprobado en el servidor. No depende de que el navegador se porte bien.
2. **Una cabecera propia** (`X-Osefi-Client`) en toda escritura. Una cabecera no estándar obliga al navegador a pedir permiso con un preflight, y el CORS solo autoriza el origen del frontend.

`SameSite=Lax` **no** cuenta como tercera barrera frente a un subdominio, porque un subdominio **es** same-site. Contra `evil.osefi.net` las únicas que quedan son estas dos.

**La regla que hace posible la coexistencia:** la comprobación se aplica **solo a las peticiones autenticadas por cookie**. Una petición con `Authorization: Bearer` no la necesita, porque un navegador nunca manda ese encabezado por su cuenta: sin envío automático no hay CSRF. Si se exigiera a todas, el frontend actual —que no manda la cabecera propia— dejaría de funcionar entero.

- [ ] **Step 2: Escribir el test, el módulo y montarlo**

Cubre: que una escritura con cookie y sin cabecera propia se rechaza con 403; que la misma con `Bearer` pasa; que un `Origin` de otro host se rechaza aunque traiga la cabecera; que un `GET` no se toca; que una petición sin `Origin` (que no es un navegador) con `Bearer` pasa.

Rompe a propósito: acepta cualquier `Origin`; exige la cabecera también en el camino Bearer (debe romper un test que fije la coexistencia).

```bash
cd api && npm run typecheck && npm run lint && npm test
```

Commit.

---

## Task 8: La purga, y el cierre del plan

**Files:**
- Modify: `src/index.ts`
- Create: `src/auth/purgeJob.test.ts`

- [ ] **Step 1: Arrancar la purga**

En `main()`, tras `sequelize.authenticate()` y antes del `listen`: una primera pasada y luego un intervalo diario. Con `.catch` en el sitio de la llamada — en este proceso, una promesa rechazada sin handler llega al `unhandledRejection` que **mata el proceso**, y una purga que falla no debe tumbar el ERP. Y con `unref()` en el intervalo, para que no impida que el proceso termine.

- [ ] **Step 2: Verificación final del plan**

1. `npm run typecheck && npm run lint && npm test`, los tres en verde. Pega el recuento.
2. Levanta el servidor y comprueba con `curl -i` el ciclo completo: `POST /api/auth/login` devuelve `Set-Cookie` con `HttpOnly`, `SameSite=Lax` y `Path=/`, y **sin token en el cuerpo**; una petición con esa cookie a `/api/auth/me` responde 200; `POST /api/auth/logout` y la misma petición responde 401.
3. **La prueba que de verdad importa:** entra, llama a `logout-all`, y comprueba que la cookie ya no vale. Eso es lo que el JWT no podía hacer y es la razón de todo el plan. Pégalo en el informe.
4. Comprueba que **el camino viejo sigue funcionando**: una petición con `Authorization: Bearer <jwt>` a una ruta protegida responde 200, y aparece la línea de log del token antiguo.
5. `npm run migrate` contra la copia local, y comprueba la tabla.

---

## Cobertura contra el spec

| Requisito | Tarea |
|---|---|
| Tabla `sesion` con sus índices y `ON DELETE RESTRICT` (§3) | 1 |
| Token opaco de 32 bytes, guardado en SHA-256 (§3) | 2 |
| Siete días de inactividad, tope absoluto de treinta (§3) | 3 |
| `last_used_at` escrito como mucho cada cinco minutos (§3) | 3 |
| Cookie host-only con prefijo `__Host-` (§2) | 4 |
| `authenticateToken` con `deletedAt IS NULL` y rol de la base (§3) | 5 |
| Endpoints de sesión, con `DELETE` solo sobre filas propias (§5) | 6 |
| Cambiar la contraseña revoca las demás y conserva la actual (§5) | 6 |
| Archivar un usuario revoca sus sesiones (§3) | 6 |
| CSRF con `Origin` y cabecera propia (§7) | 7 |
| Purga de lo caducado (§3) | 8 |
| **Estados de sesión, `mfa_satisfied_at`, step-up** | **Plan 4** — no hay MFA todavía |
| **Retirar el JWT** | **Plan 2C** |

## Riesgos

**El agujero sigue abierto mientras dure la coexistencia.** Un JWT vivo no se puede revocar, y este plan lo mantiene válido a propósito. Lo que se gana es que ningún despliegue puede dejar a la empresa fuera; lo que se paga es que la revocación no es real hasta el Plan 2C. **El contador del camino viejo es lo que dice cuándo se puede cerrar.**

**Una petición del camino viejo no tiene `id_sesion`.** Los endpoints que la necesitan responden 400 pidiendo volver a entrar. Es correcto y transitorio, pero durante la transición alguien puede encontrarse con que "cerrar esta sesión" no funciona hasta que vuelva a entrar.

**El `DELETE /sessions/:id` es la superficie de IDOR de este plan.** Este repositorio ya tuvo uno que permitía a cualquier autenticado hacerse administrador. El filtro por `id_usuario` no es una comprobación de más.

**La cookie viaja en cada imagen.** `express.static` está montado en la raíz, antes de autenticar, y el frontend construye `<img src>` contra el origen de la API desde veinte sitios. Con la cookie host-only esas peticiones la llevarán. No rompe nada —`express.static` la ignora— pero multiplica la superficie por la que la credencial viaja, y el logger ya redacta la cabecera `cookie`.
