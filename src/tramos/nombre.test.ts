import { describe, it, expect } from "vitest";
import {
  nombreDeTramo, ordenarExtremos, sqlNombreDeTramo, sqlNombreDelTramo, sqlNombreDelTramoDelPoste,
} from "./nombre.js";

describe("nombreDeTramo", () => {
  it("is the same name whichever end is handed over first", () => {
    const sucre = { id: 7, name: "Sucre" };
    const potosi = { id: 3, name: "Potosí" };
    expect(nombreDeTramo(sucre, potosi)).toBe("Potosí – Sucre");
    expect(nombreDeTramo(potosi, sucre)).toBe("Potosí – Sucre");
  });

  it("orders by the name and not by the id", () => {
    expect(nombreDeTramo({ id: 1, name: "Tarija" }, { id: 9, name: "Beni" })).toBe("Beni – Tarija");
  });

  it("falls back to the id when two ends carry the same name", () => {
    const [primero, segundo] = ordenarExtremos({ id: 77, name: "Millares" }, { id: 58, name: "Millares" });
    expect([primero.id, segundo.id]).toEqual([58, 77]);
  });

  it("ignores the spaces around a name, for the order and for the text", () => {
    expect(nombreDeTramo({ id: 1, name: " Villanueva " }, { id: 2, name: "Olivos" })).toBe("Olivos – Villanueva");
  });

  it("writes #id for an end that has no name, and never an empty side", () => {
    expect(nombreDeTramo({ id: 4, name: null }, { id: 2, name: "Oruro" })).toBe("#4 – Oruro");
    expect(nombreDeTramo({ id: 4, name: "  " }, { id: 2 })).toBe("#2 – #4");
  });

  it("compares by code unit, so the SQL twin can agree with it exactly", () => {
    // "Ñ" (U+00D1) sorts after "Z" (U+005A) here and under COLLATE "C" alike.
    expect(nombreDeTramo({ id: 1, name: "Ñuflo" }, { id: 2, name: "Zudáñez" })).toBe("Zudáñez – Ñuflo");
  });
});

describe("the SQL twin", () => {
  it("compares under COLLATE \"C\" and breaks ties by id", () => {
    const sql = sqlNombreDeTramo("t", "a", "b");
    expect(sql).toContain('COLLATE "C"');
    expect(sql).toContain('t."id_ciudad_min"');
    expect(sql).toContain("' – '");
    expect(sql).toContain("'#' ||");
  });

  it("reaches the name from a tramo id, and from a pole id, without naming any outer alias", () => {
    expect(sqlNombreDelTramo('"poste"."id_tramo"')).toMatch(/^\(SELECT .* WHERE t\."id" = "poste"\."id_tramo"\)$/);
    expect(sqlNombreDelTramoDelPoste('"evento"."id_poste"')).toContain('WHERE p."id" = "evento"."id_poste"');
  });
});
