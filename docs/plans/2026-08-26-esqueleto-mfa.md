# Plan 4A — El esqueleto del segundo factor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** poner en pie el esquema, los estados de sesión y la puerta de step-up sobre
los que se enchufan los factores, sin construir todavía ningún factor.

**Architecture:** dos migraciones (columnas nuevas en `usuarios` y `sesiones`, y cuatro
tablas para los factores), cuatro modelos, un `authenticate` que además del *quién* mira
el *hasta dónde*, y un middleware `requireStepUp` montado sobre las rutas sensibles. Al
terminar el 4A un usuario normal ve el ERP exactamente igual que hoy: las tablas de
factores están vacías, nadie tiene factor, todo el mundo entra en gracia. Lo que cambia
es que la maquinaria existe y los planes 4B y 4C solo tienen que insertar filas.

**Tech Stack:** TypeScript, Express 4, Sequelize 6 con Umzug, Postgres, Vitest.
Ninguna dependencia nueva — las de WebAuthn y TOTP entran en el 4B y el 4C.

**Spec:** [`docs/specs/2026-08-21-autenticacion-mfa-design.md`](../specs/2026-08-21-autenticacion-mfa-design.md)
— §3 (esquema), §4 (flujo de entrada, los tres estados, la gracia, step-up) y §5
(endpoints, dónde se monta `requireStepUp`).

---

## Lo que el 4A NO hace

Escrito primero porque un plan se lee para saber qué falta, y estas cuatro cosas van a
parecer omisiones:

- **Ningún factor.** Ni TOTP, ni passkeys, ni códigos de recuperación. Las tablas se
  crean vacías y las consultas que las leen son reales; simplemente devuelven cero.
- **Ningún endpoint nuevo.** `/auth/totp/*`, `/auth/webauthn/*`, `/auth/mfa/verify` y
  `/auth/recovery-codes` son del 4B y el 4C.
- **Nada del frontend.** El 4D.
- **El almacén del reto de WebAuthn.** La especificación (§3) lo pone en la fila de
  sesión y para eso haría falta que `sesiones.id_usuario` aceptara NULL en el login sin
  contraseña. **Se aplaza al 4C a propósito**, y el motivo está abajo.

---

## Global Constraints

Copiadas literalmente de la especificación y del código que ya existe. Vinculan a todas
las tareas.

- **Rama `isaias`.** Nunca `main` ni `development`.
- **Un commit por tarea**, con mensaje semántico —nunca «tarea N»— y ninguna tarea
  repartida entre dos commits. La norma de la casa es un commit por arco, pero un arco de
  diez tareas revisadas una a una necesita un rango que empaquetar para cada revisión, y
  el Plan 3 acabó igual: siete commits semánticos. Los ficheros se añaden **por nombre**,
  nunca `git add -A` —hay otra sesión trabajando en el mismo árbol—, y nunca
  `git commit --amend`.
- **Toda migración va dentro de una transacción y abre con
  `SET LOCAL lock_timeout = '5s'`.** Es la norma de la casa: una consulta larga que
  retiene un bloqueo tiene que hacer fallar la migración rápido, no encolar detrás de
  ella todo lo que toque `usuarios`.
- **Toda clave foránea nueva hacia `usuarios` es `ON DELETE RESTRICT` / `ON UPDATE
  CASCADE`**, igual que las añadidas desde `20260804000001`. El borrado de usuarios es
  lógico (`paranoid`), así que ninguna cascada se dispara nunca y una cascada escrita da
  falsa sensación de limpieza.
- **Nombre de tabla explícito en todo modelo nuevo.** La pluralización por defecto de
  Sequelize ya produjo `ciudads`, `rols` y `revicions` en este esquema.
- **Los tests se rompen antes de darse por buenos.** Cada test nuevo se ejecuta contra el
  código roto a propósito y se comprueba que falla, y solo entonces se arregla el código.
  Un test que nunca se vio en rojo no ha demostrado nada. **Y al cambiar *cómo* se calcula
  algo, se reejecuta la rotura que lo cubría**: cinco veces en este plan una optimización o
  un arreglo ha borrado en silencio la capacidad de fallar de un test que estaba bien.
- 🔴 **La comprobación de tipos es `npm run typecheck`, nunca `npx tsc --noEmit`.** El
  script del proyecto pasa `tsc` por `tsconfig.json` **y** por `tsconfig.test.json`; el
  comando suelto solo mira el primero. Durante seis tareas todo el mundo ejecutó el
  comando suelto e informó «tipos limpios» de forma veraz e incompleta, mientras la Tarea 5
  —al hacer obligatorios `estado` y `mfa_satisfied_at` en `req.user`— dejaba 57 errores
  `TS2739` en los fixtures de sesión de cinco ficheros de test. Ninguna tarea se da por
  cerrada sin que ese script salga limpio de lo que esa tarea haya tocado.
- **Nada de `error.message` en respuestas nuevas.** Es deuda declarada de la
  especificación (§11); no se amplía.
- **Código, comentarios y mensajes de commit en inglés.** Los mensajes dirigidos al
  usuario final, en español, que es lo que hace el resto de la API.
- **`TIMESTAMPTZ`, nunca `TIMESTAMP`.** Todo el esquema lleva zona horaria; una columna
  ingenua contra un servidor en UTC y un cliente en Madrid difiere en una o dos horas
  según el mes, y en una fecha de caducidad eso es una sesión que muere antes o vive
  después de lo que dice.

---

## Decisiones tomadas al escribir el plan

Las tres se apartan de la letra de la especificación o rellenan un hueco que deja. Van
aquí y no enterradas en una tarea porque quien ejecute el plan tiene que poder discutirlas.

### 1. El reto de WebAuthn se aplaza al 4C, y `sesiones.id_usuario` sigue NOT NULL

La especificación guarda el reto en la fila de sesión, y para el login con passkey —donde
todavía no se sabe quién llama— manda crear «una fila `estado = parcial` sin
`id_usuario`». Eso obliga a que `sesiones.id_usuario` acepte NULL.

**No se hace en el 4A.** `id_usuario NOT NULL` es una invariante de la que cuelga todo:
`findLiveSession`, `revokeAllSessionsOf`, `listSessionsOf`, la purga y el propio
`authenticate`. Hacerla nullable añade a cada una de esas consultas una condición que
—como advierte la propia especificación sobre `deletedAt`— **no viene sola**: una fila sin
dueño que llegue a `authenticate` autenticaría a nadie, y «a nadie» en JavaScript se
parece demasiado a «a alguien» si la comprobación se olvida.

Y sobre todo: es una decisión de **ceremonia**, y la ceremonia se diseña en el 4C. Tomarla
ahora es decidir en el vacío sobre la mecánica de un flujo que aún no está escrito. Si el
4C concluye que el reto anónimo va mejor en su propia tabla de un solo uso, el 4A no habrá
dejado dos columnas muertas en `sesiones` ni una clave foránea debilitada que haya que
volver a apretar.

Las columnas `webauthn_challenge` y `challenge_expires_at` **no se crean aquí**.

### 2. `pass_changed_at` se rellena con la fecha de alta, no con `now()`

La especificación la quiere `NOT NULL DEFAULT now()` y explica bien por qué no puede ser
nullable. Lo que no dice es con qué se rellenan las filas que ya existen.

Con `now()`, el instante de la migración queda por delante de la fecha de creación de
**todas** las sesiones vivas, y la condición `s.created_at >= u.pass_changed_at` que la
Tarea 8 mete en `authenticate` las mata a todas: todo el mundo fuera, a la vez, el día del
despliegue. Hoy en producción hay cero sesiones y no se notaría, pero el 4A no se despliega
hoy y la migración correrá contra lo que haya entonces.

Se rellena con `usuarios."createdAt"` en la misma migración. Nadie pierde la sesión, y la
columna sigue significando exactamente lo que dice: «desde cuándo vale la contraseña
actual» — que para quien no la ha cambiado nunca es desde que existe la cuenta.

### 3. Durante la gracia, el step-up se satisface reintroduciendo la contraseña

La especificación exige step-up —factor probado hace menos de 10 minutos— para crear
usuarios, tocar roles y editar la matriz de permisos. Y exige reintroducir la contraseña
solo para el caso concreto del **alta del primer factor**.

Entre el despliegue del 4A y el del 4B **no existe ningún factor que probar**. Con la
regla literal, `requireStepUp` no lo satisface nadie y el administrador se queda sin poder
crear un usuario ni tocar un permiso. El ERP se rompe.

Regla del 4A: `requireStepUp` acepta como prueba **o** un `mfa_satisfied_at` de hace menos
de diez minutos, **o** la contraseña actual reintroducida en el cuerpo de la petición,
**pero esto último solo si la cuenta no tiene ningún factor configurado**. En cuanto
alguien registra su primer factor, su contraseña deja de servir para el step-up — y con
ella deja de servir la de un atacante que solo tenga la contraseña.

Lo que cuesta si me equivoco: durante la ventana en que nadie tiene factor, quien conozca
la contraseña de un administrador puede editar la matriz de permisos. Es exactamente lo
que puede hacer hoy sin ningún step-up, así que no se abre nada nuevo; lo que no hace es
cerrarlo antes del 4B. La alternativa —bloquear la administración hasta el 4B— deja el ERP
a medias durante todo el arco.

### 4. La especificación se contradice sobre `onboarding`, y aquí se resuelve

La tabla de §4 dice que en estado `onboarding` el ERP responde **403** a todo. Tres
párrafos más abajo, explicando por qué el email no puede bloquear la entrada, dice que «se
entra en `onboarding` y **se puede trabajar**». No pueden ser las dos.

Se resuelve así, y el desarrollo completo está en la **Tarea 7**:

- **Dentro de la gracia** —con o sin email, con o sin factor— el estado es `completa`. Se
  trabaja. Dar la lata en pantalla es cosa del 4D, no cerrar la puerta.
- **Pasada la gracia sin ningún factor**, `onboarding`: se entra siempre, pero el ERP
  responde 403 con un mensaje que dice qué hacer.
- **El email verificado nunca decide el estado.** Cierra operaciones de step-up, que es
  lo que la especificación quería conseguir.

La Tarea 10 lleva esta regla al propio documento de especificación, porque una
contradicción resuelta solo en el plan la vuelve a descubrir el siguiente que lea la
especificación sola.

---

## File Structure

**Se crean:**

| Fichero | Responsabilidad |
|---|---|
| `src/migrations/20260826000002-add-mfa-columns.ts` | Columnas nuevas en `usuarios` y `sesiones` |
| `src/migrations/20260826000003-create-factor-tables.ts` | Las cuatro tablas de factores |
| `src/models/credencialWebauthn.model.ts` | Passkeys guardadas |
| `src/models/factorTotp.model.ts` | Secreto TOTP cifrado |
| `src/models/codigoRecuperacion.model.ts` | Códigos de un solo uso |
| `src/models/dispositivoRecordado.model.ts` | «No me lo preguntes en este equipo» |
| `src/auth/sessionState.ts` | Los tres estados, la allowlist y qué abre cada uno |
| `src/auth/factorInventory.ts` | Qué factores tiene una cuenta, y si está en gracia |
| `src/middleware/requireStepUp.ts` | La puerta de las operaciones sensibles |

**Se modifican:**

| Fichero | Qué cambia |
|---|---|
| `src/models/usuario.model.ts` | Dos campos nuevos |
| `src/models/sesion.model.ts` | Tres campos nuevos |
| `src/interfaces/index.ts` | `ISesion`, `IUsuario` y las cuatro interfaces nuevas |
| `src/auth/sessionStore.ts` | `createSession` recibe estado; `findLiveSession` lo devuelve |
| `src/auth/issueSession.ts` | Pasa el estado al crear |
| `src/middleware/authenticate.ts` | Mira el estado y `pass_changed_at`; amplía `req.user` |
| `src/app.ts` | La declaración global de `Request` |
| `src/config/security.ts` | Constantes del step-up y de la gracia |
| `src/controllers/auth.controller.ts` | El login fija la gracia y elige estado |
| `src/controllers/password.controller.ts` | El reset escribe `pass_changed_at` |
| `src/controllers/usuario.controller.ts` | Cambio de contraseña escribe `pass_changed_at`; archivar revoca dispositivos |
| `src/routes/usuario.routes.ts`, `rol.routes.ts`, `permiso.routes.ts` | Montaje de `requireStepUp` |
| `src/auth/purgeJob.ts` | Purga las tablas nuevas |
| `src/routes/routeGuards.test.ts` | La lista de guardas conoce `requireStepUp` |

---

## Task 1: La migración de columnas

Dos columnas en `usuarios` y tres en `sesiones`. Es la única tarea del plan que toca
tablas con datos dentro, así que va sola.

**Files:**
- Create: `src/migrations/20260826000002-add-mfa-columns.ts`
- Test: `src/migrations/20260826000002-add-mfa-columns.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: las columnas `usuarios.mfa_grace_until`, `usuarios.pass_changed_at`,
  `sesiones.estado`, `sesiones.mfa_satisfied_at` y `sesiones.mfa_source`. Los valores
  permitidos de `estado` son exactamente `parcial`, `onboarding` y `completa`; los de
  `mfa_source`, `passkey`, `totp`, `codigo` y `dispositivo`.

- [ ] **Step 1: Escribir el test que falla**

Sigue el patrón de `20260826000001-add-rol-archiving.test.ts`, que ya está en el repo:
un `queryInterface` falso que apunta las llamadas.

```ts
// The migration that gives sessions a state and users a grace deadline.
//
// Three things are asserted and each one is a night's work if it goes wrong:
// that every call carries the transaction, that the existing rows are
// back-filled rather than left to the column default, and that the CHECK
// constraints spell the state names the code will compare against.

