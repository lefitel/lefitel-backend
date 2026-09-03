import { QueryInterface, DataTypes, QueryTypes, type Transaction } from "sequelize";

// One row per login code sent by email, and the fifth value `sesiones.mfa_source`
// may hold. Plan 4E, Task 1; design in
// `docs/specs/2026-09-03-correo-como-factor-y-relevo-de-correo-design.md` §5.
//
// **Why a table of its own and not a row in `token_uso_unico`.** That table
// stores SHA-256 of the token and carries a unique index on the hash. Both
// choices are right for a 32-byte bearer token and wrong for six digits: SHA-256
// over a million possible values is reversed from a dump in milliseconds, and a
// unique hash would make the mint fail the moment two people are handed the
// same six digits at once — with a million values and several accounts in
// flight, that happens. So this table holds bcrypt (as `codigo_recuperacion`
// does, for the same reason), no uniqueness on the hash, and a counter of
// attempts that the spend charges *before* comparing — see
// `auth/emailCodeStore.ts` for the one statement that does it.
//
// **The FK is RESTRICT, like every FK to `usuarios` since `20260804000001`.**
// `usuarios` is `paranoid: true`, so no row is ever really deleted and no
// CASCADE would ever fire; writing one here would read as cleanup that happens
// and does not. Nothing deletes these rows when an account is archived either
// — `deleteUsuario` archives the row and revokes sessions and remembered
// devices, and does not touch any factor table (the design's §5 says it does;
// it does not, and the plan's Task 1 said to note that rather than invent a
// deletion) — and nothing needs to: a code lives ten minutes. **Nothing sweeps
// this table yet**: Task 4 adds `purgarCodigosCaducados()`, called from the
// route that mints a code, the way `purgeExpiredTokens` rides the login.
//
// **The pending-code index is UNIQUE, and that is a rule, not an
// optimisation.** The design says "never two valid codes per account" and
// enforces it only in the mint's sequence (burn the previous, insert the new).
// Two mints for the same account in the same instant — a double click, two
// tabs, two processes — both read the same pending row, both burn it, both
// insert, and the spend's single `UPDATE … WHERE used_at IS NULL` then charges
// an attempt against two rows and returns two hashes; whichever code the
// person typed, the other one's attempt burns silently. `factor_totp.id_usuario`
// is unique for the same reason ("two rows would mean two secrets that both
// open the door"). With the index unique the second mint fails with a `23505`
// that `emailCodeStore.ts` reads as "somebody else just minted one" — same
// key, same predicate, no extra cost. The *hash* stays non-unique, for the
// opposite reason given above.
//
// **The CHECK on `sesiones.mfa_source` is recreated with `'correo'` added, as
// a plain `ADD CONSTRAINT … CHECK`, and a first draft of this header claimed
// something false about the alternative.** It said `NOT VALID` + `VALIDATE`
// "cannot time out" because `VALIDATE` scans under a weaker lock. Inside one
// transaction that is wrong twice: `ADD CONSTRAINT … NOT VALID` takes ACCESS
// EXCLUSIVE on `sesiones`, table locks are held until commit and never
// downgraded, so the `VALIDATE` that follows scans under that same lock —
// exactly what a plain `ADD CONSTRAINT` does; and `lock_timeout` aborts a
// statement *waiting* for a lock, never one scanning while holding it, so
// neither shape "times out" on the scan. The split only helps when `VALIDATE`
// runs in its own later transaction, which is the shape for a big table and
// not for this one: the widened constraint is satisfied by every existing row
// by construction, `sesiones` holds a few dozen rows, and the scan is
// microseconds under a lock this transaction holds anyway. So: the plain form,
// byte-for-byte the shape `20260826000002` used, plus the fifth word.
//
// **Two names not to change:** `sesiones_mfa_source_chk` is the constraint
// `20260826000002` created and its `down` drops with `IF EXISTS`; the index
// names below follow the `<tabla>_<columnas>_idx` rule `20260827000001`
// standardised across the arc — which is why the expiry index is
// `codigo_correo_expires_at_idx` and not the `codigo_correo_expira_idx` the
// design's §5 wrote: the design was wrong on the name, the rule wins.

const TABLA = "codigo_correo";
const RESTRICCION = "sesiones_mfa_source_chk";

/** What `20260826000002` allowed, in its order. */
const FUENTES_ANTES = ["passkey", "totp", "codigo", "dispositivo"] as const;
/** What this migration allows: the same, plus the email code. */
const FUENTES_AHORA = [...FUENTES_ANTES, "correo"] as const;

/** The CHECK body for a given list of sources — one place, so `up` and `down` cannot drift. */
function condicionDe(fuentes: readonly string[]): string {
  return `CHECK (mfa_source IS NULL OR mfa_source IN (${fuentes.map((f) => `'${f}'`).join(", ")}))`;
}

/**
 * Replace the constraint with one accepting `fuentes`: drop, then add. Shared
 * by `up` and `down`, so the two cannot drift; the header says why the plain
 * `ADD CONSTRAINT` and not the `NOT VALID` + `VALIDATE` pair.
 */
