// Reading the permission matrix.
//
// Everything the API allows now passes through here, so the interesting cases
// are the ones where the answer is missing rather than the ones where it is
// written down: a role with no rows, a module nobody granted, a table that has
// not been migrated yet. Each of those must come back "no". A permission system
// that guesses "yes" when it is unsure is not a permission system.
//
// The cache is the other half. It exists so a question asked on every write does
// not become a query on every write, and it is only correct if a change is seen.

import { describe, it, expect, vi, beforeEach } from "vitest";

const findAll = vi.fn();
const bulkCreate = vi.fn();
vi.mock("../models/permiso.model.js", () => ({
  PermisoModel: {
    findAll: (...args: unknown[]) => findAll(...args),
    bulkCreate: (...args: unknown[]) => bulkCreate(...args),
  },
}));

const { can, permissionsFor, allPermissions, invalidatePermissions, seedRolePermissions } =
  await import("./store.js");
const { MODULES, ACTIONS, actionsOf } = await import("./matrix.js");

const ADMIN = 1;
const CLIENTE = 3;

const row = (id_rol: number, modulo: string, accion: string, permitido = true) => ({
  id_rol,
  modulo,
  accion,
  permitido,
});

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePermissions();
  findAll.mockResolvedValue([]);
});

describe("answering a question", () => {
  it("says yes only to what the table says yes to", async () => {
    findAll.mockResolvedValue([
      row(ADMIN, "eventos", "archivar", true),
      row(ADMIN, "eventos", "crear", false),
    ]);

    expect(await can(ADMIN, "eventos", "archivar")).toBe(true);
    expect(await can(ADMIN, "eventos", "crear")).toBe(false);
  });

  it("refuses a module nobody granted", async () => {
    findAll.mockResolvedValue([row(CLIENTE, "eventos", "ver")]);

    expect(await can(CLIENTE, "bitacora", "ver")).toBe(false);
    expect(await can(CLIENTE, "roles", "editar")).toBe(false);
  });

  it("refuses a role that has no rows at all", async () => {
    // A role created from the Seguridad screen before anybody configured it.
    findAll.mockResolvedValue([row(ADMIN, "eventos", "crear")]);

    expect(await can(4, "eventos", "crear")).toBe(false);
  });

  it("refuses when there is no role on the request", async () => {
    findAll.mockResolvedValue([row(ADMIN, "eventos", "crear")]);

    expect(await can(undefined, "eventos", "crear")).toBe(false);
  });

  it("refuses everything when the table is empty", async () => {
    // What a deployment looks like between the code landing and the migration
    // running. Closed, not open.
    for (const modulo of MODULES) {
      for (const accion of ACTIONS) {
        expect(await can(ADMIN, modulo, accion), `${modulo}.${accion}`).toBe(false);
      }
    }
  });

  it("ignores rows naming something the code no longer knows about", async () => {
    // A module deleted from the code leaves its rows behind. They are history,
    // not permission, and must not grant anything under a name nobody reads.
    findAll.mockResolvedValue([
      row(ADMIN, "modulo_que_ya_no_existe", "archivar"),
      row(ADMIN, "eventos", "accion_inventada"),
      row(ADMIN, "eventos", "ver"),
    ]);

    const permissions = await permissionsFor(ADMIN);
    expect(Object.keys(permissions).sort()).toEqual([...MODULES].sort());
    expect(permissions.eventos.ver).toBe(true);
    expect(Object.keys(permissions.eventos).sort()).toEqual([...ACTIONS].sort());
  });

  it("does not treat a non-boolean as permission", async () => {
    // Postgres returns booleans, but a hand-written row or a driver change
    // should not turn "0" or null into a yes.
    findAll.mockResolvedValue([
      { id_rol: ADMIN, modulo: "eventos", accion: "crear", permitido: "0" },
      { id_rol: ADMIN, modulo: "eventos", accion: "editar", permitido: null },
      { id_rol: ADMIN, modulo: "eventos", accion: "ver", permitido: 1 },
    ]);

    expect(await can(ADMIN, "eventos", "crear")).toBe(false);
    expect(await can(ADMIN, "eventos", "editar")).toBe(false);
    expect(await can(ADMIN, "eventos", "ver")).toBe(false);
  });

  it("grants nothing from a real action named against a module that does not have it", async () => {
    // The trapdoor. Every module used to carry all four verbs, so a row was
    // checked one half at a time — "is `bitacora` a module" and "is `archivar`
    // an action" — and both halves of `bitacora.archivar` answer yes. Nothing
    // asked whether the pair existed, because until now every pair did.
    //
    // Now that modules declare their own actions, that stops being true, and a
    // half-checked row is a permission nobody granted: it can be written today,
    // is read by nobody, and starts meaning yes the day that module gains that
    // action for real. The test above covers names the code does not know at
    // all; this one covers two names it knows perfectly well in the wrong
    // combination, which is the case that survives a `isAction()` check.
    findAll.mockResolvedValue([
      row(ADMIN, "bitacora", "archivar"),
      row(ADMIN, "reportes", "crear"),
      row(ADMIN, "archivos", "editar"),
    ]);

    expect(await can(ADMIN, "bitacora", "archivar")).toBe(false);
    expect(await can(ADMIN, "reportes", "crear")).toBe(false);
    expect(await can(ADMIN, "archivos", "editar")).toBe(false);
  });
});

