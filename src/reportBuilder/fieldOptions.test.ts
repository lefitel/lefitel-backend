// The value lists a filter offers.
//
// Nothing here contacts Postgres: the configured database in this environment
// is a copy of production, so every model read is spied and the models
// themselves are left real — several of them declare associations while being
// imported, and mocking the module breaks that graph for everything else.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { catalog } from "./catalog.js";
import {
  loadOptionLists, resetOptionCache, MAX_OPTION_VALUES, OPTION_SOURCES,
} from "./fieldOptions.js";
import { buildCatalogView } from "./catalogView.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { MaterialModel } from "../models/material.model.js";
import { ObsModel } from "../models/obs.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { RolModel } from "../models/rol.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";

const MODELS = {
  "ciudad.name": CiudadModel,
  "material.name": MaterialModel,
  "propietario.name": PropietarioModel,
  "tipoObs.name": TipoObsModel,
  "obs.name": ObsModel,
  "rol.name": RolModel,
};

/** Every model answers one name per row unless a test says otherwise. */
function stub(rows: Partial<Record<keyof typeof MODELS, string[]>> = {}) {
  for (const [key, model] of Object.entries(MODELS)) {
    const names = rows[key as keyof typeof MODELS] ?? [`valor de ${key}`];
    vi.spyOn(model, "findAll").mockResolvedValue(
      names.map((name) => ({ name })) as never,
    );
  }
}

beforeEach(() => resetOptionCache());
afterEach(() => vi.restoreAllMocks());

describe("las marcas del catálogo y los lectores", () => {
  /** Both directions, because either half alone is a list that silently rots. */
  it("cada campo marcado tiene quien lo lea, y cada lector un campo marcado", () => {
    const marcados: string[] = [];
    for (const [entityKey, entity] of Object.entries(catalog.entities)) {
      for (const [fieldName, field] of Object.entries(entity.fields)) {
        if (field.optionList === true) marcados.push(`${entityKey}.${fieldName}`);
      }
    }
    expect([...marcados].sort()).toEqual([...OPTION_SOURCES].sort());
  });

  it("solo se marcan columnas de texto: una lista de fechas o de números no se elige de un desplegable", () => {
    for (const entity of Object.values(catalog.entities)) {
      for (const field of Object.values(entity.fields)) {
        if (field.optionList === true) expect(field.kind).toBe("string");
      }
    }
  });

  /**
   * The key the view publishes has to be the key this module answers, and they
   * are built in two different files from two different loops.
   */
  it("las claves que publica el catálogo son las que el lector conoce", () => {
    const { roots } = buildCatalogView({ role: 1, staff: true });
    const publicadas = new Set<string>();
    for (const root of roots) {
      for (const field of root.fields) if (field.optionList) publicadas.add(field.optionList);
    }
    expect(publicadas.size).toBeGreaterThan(0);
    for (const clave of publicadas) expect(OPTION_SOURCES).toContain(clave);
  });

  it("un mismo campo alcanzado por dos caminos nombra la misma lista", () => {
    const { roots } = buildCatalogView({ role: 1, staff: true });
    const poste = roots.find((r) => r.key === "poste")!;
    const evento = roots.find((r) => r.key === "evento")!;
    const desdePoste = poste.fields.find((f) => f.path === "propietario.name");
    const desdeEvento = evento.fields.find((f) => f.path === "poste.propietario.name");
    expect(desdePoste?.optionList).toBe("propietario.name");
    expect(desdeEvento?.optionList).toBe("propietario.name");
  });
});

