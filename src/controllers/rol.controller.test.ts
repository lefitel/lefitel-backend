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
import { Op } from "sequelize";

const rolFindOne = vi.fn();
const rolRestore = vi.fn();
// `findAndCountAll` and no longer `findAll`: since C3 every listing answers
// the same envelope, and the count comes back with the rows.
const rolFindAll = vi.fn();
const rolCreate = vi.fn();
// How many active roles already go by a name. Unset, it answers `undefined`,
// which is "none": the default every test about something else relies on.
const rolCount = vi.fn();
const usuarioCount = vi.fn();
const logAction = vi.fn();

vi.mock("../models/rol.model.js", () => ({
  RolModel: {
    findOne: (...a: unknown[]) => rolFindOne(...a),
    restore: (...a: unknown[]) => rolRestore(...a),
    findAndCountAll: (...a: unknown[]) => rolFindAll(...a),
    create: (...a: unknown[]) => rolCreate(...a),
    count: (...a: unknown[]) => rolCount(...a),
  },
}));
// Mocked rather than real: `usuario.model.ts` calls `RolModel.hasMany` while
// being imported, and `RolModel` above is a plain object with no such method.
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { count: (...a: unknown[]) => usuarioCount(...a) },
}));
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));
vi.mock("../permissions/store.js", () => ({ seedRolePermissions: vi.fn() }));

const { getRol, createRol, updateRol, deleteRol, desarchivarRol, exigirNombreDeRol } =
  await import("./rol.controller.js");

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

/**
 * The accounts the database holds, by role: `[total, of which archived]`.
 *
 * Answers the way Sequelize answers a grouped count — one row per role that has
 * any, the count already a number — and tells the two questions apart by the
 * one thing that differs between them, `paranoid: false`.
 */
function hayCuentas(porRol: Record<number, [number, number]>) {
  usuarioCount.mockImplementation(async (opciones: { where: { id_rol: number[] }; paranoid?: boolean }) =>
    opciones.where.id_rol
      .map((id) => {
        const [total, archivadas] = porRol[id] ?? [0, 0];
        return { id_rol: id, count: opciones.paranoid === false ? total : total - archivadas };
      })
      .filter((g) => g.count > 0));
}

beforeEach(() => {
  rolFindOne.mockReset();
  rolRestore.mockReset();
  rolFindAll.mockReset();
  rolCreate.mockReset();
  rolCount.mockReset();
  usuarioCount.mockReset();
  logAction.mockReset();
});