describe("the shape handed to the client", () => {
  it("fills in each module's own actions, granted or not, and nothing else", async () => {
    // This used to walk `MODULES × ACTIONS` and demand a boolean in all forty
    // cells. Now a module carries only what it declares, and the second half of
    // the assertion is the half that matters: a cell that is absent has to read
    // as absent, not as a quietly denied one the screen would draw a box for.
    findAll.mockResolvedValue([row(CLIENTE, "eventos", "ver")]);

    const permissions = await permissionsFor(CLIENTE);
    for (const modulo of MODULES) {
      for (const accion of actionsOf(modulo)) {
        expect(typeof permissions[modulo][accion], `${modulo}.${accion}`).toBe("boolean");
      }
      for (const accion of ACTIONS) {
        if (actionsOf(modulo).includes(accion)) continue;
        expect(permissions[modulo][accion], `${modulo}.${accion}`).toBeUndefined();
      }
    }
    expect(permissions.eventos.ver).toBe(true);
    expect(permissions.eventos.crear).toBe(false);
    expect(permissions.bitacora.archivar).toBeUndefined();
  });

  it("gives an unknown role a complete set of denials, not an empty object", async () => {
    // The interface reads this to decide what to draw. Undefined would crash it;
    // an all-false matrix renders an empty application, which is the truth.
    const permissions = await permissionsFor(999);
    expect(Object.keys(permissions).sort()).toEqual([...MODULES].sort());
    expect(Object.values(permissions).every((m) => Object.values(m).every((v) => v === false)))
      .toBe(true);
  });

  it("returns one entry per role that has rows", async () => {
    findAll.mockResolvedValue([row(ADMIN, "eventos", "ver"), row(CLIENTE, "eventos", "ver")]);

    expect(Object.keys(await allPermissions()).sort()).toEqual(["1", "3"]);
  });
});

describe("the cache", () => {
  it("reads the table once and answers from memory after that", async () => {
    findAll.mockResolvedValue([row(ADMIN, "eventos", "crear")]);

    await can(ADMIN, "eventos", "crear");
    await can(ADMIN, "eventos", "editar");
    await can(CLIENTE, "postes", "ver");

    expect(findAll).toHaveBeenCalledTimes(1);
  });

  it("shares one query between questions asked at the same moment", async () => {
    // Without this a burst of requests on a cold cache each starts its own
    // query, which is the opposite of what a cache is for.
    findAll.mockResolvedValue([row(ADMIN, "eventos", "crear")]);

    await Promise.all([
      can(ADMIN, "eventos", "crear"),
      can(ADMIN, "eventos", "editar"),
      can(CLIENTE, "postes", "ver"),
    ]);

    expect(findAll).toHaveBeenCalledTimes(1);
  });

  it("sees a change after the write says so", async () => {
    findAll.mockResolvedValue([row(ADMIN, "eventos", "crear", false)]);
    expect(await can(ADMIN, "eventos", "crear")).toBe(false);

    findAll.mockResolvedValue([row(ADMIN, "eventos", "crear", true)]);
    // Still the old answer: nothing has told it otherwise.
    expect(await can(ADMIN, "eventos", "crear")).toBe(false);

    invalidatePermissions();
    expect(await can(ADMIN, "eventos", "crear")).toBe(true);
  });
});

describe("seeding a new role", () => {
  it("writes a denied row for every cell, so the screen has boxes to tick", async () => {
    await seedRolePermissions(4);

    const [rows] = bulkCreate.mock.calls[0] as [Record<string, unknown>[]];
    // Not `MODULES.length * ACTIONS.length` any more: that product counts the
    // eight cells no module has, and seeding them is how a freshly created role
    // would put back exactly what the cleanup migration deletes.
    const esperadas = MODULES.reduce((n, m) => n + actionsOf(m).length, 0);
    expect(rows).toHaveLength(esperadas);
    expect(rows.some((r) => r.modulo === "bitacora" && r.accion === "archivar")).toBe(false);
    expect(rows.every((r) => r.id_rol === 4 && r.permitido === false)).toBe(true);
    expect(new Set(rows.map((r) => r.modulo))).toEqual(new Set(MODULES));
  });

  it("does not trip over rows that already exist", async () => {
    await seedRolePermissions(4);

    const [, options] = bulkCreate.mock.calls[0] as [unknown, { ignoreDuplicates?: boolean }];
    expect(options?.ignoreDuplicates).toBe(true);
  });

  it("makes the new rows visible immediately", async () => {
    findAll.mockResolvedValue([]);
    await can(ADMIN, "eventos", "crear");
    expect(findAll).toHaveBeenCalledTimes(1);

    await seedRolePermissions(4);
    await can(ADMIN, "eventos", "crear");

    expect(findAll).toHaveBeenCalledTimes(2);
  });
});
