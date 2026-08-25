// Who gets recorded as the author, at every door that writes one.
//
// `revicions` and `solucions` gained an `id_usuario`, and three of the five
// handlers that create those rows did it as `Model.create(req.body)` — the two
// inside `evento.controller` always built their payload field by field. Those
// three made the request body a place to type an author: a POST carrying
// `"id_usuario": 2` would have been stored verbatim, and the report built on
// top would name a colleague as the author of somebody else's work. A wrong
// name is worse than a null — a null reads as unknown, a name reads as fact.
//
// The audit widened it twice. `eventos` and `postes` had the same hole and had
// been left alone, which mattered because the per-person report puts their two
// counts beside the two new ones: half of it would have been client-controlled.
// And the body could still set `createdAt`, which is the key the authorship
// backfill matches on.
//
// So this file spans four controllers, because the rule does. Nine doors.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const revisionCreate = vi.fn();
const solucionCreate = vi.fn();
const eventoCreate = vi.fn();
const eventoFindByPk = vi.fn();
const eventoFindOne = vi.fn();

vi.mock("../models/revision.model.js", () => ({
  RevisionModel: {
    create: (...a: unknown[]) => revisionCreate(...a),
    findOne: vi.fn(),
    findAll: vi.fn(),
    destroy: vi.fn(),
  },
}));
vi.mock("../models/solucion.model.js", () => ({
  SolucionModel: {
    create: (...a: unknown[]) => solucionCreate(...a),
    findOne: vi.fn(),
    findAll: vi.fn(),
    destroy: vi.fn(),
  },
}));
vi.mock("../models/evento.model.js", () => ({
  EventoModel: {
    create: (...a: unknown[]) => eventoCreate(...a),
    findByPk: (...a: unknown[]) => eventoFindByPk(...a),
    findOne: (...a: unknown[]) => eventoFindOne(...a),
    findAndCountAll: vi.fn(),
    destroy: vi.fn(),
    restore: vi.fn(),
  },
}));
vi.mock("../models/eventoObs.model.js", () => ({ EventoObsModel: { create: vi.fn(), destroy: vi.fn(), findAll: vi.fn() } }));
vi.mock("../models/obs.model.js", () => ({ ObsModel: { findAll: vi.fn().mockResolvedValue([]) } }));
vi.mock("../models/poste.model.js", () => ({ PosteModel: { findByPk: vi.fn().mockResolvedValue(null) } }));
vi.mock("../models/propietario.model.js", () => ({ PropietarioModel: {} }));
vi.mock("../models/ciudad.model.js", () => ({ CiudadModel: {} }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: {} }));
vi.mock("../utils/fileUtils.js", () => ({ deleteImageFile: vi.fn() }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
// The inline writes live inside a transaction; running the callback with a
// stand-in token is enough, since what is under test is the payload.
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (cb: (t: unknown) => Promise<unknown>) => cb({ id: "t" }) },
}));

const { createRevision, updateRevision } = await import("./revision.controller.js");
const { createSolucion, updateSolucion } = await import("./solucion.controller.js");
const { createEvento, updateEvento, resolverEvento } = await import("./evento.controller.js");

/** A request from user 7, carrying whatever body the test wants to try. */
const reqOf = (body: unknown, params: Record<string, string> = {}) =>
  ({ body, params, user: { id: 7, id_rol: 1 } }) as unknown as Request;

const resOf = () => {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.payload = body; return res; },
    sendStatus(code: number) { res.statusCode = code; return res; },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
};

beforeEach(() => {
  vi.clearAllMocks();
  revisionCreate.mockResolvedValue({ dataValues: { id: 1 } });
  solucionCreate.mockResolvedValue({ dataValues: { id: 1 } });
  eventoCreate.mockResolvedValue({ dataValues: { id: 99 } });
  eventoFindByPk.mockResolvedValue(null);
});

