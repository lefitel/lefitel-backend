// The tramo migration against a real PostgreSQL holding a copy of the data.
//
// **Only against a throwaway database, and never by accident.** It drops two
// columns from `postes`. The database the rest of the suite reads is shared by
// every session working in this tree, so this asks for one called exactly
// `probe_tramos` and is skipped — loudly — anywhere else. That database is a
// scratch PostgreSQL that must be a restore of a dump of the local data taken
// BEFORE this migration (`pg_restore --no-owner --no-acl` into an empty
// database), because the test runs `up` itself, once. Then:
//
//   PG_DATABASE=probe_tramos PG_USER=postgres PG_PASS=probe PG_IP=127.0.0.1 \
//     PG_PORT=55434 npx vitest run src/tramos/tramos.db.test.ts
//
// **With `PG_DATABASE=probe_tramos` it never skips quietly.** A database with no
// `postes` table (a restore that did not happen) or one already migrated fails
// the file, because a green exit would then say nothing about the migration.
// `TRAMOS_DB_YA_MIGRADA=1` is the explicit opt-out for the second case, for
// running the rest of the suite on a migrated `probe_tramos`; it skips, loudly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sequelize } from "../database/sequelize.js";
import { up, FUSIONES, RESTRICCIONES } from "../migrations/20261010000005-create-tramos.js";
import { nombreDeTramo, sqlNombreDeTramo } from "./nombre.js";

const esProbe = process.env.PG_DATABASE === "probe_tramos";