describe("deleteRol", () => {
  it("refuses while accounts still hold the role, and does not archive it", async () => {
    const destroy = vi.fn();
    rolFindOne.mockResolvedValue({ destroy });
    hayCuentas({ 2: [3, 0] });
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
    hayCuentas({ 7: [1, 0] });

    await deleteRol(req({ id: "7" }), fakeRes());

    for (const [opciones] of usuarioCount.mock.calls) {
      expect(opciones.where).toEqual({ id_rol: [7] });
    }
  });

  it("refuses while only archived accounts hold it, and says that is what they are", async () => {
    // The hole this closes: the guard counted active accounts only, so a role
    // held by archived ones could be archived — and restoring one of them left
    // a live account on an archived role, keeping permissions nobody can see.
    const destroy = vi.fn();
    rolFindOne.mockResolvedValue({ destroy });
    hayCuentas({ 5: [2, 2] });
    const res = fakeRes();

    await deleteRol(req({ id: "5" }), res);

    expect(res.statusCode).toBe(409);
    expect(destroy).not.toHaveBeenCalled();
    expect(res.body.cuentas).toBe(2);
    expect(String(res.body.message)).toContain("hay 2 cuentas con este rol, todas archivadas");
  });

  it("says how many of them are archived when only some are", async () => {
    rolFindOne.mockResolvedValue({ destroy: vi.fn() });
    hayCuentas({ 5: [4, 1] });
    const res = fakeRes();

    await deleteRol(req({ id: "5" }), res);

    expect(String(res.body.message)).toContain("hay 4 cuentas con este rol, 1 de ellas archivada.");
  });

  it("says nothing about archived accounts when there are none", async () => {
    rolFindOne.mockResolvedValue({ destroy: vi.fn() });
    hayCuentas({ 5: [4, 0] });
    const res = fakeRes();

    await deleteRol(req({ id: "5" }), res);

    expect(String(res.body.message)).not.toMatch(/archivad/);
  });

  it("says it in the singular when there is exactly one", async () => {
    rolFindOne.mockResolvedValue({ destroy: vi.fn() });
    hayCuentas({ 2: [1, 0] });
    const res = fakeRes();

    await deleteRol(req({ id: "2" }), res);

    expect(String(res.body.message)).toContain("1 cuenta con este rol");
    expect(String(res.body.message)).not.toContain("cuentas");
  });

  it("archives a role nobody holds", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    rolFindOne.mockResolvedValue({ destroy });
    hayCuentas({});
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
    hayCuentas({});

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
    rolFindOne.mockResolvedValue({ get: (campo: string) => (campo === "deletedAt" ? new Date() : 4) });
    const res = fakeRes();

    await desarchivarRol(req({ id: "4" }), res);

    expect(rolRestore).toHaveBeenCalledWith({ where: { id: "4" } });
    expect(res.statusCode).toBe(204);
    expect(logAction.mock.calls[0][0].action).toBe("RESTORE_ROL");
  });

  it("answers 404 and logs nothing when there was no archived role to restore", async () => {
    // It used to answer 204 and write "Desarchivó rol #99" for a role that did
    // not exist. `restore` does not fail when nothing matches.
    for (const fila of [null, { get: () => null }]) {
      rolFindOne.mockReset(); rolRestore.mockReset(); logAction.mockReset();
      rolFindOne.mockResolvedValue(fila);
      const res = fakeRes();

      await desarchivarRol(req({ id: "99" }), res);

      expect(res.statusCode).toBe(404);
      expect(rolRestore).not.toHaveBeenCalled();
      expect(logAction).not.toHaveBeenCalled();
    }
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

// A role with no name is a row every reader has to survive. One was made on a
// development database, and the account form — which lists the roles in a
// picker that searches by name — went blank for every account but one's own.
describe("the name of a role", () => {
  const withBody = (body: unknown, params: Record<string, string> = {}) =>
    ({ params, query: {}, body, user: { id: 1 } } as unknown as Request);

  for (const [caso, body] of [
    ["missing", { description: "x" }],
    ["null", { name: null }],
    ["empty", { name: "" }],
    ["only spaces", { name: "   " }],
    ["not text", { name: 7 }],
  ] as const) {
    it(`refuses to create one whose name is ${caso}, and writes nothing`, async () => {
      const res = fakeRes();
      await createRol(withBody(body), res);

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/nombre/);
      expect(rolCreate).not.toHaveBeenCalled();
      expect(logAction).not.toHaveBeenCalled();
    });
  }

  it("creates one that has a name", async () => {
    rolCreate.mockResolvedValue({ dataValues: { id: 9, name: "Auditor" } });
    const res = fakeRes();
    await createRol(withBody({ name: "Auditor" }), res);

    expect(res.statusCode).toBe(201);
    expect(rolCreate).toHaveBeenCalledTimes(1);
  });

  it("stores the name it checked, without the padding it looked past", async () => {
    rolCreate.mockResolvedValue({ dataValues: { id: 9, name: "Auditor" } });
    await createRol(withBody({ name: "  Auditor  ", description: "d" }), fakeRes());

    expect(rolCreate.mock.calls[0][0]).toEqual({ name: "Auditor", description: "d" });
    // And the audit line names what was stored, not what was typed.
    expect(logAction.mock.calls[0][0].detail).toBe('Creó rol "Auditor"');
  });

  for (const [caso, name] of [
    ["a zero width space", "\u200b"],
    ["a word joiner", "\u2060"],
    ["a soft hyphen", "\u00ad"],
    ["a Hangul filler", "\u3164"],
    ["spaces around invisible characters", " \u200b \ufeff "],
  ] as const) {
    it(`refuses a name that is only ${caso}, which would draw as an empty line`, async () => {
      // None of these is removed by `trim()`, so each one passed the first
      // version of this check and rendered exactly like the NULL it replaced.
      const res = fakeRes();
      await createRol(withBody({ name }), res);

      expect(res.statusCode).toBe(400);
      expect(rolCreate).not.toHaveBeenCalled();
    });
  }

  it("keeps a name that merely contains one of them", async () => {
    rolCreate.mockResolvedValue({ dataValues: { id: 9, name: "x" } });
    const res = fakeRes();
    await createRol(withBody({ name: "Jefe\u00adde\u00adzona" }), res);

    expect(res.statusCode).toBe(201);
  });

  for (const [caso, name] of [
    ["null", null], ["empty", ""], ["a number", 7], ["a list", ["Auditor"]],
  ] as const) {
    it(`refuses an edit whose name is ${caso}, before touching the row`, async () => {
      const res = fakeRes();
      await updateRol(withBody({ name }, { id: "4" }), res);

      expect(res.statusCode).toBe(400);
      expect(rolFindOne).not.toHaveBeenCalled();
    });
  }

  it("writes an edited name trimmed, and logs it that way", async () => {
    const set = vi.fn();
    const save = vi.fn();
    rolFindOne.mockResolvedValue({ dataValues: { id: 4, name: "Auditor", description: "" }, set, save });
    await updateRol(withBody({ name: " Inspector " }, { id: "4" }), fakeRes());

    expect(set).toHaveBeenCalledWith({ name: "Inspector" });
    expect(logAction.mock.calls[0][0].metadata).toEqual({
      before: { name: "Auditor" }, after: { name: "Inspector" },
    });
  });

  it("refuses an edit that blanks the name, before touching the row", async () => {
    const res = fakeRes();
    await updateRol(withBody({ name: " " }, { id: "4" }), res);

    expect(res.statusCode).toBe(400);
    expect(rolFindOne).not.toHaveBeenCalled();
  });

  it("lets an edit leave the name alone, and does not write one", async () => {
    const set = vi.fn();
    const save = vi.fn();
    rolFindOne.mockResolvedValue({ dataValues: { id: 4, name: "Auditor", description: "" }, set, save });
    const res = fakeRes();
    await updateRol(withBody({ description: "Solo lectura" }, { id: "4" }), res);

    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ description: "Solo lectura" });
  });
});