describe("the author of an inspection", () => {
  it("is the session, on POST /revision", async () => {
    await createRevision(reqOf({ description: "ok", id_evento: 3 }), resOf());
    expect(revisionCreate).toHaveBeenCalledOnce();
    expect(revisionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: 7 });
  });

  it("is the session even when the body claims otherwise", async () => {
    // The whole reason `authoredBy` exists rather than a spread at each site.
    await createRevision(reqOf({ description: "ok", id_evento: 3, id_usuario: 2 }), resOf());
    expect(revisionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: 7 });
  });

  it("is the session on the id-less branch of PUT /revision, which also creates", async () => {
    // `updateRevision` with no `:id` falls through to a create. That branch is
    // unreachable through the router as mounted — `put("/:id")` cannot match an
    // empty segment — so this is a guard on dead code, kept because the code is
    // there and the next person to add a route may reach it.
    await updateRevision(reqOf({ description: "ok", id_evento: 3, id_usuario: 2 }), resOf());
    expect(revisionCreate).toHaveBeenCalledOnce();
    expect(revisionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: 7 });
  });

  it("is the session on POST /evento, which writes the first inspection inline", async () => {
    await createEvento(
      reqOf({ description: "e", id_poste: 1, revision: { description: "primera" } }),
      resOf(),
    );
    expect(revisionCreate).toHaveBeenCalledOnce();
    expect(revisionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: 7, id_evento: 99 });
  });

  it("is null rather than absent when there is no session", async () => {
    // Every one of these routes is authenticated today. A null is the honest
    // answer if that ever stops being true, and an absent key would let the
    // column keep whatever a body happened to carry.
    const req = { body: { description: "ok", id_evento: 3, id_usuario: 2 }, params: {} } as unknown as Request;
    await createRevision(req, resOf());
    expect(revisionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: null });
  });
});

describe("the author of a repair", () => {
  it("is the session, on POST /solucion", async () => {
    await createSolucion(reqOf({ description: "arreglado", id_evento: 3, id_usuario: 2 }), resOf());
    expect(solucionCreate).toHaveBeenCalledOnce();
    expect(solucionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: 7 });
  });

  it("is the session on PUT /evento/:id/resolver, which writes the repair inline", async () => {
    // 342 of the 513 attributable repairs came in through this door, not
    // through POST /solucion — which is exactly why the backfill had to read
    // RESOLVE_EVENTO and why this path needed stamping too.
    eventoFindOne.mockResolvedValue({
      dataValues: { id: 5, state: false, id_poste: 1 },
      set: vi.fn(),
      save: vi.fn(),
    });
    await resolverEvento(reqOf({ description: "listo" }, { id: "5" }), resOf());
    expect(solucionCreate).toHaveBeenCalledOnce();
    expect(solucionCreate.mock.calls[0][0]).toMatchObject({ id_usuario: 7, id_evento: 5 });
  });
});

describe("an edit cannot reassign the author", () => {
  it("drops id_usuario from PUT /revision/:id", async () => {
    // Not overwritten with the editor's id: fixing a typo in a description is
    // not a claim to have carried out the inspection.
    const set = vi.fn();
    const { RevisionModel } = await import("../models/revision.model.js");
    vi.mocked(RevisionModel.findOne).mockResolvedValue({
      dataValues: { id: 4, id_evento: 3, description: "vieja", id_usuario: 2 },
      set,
      save: vi.fn(),
    } as never);

    await updateRevision(reqOf({ description: "nueva", id_usuario: 9 }, { id: "4" }), resOf());

    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0][0]).toEqual({ description: "nueva" });
    expect(set.mock.calls[0][0]).not.toHaveProperty("id_usuario");
  });

  it("drops id_usuario from PUT /solucion/:id", async () => {
    const set = vi.fn();
    const { SolucionModel } = await import("../models/solucion.model.js");
    vi.mocked(SolucionModel.findOne).mockResolvedValue({
      dataValues: { id: 4, id_evento: 3, description: "vieja", image: null, id_usuario: 2 },
      set,
      save: vi.fn(),
    } as never);

    await updateSolucion(reqOf({ description: "nueva", id_usuario: 9 }, { id: "4" }), resOf());

    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0][0]).toEqual({ description: "nueva" });
  });

  it("does not tell the bitácora about a change it refused", async () => {
    // The audit entry's `after` used to be `req.body` verbatim, which would
    // have recorded an authorship change that never happened — the one place a
    // reader would go to find out who reassigned it.
    const { logAction } = await import("../utils/logAction.js");
    const { RevisionModel } = await import("../models/revision.model.js");
    vi.mocked(RevisionModel.findOne).mockResolvedValue({
      dataValues: { id: 4, id_evento: 3, description: "vieja", id_usuario: 2 },
      set: vi.fn(),
      save: vi.fn(),
    } as never);

    await updateRevision(reqOf({ description: "nueva", id_usuario: 9 }, { id: "4" }), resOf());

    const entry = vi.mocked(logAction).mock.calls[0][0];
    const after = (entry.metadata as { after?: Record<string, unknown> }).after;
    expect(after).toBeDefined();
    expect(after).not.toHaveProperty("id_usuario");
  });
});

