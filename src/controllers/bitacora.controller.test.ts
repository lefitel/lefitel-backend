// The audit log as the server hands it over.
//
// Three things are asserted, and each was wrong or missing:
//
//   1. **Every row leaves with its names.** The screen translated the stored
//      code from a table of its own and fell 58 codes behind. The label travels
//      with the row now, computed here.
//   2. **The filter is by family, as a list of codes.** It was a prefix, which
//      a third of the log matched none of.
//   3. **What the filters offer is served**, so a family added on the server is
//      one the screen can filter for without anybody touching the client.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { Op } from "sequelize";

const findAndCountAll = vi.fn();

vi.mock("../models/bitacora.model.js", () => ({
  BitacoraModel: { findAndCountAll: (...a: unknown[]) => findAndCountAll(...a) },
}));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {},
  USUARIO_AS_AUTHOR: ["id", "name", "lastname"],
}));

const { getAllBitacora, getBitacora, getVocabularioBitacora } = await import("./bitacora.controller.js");

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
}

/** A row as Sequelize returns it: something with a `toJSON`. */
const fila = (datos: Record<string, unknown>) => ({ toJSON: () => datos });

async function pedir(query: Record<string, unknown>) {
  findAndCountAll.mockClear();
  const res = fakeRes();
  await getAllBitacora({ query } as unknown as Request, res as unknown as Response);
  return res;
}

/** The `where` the controller built for this query string. */
async function whereDe(query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await pedir(query);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect(findAndCountAll).toHaveBeenCalledTimes(1);
  return (findAndCountAll.mock.calls[0][0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  findAndCountAll.mockReset();
  findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
});

describe("the rows", () => {
  it("leave with what their action and entity are called, and keep what is stored", async () => {
    findAndCountAll.mockResolvedValue({
      count: 2,
      rows: [
        fila({ id: 1, action: "UPDATE_ROL", entity: "Rol", entity_id: 7, metadata: null }),
        fila({ id: 2, action: "WEBAUTHN_DELETED", entity: "credencial_webauthn", entity_id: 31, metadata: {} }),
      ],
    });

    const res = await pedir({});
    const { data, total } = res.body as { data: Record<string, unknown>[]; total: number };

    expect(total).toBe(2);
    expect(data[0]).toMatchObject({ action: "UPDATE_ROL", action_label: "Editó rol", entity: "Rol", entity_label: "Rol" });
    expect(data[1]).toMatchObject({
      action: "WEBAUTHN_DELETED", entity: "credencial_webauthn", entity_label: "Llave de acceso",
    });
    expect(data[1].action_label).not.toBe("WEBAUTHN_DELETED");
  });

  it("are named by their metadata where one code means several things", async () => {
    findAndCountAll.mockResolvedValue({
      count: 2,
      rows: [
        fila({ id: 1, action: "STEP_UP_DENIED", entity: "Sesion", metadata: { motivo: "contraseña-requerida" } }),
        fila({ id: 2, action: "STEP_UP_DENIED", entity: "Sesion", metadata: { motivo: "contraseña-incorrecta" } }),
      ],
    });

    const { data } = (await pedir({})).body as { data: { action_label: string }[] };

    expect(data[0].action_label).toBe("Se le pidió confirmar su identidad");
    expect(data[1].action_label).toBe("Contraseña incorrecta al confirmar identidad");
  });

  it("carry their names on a person's own log too", async () => {
    // The profile and the user sheet read this endpoint, not the one above, and
    // each kept a table of its own.
    findAndCountAll.mockResolvedValue({ count: 1, rows: [fila({ id: 1, action: "LOGOUT", entity: "Usuario", metadata: null })] });
    const res = fakeRes();

    await getBitacora({ params: { id: "7" }, query: {} } as unknown as Request, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect((res.body as { data: Record<string, unknown>[] }).data[0])
      .toMatchObject({ action: "LOGOUT", action_label: "Cerró sesión", entity_label: "Usuario" });
  });
});

describe("the action filter", () => {
  it("leaves the column alone when nothing is asked for", async () => {
    expect("action" in await whereDe({})).toBe(false);
  });

  it("is the family's codes, listed — not a prefix", async () => {
    const where = await whereDe({ family: "rechazos" });
    const codigos = (where.action as Record<symbol, string[]>)[Op.in];

    // The one a prefix sent elsewhere is the reason this is a list.
    expect(codigos).toEqual(expect.arrayContaining(["READ_REPORTE_DENIED", "DELETE_REPORTE_DENIED", "ROLE_CHANGE_DENIED"]));
    expect(codigos).not.toContain("DELETE_POSTE");
  });

  it("refuses a family that does not exist, instead of answering with everything", async () => {
    // An unknown filter silently dropped is a screen showing a filter as
    // applied over rows that were never filtered.
    for (const family of ["no-existe", "constructor", ["factor", "sesion"]]) {
      const res = await pedir({ family });
      expect(res.statusCode, String(family)).toBe(400);
      expect(findAndCountAll, String(family)).not.toHaveBeenCalled();
    }
  });

  it("still takes a prefix from a client that sends one", async () => {
    const where = await whereDe({ action: "CREATE" });
    expect(where.action).toEqual({ [Op.like]: "CREATE%" });
  });
});

describe("what the filters offer", () => {
  it("is every family and every entity, each with its name", async () => {
    const res = fakeRes();
    await getVocabularioBitacora({} as Request, res as unknown as Response);

    const { families, entities } = res.body as Record<string, { value: string; label: string }[]>;
    expect(families).toContainEqual({ value: "factor", label: "Segundo factor" });
    expect(families.length).toBeGreaterThan(10);
    expect(entities).toContainEqual({ value: "credencial_webauthn", label: "Llave de acceso" });
    // Still in old rows, so still offered.
    expect(entities).toContainEqual({ value: "Solución", label: "Solución" });
    expect([...families, ...entities].every((o) => o.label.trim() !== "")).toBe(true);
  });
});
