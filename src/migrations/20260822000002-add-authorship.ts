import { QueryInterface, DataTypes } from "sequelize";

/**
 * Who wrote each inspection and each repair.
 *
 * `revicions` and `solucions` were the only two work tables with no author at
 * all: an event knows who registered it, a pole knows who filed it, but the
 * 7.741 inspections and 1.071 repairs — the actual volume of field work — knew
 * only their date. So "who inspects the most" was not a hard query, it was an
 * unanswerable one, and every day that passed added rows that could never be
 * attributed. The column is the point; the backfill below is what can be
 * salvaged of the past, which is much less than the future.
 *
 * ── The backfill, and what it can honestly recover ──────────────────────────
 *
 * The bitácora records the author of an action but keys `entity_id` to the
 * *event*, not to the row that was created — so there is no join on a primary
 * key to be had. What identifies a row is therefore (event, moment): a bitácora
 * entry for the same event, written within seconds of the row.
 *
 * Be clear about what that rule says, because it is not quite the question
 * being asked. It says **who touched this event at that moment**, not who wrote
 * this row. Two of the four actions below are also logged by code paths that
 * write nothing: `resolverEvento` logs `RESOLVE_EVENTO` on any pendiente→resuelto
 * transition, and `createEvento` logs `CREATE_EVENTO` even when the request
 * carries no inline revision. So an entry can be evidence for a row that does
 * not exist, and if a different person acted on the same event inside the
 * window, a row would be signed by the wrong one.
 *
 * Measured, that exposure is one entry: of 513 `RESOLVE_EVENTO` entries, 512
 * sit within two seconds of a real `solucions` row. And no row in either table
 * has a *foreign* action inside a two-second window — see the window note
 * below. The mechanism is real; the exposure in this data is not, and the
 * narrow window is what keeps it that way.
 *
 * Two actions create each kind of row, not one, and the second is easy to miss
 * because a different endpoint writes it inline:
 *
 *  - a revision: `ADD_REVISION` (POST /revision) finds 1.319 on its own;
 *    `CREATE_EVENTO` adds the 26 that `createEvento` writes inline.
 *  - a repair: `RESOLVE_EVENTO` (PUT /evento/:id/resolver) finds 512 on its own
 *    and `CREATE_SOLUCION` (POST /solucion) adds exactly 1. Reading only the
 *    obvious `CREATE_SOLUCION` would have found 171 of 513 — a third of what is
 *    there — because the old flow was POST /solucion *followed by* closing the
 *    event, so nearly every repair has a `RESOLVE_EVENTO` beside it.
 *
 * ── The window: two seconds, and every number here is measured ──────────────
 *
 * The first version used thirty seconds, justified by measuring 30s, 1min and
 * 5min — all of which recover the same rows, so wider was clearly pointless.
 * Measuring *downwards* is what mattered and was not done:
 *
 *   window      attributed (rev/sol)   ambiguous   rows with a foreign
 *                                                  action inside the window
 *   0.5s–5s     1.345 / 513            0           0
 *   30s         1.345 / 513            0           123
 *
 * Thirty seconds recovers not one extra row, and is the only width that puts an
 * unrelated action (`UPDATE_EVENTO`, `REABRIR_EVENTO`) within reach of a row.
 * Two seconds sits inside the safe band with a second of headroom that the
 * floor of 0.5s does not have: a row and its bitácora entry are two statements
 * of one request, and a slow request can put them a second apart.
 *
 * Where the evidence is not unanimous the column stays null, which is the true
 * answer and not a gap to be filled with a guess.
 *
 * ── What it recovers here, in the two numbers that are not the same ─────────
 *
 * Measured against osefi_local. Quoting one of these for the other is how a
 * figure ends up being wrong in a meeting:
 *
 *                        rows filled          visible in a report
 *   revisiones           1.345 of 7.741       1.289 of 7.337
 *   soluciones             513 of 1.071         422 of   943
 *
 * The second column is smaller because 404 inspections and 81 repairs hang off
 * archived events, and a report rooted here drops them — see
 * requiredParentGuards. Per person, on both bases:
 *
 *                   filled (rev/sol)     in a report (rev/sol)
 *   Fisher            846 / 459            831 / 380
 *   Omar              439 /  50            433 /  41
 *   Miguel             60 /   4             25 /   1
 *
 * `npm run check:authorship` prints this against whatever database you point it
 * at, which is the only honest way to know: these figures describe one database
 * on one day, not a property of the migration.
 *
 * Either way it is a fifth of the two tables, **under two months** of a
 * two-year history (2026-03-18 to 2026-05-07, which is as far back as the
 * bitácora goes), and three accounts out of fifteen. So the null is not a gap
 * to be tidied away later: it is most of the data and it has to stay visible in
 * any report, or a table reading "Fisher: 831 revisiones" will be read as the
 * whole story when it is a tenth of it.
 *
 * ── Why the FK deletes to null, and what that does *not* buy ────────────────
 *
 * SET NULL rather than the CASCADE its two neighbours use
 * (`eventos.id_usuario`, `bitacoras.id_usuario`): the attribution is what may
 * be lost, the record is not — the inspection happened.
 *
 * But do not read more into it than it delivers. `eventos.id_usuario` is
 * CASCADE and `revicions.id_evento` is CASCADE, so hard-deleting a user still
 * deletes their events and every inspection hanging off them, whoever authored
 * those. 6.249 of 7.741 inspections sit on an event that has an author, so four
 * rows in five would go anyway. SET NULL is still the right rule for this
 * column; the chain above it is a separate defect, recorded in
 * docs/ESTADO-GENERADOR.md and not fixed here.
 */

