// What a reader cannot see by reading the migration once: that it looks before
// it changes anything, that nothing is dropped before every pole has been
// checked against its tramo, and that every statement rides one transaction.
// That Postgres accepts the SQL and that the constraints really refuse is
// `tramos/tramos.db.test.ts`, against a real database.

import { describe, it, expect } from "vitest";
import { up, down, FUSIONES, RESTRICCIONES } from "./20261010000005-create-tramos.js";
import { TramoModel } from "../models/tramo.model.js";
import { DEPARTAMENTOS } from "../models/departamento.model.js";

type Respuesta = (sql: string) => unknown;

const CIUDADES_DE_LA_FUSION = FUSIONES.flatMap((f) => [
  { id: f.pierde, name: f.nombre },
  { id: f.gana, name: f.nombre },
]);

/** A database with nothing wrong in it. */
const limpia: Respuesta = (sql) => {
  if (sql.includes("/* fusion */")) return CIUDADES_DE_LA_FUSION;
  if (sql.includes("/* comprobacion */")) return [{ n: "0" }];
  return [];
};

function fakeQueryInterface(responder: Respuesta = limpia) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    createTable: record("createTable"),
    dropTable: record("dropTable"),
    addColumn: record("addColumn"),
    removeColumn: record("removeColumn"),
    changeColumn: record("changeColumn"),
    bulkInsert: record("bulkInsert"),
    sequelize: {
      literal: (sql: string) => ({ literal: sql }),
      query: (...args: unknown[]) => {
        calls.push({ fn: "query", args });
        return Promise.resolve(responder(String(args[0])));
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const sqlDe = (c: { args: unknown[] }) => String(c.args[0]).replace(/\s+/g, " ");
const cambia = (c: { fn: string; args: unknown[] }) =>
  c.fn !== "query" || /^(UPDATE|INSERT|ALTER|CREATE|DROP|DELETE)/i.test(sqlDe(c).trim());

describe("create-tramos: it looks before it builds", () => {
  const casos: [string, Respuesta, RegExp][] = [
    ["a city of the merge is missing",
      (sql) => (sql.includes("/* fusion */") ? CIUDADES_DE_LA_FUSION.slice(1) : limpia(sql)), /77/],
    ["a city of the merge is not called what is expected",
      (sql) => (sql.includes("/* fusion */")
        ? CIUDADES_DE_LA_FUSION.map((c) => (c.id === 98 ? { ...c, name: "Otra" } : c)) : limpia(sql)), /98/],
    ["a winner of the merge is archived",
      (sql) => (sql.includes("/* fusion */")
        ? CIUDADES_DE_LA_FUSION.map((c) => (c.id === 60 ? { ...c, deletedAt: new Date() } : c)) : limpia(sql)), /60/],
    ["a pole points at a city that does not exist",
      (sql) => (sql.includes("/* huerfanos */") ? [{ id: 41 }] : limpia(sql)), /41/],
    ["a pole would end with the same city at both ends",
      (sql) => (sql.includes("/* misma */") ? [{ id: 12 }] : limpia(sql)), /12/],
    ["a saved report uses Ciudad A or filters by the tramo text",
      (sql) => (sql.includes("/* informes */") ? [{ id: 10, name: "Propietarios" }] : limpia(sql)), /Propietarios/],
  ];

  for (const [titulo, responder, nombra] of casos) {
    it(`stops when ${titulo}, names the rows, and has changed nothing`, async () => {
      const qi = fakeQueryInterface(responder);
      await expect(up({ context: qi as never })).rejects.toThrow(nombra);
      await expect(up({ context: fakeQueryInterface(responder) as never })).rejects.toThrow(/No se ha cambiado nada/);
      // `SET LOCAL lock_timeout` is the only statement allowed before a refusal.
      expect(qi.calls.filter(cambia).map(sqlDe)).toEqual([]);
    });
  }
});

describe("create-tramos: the order things happen in", () => {
  it("cleans the names and merges the cities before it derives any tramo", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const pasos = qi.calls.map((c) => (c.fn === "query" ? sqlDe(c) : `${c.fn} ${String(c.args[0])}`));
    const en = (trozo: string) => pasos.findIndex((p) => p.includes(trozo));

    expect(en("regexp_replace")).toBeGreaterThan(-1);
    expect(en("regexp_replace")).toBeLessThan(en('SET "id_ciudadA" ='));
    expect(en('SET "id_ciudadA" =')).toBeLessThan(en("createTable tramos"));
    expect(en("createTable departamentos")).toBeLessThan(en("createTable tramos"));
    expect(en("createTable tramos")).toBeLessThan(en("INSERT INTO tramos"));
    expect(en("INSERT INTO tramos")).toBeLessThan(en('SET "id_tramo" ='));
  });

  it("checks every pole against its tramo before it drops the two columns", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const orden = qi.calls.map((c) => (c.fn === "query" ? sqlDe(c) : `${c.fn} ${String(c.args[1] ?? c.args[0])}`));
    const comprobacion = orden.findIndex((p) => p.includes("/* comprobacion */"));
    const primerBorrado = orden.findIndex((p) => p.startsWith("removeColumn"));
    expect(comprobacion).toBeGreaterThan(-1);
    expect(primerBorrado).toBeGreaterThan(comprobacion);
  });

  it("drops nothing when a single pole does not match", async () => {
    const qi = fakeQueryInterface((sql) => (sql.includes("/* comprobacion */") ? [{ n: "3" }] : limpia(sql)));
    await expect(up({ context: qi as never })).rejects.toThrow(/3 postes/);
    expect(qi.calls.some((c) => c.fn === "removeColumn")).toBe(false);
  });

  it("merges exactly the five pairs that were decided", () => {
    expect(FUSIONES.map((f) => [f.pierde, f.gana])).toEqual([[77, 58], [78, 59], [76, 57], [79, 60], [86, 98]]);
  });

  it("seeds the nine departments in their order", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const siembra = qi.calls.find((c) => c.fn === "bulkInsert" && c.args[0] === "departamentos");
    expect((siembra?.args[1] as { name: string }[]).map((d) => d.name)).toEqual([...DEPARTAMENTOS]);
  });
});