// What `postes` looks like decides everything. Once the migration has run
// (`npm run migrate` on the same database, which is what a full suite needs for
// every other test) there is nothing left to migrate: `up` would stop at its
// orphan check, which reads `id_ciudadA`, after having opened its transaction
// and read the cities.
const estadoDePostes = esProbe
  ? await (async () => {
    const columnas = (await sequelize.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'postes'`,
    ))[0] as { column_name: string }[];
    if (columnas.length === 0) return "sin-postes";
    return columnas.some((c) => c.column_name === "id_ciudadA") ? "sin-migrar" : "migrada";
  })()
  : undefined;
const yaMigradaAceptada = process.env.TRAMOS_DB_YA_MIGRADA === "1";

if (esProbe && estadoDePostes === "sin-postes") {
  await sequelize.close();
  throw new Error(
    "tramos.db: `probe_tramos` no tiene la tabla `postes`: falta restaurar el volcado anterior a la migración 20261010000005 (reset-probe.sh).",
  );
}
if (esProbe && estadoDePostes === "migrada" && !yaMigradaAceptada) {
  await sequelize.close();
  throw new Error(
    "tramos.db: `probe_tramos` ya está migrada y esta suite necesita la copia anterior a la migración 20261010000005 (reset-probe.sh). " +
    "Si solo quieres el resto de la suite sobre una base migrada, pon TRAMOS_DB_YA_MIGRADA=1: esta suite se salta y NO comprueba la migración.",
  );
}

const habilitado = estadoDePostes === "sin-migrar";

if (!esProbe) {
  console.warn("\n  !! tramos.db: sin la base desechable `probe_tramos`. Nada comprueba la migración contra PostgreSQL.\n");
} else if (!habilitado) {
  console.warn("\n  !! tramos.db: TRAMOS_DB_YA_MIGRADA=1 — `probe_tramos` ya está migrada y esta suite se salta. Nada comprueba la migración contra PostgreSQL.\n");
}

const filas = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
  (await sequelize.query(sql))[0] as T[];
const numero = async (sql: string) => Number((await filas<{ n: string }>(sql))[0].n);
const codigoDe = async (sql: string): Promise<string | undefined> => {
  try {
    await sequelize.query(sql);
    return undefined;
  } catch (error) {
    const e = error as { parent?: { code?: string; constraint?: string } };
    return `${e.parent?.code}:${e.parent?.constraint ?? ""}`;
  }
};

const mapa = (c: string) =>
  `(CASE ${c} ${FUSIONES.map((f) => `WHEN ${f.pierde} THEN ${f.gana}`).join(" ")} ELSE ${c} END)`;

describe.skipIf(!habilitado)("create-tramos against PostgreSQL", () => {
  let postesAntes = 0;
  let paresEsperados = 0;

  beforeAll(async () => {
    postesAntes = await numero("SELECT count(*) AS n FROM postes");
    paresEsperados = await numero(
      `SELECT count(*) AS n FROM (SELECT DISTINCT LEAST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}),
              GREATEST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}) FROM postes) x`,
    );
    // What each pole had, kept aside: after `up` the columns are gone.
    await sequelize.query("DROP TABLE IF EXISTS _antes");
    await sequelize.query(
      `CREATE TABLE _antes AS SELECT id, LEAST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}) AS a,
              GREATEST(${mapa('"id_ciudadA"')}, ${mapa('"id_ciudadB"')}) AS b FROM postes`,
    );
    await up({ context: sequelize.getQueryInterface() });
  });

  afterAll(async () => {
    await sequelize.query("DROP TABLE IF EXISTS _antes");
    await sequelize.close();
  });

  it("loses no pole and leaves none without a tramo", async () => {
    expect(await numero("SELECT count(*) AS n FROM postes")).toBe(postesAntes);
    expect(await numero('SELECT count(*) AS n FROM postes WHERE "id_tramo" IS NULL')).toBe(0);
  });

  it("gives every pole the tramo of the two cities it had", async () => {
    expect(await numero(
      `SELECT count(*) AS n FROM postes p JOIN _antes x ON x.id = p.id JOIN tramos t ON t.id = p."id_tramo"
        WHERE t.id_ciudad_min <> x.a OR t.id_ciudad_max <> x.b`,
    )).toBe(0);
  });

  it("makes one tramo per pair and no more", async () => {
    expect(await numero("SELECT count(*) AS n FROM tramos")).toBe(paresEsperados);
  });

  it("has dropped the two columns", async () => {
    const columnas = await filas<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'postes'",
    );
    const nombres = columnas.map((c) => c.column_name);
    expect(nombres).toContain("id_tramo");
    expect(nombres).not.toContain("id_ciudadA");
    expect(nombres).not.toContain("id_ciudadB");
  });

  it("archived the five duplicates and left their twins alive", async () => {
    const perdedoras = FUSIONES.map((f) => f.pierde).join(", ");
    const ganadoras = FUSIONES.map((f) => f.gana).join(", ");
    expect(await numero(`SELECT count(*) AS n FROM ciudads WHERE id IN (${perdedoras}) AND "deletedAt" IS NOT NULL`)).toBe(5);
    expect(await numero(`SELECT count(*) AS n FROM ciudads WHERE id IN (${ganadoras}) AND "deletedAt" IS NULL`)).toBe(5);
    expect(await numero(`SELECT count(*) AS n FROM tramos WHERE id_ciudad_min IN (${perdedoras}) OR id_ciudad_max IN (${perdedoras})`)).toBe(0);
  });

  it("left no city name with stray spaces", async () => {
    expect(await numero(`SELECT count(*) AS n FROM ciudads WHERE name <> btrim(regexp_replace(name, '\\s+', ' ', 'g'))`)).toBe(0);
  });

  it("seeded nine departments", async () => {
    expect(await numero("SELECT count(*) AS n FROM departamentos")).toBe(9);
  });

  it("refuses a reversed pair, a single city and a repeated pair — each by its own constraint", async () => {
    const [{ a, b }] = await filas<{ a: number; b: number }>(
      "SELECT id_ciudad_min AS a, id_ciudad_max AS b FROM tramos ORDER BY id LIMIT 1",
    );
    const insertar = (min: number, max: number) =>
      `INSERT INTO tramos (id_ciudad_min, id_ciudad_max, "createdAt", "updatedAt") VALUES (${min}, ${max}, now(), now())`;
    expect(await codigoDe(insertar(b, a))).toBe(`23514:${RESTRICCIONES.orden}`);
    expect(await codigoDe(insertar(a, a))).toBe(`23514:${RESTRICCIONES.orden}`);
    expect(await codigoDe(insertar(a, b))).toBe(`23505:${RESTRICCIONES.parUnico}`);
  });

  it("still refuses the repeated pair when the first one is archived", async () => {
    const [{ id, a, b }] = await filas<{ id: number; a: number; b: number }>(
      "SELECT id, id_ciudad_min AS a, id_ciudad_max AS b FROM tramos ORDER BY id DESC LIMIT 1",
    );
    await sequelize.query(`UPDATE tramos SET "deletedAt" = now() WHERE id = ${id}`);
    expect(await codigoDe(
      `INSERT INTO tramos (id_ciudad_min, id_ciudad_max, "createdAt", "updatedAt") VALUES (${a}, ${b}, now(), now())`,
    )).toBe(`23505:${RESTRICCIONES.parUnico}`);
    await sequelize.query(`UPDATE tramos SET "deletedAt" = NULL WHERE id = ${id}`);
  });

  it("names every tramo the same in SQL and in TypeScript", async () => {
    const todos = await filas<{ nombre: string; a_id: number; a_name: string | null; b_id: number; b_name: string | null }>(
      `SELECT ${sqlNombreDeTramo("t", "a", "b")} AS nombre, a.id AS a_id, a.name AS a_name, b.id AS b_id, b.name AS b_name
         FROM tramos t LEFT JOIN ciudads a ON a.id = t.id_ciudad_min LEFT JOIN ciudads b ON b.id = t.id_ciudad_max`,
    );
    expect(todos.length).toBeGreaterThan(50);
    const distintos = todos.filter((t) =>
      t.nombre !== nombreDeTramo({ id: t.a_id, name: t.a_name }, { id: t.b_id, name: t.b_name }));
    expect(distintos).toEqual([]);
  });

  it("leaves no two tramos with the same name", async () => {
    expect(await filas(
      `SELECT ${sqlNombreDeTramo("t", "a", "b")} AS nombre, count(*) FROM tramos t
         LEFT JOIN ciudads a ON a.id = t.id_ciudad_min LEFT JOIN ciudads b ON b.id = t.id_ciudad_max
        GROUP BY 1 HAVING count(*) > 1`,
    )).toEqual([]);
  });
});