import { describe, it, expect } from "vitest";
import { up, down } from "./20260826000002-add-mfa-columns.js";

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
    sequelize: {
      query: record("query"),
      literal: (s: string) => ({ val: s }),
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const queriesOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");

describe("add-mfa-columns", () => {
  it("adds the five columns, to the two tables that need them", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const added = qi.calls.filter((c) => c.fn === "addColumn").map((c) => [c.args[0], c.args[1]]);
    expect(added).toEqual([
      ["usuarios", "mfa_grace_until"],
      ["usuarios", "pass_changed_at"],
      ["sesiones", "estado"],
      ["sesiones", "mfa_satisfied_at"],
      ["sesiones", "mfa_source"],
    ]);
  });

  it("carries the transaction on every single call", async () => {
    // A migration that runs half way is the failure that costs a night: five
    // columns added and the back-fill not, or the constraints not, leaves the
    // table in a shape no version of the code expects.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(qi.calls.length).toBeGreaterThan(0);
    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn}(${String(call.args[0])}) sin transacción`).toBeDefined();
    }
  });

  it("takes the lock timeout first, before touching anything", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
  });

  it("back-fills pass_changed_at from the account's own creation date", async () => {
    // Not from now(). The condition `sesion.created_at >= usuario.pass_changed_at`
    // that Task 8 puts inside `authenticate` would then be false for every
    // session alive at deploy time, and everybody would be thrown out at once
    // — for a column that was only ever meant to invalidate sessions older
    // than a password *change*.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    expect(sql).toMatch(/UPDATE\s+usuarios\s+SET\s+pass_changed_at\s*=\s*"createdAt"/i);
  });

  it("spells the three session states exactly as the code will compare them", async () => {
    // A CHECK is worth having only if it names the same strings the
    // application does. `parcial`/`onboarding`/`completa` are compared as
    // literals in `sessionState.ts`; a typo here makes a legitimate login fail
    // at INSERT time with a constraint error nobody will read as "typo".
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    expect(sql).toContain("'parcial'");
    expect(sql).toContain("'onboarding'");
    expect(sql).toContain("'completa'");
  });

  it("constrains mfa_source to the four sources that exist", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = queriesOf(qi);
    for (const source of ["passkey", "totp", "codigo", "dispositivo"]) {
      expect(sql).toContain(`'${source}'`);
    }
  });

  it("gives every existing session the state that keeps it working", async () => {
    // `completa` as the column default is what stops this migration logging
    // out the whole company: the rows that exist were opened before states
    // existed, and they were, in the old sense, complete.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const estado = qi.calls.find((c) => c.fn === "addColumn" && c.args[1] === "estado");
    expect((estado?.args[2] as { defaultValue?: string })?.defaultValue).toBe("completa");
  });

  it("reverses cleanly", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const removed = qi.calls.filter((c) => c.fn === "removeColumn").map((c) => [c.args[0], c.args[1]]);
    expect(removed).toEqual([
      ["sesiones", "mfa_source"],
      ["sesiones", "mfa_satisfied_at"],
      ["sesiones", "estado"],
      ["usuarios", "pass_changed_at"],
      ["usuarios", "mfa_grace_until"],
    ]);
    // The constraints go before the columns they constrain, or the DROP fails.
    const sql = queriesOf(qi);
    expect(sql).toContain("DROP CONSTRAINT");
  });
});
```

- [ ] **Step 2: Ejecutarlo y ver que falla**

Run: `npx vitest run src/migrations/20260826000002-add-mfa-columns.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Escribir la migración**

```ts
import { QueryInterface, DataTypes } from "sequelize";

// Session states, the MFA grace deadline, and the moment each password started
// being the current one.
//
// **`pass_changed_at` is back-filled from `usuarios."createdAt"`, not left at
// its `now()` default.** The default is right for rows created from here on —
// a new account's password is new — but wrong for the rows that already
// exist. `authenticate` gains the condition `sesion.created_at >=
// usuario.pass_changed_at`, and with `now()` in that column every session
// alive on deploy day was created *before* it: the whole company is logged
// out at once, by a column whose only job is to invalidate sessions older
// than a password change that, for these rows, never happened.
//
// **`estado` arrives with a default of `completa`** for the same reason from
// the other side: the sessions that exist were opened when states did not,
// and in the only sense that existed then they were complete. A default of
// `parcial` would have been the same outage wearing a different name.
//
// The CHECK constraints are not decoration. `sessionState.ts` compares these
// strings as literals; a row carrying `completo` or `pasarela` instead would
// fall through every comparison and be treated as the *least* privileged
// state by the allowlist — silently, and only for whoever wrote it.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a lock
    // should make the migration fail fast and get retried, not queue whatever
    // else is touching `usuarios` behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "usuarios",
      "mfa_grace_until",
      {
        // Born NULL and set at the first successful login *after* deploy, not
        // filled in here with "deploy + 14 days". Somebody on holiday would
        // come back on day 30 to a grace period that expired without them
        // seeing a single screen: zero of their fourteen days.
        type: DataTypes.DATE,
        allowNull: true,
      },
      { transaction },
    );

    await queryInterface.addColumn(
      "usuarios",
      "pass_changed_at",
      {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: queryInterface.sequelize.literal("now()"),
      },
      { transaction },
    );

    // Postgres 11+ adds a NOT NULL column with a default without rewriting the
    // table, so this is two fast statements rather than one long lock.
    await queryInterface.sequelize.query(
      'UPDATE usuarios SET pass_changed_at = "createdAt" WHERE "createdAt" IS NOT NULL',
      { transaction },
    );

    await queryInterface.addColumn(
      "sesiones",
      "estado",
      { type: DataTypes.STRING(20), allowNull: false, defaultValue: "completa" },
      { transaction },
    );

    await queryInterface.addColumn(
      "sesiones",
      "mfa_satisfied_at",
      {
        // Written **only** by a live proof of a factor. A login that came in
        // on a remembered device leaves this NULL on purpose: if it were
        // stamped, every remembered login would open ten minutes of
        // already-satisfied step-up, and stealing that cookie plus the
        // password would be enough to edit the permission matrix without
        // touching a single factor.
        type: DataTypes.DATE,
        allowNull: true,
      },
      { transaction },
    );

    await queryInterface.addColumn(
      "sesiones",
      "mfa_source",
      { type: DataTypes.STRING(20), allowNull: true },
      { transaction },
    );

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ADD CONSTRAINT sesiones_estado_chk " +
        "CHECK (estado IN ('parcial', 'onboarding', 'completa'))",
      { transaction },
    );

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ADD CONSTRAINT sesiones_mfa_source_chk " +
        "CHECK (mfa_source IS NULL OR mfa_source IN ('passkey', 'totp', 'codigo', 'dispositivo'))",
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    // Constraints first: dropping a column a CHECK still references fails.
    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_mfa_source_chk",
      { transaction },
    );
    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_estado_chk",
      { transaction },
    );

    await queryInterface.removeColumn("sesiones", "mfa_source", { transaction });
    await queryInterface.removeColumn("sesiones", "mfa_satisfied_at", { transaction });
    await queryInterface.removeColumn("sesiones", "estado", { transaction });
    await queryInterface.removeColumn("usuarios", "pass_changed_at", { transaction });
    await queryInterface.removeColumn("usuarios", "mfa_grace_until", { transaction });
  });
}
```

- [ ] **Step 4: Ejecutar el test y verlo pasar**

Run: `npx vitest run src/migrations/20260826000002-add-mfa-columns.test.ts`
Expected: PASS, ocho tests.

- [ ] **Step 5: Romper el back-fill a propósito y ver el test en rojo**

Cambia `"createdAt"` por `now()` en la sentencia `UPDATE` y vuelve a ejecutar. El test
*"back-fills pass_changed_at from the account's own creation date"* tiene que fallar.
Deshaz el cambio.

- [ ] **Step 6: No ejecutar la migración todavía**

`npm run migrate` **no** se ejecuta en esta tarea. La base de datos se migra una sola vez,
al final del plan, con las dos migraciones juntas. Anótalo en el informe.

---

## Task 2: La migración de las cuatro tablas

Passkeys, TOTP, códigos de recuperación y dispositivos recordados. Tablas nuevas, vacías,
sin nadie que las lea todavía.

**Files:**
- Create: `src/migrations/20260826000003-create-factor-tables.ts`
- Test: `src/migrations/20260826000003-create-factor-tables.test.ts`

**Interfaces:**
- Consumes: nada de la Tarea 1 — son tablas independientes.
- Produces: las tablas `credencial_webauthn`, `factor_totp`, `codigo_recuperacion` y
  `dispositivo_recordado`, con los nombres de columna que usan los modelos de la Tarea 3.

- [ ] **Step 1: Escribir el test que falla**

```ts
// The four tables the factors live in. Created empty: nothing reads them until
// plans 4B and 4C.
//
// What is asserted here is the shape that later plans cannot fix cheaply — a
// missing UNIQUE on `credential_id` is an authentication bypass, and a
// `factor_totp` row without its IV and auth tag is a secret that can never be
// decrypted again.

import { describe, it, expect } from "vitest";
import { up, down } from "./20260826000003-create-factor-tables.js";

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

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const tableOf = (qi: ReturnType<typeof fakeQueryInterface>, name: string) =>
  qi.calls.find((c) => c.fn === "createTable" && c.args[0] === name)?.args[1] as
    | Record<string, { allowNull?: boolean; unique?: boolean; references?: unknown; onDelete?: string }>
    | undefined;

describe("create-factor-tables", () => {
  it("creates the four tables, under the names the spec gives them", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const created = qi.calls.filter((c) => c.fn === "createTable").map((c) => c.args[0]);
    expect(created).toEqual([
      "credencial_webauthn",
      "factor_totp",
      "codigo_recuperacion",
      "dispositivo_recordado",
    ]);
  });

  it("carries the transaction on every single call", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    for (const call of qi.calls) {
      expect(transactionOf(call), `${call.fn}(${String(call.args[0])}) sin transacción`).toBeDefined();
    }
  });

  it("makes credential_id unique, which is the whole of the lookup's safety", async () => {
    // A passkey assertion names its credential. If two rows could carry the
    // same id, the lookup picks one of them and the public key it verifies
    // against may not be the one that signed — and, worse, may belong to a
    // different account.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(tableOf(qi, "credencial_webauthn")?.credential_id?.unique).toBe(true);
  });

  it("stores the TOTP nonce and auth tag beside the ciphertext", async () => {
    // Without both, the secret is unrecoverable from the first minute: AES-GCM
    // cannot decrypt without its IV, and cannot be trusted without its tag.
    const totp = tableOf(await withUp(), "factor_totp");
    expect(totp?.secreto_cifrado?.allowNull).toBe(false);
    expect(totp?.iv?.allowNull).toBe(false);
    expect(totp?.auth_tag?.allowNull).toBe(false);
    expect(totp?.key_version?.allowNull).toBe(false);
  });

  it("pins the IV to 12 bytes and the tag to 16", async () => {
    // BYTEA has no length in Postgres, so the only place this can be enforced
    // is a CHECK. A 16-byte IV silently changes the GCM construction, and a
    // truncated tag weakens the authentication it exists to provide.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const sql = qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0])).join("\n");
    expect(sql).toMatch(/octet_length\(iv\)\s*=\s*12/);
    expect(sql).toMatch(/octet_length\(auth_tag\)\s*=\s*16/);
  });

  it("allows one TOTP factor per account and no more", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(tableOf(qi, "factor_totp")?.id_usuario?.unique).toBe(true);
  });

  it("ties every table to usuarios with RESTRICT, never CASCADE", async () => {
    // The delete here is logical (`paranoid`), so no cascade ever fires. A
    // CASCADE written anyway reads as cleanup that happens and does not.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    for (const name of [
      "credencial_webauthn",
      "factor_totp",
      "codigo_recuperacion",
      "dispositivo_recordado",
    ]) {
      const col = tableOf(qi, name)?.id_usuario;
      expect(col?.allowNull, `${name}.id_usuario`).toBe(false);
      expect(col?.references, `${name}.id_usuario`).toBeDefined();
      expect(col?.onDelete, `${name}.id_usuario`).toBe("RESTRICT");
    }
  });

  it("indexes what the queries actually filter by", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const indexed = qi.calls
      .filter((c) => c.fn === "addIndex")
      .map((c) => [c.args[0], (c.args[1] as { fields: string[] }).fields.join(",")]);
    expect(indexed).toEqual(
      expect.arrayContaining([
        ["credencial_webauthn", "id_usuario"],
        ["codigo_recuperacion", "id_usuario"],
        ["dispositivo_recordado", "id_usuario"],
        ["dispositivo_recordado", "expires_at"],
      ]),
    );
  });

  it("drops the tables in reverse order", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    const dropped = qi.calls.filter((c) => c.fn === "dropTable").map((c) => c.args[0]);
    expect(dropped).toEqual([
      "dispositivo_recordado",
      "codigo_recuperacion",
      "factor_totp",
      "credencial_webauthn",
    ]);
  });
});

async function withUp() {
  const qi = fakeQueryInterface();
  await up({ context: qi as never });
  return qi;
}
```

- [ ] **Step 2: Ejecutarlo y ver que falla**

Run: `npx vitest run src/migrations/20260826000003-create-factor-tables.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Escribir la migración**

