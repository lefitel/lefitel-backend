import { QueryInterface } from "sequelize";

// An index on the audit log's author column, which three queries need and none
// had.
//
// `bitacoras` is indexed by `createdAt` and by `entity_id`, and by nothing else.
// Every question of the form "what did this person do" therefore reads the whole
// table:
//
//   - `getBitacora` — `WHERE id_usuario = ? ORDER BY id DESC LIMIT 50`, the
//     activity list on the profile page and on every user's detail sheet.
//   - `getAllBitacora` filtered by author — the same shape, plus paging.
//   - `getAutoresBitacora` — the semi-join behind the screen's author dropdown.
//
// Measured against the current data before writing this: 3.438 rows, and the
// planner costs a sequential scan of them at 103.65 for every one of the three.
// That is cheap today and does not stay cheap — this table is the one thing in
// the schema that only ever grows, and nothing prunes it. It gains a row on
// every login, every failed login, every password confirmation and every write
// to any of the thirteen entities.
//
// **Two columns and not one, because the first two queries are not the third.**
// A plain index on `id_usuario` answers `getAutoresBitacora` well — probe once
// per account, stop at the first row — and answers the other two badly: they ask
// for the newest fifty entries of one person, so Postgres would have to read
// *every* row that person ever wrote and sort it to find them. For a prolific
// author it may skip the index entirely and walk the primary key backwards
// instead. With `id` in the index, the fifty come off it already ordered, and
// the leading column still serves the semi-join. The first version of this
// migration indexed one column and justified itself with all three queries;
// its own post-audit is what caught that.

/** Named after the table and the leading column, like `idx_bitacoras_entity_id`. */
const INDEX = "idx_bitacoras_id_usuario";

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // The house rule for every migration here: fail fast rather than queue every
    // request behind a lock wait.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    // Deliberately **not** `IF NOT EXISTS`, which is what this said first.
    //
    // The reason given then was that a failing migration crash-loops the
    // container, and that is not true here: `Dockerfile` takes the migration out
    // of `CMD` on purpose — "if it fails, the deploy aborts and the previous
    // version stays up" — precisely because it once did crash-loop. So failure
    // is already the safe direction, and it should be loud.
    //
    // And `IF NOT EXISTS` compares the *name*, never the definition. This
    // schema's nine hand-made indexes are documented in `docs/ARCHITECTURE.md`,
    // and one of them is `idx_bitacora_created` — singular table, so the naming
    // by hand does not match this file's. A hand-made index under this exact
    // name over some other column would therefore be the one case `IF NOT
    // EXISTS` hides: it would report success and leave all three queries
    // scanning, which is the same blindness the test beside this file exists to
    // remove. Failing the deploy and being looked at is the better trade.
    //
    // Not `CONCURRENTLY` either, which cannot run inside a transaction: this
    // table is small enough that a plain build holds its lock for a moment, and
    // giving up the transaction would mean an index that can be left half-built.
    await queryInterface.sequelize.query(
      `CREATE INDEX "${INDEX}" ON "bitacoras" ("id_usuario", "id" DESC)`,
      { transaction },
    );
  });
}

export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    // `IF EXISTS` here and not above, and the asymmetry is the point: rolling
    // back is already the unhappy path, and an index somebody dropped by hand
    // must not be what stops it.
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${INDEX}"`, { transaction });
  });
}