/**
 * Actions whose handler creates a `revicions` row.
 *
 * Exported, along with the two below, for `scripts/check-authorship.mjs`. The
 * alternative was a second copy of the matching rule in the script that
 * verifies it, which can silently disagree with the rule that ran — and a
 * verification that can disagree with what it verifies is worse than none. A
 * future change to the rule is a new migration, so these stay put.
 */
export const REVISION_SOURCES = "('ADD_REVISION','CREATE_EVENTO')";
/** Actions whose handler creates a `solucions` row. */
export const SOLUCION_SOURCES = "('CREATE_SOLUCION','RESOLVE_EVENTO')";
/** How far from a row's own timestamp a bitácora entry may sit. See above. */
export const MATCH_WINDOW = "2 seconds";

/**
 * The author the bitácora points at, where it points at exactly one.
 *
 * `MIN(id_usuario)` under `HAVING COUNT(DISTINCT id_usuario) = 1` is not a
 * tie-break: the HAVING is what makes the MIN the only value there was. Two
 * people inside the same window leaves the row null on purpose.
 *
 * Split out from the UPDATE below so the verification script can select through
 * this exact rule rather than a paraphrase of it.
 */
export const candidates = (table: string, sources: string, window = MATCH_WINDOW) => `
    SELECT t."id" AS fila, MIN(b."id_usuario") AS id_usuario
      FROM ${table} t
      JOIN "bitacoras" b
        ON b."entity_id" = t."id_evento"
       AND b."action" IN ${sources}
       AND b."createdAt" >= t."createdAt" - interval '${window}'
       AND b."createdAt" <= t."createdAt" + interval '${window}'
     GROUP BY t."id"
    HAVING COUNT(DISTINCT b."id_usuario") = 1`;

/**
 * Fills the column, and only where it is empty.
 *
 * `WHERE t."id_usuario" IS NULL` is not redundant on a column created one
 * statement earlier. Umzug records a migration *after* `up()` resolves and
 * outside its transaction (see database/migrate.ts), so there is a window where
 * the work is committed and unrecorded: the process dies there, the next deploy
 * re-runs `up()`, and it dies on "column already exists". The natural repair is
 * `down()` then `up()` — and by then the application has been stamping real
 * authors on new rows for however long, which `down()` drops and a second
 * `up()` would replace with guesses from the bitácora. With this clause the
 * backfill is re-appliable and can never overwrite a known author with a
 * derived one.
 */
const backfill = (table: string, sources: string) => `
  WITH candidato AS (${candidates(table, sources)})
  UPDATE ${table} t
     SET "id_usuario" = c.id_usuario
    FROM candidato c
   WHERE t."id" = c.fila
     AND t."id_usuario" IS NULL`;