// The list says how many accounts hold each role, because that number is what
// decides whether a role can be archived at all.
describe("the accounts beside each role", () => {
  const fila = (id: number, name: string) => ({
    dataValues: { id, name },
    toJSON: () => ({ id, name }),
  });

  it("counts them for the whole page at once, and gives zero to a role nobody holds", async () => {
    rolFindAll.mockResolvedValue({ count: 2, rows: [fila(8, "nuevo"), fila(2, "Coordinador")] });
    hayCuentas({ 2: [6, 0] });
    const res = fakeRes();

    await getRol(req({}, {}), res);

    // Two grouped questions for the page — everyone, and the active ones —
    // however many roles are on it. Never one per role.
    expect(usuarioCount).toHaveBeenCalledTimes(2);
    for (const [opciones] of usuarioCount.mock.calls) {
      expect(opciones.where).toEqual({ id_rol: [8, 2] });
      expect(opciones.group).toEqual(["id_rol"]);
    }
    expect(res.body.data).toEqual([
      { id: 8, name: "nuevo", cuentas: 0, cuentasArchivadas: 0 },
      { id: 2, name: "Coordinador", cuentas: 6, cuentasArchivadas: 0 },
    ]);
    // The envelope every listing answers is still there around them.
    expect(res.body.total).toBe(2);
  });

  it("counts archived accounts too, and says how many of the total they are", async () => {
    // "0 cuentas" beside a role that archived accounts still hold was the
    // listing vouching for an archive the guard should refuse.
    rolFindAll.mockResolvedValue({ count: 2, rows: [fila(5, "Inspector"), fila(2, "Coordinador")] });
    hayCuentas({ 5: [2, 2], 2: [6, 1] });
    const res = fakeRes();

    await getRol(req({}, {}), res);

    expect(res.body.data).toEqual([
      { id: 5, name: "Inspector", cuentas: 2, cuentasArchivadas: 2 },
      { id: 2, name: "Coordinador", cuentas: 6, cuentasArchivadas: 1 },
    ]);
  });

  it("agrees with the archive guard about the same role", async () => {
    // One function answers both. Pinned because the two used to be separate
    // queries, and one changing without the other is how a list comes to say
    // "0" over a role that will not archive — or worse, the reverse.
    hayCuentas({ 5: [2, 2] });
    rolFindAll.mockResolvedValue({ count: 1, rows: [fila(5, "Inspector")] });
    const lista = fakeRes();
    await getRol(req({}, {}), lista);

    rolFindOne.mockResolvedValue({ destroy: vi.fn() });
    const archivo = fakeRes();
    await deleteRol(req({ id: "5" }), archivo);

    expect(archivo.body.cuentas).toBe(lista.body.data[0].cuentas);
  });

  it("asks nothing when there are no roles to count for", async () => {
    rolFindAll.mockResolvedValue({ count: 0, rows: [] });
    const res = fakeRes();

    await getRol(req({}, {}), res);

    expect(usuarioCount).not.toHaveBeenCalled();
    expect(res.body.data).toEqual([]);
  });
});