```ts
import { QueryInterface, DataTypes } from "sequelize";

// The four tables the second factor lives in. Created empty; nothing reads
// them until plans 4B and 4C.
//
// Table names are set explicitly, same reason as `sesiones` and
// `token_uso_unico`: Sequelize's default pluralisation has already produced
// `ciudads`, `rols` and `revicions` in this schema.
//
// Every foreign key is RESTRICT. `usuarios` is `paranoid: true`, so the row is
// never really deleted and no cascade ever fires — a CASCADE written here
// would read as cleanup that happens and does not. What actually has to
// revoke a user's factors when they are archived is `deleteUsuario`, in code,
// inside the same transaction (Task 9).

/** Shared by the four tables: the owner column, spelled once. */
const OWNER = {
  type: DataTypes.INTEGER,
  allowNull: false,
  references: { model: "usuarios", key: "id" },
  onUpdate: "CASCADE",
  onDelete: "RESTRICT",
} as const;

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      "credencial_webauthn",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_usuario: { ...OWNER },
        // base64url, and unique across the whole table rather than per user: an
        // assertion arrives naming only its credential, so the lookup has no
        // user to scope by. Two rows sharing an id would let the server verify
        // a signature against a key that did not produce it — possibly one
        // belonging to another account.
        credential_id: { type: DataTypes.TEXT, allowNull: false, unique: true },
        public_key: { type: DataTypes.BLOB, allowNull: false },
        // BIGINT because the spec's counter rule compares it, and some
        // authenticators count into the millions over a device's life.
        counter: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        transports: { type: DataTypes.STRING(255), allowNull: true },
        // The person writes this: "mi móvil", "PC oficina". It is what makes
        // the list on the profile screen mean anything, and what makes an
        // unexpected passkey recognisable as unexpected.
        nombre: { type: DataTypes.STRING(100), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false },
        last_used_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );

    await queryInterface.createTable(
      "factor_totp",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        // Unique: one TOTP factor per account. Two rows would mean two secrets
        // that both open the door, and a "remove my TOTP" that removes one of
        // them.
        id_usuario: { ...OWNER, unique: true },
        secreto_cifrado: { type: DataTypes.BLOB, allowNull: false },
        // Both NOT NULL, and both useless as an afterthought: AES-256-GCM
        // cannot decrypt without the nonce, and cannot be trusted without the
        // tag. A row missing either is a secret nobody can ever recover.
        iv: { type: DataTypes.BLOB, allowNull: false },
        auth_tag: { type: DataTypes.BLOB, allowNull: false },
        // Without this, rotating MFA_ENCRYPTION_KEY is impossible to do
        // halfway: there is no way to tell which rows were re-encrypted.
        key_version: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
        // Anti-replay: the last accepted time step. A code stays valid for its
        // whole window, so without this the same six digits work twice.
        ultimo_paso: { type: DataTypes.BIGINT, allowNull: true },
        // NULL until the person has typed a code back. An unconfirmed factor
        // must not satisfy anything: it is a secret they may never have
        // managed to scan.
        confirmed_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );

    await queryInterface.createTable(
      "codigo_recuperacion",
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_usuario: { ...OWNER },
        // bcrypt, not SHA-256 — the opposite choice from `sesiones.token_hash`,
        // and deliberately. A session token is 32 random bytes; there is no
        // entropy to reinforce and the comparison runs on every request. A
        // recovery code is short enough to be written on paper, so a fast hash
        // plus a stolen database dump is an offline break in hours.
        codigo_hash: { type: DataTypes.STRING(60), allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
      },
      { transaction },
    );

    await queryInterface.createTable(
      "dispositivo_recordado",
      {
        id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        // NOT NULL, and this is the security property of the table. With the
        // check done on the hash alone, ticking "remember me" on your own
        // account and carrying that cookie to the administrator's login would
        // skip *their* second factor.
        id_usuario: { ...OWNER },
        token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
        user_agent: { type: DataTypes.STRING(255), allowNull: true },
        ip_address: { type: DataTypes.STRING(45), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
      },
      { transaction },
    );

    // BYTEA has no length in Postgres, so the sizes GCM depends on can only be
    // enforced here.
    await queryInterface.sequelize.query(
      "ALTER TABLE factor_totp ADD CONSTRAINT factor_totp_iv_len_chk CHECK (octet_length(iv) = 12)",
      { transaction },
    );
    await queryInterface.sequelize.query(
      "ALTER TABLE factor_totp ADD CONSTRAINT factor_totp_tag_len_chk CHECK (octet_length(auth_tag) = 16)",
      { transaction },
    );

    await queryInterface.addIndex("credencial_webauthn", { fields: ["id_usuario"], transaction });
    await queryInterface.addIndex("codigo_recuperacion", { fields: ["id_usuario"], transaction });
    await queryInterface.addIndex("dispositivo_recordado", { fields: ["id_usuario"], transaction });
    // The purge filters by this one, and it runs against every row in the table.
    await queryInterface.addIndex("dispositivo_recordado", { fields: ["expires_at"], transaction });
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.dropTable("dispositivo_recordado", { transaction });
    await queryInterface.dropTable("codigo_recuperacion", { transaction });
    await queryInterface.dropTable("factor_totp", { transaction });
    await queryInterface.dropTable("credencial_webauthn", { transaction });
  });
}
```

- [ ] **Step 4: Ejecutar el test y verlo pasar**

Run: `npx vitest run src/migrations/20260826000003-create-factor-tables.test.ts`
Expected: PASS, nueve tests.

- [ ] **Step 5: Romper la unicidad a propósito y ver el test en rojo**

Quita `unique: true` de `credencial_webauthn.credential_id` y vuelve a ejecutar. El test
*"makes credential_id unique…"* tiene que fallar. Deshaz el cambio.

---

## Task 3: Los modelos y las interfaces

Cuatro modelos nuevos y dos ampliados. Mecánico, pero es lo que hace que las tablas de la
Tarea 2 sean alcanzables desde el código.

**Files:**
- Create: `src/models/credencialWebauthn.model.ts`, `src/models/factorTotp.model.ts`,
  `src/models/codigoRecuperacion.model.ts`, `src/models/dispositivoRecordado.model.ts`
- Modify: `src/models/usuario.model.ts`, `src/models/sesion.model.ts`,
  `src/interfaces/index.ts`
- Test: `src/models/factorModels.test.ts`

**Interfaces:**
- Consumes: los nombres de tabla y de columna de la Tarea 2, exactamente como están ahí.
- Produces: `CredencialWebauthnModel`, `FactorTotpModel`, `CodigoRecuperacionModel`,
  `DispositivoRecordadoModel`, y las interfaces `ICredencialWebauthn`, `IFactorTotp`,
  `ICodigoRecuperacion`, `IDispositivoRecordado`. `IUsuario` gana
  `mfa_grace_until?: Date | null` y `pass_changed_at?: Date`. `ISesion` gana
  `estado: EstadoSesion`, `mfa_satisfied_at: Date | null` y `mfa_source: string | null`
  (los tres requeridos, no opcionales — la fila leída de la base siempre los trae, a
  veces con valor nulo, y `?:` dejaría al consumidor saltarse la comprobación).

- [ ] **Step 1: Escribir el test que falla**

```ts
// The four factor models, checked against the migration that creates their
// tables — not against each other.
//
// A model whose `tableName` or column names drift from the migration compiles,
// passes every unit test that mocks it, and fails at runtime with "no existe la
// columna". That is the failure mode this file exists for, and it is exactly
// the one that took `GET /api/usuario/1` down on 2026-08-26: `rol.model.ts`
// declared `paranoid: true` against a table with no `deletedAt`, and every
// query that touched roles returned a 500.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MIGRACION = readFileSync("src/migrations/20260826000003-create-factor-tables.ts", "utf8");

const MODELOS = [
  { fichero: "src/models/credencialWebauthn.model.ts", tabla: "credencial_webauthn" },
  { fichero: "src/models/factorTotp.model.ts", tabla: "factor_totp" },
  { fichero: "src/models/codigoRecuperacion.model.ts", tabla: "codigo_recuperacion" },
  { fichero: "src/models/dispositivoRecordado.model.ts", tabla: "dispositivo_recordado" },
];

describe("the factor models name the tables their migration creates", () => {
  it("sets tableName explicitly on every one", async () => {
    // Sequelize's default pluralisation produced `ciudads`, `rols` and
    // `revicions` in this schema. Left to it, `factor_totp` becomes
    // `factor_totps` and nothing in this repo creates that table.
    for (const { fichero, tabla } of MODELOS) {
      const src = readFileSync(fichero, "utf8");
      expect(src, `${fichero} no fija tableName: "${tabla}"`).toContain(`tableName: "${tabla}"`);
    }
  });

  it("turns Sequelize's automatic timestamps off, because these tables have none", async () => {
    // The migration writes `created_at`, not `createdAt`/`updatedAt`. With
    // timestamps left on, every INSERT names two columns that do not exist.
    for (const { fichero } of MODELOS) {
      const src = readFileSync(fichero, "utf8");
      expect(src, `${fichero} deja los timestamps automáticos puestos`).toContain("timestamps: false");
    }
  });

  it("declares no column the migration does not create", async () => {
    for (const { fichero, tabla } of MODELOS) {
      const src = readFileSync(fichero, "utf8");
      const bloque = MIGRACION.slice(MIGRACION.indexOf(`"${tabla}"`));
      const declaradas = [...src.matchAll(/^\s{4}(\w+):\s*\{/gm)].map((m) => m[1]);
      expect(declaradas.length, `${fichero} no declara ninguna columna`).toBeGreaterThan(3);
      for (const col of declaradas) {
        expect(bloque, `${fichero}: la columna "${col}" no existe en la migración`).toContain(
          `${col}:`,
        );
      }
    }
  });
});

describe("the two tables that gained columns declare them too", () => {
  it("usuario carries the grace deadline and the password date", () => {
    const src = readFileSync("src/models/usuario.model.ts", "utf8");
    expect(src).toContain("mfa_grace_until");
    expect(src).toContain("pass_changed_at");
  });

  it("sesion carries the state and the proof of a factor", () => {
    const src = readFileSync("src/models/sesion.model.ts", "utf8");
    expect(src).toContain("estado");
    expect(src).toContain("mfa_satisfied_at");
    expect(src).toContain("mfa_source");
  });
});
```

- [ ] **Step 2: Ejecutarlo y ver que falla**

Run: `npx vitest run src/models/factorModels.test.ts`
Expected: FAIL — los ficheros de modelo no existen.

- [ ] **Step 3: Escribir los cuatro modelos**

Los cuatro siguen la forma de `src/models/sesion.model.ts`, que ya está en el repo. Uno
completo como referencia; los otros tres son el mismo patrón con las columnas de la
Tarea 2.

```ts
// src/models/dispositivoRecordado.model.ts
import { DataTypes, ModelDefined, Optional } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { IDispositivoRecordado } from "../interfaces/index.js";

type Creation = Optional<IDispositivoRecordado, "id" | "revoked_at">;

/**
 * One browser that has already proved a factor and asked not to be asked again.
 *
 * `id_usuario` is not bookkeeping: the acceptance condition is
 * `token_hash = ? AND id_usuario = ? AND revoked_at IS NULL AND expires_at > now()`,
 * all four together. Checked on the hash alone, ticking "remember me" on your
 * own account and carrying that cookie to somebody else's login would skip
 * *their* second factor.
 */
export const DispositivoRecordadoModel: ModelDefined<IDispositivoRecordado, Creation> =
  sequelize.define(
    "dispositivo_recordado",
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: DataTypes.UUIDV4 },
      id_usuario: { type: DataTypes.INTEGER, allowNull: false },
      token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      user_agent: { type: DataTypes.STRING(255), allowNull: true },
      ip_address: { type: DataTypes.STRING(45), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE, allowNull: true },
    },
    {
      // Both explicit, both load-bearing. The name because Sequelize would
      // pluralise it into a table nothing creates; the timestamps because this
      // table has `created_at`, not `createdAt`, and leaving them on makes
      // every INSERT name two columns that do not exist.
      tableName: "dispositivo_recordado",
      timestamps: false,
    },
  );
```

`credencialWebauthn.model.ts`, `factorTotp.model.ts` y `codigoRecuperacion.model.ts` se
escriben igual, con las columnas y los tipos de la migración de la Tarea 2. `public_key`,
`secreto_cifrado`, `iv` y `auth_tag` son `DataTypes.BLOB`; `counter` y `ultimo_paso`,
`DataTypes.BIGINT`; `key_version`, `DataTypes.SMALLINT`.

- [ ] **Step 4: Ampliar `usuario.model.ts` y `sesion.model.ts`**

En `usuario.model.ts`, junto a `email_verified_at`:

```ts
  mfa_grace_until: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  pass_changed_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
```

En `sesion.model.ts`, junto a `revoked_at`:

```ts
    estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "completa" },
    mfa_satisfied_at: { type: DataTypes.DATE, allowNull: true },
    mfa_source: { type: DataTypes.STRING(20), allowNull: true },
```

- [ ] **Step 5: Ampliar `src/interfaces/index.ts`**

Añadir `mfa_grace_until?: Date | null` y `pass_changed_at?: Date` a `IUsuario`; los tres
campos nuevos a `ISesion` **sin `?`**; y las cuatro interfaces nuevas, una por tabla, con
los mismos nombres de columna.

- [ ] **Step 6: Ejecutar los tests y verlos pasar**

Run: `npx vitest run src/models/`
Expected: PASS.

- [ ] **Step 7: Comprobar que compila**

Run: `npx tsc --noEmit`
Expected: sin errores nuevos. `src/controllers/rol.controller.ts` ya arrastra errores de
otra sesión; se ignoran esos y solo esos, y se anota cuáles en el informe.

---

## Task 4: El estado en el almacén de sesiones

`createSession` pasa a recibir en qué estado nace la sesión, y `findLiveSession` a
devolverlo. Sin esto la Tarea 5 no tiene qué leer.

**Files:**
- Create: `src/auth/sessionState.ts`, `src/auth/sessionState.test.ts`
- Modify: `src/auth/sessionStore.ts`, `src/auth/issueSession.ts`
- Test: `src/auth/sessionStore.test.ts` (existente, se amplía)

**Interfaces:**
- Consumes: `ISesion` ampliada (Tarea 3).
- Produces:
  ```ts
  export type EstadoSesion = "parcial" | "onboarding" | "completa";
  export const ESTADOS_SESION: readonly EstadoSesion[];
  export function puedeAlcanzar(estado: EstadoSesion, ruta: string): boolean;
  export const MENSAJE_FACTOR_PENDIENTE: string;
  ```
  `createSession(id_usuario, meta, estado: EstadoSesion)` — tercer parámetro
  **obligatorio**, sin valor por defecto. `findLiveSession` devuelve además
  `estado: EstadoSesion`, `mfa_satisfied_at: Date | null` y `mfa_source: string | null`.
  `issueSession(req, res, id_usuario, estado: EstadoSesion)` — igual, obligatorio.

- [ ] **Step 1: Escribir `sessionState.ts` con su test primero**

El test, antes que el código:

