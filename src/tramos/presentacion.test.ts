import { describe, it, expect } from "vitest";
import { INCLUDE_TRAMO, presentarTramo, presentarTramos } from "./presentacion.js";
import { TRAMO_PUBLIC_ATTRIBUTES } from "../models/tramo.model.js";

const crudo = (extra: Record<string, unknown> = {}) => ({
  id: 14,
  id_ciudad_min: 3,
  id_ciudad_max: 7,
  id_departamento: 5,
  deletedAt: null,
  ciudadMin: { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
  ciudadMax: { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
  departamento: { id: 5, name: "Potosí" },
  ...extra,
});

describe("presentarTramo", () => {
  it("sends a name and two cities in the order of the name, and neither min nor max", () => {
    const t = presentarTramo(crudo());
    expect(t).toEqual({
      id: 14,
      nombre: "Potosí – Sucre",
      ciudades: [
        { id: 7, name: "Potosí", lat: -19.58, lng: -65.75 },
        { id: 3, name: "Sucre", lat: -19.04, lng: -65.26 },
      ],
      id_departamento: 5,
      departamento: { id: 5, name: "Potosí" },
      archivado: false,
    });
    expect(JSON.stringify(t)).not.toMatch(/min|max/);
  });

  it("says so when the tramo is archived, and still names it", () => {
    const t = presentarTramo(crudo({ deletedAt: "2026-10-01T00:00:00.000Z" }));
    expect(t.archivado).toBe(true);
    expect(t.nombre).toBe("Potosí – Sucre");
  });

  it("stands a city that did not come in the join on its id, rather than failing", () => {
    const t = presentarTramo(crudo({ ciudadMin: null }));
    expect(t.nombre).toBe("#3 – Potosí");
    expect(t.ciudades[0]).toEqual({ id: 3, name: null, lat: null, lng: null });
  });

  it("has no department when none was assigned", () => {
    const t = presentarTramo(crudo({ id_departamento: null, departamento: null }));
    expect(t.departamento).toBeNull();
    expect(t.id_departamento).toBeNull();
  });
});

describe("presentarTramos", () => {
  it("replaces every raw tramo, however deep, and leaves the rest alone", () => {
    const respuesta = {
      data: [
        { id: 1, name: "P-1", tramo: crudo(), eventos: [{ id: 9, poste: { id: 1, tramo: crudo() } }] },
        { id: 2, name: "P-2", tramo: null },
      ],
      total: 2,
    };
    const salida = presentarTramos(respuesta) as typeof respuesta & { data: { tramo: { nombre?: string } | null }[] };
    expect(salida.total).toBe(2);
    expect(salida.data[0].tramo?.nombre).toBe("Potosí – Sucre");
    expect((salida.data[0] as never as { eventos: { poste: { tramo: { nombre: string } } }[] }).eventos[0].poste.tramo.nombre)
      .toBe("Potosí – Sucre");
    expect(salida.data[1].tramo).toBeNull();
    expect(JSON.stringify(salida)).not.toContain("id_ciudad_min");
  });

  it("goes through model instances the way the response would", () => {
    const instancia = { toJSON: () => ({ id: 1, tramo: crudo() }) };
    expect((presentarTramos(instancia) as { tramo: { nombre: string } }).tramo.nombre).toBe("Potosí – Sucre");
  });

  it("does not touch a `tramo` that is already presented, or one that is not a tramo", () => {
    const ya = { tramo: presentarTramo(crudo()), otro: { tramo: "texto" } };
    expect(presentarTramos(ya)).toEqual(JSON.parse(JSON.stringify(ya)));
  });
});

describe("INCLUDE_TRAMO", () => {
  it("names its columns, and brings an archived tramo and an archived city all the same", () => {
    expect(INCLUDE_TRAMO.attributes).toEqual([...TRAMO_PUBLIC_ATTRIBUTES]);
    expect(INCLUDE_TRAMO.paranoid).toBe(false);
    const ciudades = INCLUDE_TRAMO.include.filter((i) => "as" in i);
    expect(ciudades.map((i) => (i as { as: string }).as)).toEqual(["ciudadMin", "ciudadMax"]);
    for (const c of ciudades) {
      expect((c as { paranoid: boolean }).paranoid).toBe(false);
      expect(c.attributes).toEqual(["id", "name", "lat", "lng"]);
    }
  });
});