// Both writes sit behind the step-up gate, and the gate runs before the
// handler. So the name is also checked in front of the gate: nobody should type
// a password for a request that could never have worked.
describe("the name, checked before anybody is asked for a password", () => {
  const pasar = async (required: boolean, body: unknown, params: Record<string, string> = {}) => {
    const res = fakeRes();
    const next = vi.fn();
    await exigirNombreDeRol(required)({ body, params } as unknown as Request, res, next);
    return { res, next };
  };

  it("stops a creation with no name, and lets one with a name through", async () => {
    const sin = await pasar(true, {});
    expect(sin.res.statusCode).toBe(400);
    expect(sin.res.body.message).toMatch(/nombre/);
    expect(sin.next).not.toHaveBeenCalled();

    const con = await pasar(true, { name: "Auditor" });
    expect(con.next).toHaveBeenCalledTimes(1);
    expect(con.res.statusCode).toBe(0);
  });

  it("stops an edit that blanks the name, and lets one that leaves it alone through", async () => {
    expect((await pasar(false, { name: " " })).next).not.toHaveBeenCalled();
    expect((await pasar(false, { description: "x" })).next).toHaveBeenCalledTimes(1);
  });

  it("stops a name another role already has, here too", async () => {
    rolCount.mockResolvedValue(1);
    const { res, next } = await pasar(true, { name: "Supervisor" });

    expect(res.statusCode).toBe(409);
    expect(next).not.toHaveBeenCalled();
  });

  it("stands between the permission and the gate on both writes", async () => {
    // Read from the route file, because the order of three middlewares is the
    // whole of this and nothing short of a real request would otherwise see it.
    const { readFileSync } = await import("node:fs");
    const rutas = readFileSync(new URL("../routes/rol.routes.ts", import.meta.url), "utf8");

    expect(rutas).toMatch(
      /router\.post\("\/", requirePermission\("roles", "crear"\), exigirNombreDeRol\(true\), requireStepUp\(\), createRol\)/,
    );
    expect(rutas).toMatch(
      /router\.put\("\/:id", requirePermission\("roles", "editar"\), exigirNombreDeRol\(false\), requireStepUp\(\), updateRol\)/,
    );
  });
});