```ts
import { describe, it, expect } from "vitest";
import { puedeAlcanzar } from "./sessionState.js";

describe("what each session state opens", () => {
  it("lets a partial session reach only the doors that can finish the login", () => {
    expect(puedeAlcanzar("parcial", "/api/auth/mfa/verify")).toBe(true);
    expect(puedeAlcanzar("parcial", "/api/auth/logout")).toBe(true);
    expect(puedeAlcanzar("parcial", "/api/auth/me")).toBe(true);
  });

  it("closes the ERP to a partial session, which is the whole point", () => {
    // The single most important assertion in this plan. Without it the second
    // factor is decorative: the password alone reaches the data.
    expect(puedeAlcanzar("parcial", "/api/usuario")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/poste/1")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/permiso/1")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/auth/totp/setup")).toBe(false);
  });

  it("lets an onboarding session set itself up, and nothing else", () => {
    expect(puedeAlcanzar("onboarding", "/api/auth/email/send")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/totp/setup")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/webauthn/register/options")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/auth/recovery-codes/regenerate")).toBe(true);
    expect(puedeAlcanzar("onboarding", "/api/usuario")).toBe(false);
  });

  it("opens everything to a complete session", () => {
    expect(puedeAlcanzar("completa", "/api/usuario")).toBe(true);
    expect(puedeAlcanzar("completa", "/api/auth/me")).toBe(true);
  });

  it("matches on whole path segments, not on string prefixes", () => {
    // `/api/auth/mefoo` starts with `/api/auth/me`. A naive startsWith would
    // open any route somebody later mounts under a name that happens to share
    // an allowed prefix.
    expect(puedeAlcanzar("parcial", "/api/auth/mefoo")).toBe(false);
    expect(puedeAlcanzar("parcial", "/api/auth/sessions-all")).toBe(false);
  });

  it("ignores the query string", () => {
    expect(puedeAlcanzar("parcial", "/api/auth/me?x=1")).toBe(true);
  });
});
```

El módulo:

```ts
// Which doors each session state opens.
//
// **This file is what stops the second factor being decorative.** Until it
// existed, `authenticate` answered one question — is this cookie a live
// session — and a session created the instant a password was accepted was
// indistinguishable from one that had proved a factor. The state has to be
// read, and read here, in one allowlist rather than in an `if` scattered
// across thirty controllers: an allowlist that lives in one constant can be
// audited by reading it, and one spread across route files can only be audited
// by reading all of them.
//
// Allowlist and not blocklist, and the difference is the next route somebody
// mounts: a blocklist forgets it, an allowlist refuses it.

export type EstadoSesion = "parcial" | "onboarding" | "completa";

export const ESTADOS_SESION: readonly EstadoSesion[] = ["parcial", "onboarding", "completa"];

/** What a session with a password behind it and no factor may reach. */
const PARCIAL: readonly string[] = [
  "/api/auth/mfa",
  "/api/auth/webauthn/login",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/auth/me",
];

/** What `onboarding` adds: the doors that let somebody finish setting up. */
const ONBOARDING_EXTRA: readonly string[] = [
  "/api/auth/email",
  "/api/auth/totp",
  "/api/auth/webauthn/register",
  "/api/auth/webauthn/credentials",
  "/api/auth/recovery-codes",
  "/api/auth/sessions",
];

const PERMITIDAS: Record<EstadoSesion, readonly string[] | "todo"> = {
  parcial: PARCIAL,
  onboarding: [...PARCIAL, ...ONBOARDING_EXTRA],
  completa: "todo",
};

/**
 * Segment-aware prefix match. `/api/auth/me` opens `/api/auth/me` and
 * `/api/auth/me/anything`, and does **not** open `/api/auth/mefoo` — which a
 * bare `startsWith` would, handing a partial session any route somebody later
 * mounts under a name that shares an allowed prefix.
 */
function coincide(ruta: string, permitida: string): boolean {
  return ruta === permitida || ruta.startsWith(`${permitida}/`);
}

export function puedeAlcanzar(estado: EstadoSesion, ruta: string): boolean {
  const permitidas = PERMITIDAS[estado];
  if (permitidas === "todo") return true;
  const limpia = ruta.split("?")[0];
  return permitidas.some((p) => coincide(limpia, p));
}

/** Shown to somebody in `onboarding` who reached for the ERP. In Spanish: they read it. */
export const MENSAJE_FACTOR_PENDIENTE =
  "Configura tu segundo factor de autenticación para continuar.";
```

- [ ] **Step 2: Ejecutar el test y verlo pasar**

Run: `npx vitest run src/auth/sessionState.test.ts`
Expected: PASS, seis tests.

- [ ] **Step 3: Romper la coincidencia por segmentos y ver el test en rojo**

Cambia `coincide` por `ruta.startsWith(permitida)` y vuelve a ejecutar. El test
*"matches on whole path segments"* tiene que fallar. Deshaz el cambio.

- [ ] **Step 4: `createSession` recibe el estado**

En `src/auth/sessionStore.ts`, tercer parámetro **obligatorio y sin valor por defecto**:

```ts
export async function createSession(
  id_usuario: number,
  meta: { userAgent?: string; ip?: string },
  // No default. A default here would be a policy decision taken by the
  // storage layer, and whichever value it took would be wrong somewhere:
  // `completa` hands a fresh password-only login the whole ERP, and `parcial`
  // locks out every caller that has legitimately finished. Making it
  // mandatory turns "which state does this login deserve" into a question the
  // compiler asks at each of the call sites, where the answer is known.
  estado: EstadoSesion,
): Promise<{ token: string; expiresAt: Date }> {
```

y en el `SesionModel.create({...})`, `estado,` junto a `revoked_at: null`.

- [ ] **Step 5: `findLiveSession` devuelve el estado**

Añadir `"estado"`, `"mfa_satisfied_at"` y `"mfa_source"` a `attributes`, al tipo de
retorno y al objeto que construye. **Sin cambiar ninguna de las tres condiciones del
`where`** — revocada, caducada y pasada del tope siguen igual y siguen en la consulta.

- [ ] **Step 6: `issueSession` pasa el estado**

Cuarto parámetro obligatorio, que reenvía a `createSession`. El único llamante hoy es el
login (Tarea 7).

- [ ] **Step 7: Ampliar `sessionStore.test.ts`**

Un test que fija que el estado llega a la fila:

```ts
it("writes the state it was told, and never invents one", async () => {
  await createSession(7, {}, "parcial");
  expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ id_usuario: 7, estado: "parcial" });
});
```

- [ ] **Step 8: Ejecutar toda la suite de auth**

Run: `npx vitest run src/auth/`
Expected: PASS. Si algún test existente rompe por el parámetro nuevo, se arregla el test
pasándole el estado explícito — nunca poniéndole un valor por defecto a `createSession`.

---

## Task 5: `authenticate` mira el estado

El corte. Hasta aquí el estado se escribe y se lee pero no decide nada.

**Files:**
- Modify: `src/middleware/authenticate.ts`, `src/app.ts`
- Test: `src/middleware/authenticate.test.ts` (existente, se amplía)

**Interfaces:**
- Consumes: `puedeAlcanzar`, `MENSAJE_FACTOR_PENDIENTE` (Tarea 4); `findLiveSession`
  ampliada (Tarea 4).
- Produces: `req.user` gana `estado: EstadoSesion` y `mfa_satisfied_at: Date | null`.
  Los seis campos son **requeridos**: una petición autenticada tiene fila por
  construcción, igual que `id_sesion` y `expires_at`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
it("refuses the ERP to a partial session", async () => {
  // The assertion that makes MFA real. A session that has shown a password and
  // nothing else must not read a single row of the business data.
  findLiveSession.mockResolvedValue(sesionViva({ estado: "parcial" }));
  const req = peticion({ originalUrl: "/api/usuario" });
  const res = respuesta();

  await authenticate(req, res, next);

  expect(res.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
});

it("lets a partial session finish logging in", async () => {
  findLiveSession.mockResolvedValue(sesionViva({ estado: "parcial" }));
  const req = peticion({ originalUrl: "/api/auth/mfa/verify" });

  await authenticate(req, respuesta(), next);

  expect(next).toHaveBeenCalled();
});

it("answers 403 and not 401 to an onboarding session reaching the ERP", async () => {
  // The difference is what the frontend does with it: a 401 ends the session
  // and sends somebody back to the login they just completed, which is a loop.
  // A 403 keeps them inside, where the screen that finishes their setup is.
  findLiveSession.mockResolvedValue(sesionViva({ estado: "onboarding" }));
  const res = respuesta();

  await authenticate(peticion({ originalUrl: "/api/usuario" }), res, next);

  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ message: MENSAJE_FACTOR_PENDIENTE });
});

it("puts the state on req.user, for the step-up gate to read", async () => {
  const req = peticion({ originalUrl: "/api/auth/me" });
  findLiveSession.mockResolvedValue(sesionViva({ estado: "onboarding", mfa_satisfied_at: null }));

  await authenticate(req, respuesta(), next);

  expect(req.user).toMatchObject({ estado: "onboarding", mfa_satisfied_at: null });
});

it("reads the path off originalUrl, not off req.path", async () => {
  // `authenticate` is mounted inside routers, so `req.path` is the path
  // *relative to the mount* — "/1" for `/api/usuario/1`. Matching the
  // allowlist against that would compare "/1" to "/api/auth/me" and refuse
  // everything, or worse, match nothing and let everything through depending
  // on which way the default falls.
  findLiveSession.mockResolvedValue(sesionViva({ estado: "parcial" }));
  const res = respuesta();

  await authenticate(peticion({ originalUrl: "/api/usuario/1", path: "/1" }), res, next);

  expect(res.status).toHaveBeenCalledWith(401);
});
```

- [ ] **Step 2: Ejecutarlos y verlos fallar**

Run: `npx vitest run src/middleware/authenticate.test.ts`
Expected: FAIL — `authenticate` no mira el estado todavía.

- [ ] **Step 3: El corte en `authenticateBySession`**

Justo después de resolver `usuario` y antes de escribir las cabeceras:

```ts
  /**
   * What this session may reach, on top of whether it exists.
   *
   * Until this block, `authenticate` answered one question — is this cookie a
   * live session — and a row written the instant a password was accepted
   * looked exactly like one that had proved a factor. That is what made the
   * second factor decorative: the whole ERP sat behind "the cookie exists".
   *
   * The two answers are deliberately different, and the difference is what the
   * frontend does with them:
   *
   * - `parcial` gets **401**. The login is unfinished; ending the session and
   *   going back to the start is the correct move.
   * - `onboarding` gets **403**. This person *is* logged in, and their setup
   *   screen is inside the application. A 401 here would throw them out to a
   *   login they have already passed, and they would pass it again, and land
   *   in the same place: a loop with no way out.
   *
   * `originalUrl` and not `req.path`: this middleware runs inside routers, so
   * `req.path` is relative to the mount point — "/1", not "/api/usuario/1".
   */
  const ruta = req.originalUrl;
  if (!puedeAlcanzar(sesion.estado, ruta)) {
    if (sesion.estado === "parcial") {
      res.status(401).json({ message: SESION_INCOMPLETA });
      return;
    }
    res.status(403).json({ message: MENSAJE_FACTOR_PENDIENTE });
    return;
  }
```

con `const SESION_INCOMPLETA = "Termina de iniciar sesión.";` junto a las otras constantes
del fichero, y

```ts
  req.user = {
    id: usuario.id,
    id_rol: usuario.id_rol,
    id_sesion: sesion.id,
    expires_at: expiresAt,
    estado: sesion.estado,
    mfa_satisfied_at: sesion.mfa_satisfied_at,
  };
```

- [ ] **Step 4: Ampliar la declaración global de `Request` en `app.ts`**

```ts
      user?: {
        id: number;
        id_rol: number;
        id_sesion: string;
        expires_at: Date;
        // Both required for the same reason the two above are: an
        // authenticated request has a session row by construction, so there is
        // nothing for a controller to check. `requireStepUp` reads them and
        // must not have to ask whether they are there — an optional field is
        // an invitation to a `?.` that silently reads `undefined` as "not
        // satisfied" in one place and as "no opinion" in another.
        estado: EstadoSesion;
        mfa_satisfied_at: Date | null;
      };
```

- [ ] **Step 5: Ejecutar los tests y verlos pasar**

Run: `npx vitest run src/middleware/`
Expected: PASS.

- [ ] **Step 6: Romper el corte y ver los tests en rojo**

Cambia `if (!puedeAlcanzar(...))` por `if (false)` y vuelve a ejecutar. Tienen que fallar
*"refuses the ERP to a partial session"* y *"answers 403 and not 401…"*. Deshaz el cambio.

- [ ] **Step 7: La suite entera**

Run: `npx vitest run`
Expected: PASS. Cualquier test que rompa aquí lo hace porque construía un `req.user` sin
los campos nuevos: se arregla el test, no el tipo.

---

## Task 6: `requireStepUp`

La puerta de las operaciones sensibles.

**Files:**
- Create: `src/middleware/requireStepUp.ts`, `src/middleware/requireStepUp.test.ts`
- Modify: `src/config/security.ts`, `src/routes/usuario.routes.ts`,
  `src/routes/rol.routes.ts`, `src/routes/permiso.routes.ts`

**Interfaces:**
- Consumes: `req.user.estado` y `req.user.mfa_satisfied_at` (Tarea 5);
  `verifyOwnPassword` de `src/auth/credentials.ts`; `tieneAlgunFactor` (Tarea 7).
- Produces: `export function requireStepUp(): RequestHandler` y
  `export const CODIGO_STEP_UP = "STEP_UP_REQUIRED"`. La respuesta de denegación es
  `403 { message, code: CODIGO_STEP_UP }` — el código es lo que el 4D usa para abrir el
  diálogo de reautenticación en vez de mostrar un error rojo.

**Nota de orden:** esta tarea depende de `tieneAlgunFactor`, que se escribe en la Tarea 7.
Si se ejecutan en orden, escribe aquí la función mínima en `src/auth/factorInventory.ts` y
la Tarea 7 la completa; el informe tiene que decir cuál de las dos la escribió.

- [ ] **Step 1: Las constantes**

En `src/config/security.ts`:

```ts
/**
 * How long a proved factor keeps opening the sensitive operations.
 *
 * Ten minutes is long enough to create three users in a row without
 * re-authenticating, and short enough that an unlocked laptop left on a desk is
 * not a standing authorisation to edit the permission matrix.
 */
export const STEP_UP_WINDOW_MINUTES = 10;

