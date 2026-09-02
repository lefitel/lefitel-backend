import { QueryInterface, DataTypes } from "sequelize";

// Hallazgo B7 🔴, measured. This is the only migration Plan 4B needs — the
// four factor tables already exist from 4A — and the reason it exists is not
// the column, it is the index the column makes possible.
//
// **The number that justifies this, measured against the real library:** ten
// `bcryptjs.compare` calls at cost 12 take 2646 ms, and during that window
// only 31 of roughly 264 event-loop ticks of 10 ms got to run — the process
// sits idle-loop-starved at 88%. Five attempts is 12.4 s of CPU. Against the
// existing bucket of ten logins per fifteen minutes, that is 124 seconds of a
// stopped server per IP per quarter hour; two or three IPs make the whole ERP
// unusable. **No code has to be guessed for this to happen.** This is not a
// brute-force cost — it is a denial of service that a single wrong password
// buys, and nothing else has to go right for the attacker.
//
// The natural implementation of "check a recovery code" — SELECT the ten
// outstanding rows for the account, loop `bcryptjs.compare` against each,
// UPDATE the one that matched — *is* the attack. That is why this fix goes
// **before** the code that verifies a recovery code (Tasks 10 and 11), not
// after it: writing the loop first and narrowing the lookup later leaves the
// hole live for however long that gap lasts.
//
// **`prefijo` is plaintext on purpose, and this is not a leak.** It is the
// first eight characters of the code, stored unhashed next to a `codigo_hash`
// that still covers the ENTIRE code, prefix included. Whoever walks off with
// this table gains nothing usable from the prefix alone — the remaining bits
// are exactly as protected by bcrypt as they were before this column existed;
// to use the code they still need what `codigo_hash` still guards. What the
// prefix buys is that "does this account have an outstanding code starting
// with these eight characters" becomes an index lookup instead of a table
// scan: verification becomes `SELECT ... WHERE id_usuario = ? AND prefijo =
// ?` — at most one candidate row — and one `bcryptjs.compare`, not ten.
//
// **It also closes a timing leak nobody had to ask for separately.** The
// natural "loop the ten, return on the first match" implementation reveals,
// through response time, roughly how many codes an account has left: one
// code left answers fast on a hit and slow on its one miss, while ten codes
// take about the same wall time whether the first guess lands or not. A
// lookup that narrows to a single candidate before any `compare` ever runs
// erases that signal by construction, with nothing to remember at the call
// site. Anyone who reintroduces a loop over several `codigo_recuperacion`
// rows here reopens both problems without noticing either one — there is no
// test outside this comment that can catch a timing side-channel from the
// outside.
//
// **Zero rows exist in this table today.** Nothing in `src/` writes to
// `codigo_recuperacion` yet — `recoveryCodeStore.ts` is Task 10 of this same
// plan, still to come — so this is the cheap kind of schema change: no
// backfill, and a `NOT NULL` column with no default is safe to add outright.
// If that assumption is ever wrong by the time this runs, Postgres refuses
// the `ADD COLUMN` itself (`column "prefijo" contains null values`) instead
// of doing anything silent — the constraint already is the guard, so this
// migration does not need a separate one.
//
// Format validation ("does this even look like a code") belongs to
// `recoveryCodeStore.ts`, not here — that module does not exist yet either,
// and it is free, so it is not a reason to hold this migration back.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a
    // lock should make the migration fail fast and get retried, not queue
    // whatever else is touching this table behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.addColumn(
      "codigo_recuperacion",
      "prefijo",
      { type: DataTypes.CHAR(8), allowNull: false },
      { transaction },
    );

    // Composite, not two single-column indexes: every lookup this column
    // exists for filters by both at once (`WHERE id_usuario = ? AND prefijo
    // = ?`), and one composite index serves that in a single pass where two
    // separate indexes would make Postgres intersect bitmaps for no benefit.
    await queryInterface.addIndex("codigo_recuperacion", {
      fields: ["id_usuario", "prefijo"],
      name: "codigo_recuperacion_id_usuario_prefijo_idx",
      transaction,
    });
  });
}

/**
 * Drops the index and the column, in the opposite order they arrived.
 *
 * No empty-table refusal here, unlike `20260826000003-create-factor-tables.ts`'s
 * guard on the tables themselves: `prefijo` is a derived value, not a secret
 * that exists nowhere else. Losing it costs nothing a `factor_totp` row would
 * — the codes it prefixes stay exactly as protected by `codigo_hash` with the
 * column gone; they just go back to being checked ten at a time, the way they
 * were before this migration, until it runs again.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.removeIndex(
      "codigo_recuperacion",
      "codigo_recuperacion_id_usuario_prefijo_idx",
      { transaction },
    );
    await queryInterface.removeColumn("codigo_recuperacion", "prefijo", { transaction });
  });
}