async function reemplazarRestriccion(
  queryInterface: QueryInterface,
  fuentes: readonly string[],
  transaction: Transaction,
): Promise<void> {
  await queryInterface.sequelize.query(`ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS ${RESTRICCION}`, {
    transaction,
  });
  await queryInterface.sequelize.query(
    `ALTER TABLE sesiones ADD CONSTRAINT ${RESTRICCION} ${condicionDe(fuentes)}`,
    { transaction },
  );
}

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a lock
    // should make the migration fail fast and get retried, not queue whatever
    // else is touching `usuarios` or `sesiones` behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.createTable(
      TABLA,
      {
        // INTEGER, not UUID: this id never reaches a client. The three factor
        // tables whose ids stay server-side use the same; only
        // `dispositivo_recordado` and `reto_webauthn`, whose ids travel, use UUID.
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        id_usuario: {
          type: DataTypes.INTEGER,
          allowNull: false,
          references: { model: "usuarios", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        // Where the code went. The spend compares it with `usuarios.email` in
        // the same statement that charges the attempt, so a code minted for an
        // address the account has since left is worth nothing — the same rule
        // `token_uso_unico.email_destino` carries for the verification link.
        email_destino: { type: DataTypes.STRING(255), allowNull: false },
        // bcrypt, 60 characters; same column, same name, same reasoning as
        // `codigo_recuperacion.codigo_hash`.
        codigo_hash: { type: DataTypes.STRING(60), allowNull: false },
        // Charged before the compare, by the statement that reads the hash. At
        // `EMAIL_CODE_MAX_ATTEMPTS` the same statement sets `used_at`, and from
        // then on no request obtains the hash — which is what makes "five
        // attempts per code" true for five requests arriving in the same tick.
        intentos: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        used_at: { type: DataTypes.DATE, allowNull: true },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          // `sequelize.literal("now()")` and **not** `DataTypes.NOW`: Sequelize
          // 6.37.8 drops the latter from `createTable` without a word — measured
          // in `20260827000001`. Only the literal survives into the SQL.
          defaultValue: queryInterface.sequelize.literal("now()"),
        },
      },
      { transaction },
    );

    // The spend reads "the pending code of this account". Partial, because a
    // spent code is the common row and the index should hold only what the
    // `WHERE` can match; UNIQUE, because "one pending code per account" is
    // the rule — the header says what two would do. Raw SQL: `addIndex` can
    // express a WHERE, but `20260825000001` set the precedent of writing
    // partial indexes plainly.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX ${TABLA}_pendiente_idx ON ${TABLA} (id_usuario) WHERE used_at IS NULL`,
      { transaction },
    );
    // The cooldown and the hourly and daily caps count this account's rows by
    // `created_at`; both columns in one index so the count is index-only.
    await queryInterface.addIndex(TABLA, {
      fields: ["id_usuario", "created_at"],
      name: `${TABLA}_cuenta_creado_idx`,
      transaction,
    });
    // The purge sweeps by expiry, like `token_uso_unico_expires_at_idx`.
    await queryInterface.addIndex(TABLA, {
      fields: ["expires_at"],
      name: `${TABLA}_expires_at_idx`,
      transaction,
    });

    await reemplazarRestriccion(queryInterface, FUENTES_AHORA, transaction);
  });
}

/**
 * Drops the table and narrows the constraint back — **unless a session already
 * carries `'correo'`.**
 *
 * Narrowing the CHECK with such a row present would fail with Postgres's own
 * message, which names a constraint and not what to do. The guard runs first
 * and says which rows are in the way and the statement that removes them.
 * Those sessions are live logins by email code; deleting them logs those
 * people out, which is the honest cost of taking the value away.
 *
 * **The guard has the race `20260826000003`'s `down` documents, and here it is
 * left open on purpose.** The count runs under ACCESS SHARE; a session with
 * `'correo'` committed between the count and the `ALTER` is not seen by the
 * guard. What that costs is the difference between this message and
 * Postgres's: the `ADD CONSTRAINT` still checks every row, the transaction
 * aborts, nothing is dropped. That migration took `LOCK TABLE` first because
 * losing its race destroyed TOTP secrets; losing this one costs a sentence.
 *
 * The table itself is dropped without a data guard, unlike `20260826000003`'s:
 * what it holds are ten-minute codes, and losing them fails a handful of
 * logins that succeed on the next attempt.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    const [fila] = (await queryInterface.sequelize.query(
      "SELECT count(*) AS filas FROM sesiones WHERE mfa_source = 'correo'",
      { transaction, type: QueryTypes.SELECT },
    )) as unknown as { filas: string | number }[];
    // `Number(...)`: `count(*)` is a BIGINT and node-postgres hands it back as a
    // string. The comparison below would coerce it anyway; what must not be
    // written is `if (fila.filas)` — `"0"` is truthy — and the message should
    // print a number, not a quoted string.
    const conCorreo = Number(fila?.filas ?? 0);
    if (conCorreo > 0) {
      throw new Error(
        `Deshacer esta migración deja ${conCorreo} sesión(es) con mfa_source = 'correo', ` +
          "que la restricción anterior no admite. Si de verdad tiene que deshacerse: " +
          "DELETE FROM sesiones WHERE mfa_source = 'correo'; y vuelve a ejecutar el down. " +
          "Esas personas tendrán que volver a entrar.",
      );
    }

    await reemplazarRestriccion(queryInterface, FUENTES_ANTES, transaction);
    await queryInterface.dropTable(TABLA, { transaction });
  });
}
