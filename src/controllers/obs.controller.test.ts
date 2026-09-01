// `updateObs` had no test of any kind, and after A0 it had no *coverage* of any
// kind either.
//
// It was one of the eight controllers whose audit entry described the request
// body instead of what was written. The fix moved the filter into a `const`, and
// that is exactly what took it out of `requestShape.test.ts`'s sight — the
// `.set()` stopped naming `req.body`. `logShape.test.ts` cannot see it for the
// mirror reason: the diff is built through a variable, so the `metadata` block
// does not name `req.body` either.
//
// So the two source-level tests both look straight through this file, and it is
// the only one of the eight where nothing else was watching. Hence a behavioural
// test, kept deliberately small: what the write accepts, and what the log claims.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const obsFindOne = vi.fn();
vi.mock("../models/obs.model.js", () => ({ ObsModel: { findOne: obsFindOne } }));
vi.mock("../models/tipoObs.model.js", () => ({ TipoObsModel: { findByPk: vi.fn().mockResolvedValue(null) } }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));

const { updateObs } = await import("./obs.controller.js");
const { logAction } = await import("../utils/logAction.js");

/** A request from user 7, carrying whatever body the test wants to try. */
const reqOf = (body: unknown, params: Record<string, string> = {}) =>
  ({ body, params, user: { id: 7, id_rol: 1 } }) as unknown as Request;

const resOf = () =>
  ({ status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() }) as unknown as Response;

describe("PUT /api/obs/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses deletedAt, which is the archive column, and does not log it either", async () => {
    // Every model this screen edits is `paranoid: true`, so `deletedAt` is the
    // archive. A role with `editar` and without `archivar` sending it must
    // neither archive the row nor leave an entry saying it did.
    const set = vi.fn();
    obsFindOne.mockResolvedValue({
      dataValues: { id: 4, name: "vieja", id_tipoObs: 2, deletedAt: null },
      set,
      save: vi.fn(),
    });

    await updateObs(
      reqOf({ name: "nueva", deletedAt: "2026-01-01T00:00:00Z" }, { id: "4" }),
      resOf(),
    );

    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0][0]).not.toHaveProperty("deletedAt");

    const entry = vi.mocked(logAction).mock.calls[0][0];
    const meta = entry.metadata as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    expect(meta.after).not.toHaveProperty("deletedAt");
    expect(meta.before).not.toHaveProperty("deletedAt");
  });

  it("still records the change that did happen", async () => {
    // The guard above is worthless if it works by logging nothing at all.
    const set = vi.fn();
    obsFindOne.mockResolvedValue({
      dataValues: { id: 4, name: "vieja", id_tipoObs: 2 },
      set,
      save: vi.fn(),
    });

    await updateObs(reqOf({ name: "nueva" }, { id: "4" }), resOf());

    expect(set.mock.calls[0][0]).toMatchObject({ name: "nueva" });
    const entry = vi.mocked(logAction).mock.calls[0][0];
    const meta = entry.metadata as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    expect(meta.before).toMatchObject({ name: "vieja" });
    expect(meta.after).toMatchObject({ name: "nueva" });
  });
});