/** The field a caller re-enters their password in when they have no factor yet. */
export const STEP_UP_PASSWORD_FIELD = "stepup_password";
```

- [ ] **Step 2: Escribir el test que falla**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyOwnPassword = vi.fn();
const tieneAlgunFactor = vi.fn();
const logAction = vi.fn();
vi.mock("../auth/credentials.js", () => ({ verifyOwnPassword }));
vi.mock("../auth/factorInventory.js", () => ({ tieneAlgunFactor }));
vi.mock("../utils/logAction.js", () => ({ logAction }));

const { requireStepUp, CODIGO_STEP_UP } = await import("./requireStepUp.js");
const { STEP_UP_WINDOW_MINUTES } = await import("../config/security.js");

const haceMinutos = (m: number) => new Date(Date.now() - m * 60_000);

function contexto(user: Record<string, unknown> | undefined, body: unknown = {}) {
  const req = { user, body, ip: "::1", originalUrl: "/api/rol/1" } as never;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as never;
  return { req, res, next: vi.fn() };
}

beforeEach(() => {
  verifyOwnPassword.mockReset();
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  logAction.mockReset();
});

describe("requireStepUp", () => {
  it("lets through a factor proved inside the window", async () => {
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES - 1),
    });
    await requireStepUp()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("refuses a factor proved one minute outside the window", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES + 1),
    });
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses a session that came in on a remembered device", async () => {
    // A remembered login leaves `mfa_satisfied_at` NULL on purpose. If it did
    // not, stealing that cookie plus the password would be enough to edit the
    // permission matrix without touching a single factor — which is the whole
    // reason the column and the remembered device are separate things.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("answers with a code the frontend can act on, not just a message", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: CODIGO_STEP_UP }),
    );
  });

  it("accepts the current password while the account has no factor at all", async () => {
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("stops accepting the password the moment a factor exists", async () => {
    // The narrow window this fallback exists for closes by itself. Somebody who
    // has a factor and only knows the password must not reach these routes —
    // that is precisely the attacker the second factor is for.
    tieneAlgunFactor.mockResolvedValue(true);
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(verifyOwnPassword).not.toHaveBeenCalled();
  });

  it("refuses an onboarding session outright, password or not", async () => {
    // Somebody still setting up must not create users or touch roles. If the
    // password alone opened these during the grace period, the second factor
    // would be optional for exactly the operations it exists to protect.
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "onboarding", mfa_satisfied_at: haceMinutos(1) },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("writes a bitácora line when it refuses", async () => {
    // An attacker probing these routes is invisible otherwise.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_DENIED", severity: "critical" }),
    );
  });

  it("refuses when there is no user at all", async () => {
    // Mounted behind `authenticate`, so this cannot happen — unless somebody
    // mounts it in front of it one day. Fail closed.
    const { req, res, next } = contexto(undefined);
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
```

- [ ] **Step 3: Ejecutarlo y ver que falla**

Run: `npx vitest run src/middleware/requireStepUp.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 4: Escribir el middleware**

```ts
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyOwnPassword } from "../auth/credentials.js";
import { tieneAlgunFactor } from "../auth/factorInventory.js";
import { logAction } from "../utils/logAction.js";
import { STEP_UP_WINDOW_MINUTES, STEP_UP_PASSWORD_FIELD } from "../config/security.js";

/**
 * The gate on the operations that a stolen session must not be enough for.
 *
 * Being logged in is not the question this asks. The question is whether a
 * *factor* was proved recently — which is a different thing from having a live
 * cookie, and deliberately so: a laptop left unlocked carries a perfectly valid
 * session, and the operations behind this gate (handing out permissions,
 * creating accounts, registering another factor) are the ones where that must
 * not be enough.
 *
 * **A remembered device does not satisfy it.** Those logins leave
 * `mfa_satisfied_at` NULL on purpose; see the column's comment in the
 * migration. Anything that changes that turns "remember this browser" into
 * "this browser is permanently step-up authorised".
 *
 * **The password fallback closes by itself.** Between the deploy of plan 4A and
 * plan 4B nobody has a factor to prove, so a literal reading of the rule would
 * lock every administrator out of user and role management. So the current
 * password is accepted instead — but only while `tieneAlgunFactor` says the
 * account has nothing better. The moment somebody registers a factor, their
 * password stops opening this gate, and so does an attacker's copy of it.
 */
export const CODIGO_STEP_UP = "STEP_UP_REQUIRED";

const MENSAJE =
  "Esta operación necesita que confirmes tu identidad. Vuelve a autenticarte y repite la acción.";
const MENSAJE_ONBOARDING =
  "Termina de configurar tu segundo factor antes de realizar esta operación.";

export function requireStepUp(): RequestHandler {
  return async function stepUpGate(req: Request, res: Response, next: NextFunction) {
    const user = req.user;
    if (!user) {
      // Unreachable while this is mounted behind `authenticate`, which is
      // everywhere it is mounted today. Written anyway, and closed rather than
      // open, because the day somebody mounts it first this must refuse.
      res.status(401).json({ message: "Su sesión expiró. Vuelva a iniciar sesión." });
      return;
    }

    // An `onboarding` session is not a lesser version of a complete one for
    // these routes: it is refused outright. Otherwise the password alone would
    // edit the permission matrix for the whole of the grace period.
    if (user.estado !== "completa") {
      denegar(req, res, MENSAJE_ONBOARDING, "estado-incompleto");
      return;
    }

    const satisfecho =
      user.mfa_satisfied_at !== null &&
      Date.now() - new Date(user.mfa_satisfied_at).getTime() <= STEP_UP_WINDOW_MINUTES * 60_000;
    if (satisfecho) {
      next();
      return;
    }

    // Asked before the password is even looked at: with a factor on the
    // account, no password is an acceptable answer here, and checking it first
    // would spend a bcrypt comparison to reach the same refusal.
    if (await tieneAlgunFactor(user.id)) {
      denegar(req, res, MENSAJE, "sin-factor-reciente");
      return;
    }

    const confirmacion = await verifyOwnPassword({
      id: user.id,
      pass: (req.body as Record<string, unknown> | undefined)?.[STEP_UP_PASSWORD_FIELD],
      ip: req.ip ?? null,
    });
    if (confirmacion.ok) {
      next();
      return;
    }

    denegar(req, res, MENSAJE, "contraseña-incorrecta");
  };
}

function denegar(req: Request, res: Response, message: string, motivo: string): void {
  logAction({
    id_usuario: req.user?.id,
    action: "STEP_UP_DENIED",
    entity: "Sesion",
    entity_id: null,
    detail: `Operación sensible rechazada por falta de step-up: ${motivo}`,
    metadata: { ruta: req.originalUrl, motivo, id_sesion: req.user?.id_sesion },
    severity: "critical",
    ip_address: req.ip ?? null,
  });
  // The code, not just the message: the frontend opens the re-authentication
  // dialog off this and retries the request. Matching on the Spanish text
  // instead would break the day somebody improves the wording.
  res.status(403).json({ message, code: CODIGO_STEP_UP });
}
```

- [ ] **Step 5: Ejecutar el test y verlo pasar**

Run: `npx vitest run src/middleware/requireStepUp.test.ts`
Expected: PASS, nueve tests.

- [ ] **Step 6: Romper la ventana y ver el test en rojo**

Cambia `<=` por `>=` en el cálculo de `satisfecho` y vuelve a ejecutar. Tiene que fallar
*"lets through a factor proved inside the window"*. Deshaz el cambio.

- [ ] **Step 7: Montarlo en las rutas**

Detrás de la comprobación de permiso, nunca delante: quien no tiene permiso recibe 403 por
el permiso y no gasta una comparación de bcrypt ni aprende que la ruta existe.

En `usuario.routes.ts`:

```ts
router.post("/", requirePermission("seguridad", "crear"), requireStepUp(), createUsuario);
router.delete("/:id", requirePermission("seguridad", "archivar"), requireStepUp(), deleteUsuario);
router.patch("/:id/desarchivar", requirePermission("seguridad", "archivar"), requireStepUp(), desarchivarUsuario);
router.put("/:id", requireSelfOrPermission("seguridad", "editar"), requireStepUp(), updateUsuario);
router.put("/username/:id", requireSelfOrPermission("seguridad", "editar"), requireStepUp(), chargeConfirmBudgetOnSelfChange, updateUserName);
router.put("/userpass/:id", requireSelfOrPermission("seguridad", "editar"), requireStepUp(), chargeConfirmBudgetOnSelfChange, updateUserPass);
```

🔴 **`PATCH /:id/desbloquear` se quedaba fuera a propósito, y la Tarea 13 revirtió esa
decisión: hoy lleva `requireStepUp()`.** La razón que había escrita aquí —«quien ya tiene
`seguridad.editar` y una sesión viva puede hacer daño mucho mayor por las rutas de arriba, que
sí lo exigen»— es cierta solo mientras las rutas de arriba acepten lo mismo que ésta, y eso se
acaba con el primer factor registrado del 4B: entonces las de arriba responden 403 a una sesión
sin factor probado y ésta seguiría respondiendo 200, borrando `failed_attempts` y `locked_until`
en la cuenta que se elija. El porqué completo está junto a la ruta en `usuario.routes.ts` y en
la tabla `STEP_UP_GATED` de `routeGuards.test.ts`. **No reintroducir esta excepción**, ni aquí
ni en el test de la Tarea 10 del que también se quitó.

En `rol.routes.ts` y `permiso.routes.ts`, `requireStepUp()` detrás del permiso en **todas**
las rutas que escriben (`POST`, `PUT`, `PATCH`, `DELETE`). Las lecturas no lo llevan.

- [ ] **Step 8: La suite entera**

Run: `npx vitest run`
Expected: PASS.

---

## Task 7: El inventario de factores y el estado inicial

Quién tiene qué, y en qué estado nace una sesión. Es el cerebro del 4A.

**Files:**
- Create: `src/auth/factorInventory.ts`, `src/auth/factorInventory.test.ts`
- Modify: `src/config/security.ts`, `src/controllers/auth.controller.ts`

**Interfaces:**
- Consumes: los cuatro modelos (Tarea 3), `EstadoSesion` (Tarea 4).
- Produces:
  ```ts
  export type Inventario = { passkeys: number; totp: boolean; codigos: number };
  export async function factoresDe(id_usuario: number): Promise<Inventario>;
  export async function tieneAlgunFactor(id_usuario: number): Promise<boolean>;
  export async function estadoInicialDeSesion(usuario: {
    id: number;
    mfa_grace_until: Date | null;
  }, ahora: Date): Promise<{ estado: EstadoSesion; graceUntil: Date | null }>;
  ```
  `graceUntil` no nulo significa «escribe esto en `usuarios.mfa_grace_until`»; nulo
  significa «déjalo como está».

### La contradicción de la especificación que esta tarea resuelve

La especificación dice dos cosas incompatibles sobre `onboarding`. La tabla de §4 dice que
en ese estado «todo lo demás: **403**» — o sea, el ERP cerrado. Y tres párrafos más abajo,
al explicar por qué el email no puede bloquear la entrada, dice «se entra en `onboarding`
y **se puede trabajar**».

No pueden ser las dos. **Regla del 4A:**

- **Dentro de la gracia**, con o sin email verificado, con o sin factor: `completa`. Se
  trabaja. Al 4D le toca dar la lata en pantalla, no cerrar la puerta.
- **Pasada la gracia sin ningún factor configurado**: `onboarding`. El ERP responde 403 y
  el mensaje dice qué hacer. Se entra siempre —«el día 15 no echa a nadie»— pero no se
  trabaja hasta configurarlo.
- **El email verificado nunca decide el estado.** Cierra operaciones de step-up, que es lo
  que la propia especificación quería, y para eso ya basta con que el 4B exija email
  verificado en el alta de factor.

Lo que cuesta si me equivoco: si la intención era cerrar el ERP también durante la gracia,
esto la deja abierta catorce días de más. Pero cerrarlo desde el día 0 pone a toda la
plantilla —que hoy no tiene ni email ni factor— delante de una pantalla de configuración
el día del despliegue, que es exactamente lo que la especificación dedica dos párrafos a
evitar.

- [ ] **Step 1: La constante**

En `src/config/security.ts`:

```ts
/**
 * How long somebody has to set up a second factor before the ERP closes to
 * them, counted from their **first login after the deploy** and not from the
 * deploy itself.
 *
 * From the deploy would mean whoever is on holiday comes back on day 30 to a
 * grace period that expired without them ever seeing a screen: zero of their
 * fourteen days. Counting from their own first login also spreads the setup
 * across the days people actually come back, instead of concentrating every
 * verification email on the Saturday the deploy happened.
 */
