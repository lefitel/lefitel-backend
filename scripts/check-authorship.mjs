// What the authorship backfill recovered, and what it left unknown.
//
// The migration that adds `id_usuario` to `revicions` and `solucions` fills it
// from the bitácora, and how much it can fill depends entirely on the data in
// front of it: the local database has a bitácora that starts in March 2026, and
// production's will not be the same shape. So the numbers written into the
// migration's own comment are a measurement of one database, not a promise —
// run this against the one you care about.
//
// Safe to run before the migration (it reports what *would* be recovered) and
// after (what was, plus a re-check that the two agree). Read-only either way:
// the session is set read-only before the first query, so a mistake below is
// refused by Postgres rather than trusted to code review.
//
//   npm run check:authorship
//
// It reads the same connection settings as the API — including a single
// DATABASE_URL, which is the shape production uses — and the matching rule from
// the migration itself, so it cannot drift from what actually ran.
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { REVISION_SOURCES, SOLUCION_SOURCES, MATCH_WINDOW, candidates } =
  await import("../src/migrations/20260822000002-add-authorship.ts");

/**
 * The same choice `src/database/sequelize.ts` makes, in the same order.
 *
 * The discrete PG_* variables win when complete, so a .env carrying both a
 * local database and a leftover remote URL points here at the local one. The
 * first version of this script read only the discrete variables, which meant
 * that against a production container — configured with DATABASE_URL alone — it
 * silently connected to localhost as the OS user and printed numbers for
 * whatever it found, under the heading `Base: undefined`. A verification tool
 * reporting on the wrong database is worse than one that fails.
 */
function connection() {
  if (process.env.PG_DATABASE && process.env.PG_USER) {
    return {
      label: `${process.env.PG_DATABASE} en ${process.env.PG_IP}:${process.env.PG_PORT}`,
      client: new pg.Client({
        host: process.env.PG_IP,
        port: Number(process.env.PG_PORT),
        database: process.env.PG_DATABASE,
        user: process.env.PG_USER,
        password: process.env.PG_PASS,
      }),
    };
  }
  if (process.env.DATABASE_URL) {
    // Hosted Postgres almost always requires TLS and almost never presents a
    // certificate this client can chain, which is the same bargain the API
    // makes through Sequelize's default for a URL connection.
    return {
      label: "DATABASE_URL",
      client: new pg.Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }),
    };
  }
  console.error(
    "Falta la configuración de la base de datos. " +
    "Define DATABASE_URL, o bien PG_DATABASE, PG_USER, PG_PASS, PG_IP y PG_PORT.",
  );
  process.exit(1);
}

const { label, client } = connection();
await client.connect();