describe("lo que se lee de la base", () => {
  it("devuelve solo las listas pedidas", async () => {
    stub();
    const listas = await loadOptionLists(["propietario.name"]);
    expect(Object.keys(listas)).toEqual(["propietario.name"]);
  });

  it("ignora una clave que no existe en vez de romper", async () => {
    stub();
    expect(await loadOptionLists(["poste.name"])).toEqual({});
  });

  it("no consulta nada cuando no se pide ninguna lista", async () => {
    stub();
    await loadOptionLists([]);
    expect(PropietarioModel.findAll).not.toHaveBeenCalled();
  });

  it("quita los repetidos y ordena alfabéticamente", async () => {
    // Three cities called Millares is the real shape of this table: 98 rows,
    // 95 distinct names.
    stub({ "ciudad.name": ["Olivos", "Millares", "Millares", "Abapó", "Millares"] });
    const listas = await loadOptionLists(["ciudad.name"]);
    expect(listas["ciudad.name"]).toEqual(["Abapó", "Millares", "Olivos"]);
  });

  it("descarta lo que no se puede elegir, y nada más", async () => {
    stub({ "material.name": ["Madera", "", "   ", "Madera"] });
    const listas = await loadOptionLists(["material.name"]);
    expect(listas["material.name"]).toEqual(["Madera"]);
  });

  it("respeta los espacios con los que el valor está guardado", async () => {
    // 17 of the 98 cities are stored with a trailing space, and they carry real
    // data: `Yacuiba ` alone holds 121 poles. Tidying the value here would put
    // a choice in the list that matches nothing — the exact failure this whole
    // feature exists to remove, only now suggested by the screen itself.
    stub({ "ciudad.name": ["Yacuiba ", "Ventillas", "Ventillas "] });
    const listas = await loadOptionLists(["ciudad.name"]);
    expect(listas["ciudad.name"]).toContain("Yacuiba ");
    expect(listas["ciudad.name"]).not.toContain("Yacuiba");
    // The one pair that reads the same in the list. Both are real cities and
    // both have to be reachable.
    expect(listas["ciudad.name"]).toEqual(["Ventillas", "Ventillas ", "Yacuiba "]);
  });

  it("una lista que pasa del tope no viaja, y las demás sí", async () => {
    const muchas = Array.from({ length: MAX_OPTION_VALUES + 1 }, (_, i) => `ciudad ${i}`);
    stub({ "ciudad.name": muchas });
    const listas = await loadOptionLists(["ciudad.name", "material.name"]);
    expect(listas["ciudad.name"]).toBeUndefined();
    expect(listas["material.name"]).toBeDefined();
  });

  it("justo en el tope sí viaja", async () => {
    const justas = Array.from({ length: MAX_OPTION_VALUES }, (_, i) => `ciudad ${i}`);
    stub({ "ciudad.name": justas });
    const listas = await loadOptionLists(["ciudad.name"]);
    expect(listas["ciudad.name"]).toHaveLength(MAX_OPTION_VALUES);
  });

  it("pide solo la columna del nombre", async () => {
    stub();
    await loadOptionLists(["obs.name"]);
    expect(ObsModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ attributes: ["name"] }),
    );
  });

  /**
   * No `paranoid: false` anywhere: the six models exclude archived rows on
   * their own, and offering an owner nobody can have any more is a choice that
   * returns an empty report.
   */
  it("no levanta el filtro de archivados", async () => {
    stub();
    await loadOptionLists(["propietario.name"]);
    const opciones = vi.mocked(PropietarioModel.findAll).mock.calls[0][0] as Record<string, unknown>;
    expect(opciones).not.toHaveProperty("paranoid");
  });

  it("una segunda llamada no vuelve a consultar", async () => {
    stub();
    await loadOptionLists(["propietario.name"]);
    await loadOptionLists(["material.name"]);
    expect(PropietarioModel.findAll).toHaveBeenCalledTimes(1);
  });
});

describe("cuando la base no contesta", () => {
  it("devuelve nada en vez de propagar el fallo", async () => {
    stub();
    vi.spyOn(CiudadModel, "findAll").mockRejectedValue(new Error("sin conexión"));
    await expect(loadOptionLists(["propietario.name"])).resolves.toEqual({});
  });

  /** A failure must not be remembered for a minute: the next request retries. */
  it("no se guarda el fallo en la caché", async () => {
    stub();
    vi.spyOn(CiudadModel, "findAll").mockRejectedValueOnce(new Error("sin conexión"));
    expect(await loadOptionLists(["propietario.name"])).toEqual({});
    const segunda = await loadOptionLists(["propietario.name"]);
    expect(segunda["propietario.name"]).toBeDefined();
  });
});
