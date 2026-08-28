import { QueryInterface } from "sequelize";

// The corrections to the two MFA migrations of 2026-08-26, in a migration of
// their own.
//
// **Why a new file and not an edit.** Both of those have already run against
// the production copy. Editing an `up` that has run makes the source stop
// describing the database it built, and the next person to replay the history
// against a restored dump gets a different schema from the one in front of
// them. So `20260826000002` and `20260826000003` keep their `up` exactly as it
// executed; only their `down` gained a guard, because a `down` has not run.
//
// Five changes, and the first one is the one with teeth.
//
// **1. `sesiones.estado` loses its `DEFAULT 'completa'`.** That default was
// right for exactly one statement: the `ALTER TABLE` that added the column had
// to put something in the rows already there, and the sessions that existed
// were, in the only sense that existed then, complete. It expired when that
// statement committed, and nobody removed it.
//
// What it means now is that `estado` — which is the whole of what a session is
// allowed to do — has a value the database supplies when nobody says. That
// contradicts, at one file's distance, the decision `createSession` is built
// on: it refuses to take a default for `estado` on purpose, "so the compiler
// asks at each call site which state this login deserves". The compiler cannot
// ask a raw `INSERT`. The rescue script the specification plans, a seed, a
// `bulkInsert`, a `.create(...)` that forgets the field — each mints a session
// with the run of the whole ERP, with no error and no trace of the decision
// ever being taken.
//
// After this, an INSERT that names no `estado` fails on NOT NULL. Loud, at the
// moment of the mistake, instead of quiet and privileged.
//
// **2. `credential_id` gets a length.** It was `TEXT` under a unique btree, and
// a btree index tuple cannot exceed 2704 bytes. Measured on a scratch database
// at Postgres 18.2: 2700 characters of incompressible text are rejected with
// `el tamaño de fila de índice 2712 excede el máximo 2704`, which arrives at
// INSERT time, from the index, naming nothing a reader would connect to a
// passkey. ⚠️ And 8000 characters of the letter `a` are accepted — the index
// compresses them — so a test written with a repeated character proves nothing
// about this.
//
// 1364 is not a round number: the WebAuthn specification caps a credential id
// at 1023 bytes, and base64url of 1023 bytes is ceil(1023 / 3) * 4 = 1364
// characters. So the column now refuses exactly what the specification refuses,
// with `value too long for type character varying(1364)`, and the btree ceiling
// is no longer reachable at all.
//
// **3. The four `created_at` columns get a real `DEFAULT now()` — and so does
// `token_uso_unico`, whose own migration only thinks it has one.**
//
// This is where the audit's premise turned out to be wrong in an interesting
// way. The four factor tables were flagged for having no default "unlike
// `token_uso_unico` two migrations earlier". In the database they are
// identical: `token_uso_unico.created_at` has no default either. Its migration
// asks for `defaultValue: DataTypes.NOW` and carries a paragraph explaining
// why, and Sequelize 6.37.8 silently drops it. Verified by running its own
// `createTable` against a scratch database and reading back the SQL:
//
//     "con_now"     TIMESTAMP WITH TIME ZONE NOT NULL
//     "con_literal" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
//
// `DataTypes.NOW` produces no default; only `sequelize.literal("now()")` does —
// which is why `pass_changed_at`, written that way, is the one column in this
// arc whose default actually exists. So the fix is raw SQL, and it covers
// `token_uso_unico` too, because a comment that describes a safety net that is
// not there is worse than no comment.
//
// **The rule these five follow, since two of them point opposite ways:**
// default the facts, never the policy. `created_at` is a fact — the instant the
// row came into being — and the value a default supplies is always the right
// one, so a rescue script that forgets the column gets a correct timestamp
// instead of a NOT NULL violation. `estado` is a policy: the value a default
// supplies is a decision about privilege, and it is wrong whenever the caller
// had a different answer to give.
//
// **4. A partial index on `dispositivo_recordado.revoked_at`, which is what
// makes the `expires_at` index true.** `20260826000003` added
// `dispositivo_recordado (expires_at)` with the comment "the purge filters by
// this one". Task 9 then wrote the purge, and it filters by
// `expires_at < now() OR revoked_at < cutoff` — an OR across two columns, only
// one of them indexed, which Postgres answers with a sequential scan. With this
// index the plan becomes a BitmapOr over both, and only now is that comment's
// claim true.
//
// **What the index buys is latency, and only latency.** Measured on 100,000
// rows, twice, with the matching rows spread differently each time: 28.0 ms →
// 3.4 ms, and 23.6 ms → 5.2 ms. Buffer counts are *not* the reason and must not
// be quoted as one — an earlier version of this comment said 2124 → 1038, which
// was true of one distribution and not of the other, where they stayed flat
// (1640 → 1645). The heap blocks dominate either way; what the index removes is
// the filtering, not the reading.
//
// Partial (`WHERE revoked_at IS NOT NULL`) because a revoked device is the rare
// row: the index holds only what the second branch of the OR can match.
//
// At fifteen people this table will not reach 100,000 rows soon, and the seq
// scan costs nothing today. The index is worth its keep anyway — the table
// grows by one row per browser per "remember me" and shrinks only through this
// sweep, and an index whose comment says it is used should be used.
//
// **5. The four index names.** `addIndex` without a `name` lets Sequelize
// generate one, and it produced `dispositivo_recordado_expires_at` where the
// rest of this arc writes `sesiones_expires_at_idx` and
// `token_uso_unico_expires_at_idx`. Renamed to match. The `_key` indexes behind
// the UNIQUE constraints keep their names: that suffix is Postgres's own
// convention and the whole schema already follows it.

