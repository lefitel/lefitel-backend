import { QueryInterface, QueryTypes } from "sequelize";

// The nine indexes that existed only because somebody typed them into a
// terminal.
//
// `docs/ARCHITECTURE.md` has carried a warning about these for weeks: they were
// created by hand against the running server, and that document was the only
// place they existed. This migration is task E1 of the API standard, and what it
// buys is **provenance** — the nine stop being prose and become something
// declared, versioned and checkable.
//
// It is worth being exact about what it does *not* buy, because the warning in
// that document overstates it and the spec repeated the overstatement. It says a
// fresh database would have none of them. True, and unreachable: no migration in
// this repository creates the base tables either — the oldest one already calls
// `addColumn("obs", …)` — and the `sync({ alter: true })` that used to create
// them is gone. So `npm run migrate` against an empty database dies long before
// it gets here, and the only two ways to stand up a new environment are a
// `pg_dump` restore, which brings the indexes along, or nothing. The gap this
// closes is knowledge, not a broken deployment.
//
// **Every name here was read out of the database on 4 September, byte for
// byte**, and two of them are not what the document's SQL block appears to say:
//
//   - `idx_postes_ciudada` and `idx_postes_ciudadb` are **lower case**. The
//     document writes `idx_postes_ciudadA`, unquoted — which is how they were
//     created, and Postgres folds an unquoted identifier to lower case. Quoting
//     that name here, which is what `queryInterface.addIndex` does and what the
//     sibling migration does, would look for `idx_postes_ciudadA`, not find it,
//     and **create a second index over the same column**: four indexes on
//     `postes` where there are two, half of them useless, slowing every write to
//     the pole register for good.
//   - `idx_reviciones_id_evento` keeps its misspelling. The table is `revicions`
//     and the index says `reviciones`: two different typos, so the index does
//     not in fact name its table, whatever the document says. Correcting it to
//     `idx_revicions_id_evento` — which is the convention the authorship
//     migration set — would create the same duplicate for the same reason. A
//     rename is `ALTER INDEX`, in its own migration, never a second `CREATE`.
//
// **`IF NOT EXISTS` here, and deliberately not in
// `20260903000002-index-bitacora-author.ts`.** That one creates an index that
// has never existed, so a name collision means something is wrong and the deploy
// should stop. These nine are known to exist already: failing on them is failing
// every time. The asymmetry has a cost, though — `IF NOT EXISTS` matches on the
// name and never on the definition — and the check at the bottom of `up()` is
// what pays it: after the creations, the real column list of all nine is read
// back and compared. So the migration is idempotent by name and loud by
// definition, which is the only combination that is honest here.

/** The nine, as they exist. `columnas` is the real column list, in order. */
export const INDICES = [
  // The correlated subquery behind every pole's pending-incident count
  // (`poste.controller.ts`), which runs once per pole in the list.
  { nombre: "idx_eventos_poste_state_deleted", tabla: "eventos", columnas: ["id_poste", "state", "deletedAt"] },
  // The Archivados tab, which asks for `deletedAt IS NOT NULL` — a small
  // fraction of the table, which is what makes a plain index on this column
  // worth having. Not the paranoid queries, which ask for `IS NULL` and match
  // nearly everything; the comment in `ARCHITECTURE.md` has that backwards.
  { nombre: "idx_eventos_deleted", tabla: "eventos", columnas: ["deletedAt"] },
  { nombre: "idx_eventos_id_usuario", tabla: "eventos", columnas: ["id_usuario"] },
  { nombre: "idx_postes_deleted", tabla: "postes", columnas: ["deletedAt"] },
  // Lower case on purpose. See the header.
  { nombre: "idx_postes_ciudada", tabla: "postes", columnas: ["id_ciudadA"] },
  { nombre: "idx_postes_ciudadb", tabla: "postes", columnas: ["id_ciudadB"] },
  // Misspelled on purpose. See the header.
  { nombre: "idx_reviciones_id_evento", tabla: "revicions", columnas: ["id_evento"] },
  { nombre: "idx_evento_obs_id_evento", tabla: "eventoObs", columnas: ["id_evento"] },
  { nombre: "idx_bitacora_created", tabla: "bitacoras", columnas: ["createdAt"] },
] as const;

