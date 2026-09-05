// Archiving a role, and the cascade it used to fire.
//
// `DELETE /api/rol/:id` called `RolModel.destroy()` against a table with no
// `deletedAt`, so it was a real DELETE — and `usuarios.id_rol` is ON DELETE
// CASCADE. 20260822000001-create-sesion.ts records that chain being measured at
// six users and 4.835 revisions through seventeen keys, which is why it chose
// RESTRICT for sessions rather than join it. The audit line the handler wrote
// said `Eliminó rol #4` and nothing about the people.
//
// Three things close it, and only the third is testable here: the migration adds
// the column, `paranoid: true` on the model turns `destroy()` into an UPDATE,
// and the guard below refuses while anybody still holds the role. The first two
// have their own tests; these pin the third, and pin that the handler still
// reaches `destroy()` at all once the guard passes — a guard that refuses
// everything would look identical to a guard that works.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const rolFindOne = vi.fn();
const rolRestore = vi.fn();
// `findAndCountAll` and no longer `findAll`: since C3 every listing answers
// the same envelope, and the count comes back with the rows.
const rolFindAll = vi.fn();
const usuarioCount = vi.fn();
const logAction = vi.fn();

vi.mock("../models/rol.model.js", () => ({
  RolModel: {
    findOne: (...a: unknown[]) => rolFindOne(...a),
    restore: (...a: unknown[]) => rolRestore(...a),
    findAndCountAll: (...a: unknown[]) => rolFindAll(...a),
  },
}));
// Mocked rather than real: `usuario.model.ts` calls `RolModel.hasMany` while
// being imported, and `RolModel` above is a plain object with no such method.
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { count: (...a: unknown[]) => usuarioCount(...a) },
}));
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));
vi.mock("../permissions/store.js", () => ({ seedRolePermissions: vi.fn() }));

const { getRol, deleteRol, desarchivarRol } = await import("./rol.controller.js");

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    sendStatus(code: number) { this.statusCode = code; return this; },
    // A 204 ends the response instead of writing one. Without this the
    // handler throws inside `makeHandler` and the test reads 500.
    end() { return this; },
  };
  // An arbitrary JSON body, read straight off (`body.cuentas`, `body.message`)
  // rather than through a cast at each assertion. `unknown` would need one every
  // time: for a serialised response, `any` is the right type here and the rule
  // is the thing that is wrong. Turned off on this line, with the reason, so that
  // `eslint` can be a deploy gate (task E3 of the API standard).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res as unknown as Response & { statusCode: number; body: any };
}

const req = (params: Record<string, string> = {}, query: Record<string, string> = {}) =>
  ({ params, query, user: { id: 1 } } as unknown as Request);

beforeEach(() => {
  rolFindOne.mockReset();
  rolRestore.mockReset();
  rolFindAll.mockReset();
  usuarioCount.mockReset();
  logAction.mockReset();
});

describe("deleteRol", () => {
  it("refuses while accounts still hold the role, and does not archive it", async () => {
    const destroy = vi.fn();
    rolFindOne.mockResolvedValue({ destroy });
    usuarioCount.mockResolvedValue(3);
    const res = fakeRes();

    await deleteRol(req({ id: "2" }), res);

    expect(res.statusCode).toBe(409);
    expect(destroy).not.toHaveBeenCalled();
    // The number matters: "cannot archive" without it leaves the administrator
    // hunting through the user list for accounts that may not be on screen.
    expect(res.body.cuentas).toBe(3);
    expect(String(res.body.message)).toContain("3");
  });

  it("counts the accounts of that role, not of some other", async () => {
    rolFindOne.mockResolvedValue({ destroy: vi.fn() });
    usuarioCount.mockResolvedValue(1);

    await deleteRol(req({ id: "7" }), fakeRes());

    expect(usuarioCount).toHaveBeenCalledWith({ where: { id_rol: "7" } });
  });

  it("says it in the singular when there is exactly one", async () => {
    rolFindOne.mockResolvedValue({ destroy: vi.fn() });
    usuarioCount.mockResolvedValue(1);
    const res = fakeRes();

    await deleteRol(req({ id: "2" }), res);

    expect(String(res.body.message)).toContain("1 cuenta con este rol");
    expect(String(res.body.message)).not.toContain("cuentas");
  });

  it("archives a role nobody holds", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    rolFindOne.mockResolvedValue({ destroy });
    usuarioCount.mockResolvedValue(0);
    const res = fakeRes();

    await deleteRol(req({ id: "4" }), res);

    expect(destroy).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(204);
  });

  it("logs the archive as critical, and says archived rather than deleted", async () => {
    // The old line read "Eliminó rol #4" for an operation that also erased
    // accounts. It is neither any more, and the audit log should not keep
    // claiming a deletion that no longer happens.
    rolFindOne.mockResolvedValue({ destroy: vi.fn() });
    usuarioCount.mockResolvedValue(0);

    await deleteRol(req({ id: "4" }), fakeRes());

    const entry = logAction.mock.calls[0][0];
    expect(entry.severity).toBe("critical");
    expect(entry.entity_id).toBe(4);
    expect(String(entry.detail)).toMatch(/Archiv/i);
    expect(String(entry.detail)).not.toMatch(/Elimin/i);
  });

  it("answers 404 for a role that is not there, without counting or archiving", async () => {
    rolFindOne.mockResolvedValue(null);
    const res = fakeRes();

    await deleteRol(req({ id: "99" }), res);

    expect(res.statusCode).toBe(404);
    expect(usuarioCount).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe("desarchivarRol", () => {
  it("restores the role and logs it", async () => {
    rolRestore.mockResolvedValue(undefined);
    const res = fakeRes();

    await desarchivarRol(req({ id: "4" }), res);

    expect(rolRestore).toHaveBeenCalledWith({ where: { id: "4" } });
    expect(res.statusCode).toBe(204);
    expect(logAction.mock.calls[0][0].action).toBe("RESTORE_ROL");
  });
});

describe("getRol", () => {
  it("hides archived roles by default", async () => {
    rolFindAll.mockResolvedValue({ count: 0, rows: [] });

    await getRol(req({}, {}), fakeRes());

    const opts = rolFindAll.mock.calls[0][0];
    expect(opts.paranoid).toBe(true);
    expect(opts.where).toBeUndefined();
  });

  it("lists only the archived ones when asked", async () => {
    rolFindAll.mockResolvedValue({ count: 0, rows: [] });

    await getRol(req({}, { archived: "true" }), fakeRes());

    const opts = rolFindAll.mock.calls[0][0];
    // Both halves are needed: `paranoid: false` alone would list every role,
    // archived and not, under a heading that says archived.
    expect(opts.paranoid).toBe(false);
    expect(opts.where).toBeDefined();
  });

  it("treats any other value of the flag as 'not archived'", async () => {
    rolFindAll.mockResolvedValue({ count: 0, rows: [] });

    await getRol(req({}, { archived: "1" }), fakeRes());

    expect(rolFindAll.mock.calls[0][0].paranoid).toBe(true);
  });
});