describe("the author of an event and of a pole", () => {
  // Left out of the first pass, and the audit was right that it mattered: the
  // per-person report shows four counts side by side — eventos, postes,
  // revisiones, soluciones — and two of them were forgeable, which makes the
  // whole table untrustworthy rather than half of it.
  //
  // Checked before changing it: both frontend callers send `sesion.usuario.id`,
  // the logged-in user's own id (web/src/components/dialogs/AddEventoPageSheet.tsx
  // and .../upsert/EventoSheet.tsx). There is no "register on behalf of" feature
  // to break.
  it("is the session on POST /evento, not what the body claims", async () => {
    await createEvento(
      reqOf({ description: "e", id_poste: 1, id_usuario: 2 }),
      resOf(),
    );
    expect(eventoCreate).toHaveBeenCalledOnce();
    expect(eventoCreate.mock.calls[0][0]).toMatchObject({ id_usuario: 7 });
  });

  it("cannot be reassigned by a PUT on an event that already exists", async () => {
    // This one changed the author of an existing row, and CREATE_EVENTO's
    // bitácora metadata does not carry `id_usuario`, so nothing recorded it.
    const set = vi.fn();
    eventoFindOne.mockResolvedValue({
      dataValues: { id: 5, state: false, image: null, id_poste: 1, id_usuario: 3 },
      set,
      save: vi.fn(),
    });
    await updateEvento(reqOf({ description: "otra", id_usuario: 9 }, { id: "5" }), resOf());

    expect(set).toHaveBeenCalled();
    expect(set.mock.calls[0][0]).not.toHaveProperty("id_usuario");
  });
});

describe("what a body may never set at all", () => {
  it("refuses createdAt, which is the backfill's matching key", async () => {
    // A client that can set `createdAt` can aim a future re-run of the
    // authorship backfill at whichever bitácora entry it likes: the rule pairs
    // a row with an entry within two seconds of it.
    await createRevision(
      reqOf({ description: "ok", id_evento: 3, createdAt: "2026-03-18T18:53:10Z" }),
      resOf(),
    );
    expect(revisionCreate.mock.calls[0][0]).not.toHaveProperty("createdAt");
  });

  it("refuses id and deletedAt too", async () => {
    await createRevision(
      reqOf({ description: "ok", id_evento: 3, id: 999, deletedAt: null, updatedAt: "x" }),
      resOf(),
    );
    const values = revisionCreate.mock.calls[0][0];
    expect(values).not.toHaveProperty("id");
    expect(values).not.toHaveProperty("deletedAt");
    expect(values).not.toHaveProperty("updatedAt");
    // And it still carries what was legitimately sent.
    expect(values).toMatchObject({ description: "ok", id_evento: 3, id_usuario: 7 });
  });

  // The same field, on the other kind of door, and this is the one that was
  // left open.
  //
  // The pass above closed `create`: `authoredBy` deletes id, createdAt,
  // updatedAt and deletedAt before the values reach the model. Nothing did the
  // same for `update`. `withoutAuthor` drops `id_usuario` and only that, so a
  // `deletedAt` in the body of a PUT arrives at `set()` untouched — and every
  // one of these models is `paranoid: true`, which makes that column the
  // archive.
  //
  // Which turns a column of the permission matrix into a decoration. The
  // Coordinador role is defined with `archivar: false` in all ten modules and
  // `editar: true` in four of them, so `requirePermission("eventos",
  // "archivar")` on the DELETE route guards a door that the PUT next to it
  // walks straight past. `editar` is not `archivar`, and the matrix says so.
  it("refuses deletedAt on a PUT, which is the archive column", async () => {
    const set = vi.fn();
    eventoFindOne.mockResolvedValue({
      dataValues: { id: 5, state: false, image: null, id_poste: 1, id_usuario: 3 },
      set,
      save: vi.fn(),
    });
    await updateEvento(
      reqOf({ description: "otra", deletedAt: "2020-01-01T00:00:00Z" }, { id: "5" }),
      resOf(),
    );

    expect(set).toHaveBeenCalled();
    expect(set.mock.calls[0][0]).not.toHaveProperty("deletedAt");
  });
});