export const MFA_GRACE_DAYS = 14;
```

- [ ] **Step 2: Escribir el test que falla**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const credCount = vi.fn();
const totpFindOne = vi.fn();
const codigoCount = vi.fn();
vi.mock("../models/credencialWebauthn.model.js", () => ({
  CredencialWebauthnModel: { count: credCount },
}));
vi.mock("../models/factorTotp.model.js", () => ({ FactorTotpModel: { findOne: totpFindOne } }));
vi.mock("../models/codigoRecuperacion.model.js", () => ({
  CodigoRecuperacionModel: { count: codigoCount },
}));

const { factoresDe, tieneAlgunFactor, estadoInicialDeSesion } = await import("./factorInventory.js");
const { MFA_GRACE_DAYS } = await import("../config/security.js");

const DIA = 24 * 60 * 60 * 1000;

beforeEach(() => {
  credCount.mockReset().mockResolvedValue(0);
  totpFindOne.mockReset().mockResolvedValue(null);
  codigoCount.mockReset().mockResolvedValue(0);
});

describe("what a user actually has", () => {
  it("reports nothing when the tables are empty, which is the state on deploy day", async () => {
    expect(await factoresDe(1)).toEqual({ passkeys: 0, totp: false, codigos: 0 });
    expect(await tieneAlgunFactor(1)).toBe(false);
  });

  it("does not count an unconfirmed TOTP as a factor", async () => {
    // A secret generated and never typed back is a QR somebody may have failed
    // to scan. Counting it would push them to `parcial` on their next login and
    // ask them for a code they cannot produce — locked out by a factor they
    // never finished setting up.
    totpFindOne.mockResolvedValue({ dataValues: { confirmed_at: null } });
    expect(await tieneAlgunFactor(1)).toBe(false);
  });

  it("counts a confirmed TOTP", async () => {
    totpFindOne.mockResolvedValue({ dataValues: { confirmed_at: new Date() } });
    expect(await tieneAlgunFactor(1)).toBe(true);
  });

  it("counts a registered passkey", async () => {
    credCount.mockResolvedValue(2);
    expect((await factoresDe(1)).passkeys).toBe(2);
    expect(await tieneAlgunFactor(1)).toBe(true);
  });

  it("does not treat recovery codes on their own as a factor", async () => {
    // They are the way back in when the factor is lost, not a factor. If they
    // counted, somebody could finish onboarding with a sheet of paper and never
    // register anything — and the spec's rule that onboarding does not end with
    // a single device would be unenforceable.
    codigoCount.mockResolvedValue(10);
    expect(await tieneAlgunFactor(1)).toBe(false);
  });
});

describe("what state a session is born in", () => {
  const ahora = new Date("2026-09-01T10:00:00Z");

  it("starts the grace clock on the first login and lets the person work", async () => {
    const r = await estadoInicialDeSesion({ id: 1, mfa_grace_until: null }, ahora);
    expect(r.estado).toBe("completa");
    expect(r.graceUntil?.getTime()).toBe(ahora.getTime() + MFA_GRACE_DAYS * DIA);
  });

  it("does not restart a grace period that is already running", async () => {
    // Restarting it on every login is a grace period that never ends.
    const enCurso = new Date(ahora.getTime() + 3 * DIA);
    const r = await estadoInicialDeSesion({ id: 1, mfa_grace_until: enCurso }, ahora);
    expect(r.estado).toBe("completa");
    expect(r.graceUntil).toBeNull();
  });

  it("drops to onboarding once the grace has run out with nothing configured", async () => {
    const vencida = new Date(ahora.getTime() - 1);
    const r = await estadoInicialDeSesion({ id: 1, mfa_grace_until: vencida }, ahora);
    expect(r.estado).toBe("onboarding");
  });

  it("never refuses the login outright, whatever the state", async () => {
    // "El día 15 existe y no echa a nadie." A technician in the field on day 15
    // gets a screen telling them what to do, never a closed door.
    const vencida = new Date(ahora.getTime() - 30 * DIA);
    const r = await estadoInicialDeSesion({ id: 1, mfa_grace_until: vencida }, ahora);
    expect(["onboarding", "completa", "parcial"]).toContain(r.estado);
  });

  it("asks for the factor when there is one to ask for", async () => {
    // The 4A tables are empty so this branch never fires today. It is written
    // and tested now because plan 4B turns it on by inserting a row, and a
    // branch first exercised in production is a branch nobody has run.
    credCount.mockResolvedValue(1);
    const r = await estadoInicialDeSesion({ id: 1, mfa_grace_until: null }, ahora);
    expect(r.estado).toBe("parcial");
  });

  it("asks for the factor even after the grace has expired", async () => {
    credCount.mockResolvedValue(1);
    const r = await estadoInicialDeSesion(
      { id: 1, mfa_grace_until: new Date(ahora.getTime() - DIA) },
      ahora,
    );
    expect(r.estado).toBe("parcial");
  });
});
```

- [ ] **Step 3: Ejecutarlo y ver que falla**

Run: `npx vitest run src/auth/factorInventory.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 4: Escribir el módulo**

```ts
import { Op } from "sequelize";
import { CredencialWebauthnModel } from "../models/credencialWebauthn.model.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { CodigoRecuperacionModel } from "../models/codigoRecuperacion.model.js";
import { MFA_GRACE_DAYS } from "../config/security.js";
import type { EstadoSesion } from "./sessionState.js";

const DIA_MS = 24 * 60 * 60 * 1000;

export type Inventario = { passkeys: number; totp: boolean; codigos: number };

/**
 * What this account actually has, read from the tables rather than from a flag.
 *
 * A denormalised "has_mfa" column on `usuarios` would be one write away from
 * lying, and the thing it would be lying about is whether somebody can get in.
 * Three counts on indexed columns is the cheaper mistake.
 *
 * On the day plan 4A deploys, all three tables are empty and this returns
 * zeroes for everybody. That is not a stub: the queries are real, and plans 4B
 * and 4C turn the behaviour on simply by inserting rows.
 */
export async function factoresDe(id_usuario: number): Promise<Inventario> {
  const [passkeys, totp, codigos] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario } }),
    FactorTotpModel.findOne({ where: { id_usuario }, attributes: ["confirmed_at"] }),
    CodigoRecuperacionModel.count({ where: { id_usuario, used_at: null } }),
  ]);
  return {
    passkeys,
    // Confirmed only. A secret that was generated and never typed back is a QR
    // somebody may have failed to scan: counting it would send them to
    // `parcial` on their next login and ask for a code they cannot produce.
    totp: totp?.dataValues.confirmed_at != null,
    codigos,
  };
}

/**
 * Is there anything this person could prove?
 *
 * Recovery codes deliberately do not count. They are the way back in when the
 * factor is lost, not a factor: if they counted, onboarding could be finished
 * with a sheet of paper and nothing registered.
 */
export async function tieneAlgunFactor(id_usuario: number): Promise<boolean> {
  const { passkeys, totp } = await factoresDe(id_usuario);
  return passkeys > 0 || totp;
}

/**
 * What state a session opens in, and whether the grace clock needs starting.
 *
 * Three branches, in this order:
 *
 * 1. **There is a factor to prove** → `parcial`. The password got them this
 *    far and no further. This is the branch the whole plan exists for, and on
 *    4A's deploy day nobody reaches it.
 * 2. **No grace deadline yet** → start it here, `completa`. Started at the
 *    first login *after* the deploy rather than filled in by the migration:
 *    somebody on holiday would otherwise come back on day 30 to a grace period
 *    that expired without them seeing a single screen.
 * 3. **Grace still running** → `completa`. **Grace expired** → `onboarding`.
 *
 * Nobody is ever refused. Day 15 is a screen that says what to do, not a
 * closed door — a technician in the field on day 15 would otherwise get a
 * generic red toast with no button and no instruction.
 */
export async function estadoInicialDeSesion(
  usuario: { id: number; mfa_grace_until: Date | null },
  ahora: Date,
): Promise<{ estado: EstadoSesion; graceUntil: Date | null }> {
  if (await tieneAlgunFactor(usuario.id)) {
    return { estado: "parcial", graceUntil: null };
  }

  if (usuario.mfa_grace_until === null) {
    return { estado: "completa", graceUntil: new Date(ahora.getTime() + MFA_GRACE_DAYS * DIA_MS) };
  }

  const vencida = new Date(usuario.mfa_grace_until).getTime() <= ahora.getTime();
  return { estado: vencida ? "onboarding" : "completa", graceUntil: null };
}
```

`Op` se importa solo si alguna consulta lo necesita; si no, se quita — el linter lo marca.

- [ ] **Step 5: Ejecutar el test y verlo pasar**

Run: `npx vitest run src/auth/factorInventory.test.ts`
Expected: PASS, once tests.

- [ ] **Step 6: Romper la regla del TOTP sin confirmar y ver el test en rojo**

Cambia `totp?.dataValues.confirmed_at != null` por `totp != null` y vuelve a ejecutar.
Tiene que fallar *"does not count an unconfirmed TOTP as a factor"*. Deshaz el cambio.

- [ ] **Step 7: Enchufarlo al login**

En `src/controllers/auth.controller.ts`, sustituir la llamada a `issueSession`:

```ts
  const ahora = new Date();
  const { estado, graceUntil } = await estadoInicialDeSesion(
    { id: check.usuario.id, mfa_grace_until: check.usuario.mfa_grace_until ?? null },
    ahora,
  );

  try {
    await issueSession(req, res, check.usuario.id, estado);
  } catch (err) {
    // ... el catch existente, sin tocar
  }

  // After the session, never before: written first, this would start somebody's
  // fourteen days on a request that ended in a 503 and gave them no way to use
  // a single one of them.
  if (graceUntil !== null) {
    await UsuarioModel.update(
      { mfa_grace_until: graceUntil },
      { where: { id: check.usuario.id } },
    );
  }
```

`verifyCredentials` tiene que devolver `mfa_grace_until` dentro de `check.usuario`; si hoy
restringe `attributes`, se añade ahí.

- [ ] **Step 8: La suite entera**

Run: `npx vitest run`
Expected: PASS. `login.session.test.ts` y `auth.controller.test.ts` van a necesitar que los
modelos nuevos estén mockeados; se añaden los mocks, no se relaja la lógica.

---

## Task 8: `pass_changed_at`, escrito y leído

La columna existe desde la Tarea 1 y hasta aquí no la escribe ni la lee nadie.

**Files:**
- Modify: `src/auth/sessionStore.ts` (`findLiveSession`), `src/middleware/authenticate.ts`,
  `src/controllers/password.controller.ts`, `src/controllers/usuario.controller.ts`
- Test: `src/middleware/authenticate.test.ts`, `src/controllers/password.controller.test.ts`

**Interfaces:**
- Consumes: `usuarios.pass_changed_at` (Tarea 1); `req.user` ampliado (Tarea 5).
- Produces: ninguna firma nueva. `currentUser` en `authenticate.ts` pasa a devolver
  `{ id, id_rol, pass_changed_at }`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
it("refuses a session opened before the password was last changed", async () => {
  // The belt to the braces of explicit revocation. Every path that changes a
  // password today also revokes the sessions — but "today" is the word doing
  // the work: the next path somebody writes will not, and this catches it
  // without that person having to know it exists.
  findLiveSession.mockResolvedValue(sesionViva({ created_at: new Date("2026-01-01") }));
  findByPk.mockResolvedValue({
    dataValues: { id: 1, id_rol: 1, pass_changed_at: new Date("2026-06-01") },
  });
  const res = respuesta();

  await authenticate(peticion(), res, next);

  expect(res.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
});

it("keeps a session opened after the change", async () => {
  findLiveSession.mockResolvedValue(sesionViva({ created_at: new Date("2026-07-01") }));
  findByPk.mockResolvedValue({
    dataValues: { id: 1, id_rol: 1, pass_changed_at: new Date("2026-06-01") },
  });

  await authenticate(peticion(), respuesta(), next);

  expect(next).toHaveBeenCalled();
});
```

y en `password.controller.test.ts`:

```ts
it("stamps pass_changed_at when the reset lands", async () => {
  await resetPassword(peticionConToken(), respuesta());
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ pass_changed_at: expect.any(Date) }),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Ejecutarlos y verlos fallar**

Run: `npx vitest run src/middleware/authenticate.test.ts src/controllers/password.controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Leerla en `authenticate`**

`currentUser` añade `"pass_changed_at"` a sus `attributes` y lo devuelve. Y justo después
de la comprobación de la cuenta archivada:

```ts
  /**
   * A session older than the current password does not work, whatever else is
   * true about it.
   *
   * Every path that changes a password today also revokes the sessions
   * explicitly, and this is deliberately a second, independent answer to the
   * same question — one that a future password-changing endpoint gets for free
   * without its author knowing this rule exists. Explicit revocation is a
   * promise every caller has to keep; this is a fact of the data.
   *
   * `>=` and not `>`: the session opened by the reset itself — if one ever is
   * — must survive its own stamp.
   */
  if (new Date(sesion.created_at).getTime() < new Date(usuario.pass_changed_at).getTime()) {
    res.status(401).json({ message: SESION_EXPIRADA });
    return;
  }
```

- [ ] **Step 4: Escribirla en los dos sitios que cambian la contraseña**

En `password.controller.ts`, dentro de la transacción del reset, junto al `pass` nuevo:
`pass_changed_at: ahora`. En `usuario.controller.ts`, en `updateUserPass`, lo mismo.

- [ ] **Step 5: Ejecutar los tests y verlos pasar**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Romper el signo y ver el test en rojo**

Cambia `<` por `>` en la comparación y vuelve a ejecutar. Tienen que fallar los dos tests
del Step 1. Deshaz el cambio.

---

## Task 9: Limpieza y archivado

Las tablas nuevas no se limpian solas, y archivar a alguien tiene que llevarse sus factores
por delante.

**Files:**
- Modify: `src/auth/purgeJob.ts`, `src/controllers/usuario.controller.ts`
- Test: `src/auth/purgeJob.test.ts`, `src/controllers/usuario.controller.test.ts`

**Interfaces:**
- Consumes: `DispositivoRecordadoModel` (Tarea 3).
- Produces: `export async function purgeExpiredRememberedDevices(): Promise<number>`, y
  `deleteUsuario` revoca en la misma transacción las sesiones y los dispositivos
  recordados del usuario que archiva.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
it("purges remembered devices that are expired or revoked", async () => {
  await purgeExpiredRememberedDevices();
  expect(destroy).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.anything() }),
  );
});

it("revokes the remembered devices of an account it archives", async () => {
  // `ON DELETE CASCADE` does nothing here and never will: the delete is
  // logical, the row stays, and no cascade fires. Without this line, the
  // laptop of somebody who was let go keeps skipping the second factor until
  // the device cookie expires on its own.
  await deleteUsuario(peticion({ params: { id: "7" } }), respuesta());
  expect(dispositivoUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ revoked_at: expect.any(Date) }),
    expect.objectContaining({ where: expect.objectContaining({ id_usuario: "7" }) }),
  );
});

it("archives and revokes inside one transaction", async () => {
  // Half of this is worse than none: an account archived whose devices still
  // work looks closed on the screen and is open in the field.
  await deleteUsuario(peticion({ params: { id: "7" } }), respuesta());
  const t = dispositivoUpdate.mock.calls.at(-1)?.[1]?.transaction;
  expect(t).toBeDefined();
  expect(sesionUpdate.mock.calls.at(-1)?.[1]?.transaction).toBe(t);
});
```

- [ ] **Step 2: Ejecutarlos y verlos fallar**

Run: `npx vitest run src/auth/purgeJob.test.ts src/controllers/usuario.controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