try {
  // Belt and braces: everything below is a SELECT, and this makes that a
  // property of the session rather than a claim in a comment.
  await client.query("SET default_transaction_read_only = on");

  const one = async (sql) => (await client.query(sql)).rows[0];
  const all = async (sql) => (await client.query(sql)).rows;
  const n = (v) => Number(v).toLocaleString("es-BO");
  const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "—");

  /** The two tables, and the actions whose handlers write them. */
  const TABLES = [
    { table: "revicions", label: "revisiones", sources: REVISION_SOURCES },
    { table: "solucions", label: "soluciones", sources: SOLUCION_SOURCES },
  ];

  /**
   * Window widths to show, always including the one the migration uses.
   *
   * Derived rather than written out: a hardcoded list stops containing the real
   * window the moment somebody changes it, and the header would print the new
   * one beside a table that never mentions it — exactly the drift this file
   * claims it cannot have.
   */
  const windows = [...new Set(["0.5 seconds", "1 second", MATCH_WINDOW, "5 seconds", "30 seconds"])];

  const { presente } = await one(`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'revicions' AND column_name = 'id_usuario') AS presente`);

  console.log(`\nBase: ${label}`);
  console.log(`Ventana de emparejamiento: ${MATCH_WINDOW}`);
  console.log(
    presente
      ? "La columna id_usuario existe: se comprueba lo que hay y se contrasta con la regla.\n"
      : "La columna id_usuario NO existe todavía: se muestra lo que la migración recuperaría.\n",
  );

  for (const { table, label: tableLabel, sources } of TABLES) {
    // Two populations, and they are not the same number. `filas` is the whole
    // table, which is what the backfill writes to. `en_reporte` excludes rows
    // that are archived or hang off an archived event, which is what a report
    // rooted here can ever show (see requiredParentGuards). The first version of
    // this script printed one of each four lines apart, so they differed by 56
    // by construction and a real discrepancy would have been invisible.
    const rule = await one(`
      WITH candidato AS (${candidates(`"${table}"`, sources)}),
           vivas AS (
        SELECT t."id" FROM "${table}" t
         WHERE t."deletedAt" IS NULL
           AND EXISTS (SELECT 1 FROM "eventos" e
                        WHERE e."id" = t."id_evento" AND e."deletedAt" IS NULL)
      )
      SELECT (SELECT count(*)::int FROM "${table}") AS filas,
             (SELECT count(*)::int FROM vivas) AS en_reporte,
             (SELECT count(*)::int FROM candidato) AS regla_tabla,
             (SELECT count(*)::int FROM vivas v
               WHERE EXISTS (SELECT 1 FROM candidato c WHERE c.fila = v."id")) AS regla_reporte`);

    console.log(`── ${tableLabel} ${"─".repeat(Math.max(0, 58 - tableLabel.length))}`);
    console.log("                            en la tabla   en un reporte");
    console.log(
      `   filas ................... ${n(rule.filas).padStart(11)}   ${n(rule.en_reporte).padStart(13)}`,
    );
    console.log(
      `   la regla puede atribuir . ${n(rule.regla_tabla).padStart(11)}   ${n(rule.regla_reporte).padStart(13)}`,
    );
    console.log(
      `                             ${pct(rule.regla_tabla, rule.filas).padStart(11)}   ${pct(rule.regla_reporte, rule.en_reporte).padStart(13)}`,
    );

    if (presente) {
      const real = await one(`
        WITH candidato AS (${candidates(`"${table}"`, sources)})
        SELECT count(*) FILTER (WHERE t."id_usuario" IS NOT NULL)::int AS con_autor,
               count(*) FILTER (WHERE t."id_usuario" IS NULL)::int AS sin_autor,
               count(*) FILTER (WHERE c.id_usuario IS NOT NULL
                                  AND t."id_usuario" IS DISTINCT FROM c.id_usuario)::int AS discrepan,
               count(*) FILTER (WHERE c.id_usuario IS NULL
                                  AND t."id_usuario" IS NOT NULL)::int AS de_la_aplicacion
          FROM "${table}" t LEFT JOIN candidato c ON c.fila = t."id"`);
      console.log(`   con autor guardado ...... ${n(real.con_autor).padStart(11)}`);
      console.log(`   sin autor ............... ${n(real.sin_autor).padStart(11)}`);
      // These two are the only lines that compare like with like, so they are
      // the only ones worth alarming on.
      console.log(`   la regla dice otra cosa . ${n(real.discrepan).padStart(11)}  <- debe ser 0`);
      // Not an error: rows the app authored itself, which the bitácora rule
      // cannot reproduce. Expected to grow from zero after the migration ships.
      console.log(`   escritas por la app ..... ${n(real.de_la_aplicacion).padStart(11)}`);
    }

    // Why the window is what it is, re-measured rather than asserted. The last
    // column is the one that decided it: a foreign action inside the window is
    // how a row gets signed by somebody who did something else to that event.
    const sensitivity = await all(`
      WITH w(etiqueta, ancho) AS (VALUES ${windows.map((x) => `('${x}', interval '${x}')`).join(", ")})
      SELECT w.etiqueta,
             count(*) FILTER (WHERE m.autores = 1)::int AS unico,
             count(*) FILTER (WHERE m.autores > 1)::int AS ambiguo,
             count(*) FILTER (WHERE m.ajenas > 0)::int AS con_accion_ajena
        FROM w CROSS JOIN "${table}" t
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT b."id_usuario") FILTER (WHERE b."action" IN ${sources}) AS autores,
                 count(*) FILTER (WHERE b."action" NOT IN ${sources}) AS ajenas
            FROM "bitacoras" b
           WHERE b."entity_id" = t."id_evento"
             AND b."createdAt" BETWEEN t."createdAt" - w.ancho AND t."createdAt" + w.ancho
        ) m ON true
       GROUP BY w.etiqueta, w.ancho ORDER BY w.ancho`);
    console.log("\n   ventana        único   ambiguo   con acción ajena dentro");
    for (const row of sensitivity) {
      const mark = row.etiqueta === MATCH_WINDOW ? " *" : "  ";
      console.log(
        `  ${mark}${row.etiqueta.padEnd(13)} ${n(row.unico).padStart(6)} ${n(row.ambiguo).padStart(9)} ${n(row.con_accion_ajena).padStart(25)}`,
      );
    }
    console.log("");
  }

  // Who a per-person report would name, and how much of the work it accounts
  // for. Printed together on purpose: the first rows are unreadable without the
  // last one, which is the work nobody can be credited with.
  if (presente) {
    console.log("── quién aparece en un reporte por persona ───────────────────");
    // Grouped by id, never by name. There are two accounts called "Fernando"
    // and two called "AUDIT" in this database, so grouping by name would sum
    // two people into one line — the exact error this column exists to prevent,
    // committed by the tool that verifies it. Invisible today only because
    // neither Fernando has a row yet.
    const people = await all(`
      SELECT x.id_usuario,
             COALESCE(u."name" || ' ' || COALESCE(u."lastname", ''), '(sin autor)') AS autor,
             u."id" IS NOT NULL AND u."deletedAt" IS NOT NULL AS archivado,
             count(*) FILTER (WHERE origen = 'rev')::int AS revisiones,
             count(*) FILTER (WHERE origen = 'sol')::int AS soluciones
        FROM (
          SELECT 'rev' AS origen, r."id_usuario" FROM "revicions" r
           WHERE r."deletedAt" IS NULL
             AND EXISTS (SELECT 1 FROM "eventos" e WHERE e."id" = r."id_evento" AND e."deletedAt" IS NULL)
          UNION ALL
          SELECT 'sol', s."id_usuario" FROM "solucions" s
           WHERE s."deletedAt" IS NULL
             AND EXISTS (SELECT 1 FROM "eventos" e WHERE e."id" = s."id_evento" AND e."deletedAt" IS NULL)
        ) x LEFT JOIN "usuarios" u ON u."id" = x."id_usuario"
       GROUP BY x.id_usuario, 2, 3
       ORDER BY revisiones DESC, soluciones DESC`);

    const cuentas = await one(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE "deletedAt" IS NULL)::int AS vivas FROM "usuarios"`);

    console.log("   autor                          revisiones  soluciones");
    for (const p of people) {
      const name = (p.autor + (p.archivado ? " (archivado)" : "")).slice(0, 30).padEnd(30);
      console.log(`   ${name} ${n(p.revisiones).padStart(10)} ${n(p.soluciones).padStart(11)}`);
    }
    const named = people.filter((p) => p.id_usuario !== null).length;
    console.log(
      `\n   Aparecen ${named} personas. Hay ${n(cuentas.total)} cuentas, ${n(cuentas.vivas)} sin` +
      `\n   archivar — y la raíz Usuario del generador sólo puede mostrar esas.` +
      `\n   Los que no aparecen no es que no trabajaran: es que su trabajo cae` +
      `\n   fuera de lo que la bitácora puede atribuir.`,
    );
  }
} finally {
  // In a `finally` so a failing query closes the socket instead of leaving the
  // process to die on an unhandled rejection with the connection still open.
  await client.end();
}
