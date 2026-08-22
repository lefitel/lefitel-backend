// Whether an event is resolved is not a field on the edit form.
//
// `state` is the flag that says "this incident is closed", and the only two
// operations entitled to move it are `/resolver` and `/reabrir`, because they
// are the ones that keep the `solucions` row in step with it. `updateEvento`
// used to spread the whole request body into `set`, so a PUT could move it too
// — with nothing on the other side creating or destroying the solution.
//
// That is not a hypothetical. The priority toggle in the events table sends the
// entire row it had loaded in the browser (`evento/index.tsx`,
// `{ ...evento, priority: newPriority }`), so:
//
//   1. Ana loads the list; event 500 is pending.
//   2. Beto resolves 500 from his phone: `state = true`, a `solucions` row.
//   3. Ana flips the priority toggle on 500, sending the stale `state: false`.
//   4. The event is pending again with Beto's solution still alive, and the
//      bitácora records `before.state: false / after.state: false` — it did not
//      register the change it caused, because it diffs against the stale value.
//
// No bad actor, two people working at once. The fix drops `state` from the body
// before either the diff or the write can see it, so the audit entry stops
// claiming a change that did not happen as well.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findOne = vi.fn();
const set = vi.fn();
const save = vi.fn();

vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (cb: (t: unknown) => unknown) => cb({}) },
}));
vi.mock("../models/evento.model.js", () => ({
  EventoModel: { findOne: (...a: unknown[]) => findOne(...a) },
}));
vi.mock("../models/eventoObs.model.js", () => ({
  EventoObsModel: { findAll: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));
vi.mock("../models/obs.model.js", () => ({ ObsModel: { findAll: vi.fn().mockResolvedValue([]) } }));
vi.mock("../models/poste.model.js", () => ({ PosteModel: { findByPk: vi.fn() } }));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/revision.model.js", () => ({
  RevisionModel: { create: vi.fn() },
  REVISION_PUBLIC_ATTRIBUTES: ["id", "date"],
}));
vi.mock("../models/solucion.model.js", () => ({ SolucionModel: { findOne: vi.fn() } }));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {},
  USUARIO_AS_AUTHOR: ["id", "name", "lastname"],
}));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("../utils/fileUtils.js", () => ({ deleteImageFile: vi.fn() }));

const { updateEvento } = await import("./evento.controller.js");

function res() {
  const r = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
  };
  return r as unknown as Response & typeof r;
}

/** A resolved event, as the database holds it. */
function resolvedEvento() {
  return {
    dataValues: {
      id: 500,
      description: "Poste inclinado",
      state: true,
      priority: false,
      date: new Date("2026-01-01"),
      image: null,
      id_poste: 44,
      id_usuario: 3,
    },
    set,
    save,
  };
}

describe("updateEvento — el estado no se edita por el formulario", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockResolvedValue(resolvedEvento());
    save.mockResolvedValue(undefined);
  });

  /** What `set` was called with, which is what reaches the row. */
  const written = () => (set.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;

  it("ignora un `state` obsoleto enviado por el toggle de prioridad", async () => {
    const req = {
      params: { id: "500" },
      body: { id: 500, description: "Poste inclinado", state: false, priority: true, id_poste: 44 },
      user: { id: 7 },
    } as unknown as Request;

    await updateEvento(req, res());

    expect(set).toHaveBeenCalled();
    expect(written()).not.toHaveProperty("state");
  });

  it("sigue aplicando el resto del cuerpo", async () => {
    const req = {
      params: { id: "500" },
      body: { description: "Texto corregido", priority: true, state: false },
      user: { id: 7 },
    } as unknown as Request;

    await updateEvento(req, res());

    expect(written()).toMatchObject({ description: "Texto corregido", priority: true });
  });

  it("no registra en bitácora un cambio de estado que no ocurrió", async () => {
    const { logAction } = await import("../utils/logAction.js");
    const req = {
      params: { id: "500" },
      body: { description: "Poste inclinado", state: false, priority: true },
      user: { id: 7 },
    } as unknown as Request;

    await updateEvento(req, res());

    const entry = vi.mocked(logAction).mock.calls
      .map((c) => c[0] as { action?: string; metadata?: { before?: object; after?: object } })
      .find((c) => c.action === "UPDATE_EVENTO");
    expect(entry?.metadata?.before ?? {}).not.toHaveProperty("state");
    expect(entry?.metadata?.after ?? {}).not.toHaveProperty("state");
  });
});