`purgeExpiredRememberedDevices` borra las filas con `expires_at < now()` **o**
`revoked_at` no nulo desde hace más de 30 días, y se llama desde el mismo intervalo que
`purgeExpiredSessions`. `deleteUsuario` abre una transacción y dentro: el archivado, la
revocación de sesiones y la de dispositivos recordados.

`codigo_recuperacion`, `factor_totp` y `credencial_webauthn` **no se purgan**: no caducan,
y borrarlos al archivar impediría desarchivar a alguien con sus factores intactos. Lo que
los neutraliza es que la cuenta esté archivada, que `authenticate` ya comprueba.

- [ ] **Step 4: Ejecutar los tests y verlos pasar**

Run: `npx vitest run`
Expected: PASS.

---

## Task 10: Las guardas de ruta y la documentación

Cerrar el plan: que el test que vigila las rutas conozca el middleware nuevo, y que la
especificación diga qué hay que hacer para desplegar esto.

**Files:**
- Modify: `src/routes/routeGuards.test.ts`,
  `docs/specs/2026-08-21-autenticacion-mfa-design.md`
- Test: el propio `routeGuards.test.ts`

**Interfaces:**
- Consumes: el montaje de `requireStepUp` de la Tarea 6.
- Produces: nada de código.

- [ ] **Step 1: Que `routeGuards.test.ts` vea el step-up**

El fichero lee la tabla de rutas del propio `app` y comprueba tres cosas: que todo lleva
autenticación, que todo lo que escribe lleva permiso, y que cada guarda pide el permiso que
le toca. `requireStepUp` añade una capa que hay que afirmar igual, o mañana alguien monta
una ruta de roles sin ella y nada lo dice.

```ts
/**
 * Which write routes have to carry `requireStepUp`, listed here rather than
 * inferred.
 *
 * Inferring it — "every write under /rol and /permiso" — would pass the day
 * somebody adds a write route to a module this list does not name, which is
 * exactly the day it needs to fail.
 */
const STEP_UP_REQUIRED = [
  "POST /api/usuario",
  "PUT /api/usuario/:id",
  "PUT /api/usuario/username/:id",
  "PUT /api/usuario/userpass/:id",
  "DELETE /api/usuario/:id",
  "PATCH /api/usuario/:id/desarchivar",
];

describe("which operations need a factor proved recently", () => {
  it("mounts the step-up gate on every one of them", () => {
    for (const ruta of STEP_UP_REQUIRED) {
      const encontrada = routes.find((r) => `${r.method} ${r.path}` === ruta);
      expect(encontrada, `${ruta} ya no existe: actualiza esta lista`).toBeDefined();
      expect(encontrada?.stack, `${ruta} sin requireStepUp`).toContain("stepUpGate");
    }
  });

  it("mounts it on every write route of roles and permissions", () => {
    const escrituras = routes.filter(
      (r) => WRITES.includes(r.method) && /^\/api\/(rol|permiso)\b/.test(r.path),
    );
    expect(escrituras.length, "no se encontró ninguna escritura de roles ni permisos").toBeGreaterThan(0);
    for (const r of escrituras) {
      expect(r.stack, `${r.method} ${r.path} sin requireStepUp`).toContain("stepUpGate");
    }
  });

  it("does not put it in front of reads", () => {
    // A gate on a read is a gate somebody will route around by reading twice.
    // More to the point: it would ask for a password to look at a list.
    const lecturas = routes.filter((r) => r.method === "GET");
    for (const r of lecturas) {
      expect(r.stack, `${r.method} ${r.path} lleva step-up y es una lectura`).not.toContain("stepUpGate");
    }
  });
});
```

🔴 **Este bloque tenía un cuarto test, «keeps the exception honest: unlocking an account is
deliberately outside», y NO se escribe.** La Tarea 13 montó `requireStepUp()` en
`PATCH /api/usuario/:id/desbloquear`: su justificación para quedarse fuera —«quien tiene ese
permiso ya puede hacer más daño por las rutas de al lado»— deja de ser cierta en cuanto el 4B
haga que esas rutas de al lado exijan un factor probado. La ruta está en la tabla
`STEP_UP_GATED` de `routeGuards.test.ts`, con el porqué escrito al lado. Reintroducir ese test
sería volver a fijar una decisión ya revertida.

`stepUpGate` es el nombre de la función que devuelve `requireStepUp()`, y por eso la
función interna del middleware está nombrada y no es anónima: es lo que hace que la pila de
Express sea legible desde un test.

- [ ] **Step 2: Ejecutarlo y ver que falla, y luego pasar**

Run: `npx vitest run src/routes/routeGuards.test.ts`
Primero contra una ruta a la que le quites `requireStepUp()` a mano — tiene que fallar
nombrándola. Devuélvela y vuelve a ejecutar: PASS.

- [ ] **Step 3: Actualizar la especificación**

En `docs/specs/2026-08-21-autenticacion-mfa-design.md`:

1. En §3, junto a la tabla de `sesion`, una nota de que `webauthn_challenge` y
   `challenge_expires_at` **no las crea el Plan 4A** y por qué, con el enlace a este plan.
2. En §4, resolver la contradicción de `onboarding` con la regla de la Tarea 7 escrita en
   el propio documento — no en el plan, que nadie relee. La tabla de estados se queda; el
   párrafo del email gana una frase que diga que durante la gracia el estado es `completa`.
3. En §11, una subsección **«Qué hay que hacer para desplegar el Plan 4A»**:
   - Las dos migraciones, en orden, con `npm run migrate:deploy`.
   - Que **no hay variables de entorno nuevas** en el 4A. `MFA_ENCRYPTION_KEY` y las de
     WebAuthn son del 4B y el 4C.
   - Que la vuelta atrás son las dos migraciones `down` en orden inverso, y que **es
     segura**: ninguna columna que se borra contiene nada que no se pueda reconstruir.
   - Que el 4A **no cierra la ventana del Plan 3**. Sigue en pie la regla de §11: nada de
     esto sale a producción hasta que el arco esté terminado.

- [ ] **Step 4: Ejecutar la migración contra la base local**

Run: `npm run migrate`
Expected: las dos migraciones aplicadas. Comprobar después, con una consulta directa, que
`usuarios` tiene las dos columnas nuevas, que `sesiones` tiene las tres, que las cuatro
tablas existen y que **el número de filas de `usuarios`, `postes`, `eventos`, `bitacoras` y
`sesiones` es idéntico al de antes**. Anotar los números en el informe, antes y después.

- [ ] **Step 5: La suite entera, en los dos repos**

Run: `npx vitest run` en `api`. Y `npx tsc --noEmit`.
Expected: PASS. `web` no se toca en este plan; no hace falta ejecutarlo.

- [ ] **Step 6: El commit, uno solo**

```bash
git add src/migrations/20260826000002-add-mfa-columns.ts \
        src/migrations/20260826000002-add-mfa-columns.test.ts \
        # ... el resto, POR NOMBRE, nunca -A
git commit -m "feat(auth): session states, step-up gate and the schema the factors plug into"
```

---

## Self-review

**Cobertura contra la especificación.** §3: las columnas de `usuario` y `sesion` y las
cuatro tablas, Tareas 1-3; las de reto de WebAuthn, aplazadas y declaradas. §4: los tres
estados, Tareas 4-5; la gracia desde el primer login, Tarea 7; el día 15 que no echa a
nadie, Tarea 7; la lista de step-up, Tarea 6. §5: `requireStepUp` montado, Tarea 6; los
endpoints nuevos, fuera del 4A por diseño. §10: los tests nuevos que el 4A puede escribir
—sesión parcial contra el ERP, sesión revocada, usuario archivado, alta de factor sin
step-up— están en las Tareas 5, 6 y 8; los que necesitan un factor real son del 4B.

**Lo que este plan deja abierto y hay que recoger en el 4B o el 4C:**

- El almacén del reto de WebAuthn (decisión 1).
- La vía de la contraseña en `requireStepUp` se cierra sola, pero **el 4B tiene que
  comprobar que se cerró**: un test que registre un factor y verifique que la contraseña
  deja de abrir la puerta.
- `mfa_satisfied_at` y `mfa_source` se escriben desde el 4B; el 4A solo los lee.
- El aviso por correo en toda alta y baja de factor (§4) es del 4B: aquí no hay altas.
- El endpoint `POST /api/usuario/:id/mfa/reset` y el script de rescate, del 4D.

**Consistencia de tipos.** `EstadoSesion` se define en `sessionState.ts` y se consume en
`sessionStore.ts`, `issueSession.ts`, `authenticate.ts`, `app.ts`, `requireStepUp.ts` y
`factorInventory.ts` — siempre importado, nunca redeclarado. `tieneAlgunFactor` la escribe
la Tarea 7 y la consume la Tarea 6; si se ejecutan en orden, la 6 escribe la versión mínima
y la 7 la completa, y el informe dice cuál fue.

---

## Task 11: La puerta de tipos del proyecto, en verde

Añadida durante la ejecución, no estaba en el plan original. **El plan la rompió y el plan la
arregla**: no se entrega con la puerta de tipos del propio proyecto en rojo por una causa
nuestra.

**Files:**
- Modify: `src/controllers/email.controller.test.ts`, `src/controllers/auth.controller.test.ts`,
  `src/middleware/loginLimiters.test.ts`, `src/middleware/uploadLimiters.test.ts`,
  `src/middleware/recoveryLimiters.test.ts`

**Interfaces:**
- Consumes: `req.user` con `estado` y `mfa_satisfied_at` obligatorios (Tarea 5).
- Produces: `npm run typecheck` limpio de todo lo que este plan introdujo.

### Qué pasó, para que no vuelva a pasar

`npm run typecheck` pasa `tsc` por `tsconfig.json` **y** por `tsconfig.test.json`.
`npx tsc --noEmit` solo mira el primero. Durante seis tareas, todos los implementadores y todos
los revisores ejecutaron el segundo comando e informaron «tipos limpios» — **de forma veraz e
incompleta**.

Mientras tanto, la Tarea 5 hizo obligatorios `estado` y `mfa_satisfied_at` en `req.user`
(`d424aa3`) y arregló los fixtures de sesión que encontró, pero se dejó cinco ficheros. Nadie lo
vio porque el comando que lo habría dicho no se ejecutaba.

Medido al cerrar la Tarea 6: **62 líneas de error, 57 de ellas nuestras**, todas el mismo
`TS2739` sobre `{ id, id_rol, id_sesion, expires_at }`.

| Fichero | Errores | ¿De este plan? |
|---|---|---|
| `email.controller.test.ts` | 33 | Sí |
| `auth.controller.test.ts` | 21 | Sí |
| `loginLimiters.test.ts` | 1 | Sí (fixture de la línea 390, de `ae244d71`, anterior a la T6 pero posterior al plan) |
| `uploadLimiters.test.ts` | 1 | Sí |
| `recoveryLimiters.test.ts` | 1 | Sí |
| `securityNotice.test.ts` | 5 | **No** — `TS2493`, de `8525ea2`, ajeno |

- [ ] **Step 1: Medir antes de tocar**

Run: `npm run typecheck 2>&1 | grep -cE "^src.*error"`
Anotar el número exacto en el informe. Sin esta cifra no hay forma de demostrar la mejora.

- [ ] **Step 2: Arreglar los 57, y solo los 57**

Cada uno es el mismo arreglo: el fixture construye `req.user` sin los dos campos que la Tarea 5
hizo obligatorios. Se añaden con valores que digan la verdad sobre lo que ese test simula —
`estado: "completa"` y `mfa_satisfied_at: null` es lo que tiene una sesión real hoy, y es lo que
debe usarse salvo que el test trate específicamente de otro estado.

**Nunca** se arregla relajando el tipo, ni con `as never`, ni con `as any`, ni marcando los campos
opcionales. Ese tipo es obligatorio a propósito: un campo opcional invita a un `?.` que lee
`undefined` como «no satisfecho» en un sitio y como «sin opinión» en otro, y de él cuelga la
puerta de step-up.

Los 5 de `securityNotice.test.ts` **no se tocan**. Son ajenos, son de otra forma (`TS2493`), y
arreglarlos mezclaría trabajo de otra sesión con el nuestro.

- [ ] **Step 3: Medir después**

Run: `npm run typecheck 2>&1 | grep -cE "^src.*error"`
Expected: **5**, y las cinco en `securityNotice.test.ts`. Cualquier otra cosa hay que explicarla.

- [ ] **Step 4: Comprobar que no se rompió nada**

Run: `npx vitest run` y `npx eslint src`.
Expected: la suite entera en verde. Un fixture ampliado no debería cambiar ningún resultado; si
alguno cambia, **es un hallazgo**: significa que ese test dependía de que el objeto estuviera
incompleto. Anotarlo, no taparlo.

- [ ] **Step 5: Que no vuelva a pasar**

`npx tsc --noEmit` es el comando que engañó a seis tareas. Dejar dicho, en el sitio donde alguien
lo vaya a leer antes de cerrar una tarea, que la comprobación es `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/email.controller.test.ts src/controllers/auth.controller.test.ts \
        src/middleware/loginLimiters.test.ts src/middleware/uploadLimiters.test.ts \
        src/middleware/recoveryLimiters.test.ts
git commit -m "fix(test): the session fixtures this arc left short of req.user's real shape"
```

---

# Lo que encontró la auditoría del arco

Cuatro auditores adversariales sobre las Tareas 1-7, una lente cada uno: **bloqueo**, **salto de
autorización**, **datos y migraciones**, **integridad de los tests**. 27 hallazgos confirmados,
todos medidos ejecutando código, no razonando sobre él.

**Reparto decidido por Isaias el 2026-08-27:** se arregla lo que bloquea el despliegue de este
plan; **las trampas que se arman con el 4B se escriben aquí, con su medición, como requisito de
entrada de ese plan.** El motivo es que arreglarlas hoy significa escribir código contra un
consumidor que todavía no existe, con el riesgo de acertar la solución al problema equivocado —
mientras que documentarlas medidas hace que el 4B empiece con la lista en la mano.

## Task 12: La sesión viva se reevalúa