const comillas = (identificador: string) => `"${identificador}"`;

/** `CREATE INDEX IF NOT EXISTS "x" ON public."t" ("a", "b")`. */
export const sentenciaDe = (i: (typeof INDICES)[number]) =>
  `CREATE INDEX IF NOT EXISTS ${comillas(i.nombre)} ON public.${comillas(i.tabla)} ` +
  `(${i.columnas.map(comillas).join(", ")})`;

/**
 * What the database really has under those nine names, columns in order.
 *
 * `indkey` is the ordered list of column numbers, so it has to be unnested with
 * its ordinality and joined back to `pg_attribute` — aggregating without the
 * order would call a two-column index correct with its columns the wrong way
 * round, and for a composite that is the difference between an index that serves
 * a query and one that does not.
 */
const VERIFICACION = `
  SELECT i.relname AS nombre,
         array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS columnas
    FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
   WHERE i.relname IN (${INDICES.map((i) => `'${i.nombre}'`).join(", ")})
   GROUP BY i.relname`;

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // The house rule, and here it is not a formality. `CREATE INDEX IF NOT
    // EXISTS` is **not** free when the index already exists: it takes a
    // `ShareLock` on the table before it looks the name up, and holds it until
    // the transaction commits. `ShareLock` blocks every INSERT, UPDATE and
    // DELETE — and one of these tables is `bitacoras`, which gains a row on
    // every login. So nine no-ops still means writes to five tables are held for
    // as long as this transaction lives. It lives for nine catalogue lookups,
    // which is milliseconds; the rule is to keep it that way and put nothing
    // else in here.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });
    // Bounds the other side of it: on an environment that is genuinely missing
    // one, this is a real build rather than a lookup.
    await queryInterface.sequelize.query("SET LOCAL statement_timeout = '60s'", { transaction });

    for (const indice of INDICES) {
      await queryInterface.sequelize.query(sentenciaDe(indice), { transaction });
    }

    // Not `CONCURRENTLY`, and not only because it cannot run in a transaction: a
    // concurrent build that fails leaves an INVALID index under the name, which
    // every later `IF NOT EXISTS` then skips while reporting success. A dead
    // index nobody rebuilds and a migration that swears everything is fine.

    const reales = await queryInterface.sequelize.query<{ nombre: string; columnas: string }>(
      VERIFICACION,
      { transaction, type: QueryTypes.SELECT },
    );
    const porNombre = new Map(reales.map((f) => [f.nombre, f.columnas]));
    const mal = INDICES.flatMap((i) => {
      const encontrado = porNombre.get(i.nombre);
      const esperado = i.columnas.join(",");
      if (encontrado === undefined) return [`${i.nombre}: no existe después de crearlo`];
      return encontrado === esperado ? [] : [`${i.nombre}: cubre (${encontrado}), se esperaba (${esperado})`];
    });
    if (mal.length > 0) {
      // Thrown inside the transaction, so nothing this migration did survives.
      // This is the case `IF NOT EXISTS` cannot see: a hand-made index under one
      // of these names covering different columns. Silently skipped, it would
      // leave the query it exists for scanning, and this file claiming otherwise.
      throw new Error(`índices con una definición distinta de la esperada:\n  ${mal.join("\n  ")}`);
    }
  });
}

/**
 * Deliberately does nothing, and that is not laziness.
 *
 * These nine existed in production *before* this migration ran, so a `down()`
 * that dropped them would destroy indexes it never created — at the worst
 * possible moment, which is a rollback with production under load. Losing
 * `idx_eventos_poste_state_deleted` alone turns the pole list into one
 * sequential scan of `eventos` per pole on the page.
 *
 * And there is no way for it to know better: `IF NOT EXISTS` does not report
 * whether it created anything, so `down()` cannot tell what it owns. Since
 * `up()` is idempotent, leaving them in place costs nothing — `down()` then
 * `up()` behaves exactly as `up()` alone does.
 *
 * The precedent is `20260822000002-add-authorship.ts`, whose `down()` documents
 * that it *is* destructive and asymmetric. Same standard applied, opposite
 * conclusion: an index left behind is a rollback that tidied up badly, an index
 * dropped is an outage.
 */
export async function down(_: { context: QueryInterface }) {
  return;
}