/**
 * A fresh spec per call, not one object passed twice.
 *
 * Sequelize's `normalizeAttribute` rewrites `attribute.type` in place rather
 * than on a copy, so a shared literal is aliased between the two ALTERs.
 * Harmless today — normalising an already-normalised type is a no-op — and not
 * worth leaving as a thing anybody has to reason about.
 */
const authorColumn = () => ({
  type: DataTypes.INTEGER,
  // Null is a real value here and always will be: it means nobody knows. A NOT
  // NULL with a default would have to name some account as the author of 6.396
  // inspections it did not carry out.
  allowNull: true,
  references: { model: "usuarios", key: "id" },
  onUpdate: "CASCADE",
  onDelete: "SET NULL",
});

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  // One transaction, same reasoning as the lockout migration: Postgres has
  // transactional DDL, and a failure part-way through would leave the columns
  // added but the migration unrecorded, so the next deploy re-runs `up` and
  // crash-loops on "column already exists". Here it also means the backfill
  // cannot land without its column or vice versa.
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Two different bounds, because they cover two different failures.
    //
    // `lock_timeout` bounds how long we WAIT for ACCESS EXCLUSIVE on tables the
    // event screen and every revision-rooted report read: better to fail fast
    // and retry when the database is quiet than to queue every request behind a
    // lock wait. `statement_timeout` bounds how long we HOLD it — the first
    // ALTER takes the lock and then two UPDATEs and three CREATE INDEXes run
    // with every read queued behind them. Sub-second on this data; the join
    // scans `bitacoras`, which only grows.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query("SET LOCAL statement_timeout = '60s'", { transaction });

    await queryInterface.addColumn("revicions", "id_usuario", authorColumn(), { transaction });
    await queryInterface.addColumn("solucions", "id_usuario", authorColumn(), { transaction });

    // Before the backfill, because the backfill joins on it. `bitacoras` had no
    // index on `entity_id` at all, so that join was a sequential scan of the
    // whole audit log, once per table, inside the exclusive lock above. It earns
    // its place independently of this migration: the bitácora screen filters by
    // `entity_id` (bitacora.controller.ts:16).
    await queryInterface.addIndex("bitacoras", ["entity_id"], {
      name: "idx_bitacoras_entity_id",
      transaction,
    });

    await queryInterface.sequelize.query(backfill('"revicions"', REVISION_SOURCES), { transaction });
    await queryInterface.sequelize.query(backfill('"solucions"', SOLUCION_SOURCES), { transaction });

    // Grouping by author is the whole point of the column, and both tables are
    // scanned by the report builder. Named after the table rather than after the
    // older `idx_reviciones_id_evento`, whose name misspells it.
    await queryInterface.addIndex("revicions", ["id_usuario"], {
      name: "idx_revicions_id_usuario",
      transaction,
    });
    await queryInterface.addIndex("solucions", ["id_usuario"], {
      name: "idx_solucions_id_usuario",
      transaction,
    });
  });
}

/**
 * Removes the column — and with it every author the application recorded.
 *
 * Worth saying plainly, because it is not symmetric with `up()`. The backfill
 * can be re-derived from the bitácora; an author the app stamped on a new row
 * cannot, because `bitacoras.entity_id` names the event and not the row, so
 * anything outside the window or inside a contested one comes back null and
 * stays null. Rolling this back a month after it ships throws away a month of
 * attribution that nothing else holds.
 *
 * There is deliberately no npm script for `down()`.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    await queryInterface.sequelize.query("SET LOCAL statement_timeout = '60s'", { transaction });
    // Dropping the column drops its index and its FK constraint with it, but
    // naming them explicitly keeps this readable as the inverse of up() and
    // survives someone later adding an index that is not attached to a column
    // being removed.
    await queryInterface.removeIndex("solucions", "idx_solucions_id_usuario", { transaction });
    await queryInterface.removeIndex("revicions", "idx_revicions_id_usuario", { transaction });
    await queryInterface.removeIndex("bitacoras", "idx_bitacoras_entity_id", { transaction });
    await queryInterface.removeColumn("solucions", "id_usuario", { transaction });
    await queryInterface.removeColumn("revicions", "id_usuario", { transaction });
  });
}