**El hallazgo:** `estado` se decide una vez, en el login, y se guarda en la fila de la sesión.
`authenticate` lo lee de ahí para siempre. **Nada vuelve a escribirlo, y nada revoca sesiones
cuando vence `mfa_grace_until`.**

Quien entra el día 13 de su gracia sigue `completa` el día 15. Y como `authenticate` desliza la
caducidad en cada petición, esa sesión —y una cookie robada de ella— conserva **el ERP entero y
las once rutas de step-up hasta 30 días pasada la fecha límite**, sobre una cuenta sin ningún
factor. La puerta solo cierra en el siguiente login, y nadie tiene motivo para hacerlo.

Esto **vacía de sentido buena parte del arco**: la máquina de estados existe para imponer una
fecha, y la fecha no se impone.

**Files:** Modify `src/middleware/authenticate.ts`; Test `src/middleware/authenticate.test.ts`,
`src/app.auth.test.ts`.

- [ ] **Step 1: El test que falla**

Una sesión `completa` cuya cuenta tiene `mfa_grace_until` vencida y ningún factor **no** puede
seguir alcanzando el ERP. Escríbelo contra la app ensamblada, no solo contra un `req` a mano — ver
la Tarea 15, que existe porque ese 403 nunca se ha ejercitado de extremo a extremo.

- [ ] **Step 2: Reevaluar en cada petición**

`currentUser` ya lee `usuarios` en cada petición, así que **añadir `mfa_grace_until` a esa
proyección no cuesta ni un viaje más a la base**. Con eso, `authenticate` puede recalcular el
estado efectivo en vez de creerse el guardado.

**Decisión pendiente, y quiero opciones antes de código:** ¿se recalcula por petición, o se
revocan las sesiones al vencer? La primera es barata y no necesita proceso de barrido; la segunda
deja rastro y cierra también las sesiones de quien no vuelva a pedir nada. Mídelas y recomienda.

**Cuidado con el orden:** el estado efectivo tiene que salir de la lectura que ya se hace, no de
una segunda consulta — y el resultado no debe escribirse en la fila de sesión sin pensarlo, porque
entonces vuelve a ser una foto, que es justo el defecto que se está arreglando.

- [ ] **Step 3: Romperlo**

Devuelve el estado guardado en vez del recalculado. Tiene que caer el test del Step 1.

## Task 13: Las puertas que faltan

Tres rutas que la especificación pone detrás del step-up y que no lo llevan, más dos arreglos de
una línea.

**Files:** Modify `src/routes/auth.routes.ts`, `src/routes/usuario.routes.ts`,
`src/routes/routeGuards.test.ts`, `src/middleware/requireStepUp.ts`,
`src/controllers/auth.controller.ts`.

- [ ] **Step 1: `DELETE /api/auth/sessions/:id`** — demostrado de extremo a extremo por el
      auditor: desde una sesión `onboarding` que recibe 403 en usuarios, postes y permisos, se
      **lista el inventario de dispositivos de la víctima** (user agent, IP, fechas) y se
      **cierran todas sus demás sesiones manteniendo viva la robada**. La especificación la marca
      «Step-up. Solo filas propias». Misma familia un estado más abajo: `parcial` abre
      `logout-all`.

      Ojo: `routeGuards.test.ts` afirma que el step-up está montado en **exactamente once rutas y
      en ninguna más**, así que añadir la puerta **rompe ese test a propósito**. Es la señal de
      que la tabla funciona; actualízala, no la relajes.

- [ ] **Step 2: `POST /api/auth/email/send`** — hoy pide la contraseña actual, que es igual o más
      fuerte que lo que aceptan las once rutas. El problema es la **forma**: la rama 2 de la
      puerta existe para decir «con un factor en la cuenta, una contraseña no es respuesta
      aceptable». En cuanto el 4B registre un factor, las once rutas empiezan a rechazar
      contraseñas **y esta seguirá aceptándolas** — siendo la ruta cuyo propio comentario la llama
      «el arreglo de una cadena real de secuestro de cuenta».

- [ ] **Step 3: `PATCH /api/usuario/:id/desbloquear`** — su justificación escrita para no llevar
      puerta es que quien tenga ese permiso «ya puede hacer más daño por las rutas de al lado».
      **Eso es exactamente lo que el 4B deja de ser verdad.** Post-4B: cookie de admin robada, las
      rutas de al lado dan 403, esta da 200, y desactiva **el único freno por cuenta que sobrevive
      a la rotación de IP** contra la víctima que se elija. Al añadir la puerta, **reescribe esa
      justificación**: se quedó obsoleta, no se quedó corta.

- [ ] **Step 4: La ventana de step-up sin cota inferior** — hoy acepta cualquier marca dentro de
      los 10 minutos **hacia atrás y hacia delante**. Una marca en el futuro la satisface mientras
      siga en el futuro: un reloj que salte atrás, o una escritura mala, y esa sesión queda
      autorizada indefinidamente. Latente hasta que el 4B escriba la columna. Arreglo: `>= 0 &&`.

- [ ] **Step 5: `/api/auth/me` entrega la matriz de permisos a una sesión no `completa`** — la
      especificación dice literalmente «en estado no `completa`, devuelve estado sin permisos», y
      hoy la devuelve entera. Post-4B eso entrega el mapa de autoridad de la cuenta a alguien que
      tiene la contraseña y **no** ha probado el segundo factor.

## Task 14: La migración que miente sobre sí misma

- [ ] **Step 1: La cabecera es falsa y el operador se la va a creer**

`20260826000003-create-factor-tables.ts:3-4` dice «creadas vacías; **nada las lee** hasta los
planes 4B y 4C». **Falso desde la Tarea 7:** `tieneAlgunFactor` hace tres COUNT contra esas tablas
y se llama **en cada login**.

Medido: deshecha solo esa migración y dejada la otra, `estadoInicialDeSesion` lanza «no existe la
relación credencial_webauthn». Esa llamada está **fuera** del `try/catch` que produce el 503, así
que **cada login responde 500** — sin cookie, sin sesión, sin una frase con la que nadie pueda
hacer nada, para los 15.

`umzug down` sin argumentos deshace exactamente una migración. Con esa cabecera, «total, si están
vacías» es el movimiento natural del operador, y es una caída completa.

- [ ] **Step 2: El `down` destruye lo irrecuperable sin preguntar**

Los cuatro `dropTable` son incondicionales. Post-4B, un rollback destruye **todos los secretos
TOTP** —que no existen en ningún otro sitio: el texto plano se enseñó una vez como QR—, las
passkeys, los códigos sin usar y los dispositivos recordados. Y las columnas de `sesiones` viven
en **otra** migración, así que no se deshacen juntas.

Que el `down` se niegue si alguna de las cuatro tablas tiene filas.

- [ ] **Step 3: `sesiones.estado` conserva un `DEFAULT 'completa'` permanente**

El default existía para dar valor a las filas que ya estaban durante el `ALTER` — buena razón, que
**caduca al hacer commit de esa sentencia**. Nadie lo quitó.

Ahora **contradice el argumento escrito un fichero más allá**: `createSession` se niega a tener
default a propósito, «para que el compilador pregunte en cada sitio de llamada». Pero el modelo sí
lo tiene, así que un `create` que lo olvide —o el `INSERT` crudo del script de rescate que planea
la especificación— **acuña una sesión con todos los privilegios, sin error y sin traza**.

`ALTER TABLE sesiones ALTER COLUMN estado DROP DEFAULT`, y fuera el `defaultValue` y el `Optional`
del modelo.

- [ ] **Step 4: `down` y luego `up` desarma el cinturón de la Tarea 8**

`removeColumn` tira `pass_changed_at` con sus datos, y el `up` reejecutado escribe
`pass_changed_at = "createdAt"`. Ana cambia su contraseña el 10 de septiembre; un despliegue se
deshace y se rehace; su marca vuelve a 2024. **El cinturón queda desarmado para toda la tabla, en
silencio.** Los tirantes (la revocación explícita) aguantan — pero la columna existe justo para el
día en que se olviden los tirantes.

- [ ] **Step 5: Los minors de esquema**

`credential_id` es `TEXT` bajo un btree único: por encima de ~2704 bytes Postgres revienta, y **un
test escrito con un carácter repetido no lo encuentra** porque el índice comprime — usa datos
incompresibles. `created_at` sin default en las cuatro tablas, al revés que `token_uso_unico` dos
migraciones antes y sin razón dada. Índice de purga para una purga que no existe: nada barre
`dispositivo_recordado`, así que IPs y user agents se quedan indefinidamente. Nombres de índice
generados por Sequelize, rompiendo la convención del propio arco.

## Task 15: Los tests que no pueden fallar

- [ ] **Step 1: La regla del TOTP sin confirmar, que falla en las DOS direcciones**

Quitar el filtro `confirmed_at` de cualquiera de las dos funciones mata **un solo test**: el que
compara la forma del `where`. **El test cuyo nombre ES la regla** —«no cuenta un TOTP sin
confirmar»— sigue verde, junto con los catorce de `estadoInicialDeSesion`, porque el mock devuelve
un número sin mirar el `where`.

Y al revés: reescribir `{[Op.ne]: null}` como `{[Op.not]: null}` —que Sequelize compila a lo
mismo, un refactor **correcto**— pone ese único test en rojo. La única guardia de la regla **falla
ante código correcto y pasa ante todo comportamiento malo**. Quien «arregle» ese rojo relajando la
aserción deja la regla sin nada.

*Lo que llega a producción:* un secreto generado y nunca escaneado cuenta como factor → esa cuenta
entra en `parcial` en su siguiente login → se le pide un código que no puede producir → encerrada
por un factor que nunca terminó de registrar, sin endpoint que la saque.

**Arreglo:** que el mock respete el argumento — que devuelva 1 solo cuando el `where` que recibe
lleve el filtro. Así los tests de comportamiento ejercitan la regla de verdad.

- [ ] **Step 2: El 403 de `onboarding` nunca se ha ejercitado contra la app ensamblada**

El único test de extremo a extremo del corte de estados cubre solo `parcial`. El fixture
compartido de `app.auth.test.ts` es siempre `completa`, **el único estado donde la puerta no hace
nada**. La rama que se dispara **para todo el mundo**, por calendario, no tiene cobertura a nivel
de petición. Es también lo que necesita la Tarea 12.

- [ ] **Step 3: Los minors**

Aserción de bucle sin contador en `20260826000003-create-factor-tables.test.ts:61-67` — su
**propio gemelo** doce líneas más abajo sí lleva `expect(qi.calls.length).toBeGreaterThan(0)`.
`ESTADOS_SESION` exportado y no importado en ningún sitio. `onUpdate: "CASCADE"` sin afirmar
aunque lo exigen las constraints globales. `token_hash` sin afirmar su unicidad.

## Lo que NO se arregla aquí — requisitos de entrada del Plan 4B

Medido y no arreglado a propósito: hoy no es explotable, y el código que lo consumiría no existe.
**El 4B no se da por diseñado sin responder a estos cuatro.**

1. **`counter` y `ultimo_paso` son `BIGINT` y llegan a Node como CADENAS**, mientras
   `src/interfaces/index.ts` los declara `number`. Medido en round-trip real: `"0"`, y
   `"0" + 1 === "01"`.
   *Por qué importa:* el anti-repetición del TOTP se escribe como
   `if (paso === row.ultimo_paso) rechazar`. Contra una cadena esa comparación es **siempre
   falsa**, y los mismos seis dígitos se aceptan dos veces dentro de la misma ventana de 30
   segundos — exactamente la repetición que la columna existe para cerrar. Lo mismo con
   `counter = stored + 1` en la detección de clonado de passkeys.
   **La declaración de tipo es lo que lo convierte en trampa:** TypeScript acepta `===` y `+`
   encantado porque la interfaz miente.
2. **Los cuatro modelos nuevos serializan sus secretos por defecto.** Sin `defaultScope`, sin
   `toJSON`, y con `hasMany` desde `usuarios` a las cuatro. Medido: `JSON.stringify` de un factor
   saca `secreto_cifrado`, `iv` y `auth_tag`. **Este repo ya envió este bug una vez** — está
   documentado en `usuario.model.ts:101-114`: un `include` publicaba el hash bcrypt de la
   contraseña a cualquier cuenta con sesión, rol Cliente incluido. Un solo `include` basta.
3. **La comprobación de cupo del step-up rechaza una contraseña CORRECTA.** Se arma con el 4D.
   Cinco fallos en la pantalla de cambiar contraseña → durante quince minutos **las once rutas
   responden 429 con la contraseña bien escrita**, porque la puerta lee el cupo **antes** de
   verificar nada. Agravante: acertar es justo lo que le habría **limpiado** el contador; el 429
   se sienta delante, así que acertar ya no compra nada.
4. **Nada en el cliente sabe qué es `onboarding`.** Publicamos `estado` en `/me` con el argumento
   de que sin él el día 15 es indepurable, y **no tiene consumidor**. La secuencia real para el
   técnico: entra, la app carga, **todas las pantallas salen vacías, todo guardado falla, y no hay
   ni un aviso en ningún sitio**. Y la lista blanca solo entiende rutas `/api/…`, así que **la
   pantalla de configuración que monte el 4B tendrá su avatar y sus imágenes rotos** y nadie va a
   pensar en añadir la raíz de imágenes a esa lista.

## Y dos cosas para el día del despliegue

- **Un reloj que salta atrás convierte «he restablecido mi contraseña» en un bucle.** El sello de
  la contraseña y el `created_at` de la sesión salen de **dos lecturas distintas** del reloj de la
  aplicación. Si NTP corrige hacia atrás entre una y otra, el login responde 200 y **la siguiente
  petición da 401**, en bucle hasta que el reloj alcance el sello — y como el reset revoca todas
  las sesiones antes, no hay nada a lo que volver. *Dirección: sellar desde `now()` de la base.*
- **El orden del despliegue pasa a ser crítico, sin guardia y sin fallo legible.** Las consultas
  nombran las columnas nuevas explícitamente y las migraciones ya no corren al arrancar el
  contenedor. Si el paso previo no se ejecuta, la imagen nueva arranca contra el esquema viejo y
  **cada petición autenticada da 500**. El 4A es el primer arco cuyo código nuevo no sirve ni una
  petición contra el esquema anterior.