describe("create-tramos: what holds the rule", () => {
  it("has a CHECK that closes the reversed pair and the single city, and a unique index with no WHERE", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = qi.calls.filter((c) => c.fn === "query").map(sqlDe);
    expect(sql.find((s) => s.includes(RESTRICCIONES.orden))).toContain("CHECK (id_ciudad_min < id_ciudad_max)");
    const unico = sql.find((s) => s.includes(RESTRICCIONES.parUnico));
    expect(unico).toContain("UNIQUE INDEX");
    // One row per pair for ever: an archived tramo still holds its pair.
    expect(unico).not.toMatch(/WHERE/i);
  });

  it("creates the columns the model declares", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const tabla = qi.calls.find((c) => c.fn === "createTable" && c.args[0] === "tramos");
    expect(Object.keys(tabla?.args[1] as object).sort()).toEqual(Object.keys(TramoModel.getAttributes()).sort());
  });
});

describe("create-tramos: the transaction", () => {
  it("opens with the lock timeout and carries every statement, both ways", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });
      expect(sqlDe(qi.calls[0])).toContain("lock_timeout");
      for (const c of qi.calls) {
        const opciones = c.args.at(-1) as { transaction?: unknown } | undefined;
        expect(opciones?.transaction, `${c.fn} ${sqlDe(c).slice(0, 60)}`).toEqual({ id: "t" });
      }
    }
  });

  it("puts the two indexes back under their lower-case names on the way down", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    const sql = qi.calls.filter((c) => c.fn === "query").map(sqlDe).join("\n");
    expect(sql).toContain("idx_postes_ciudada");
    expect(sql).toContain("idx_postes_ciudadb");
  });
});