// Two roles called the same cannot be told apart in the picker that hands a
// role to an account, and a report filtered by role name merges them.
describe("a name another role already has", () => {
  const withBody = (body: unknown, params: Record<string, string> = {}) =>
    ({ params, query: {}, body, user: { id: 1 } } as unknown as Request);

  /** The condition the count was asked with, flattened enough to read. */
  const preguntado = () => JSON.stringify(rolCount.mock.calls[0][0].where[Op.and]);

  it("refuses to create a second one, says which name, and writes nothing", async () => {
    rolCount.mockResolvedValue(1);
    const res = fakeRes();
    await createRol(withBody({ name: "Supervisor" }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe("Ya existe un rol llamado «Supervisor». Elige otro nombre.");
    expect(rolCreate).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("compares without regard to case, and against the trimmed name", async () => {
    rolCount.mockResolvedValue(0);
    rolCreate.mockResolvedValue({ dataValues: { id: 9 } });
    await createRol(withBody({ name: "  SuperVisor " }), fakeRes());

    // lower(name) against the lower-cased, trimmed name.
    expect(preguntado()).toContain('"supervisor"');
    expect(preguntado()).toContain('"lower"');
    // A new role is compared against every role: one condition, nobody left out.
    expect(rolCount.mock.calls[0][0].where[Op.and]).toHaveLength(1);
    // Among active roles only: no `paranoid: false`.
    expect(rolCount.mock.calls[0][0].paranoid).toBeUndefined();
  });

  it("refuses an edit that takes another role's name, before touching the row", async () => {
    rolCount.mockResolvedValue(1);
    const res = fakeRes();
    await updateRol(withBody({ name: "Supervisor" }, { id: "4" }), res);

    expect(res.statusCode).toBe(409);
    expect(rolFindOne).not.toHaveBeenCalled();
  });

  it("does not count a role against itself, so it can be saved under its own name", async () => {
    rolCount.mockResolvedValue(0);
    rolFindOne.mockResolvedValue({ dataValues: { id: 4, name: "Supervisor" }, set: vi.fn(), save: vi.fn() });
    const res = fakeRes();
    await updateRol(withBody({ name: "Supervisor", description: "x" }, { id: "4" }), res);

    expect(res.statusCode).toBe(200);
    // The question left role 4 out: a second condition, "id is not 4".
    const condiciones = rolCount.mock.calls[0][0].where[Op.and];
    expect(condiciones).toHaveLength(2);
    expect(condiciones[1].id[Op.ne]).toBe(4);
  });

  it("asks nothing when an edit leaves the name alone", async () => {
    rolFindOne.mockResolvedValue({ dataValues: { id: 4, name: "Supervisor" }, set: vi.fn(), save: vi.fn() });
    await updateRol(withBody({ description: "x" }, { id: "4" }), fakeRes());

    expect(rolCount).not.toHaveBeenCalled();
  });

  it("refuses to bring back an archived role whose name is taken, and says which to rename", async () => {
    rolFindOne.mockResolvedValue({
      get: (campo: string) => ({ id: 6, name: "Supervisor", deletedAt: new Date() } as Record<string, unknown>)[campo],
    });
    rolCount.mockResolvedValue(1);
    const res = fakeRes();
    await desarchivarRol(req({ id: "6" }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toContain("ya hay un rol activo llamado «Supervisor»");
    expect(rolRestore).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it("brings one back when its name is free", async () => {
    rolFindOne.mockResolvedValue({
      get: (campo: string) => ({ id: 6, name: "Supervisor", deletedAt: new Date() } as Record<string, unknown>)[campo],
    });
    rolCount.mockResolvedValue(0);
    rolRestore.mockResolvedValue(undefined);
    const res = fakeRes();
    await desarchivarRol(req({ id: "6" }), res);

    expect(res.statusCode).toBe(204);
    expect(rolRestore).toHaveBeenCalledTimes(1);
  });
});

// The check before writing is a read followed by a write, so two requests that
// arrive together both pass it. The database holds the rule for that case, and
// the second writer is told the same thing the check would have told them.
describe("a clash the database catches, because two wrote at once", () => {
  const withBody = (body: unknown, params: Record<string, string> = {}) =>
    ({ params, query: {}, body, user: { id: 1 } } as unknown as Request);
  const choque = Object.assign(new Error("Validation error"), { name: "SequelizeUniqueConstraintError" });

  it("answers a creation with the name that clashed, and logs nothing", async () => {
    rolCount.mockResolvedValue(0);
    rolCreate.mockRejectedValue(choque);
    const res = fakeRes();
    await createRol(withBody({ name: "Supervisor" }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe("Ya existe un rol llamado «Supervisor». Elige otro nombre.");
    expect(logAction).not.toHaveBeenCalled();
  });

  it("answers a rename the same way", async () => {
    rolCount.mockResolvedValue(0);
    rolFindOne.mockResolvedValue({
      dataValues: { id: 4, name: "Auditor" }, set: vi.fn(), save: vi.fn().mockRejectedValue(choque),
    });
    const res = fakeRes();
    await updateRol(withBody({ name: "Supervisor" }, { id: "4" }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toContain("«Supervisor»");
    expect(logAction).not.toHaveBeenCalled();
  });

  it("does not swallow any other failure of the write", async () => {
    rolCount.mockResolvedValue(0);
    rolCreate.mockRejectedValue(new Error("la base no responde"));
    const res = fakeRes();
    await createRol(withBody({ name: "Supervisor" }), res);

    expect(res.statusCode).not.toBe(409);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });
});
