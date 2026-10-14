import { describe, it, expect } from "vitest";
import { TramoModel, TRAMO_PUBLIC_ATTRIBUTES } from "./tramo.model.js";
import { DepartamentoModel, DEPARTAMENTOS } from "./departamento.model.js";
import { PosteModel, POSTE_PUBLIC_ATTRIBUTES } from "./poste.model.js";

describe("TramoModel", () => {
  it("lives in `tramos`, archives softly, and names its ends min and max", () => {
    expect(TramoModel.getTableName()).toBe("tramos");
    expect(TramoModel.options.paranoid).toBe(true);
    const columnas = Object.keys(TramoModel.getAttributes());
    expect(columnas).toEqual(expect.arrayContaining(["id_ciudad_min", "id_ciudad_max", "id_departamento", "id_usuario"]));
  });

  it("refuses the two ends the wrong way round before the database has to", async () => {
    const volcado = TramoModel.build({ id_ciudad_min: 7, id_ciudad_max: 3 });
    await expect(volcado.validate()).rejects.toThrow(/id_ciudad_min/);
    const misma = TramoModel.build({ id_ciudad_min: 3, id_ciudad_max: 3 });
    await expect(misma.validate()).rejects.toThrow(/id_ciudad_min/);
    await expect(TramoModel.build({ id_ciudad_min: 3, id_ciudad_max: 7 }).validate()).resolves.toBeDefined();
  });

  it("does not judge a partial instance, as a static update builds it", async () => {
    // Mirrors `Model.update`: build from the values written, skip every other attribute.
    const values = { id_departamento: 3 };
    const parcial = TramoModel.build(values, { isNewRecord: false });
    const skip = Object.keys(TramoModel.getAttributes()).filter((k) => !(k in values));
    await expect(parcial.validate({ skip })).resolves.toBeDefined();
    // With both ends present the rule still bites.
    const volcado = TramoModel.build({ id_ciudad_min: 7, id_ciudad_max: 3 }, { isNewRecord: false });
    await expect(volcado.validate({ skip })).rejects.toThrow(/id_ciudad_min/);
    const igual = TramoModel.build({ id_ciudad_min: 3, id_ciudad_max: 3 }, { isNewRecord: false });
    await expect(igual.validate({ skip })).rejects.toThrow(/id_ciudad_min/);
  });

  it("does not need a department", () => {
    expect(TramoModel.getAttributes().id_departamento.allowNull).not.toBe(false);
  });

  it("keeps its author out of what travels inside another response", () => {
    expect(TRAMO_PUBLIC_ATTRIBUTES).not.toContain("id_usuario");
    expect(TRAMO_PUBLIC_ATTRIBUTES).toContain("deletedAt");
  });

  it("is reachable from a pole as `tramo`, and reaches its ends and its department", () => {
    expect(Object.keys(PosteModel.associations)).toContain("tramo");
    expect(Object.keys(TramoModel.associations)).toEqual(
      expect.arrayContaining(["ciudadMin", "ciudadMax", "departamento"]),
    );
  });
});

describe("DepartamentoModel", () => {
  it("is the nine of Bolivia, with no timestamps to maintain", () => {
    expect(DepartamentoModel.getTableName()).toBe("departamentos");
    expect(DepartamentoModel.options.timestamps).toBe(false);
    expect(DEPARTAMENTOS).toEqual([
      "Chuquisaca", "La Paz", "Cochabamba", "Oruro", "Potosí", "Tarija", "Santa Cruz", "Beni", "Pando",
    ]);
  });
});

describe("a pole inside somebody else's response", () => {
  it("carries the id of its tramo", () => {
    expect(POSTE_PUBLIC_ATTRIBUTES).toContain("id_tramo");
  });
});