/** `ALTER INDEX <from> RENAME TO <to>`, for the four Sequelize named. */
const RENOMBRES: [string, string][] = [
  ["credencial_webauthn_id_usuario", "credencial_webauthn_id_usuario_idx"],
  ["codigo_recuperacion_id_usuario", "codigo_recuperacion_id_usuario_idx"],
  ["dispositivo_recordado_id_usuario", "dispositivo_recordado_id_usuario_idx"],
  ["dispositivo_recordado_expires_at", "dispositivo_recordado_expires_at_idx"],
];

/** Every table whose `created_at` should fill itself in when nobody says. */
const CON_CREATED_AT = [
  "credencial_webauthn",
  "factor_totp",
  "codigo_recuperacion",
  "dispositivo_recordado",
  // Not a factor table. Its own migration already claims this default in a
  // comment; this is where it becomes true. See the header.
  "token_uso_unico",
];

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a lock
    // should make the migration fail fast and get retried, not queue whatever
    // else is touching these tables behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ALTER COLUMN estado DROP DEFAULT",
      { transaction },
    );

    // A rewrite in principle, instant in practice: nothing in `src/` inserts
    // into this table yet, so it is empty everywhere this runs. The day it is
    // not, this is still only as long as the table.
    await queryInterface.sequelize.query(
      "ALTER TABLE credencial_webauthn ALTER COLUMN credential_id TYPE VARCHAR(1364)",
      { transaction },
    );

    for (const tabla of CON_CREATED_AT) {
      await queryInterface.sequelize.query(
        `ALTER TABLE ${tabla} ALTER COLUMN created_at SET DEFAULT now()`,
        { transaction },
      );
    }

    await queryInterface.sequelize.query(
      "CREATE INDEX dispositivo_recordado_revoked_at_idx " +
        "ON dispositivo_recordado (revoked_at) WHERE revoked_at IS NOT NULL",
      { transaction },
    );

    // No `IF EXISTS`: if one of these is not there, this database is not the
    // shape this migration was written against, and failing is the answer.
    for (const [desde, hacia] of RENOMBRES) {
      await queryInterface.sequelize.query(`ALTER INDEX ${desde} RENAME TO ${hacia}`, {
        transaction,
      });
    }
  });
}

/**
 * Puts the schema back exactly as `20260826000003` left it.
 *
 * Faithful rather than opinionated, including restoring `DEFAULT 'completa'` on
 * `sesiones.estado`: a `down` that improves on the state it reverts to is a
 * `down` whose dump no longer matches, and comparing dumps across a down/up/down
 * cycle is the only cheap proof a migration is reversible at all.
 *
 * ⚠️ **One direction cannot be reversed by SQL.** After this `down`,
 * `credential_id` is TEXT again and will accept a value longer than 1364
 * characters; re-running `up` with such a row present fails with `value too long
 * for type character varying(1364)`. That failure is correct — it names a row
 * the WebAuthn specification says cannot exist — and it is loud, which is the
 * whole point of the column having a length.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    for (const [desde, hacia] of RENOMBRES) {
      await queryInterface.sequelize.query(`ALTER INDEX ${hacia} RENAME TO ${desde}`, {
        transaction,
      });
    }

    await queryInterface.sequelize.query(
      "DROP INDEX dispositivo_recordado_revoked_at_idx",
      { transaction },
    );

    for (const tabla of CON_CREATED_AT) {
      await queryInterface.sequelize.query(
        `ALTER TABLE ${tabla} ALTER COLUMN created_at DROP DEFAULT`,
        { transaction },
      );
    }

    await queryInterface.sequelize.query(
      "ALTER TABLE credencial_webauthn ALTER COLUMN credential_id TYPE TEXT",
      { transaction },
    );

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ALTER COLUMN estado SET DEFAULT 'completa'",
      { transaction },
    );
  });
}
