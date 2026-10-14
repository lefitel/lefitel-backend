import { describe, it, expect } from "vitest";
import { up, down, ASIGNACIONES } from "./20261013000001-assign-tramo-departamentos.js";
import { FUSIONES } from "./20261010000005-create-tramos.js";
import { DEPARTAMENTOS } from "../models/departamento.model.js";

function fakeQueryInterface() {
  const calls: { sql: string; opciones: { transaction?: unknown } }[] = [];
  return {
    calls,
    sequelize: {
      escape: (v: string) => `'${v.replace(/'/g, "''")}'`,
      query: (sql: string, opciones: { transaction?: unknown } = {}) => {
        calls.push({ sql: sql.replace(/\s+/g, " ").trim(), opciones });
        return Promise.resolve(undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const par = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
const pares = new Set(ASIGNACIONES.map(([min, , max]) => par(min, max)));

describe("the list", () => {
  it("holds the 65 tramos the client's list gives one department for certain", () => {
    expect(ASIGNACIONES).toHaveLength(65);
    expect(pares.size).toBe(65);
  });

  it("writes every pair the way the table stores it: smaller id first", () => {
    for (const [min, , max] of ASIGNACIONES) expect(min).toBeLessThan(max);
  });

  it("names only departments the table has", () => {
    for (const a of ASIGNACIONES) expect(DEPARTAMENTOS).toContain(a[4]);
  });

  it("never points at a city the tramo migration archives in its merge", () => {
    const perdedoras = new Set<number>(FUSIONES.map((f) => f.pierde));
    for (const [min, , max] of ASIGNACIONES) {
      expect(perdedoras.has(min)).toBe(false);
      expect(perdedoras.has(max)).toBe(false);
    }
  });

  it("leaves out the three tramos the list gives two departments", () => {
    for (const [a, b] of [[6, 7], [17, 23], [42, 44]]) expect(pares.has(par(a, b))).toBe(false);
  });

  it("leaves out the tramos matched only through a doubtful name", () => {
    // Yacuiba–Villamontes and Palos Blancos–Yacuiba («MIRADOR LA CRUZ YACUIBA»),
    // Yotau–Ascensión de Guarayos and Ascensión de Guarayos–San Pablo
    // («GUARAYOS»), Paragua–Data Center and Data Center–Montero («DATACENTER»),
    // Puerto Quijarro–BRAZO B («HITO BRASIL BRAZO B»), Tambo Quemado–Hito
    // Chungara («HITO FRONTERA»).
    for (const [a, b] of [[40, 42], [39, 40], [90, 91], [91, 92], [24, 72], [72, 117], [114, 127], [21, 22]]) {
      expect(pares.has(par(a, b))).toBe(false);
    }
  });

  it("leaves out the five whose two ends lie in another department than the list says", () => {
    // Pailas–Los Troncos, San Ramón–Los Troncos, San Ramón–El Puente,
    // El Puente–Yotau (listed Beni, in Santa Cruz); Villamontes–Hito Paraguay
    // (listed Santa Cruz, in Tarija).
    for (const [a, b] of [[98, 122], [88, 122], [88, 89], [89, 90], [42, 43]]) {
      expect(pares.has(par(a, b))).toBe(false);
    }
  });

  it("takes «SAN JOSE DE CHIQUITOS» as San Jose", () => {
    expect(pares.has(par(104, 106))).toBe(true);
    expect(pares.has(par(106, 107))).toBe(true);
  });
});

describe("assign-tramo-departamentos", () => {
  it("writes only where the department is empty, the pair matches and both names do", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const update = qi.calls.find((c) => c.sql.startsWith("UPDATE tramos"))?.sql ?? "";
    expect(update).toContain("SET id_departamento = d.id");
    expect(update).toContain("t.id_departamento IS NULL");
    expect(update).toContain("t.id_ciudad_min = v.id_min AND t.id_ciudad_max = v.id_max");
    expect(update).toContain("a.id = v.id_min AND btrim(regexp_replace(a.name, '\\s+', ' ', 'g')) = v.nombre_min");
    expect(update).toContain("b.id = v.id_max AND btrim(regexp_replace(b.name, '\\s+', ' ', 'g')) = v.nombre_max");
    expect(update).toContain("(30, 'Padilla', 31, 'Zudañez', 'Chuquisaca')");
  });

  it("on the way down empties only what still holds the department it wrote", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });
    const update = qi.calls.find((c) => c.sql.startsWith("UPDATE tramos"))?.sql ?? "";
    expect(update).toContain("SET id_departamento = NULL");
    expect(update).toContain("t.id_departamento = d.id");
  });

  it("runs inside one transaction with the lock timeout first, both ways", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });
      expect(qi.calls[0].sql).toContain("lock_timeout");
      for (const c of qi.calls) expect(c.opciones.transaction).toEqual({ id: "t" });
    }
  });
});
