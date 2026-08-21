// The permission gate.
//
// This is the piece that decides who reaches what, so every way past it is a
// case here: a request with no session, a permission that was never granted,
// and — the one that serves two purposes — a person reaching for someone else's
// record on an endpoint that must still let them reach their own.
//
// The matrix itself is mocked. What is under test is the gate's decision, not
// what the database happens to hold today; store.test.ts covers the reading.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const can = vi.fn();
vi.mock("../permissions/store.js", () => ({ can: (...args: unknown[]) => can(...args) }));

const { requirePermission, requireSelfOrPermission } = await import("./requirePermission.js");

interface Caller {
  id?: number;
  id_rol?: number;
}

/** A request/response pair recording what the middleware did with it. */
function exchange(user: Caller | undefined, params: Record<string, unknown> = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  const next = vi.fn();
  return {
    req: { user, params } as unknown as Request,
    res: res as unknown as Response,
    next: next as unknown as NextFunction,
    calledNext: () => next.mock.calls.length > 0,
    get statusCode() {
      return res.statusCode;
    },
    get body() {
      return res.body as { message?: string } | undefined;
    },
  };
}

const ADMIN = 1;
const TECNICO = 3;

/** Grant exactly one cell of the matrix and deny everything else. */
function grant(role: number, modulo: string, accion: string) {
  can.mockImplementation(async (r: number, m: string, a: string) =>
    r === role && m === modulo && a === accion,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  can.mockResolvedValue(false);
});

describe("requirePermission", () => {
  it("turns away a request that carries no session", async () => {
    const call = exchange(undefined);
    await requirePermission("eventos", "crear")(call.req, call.res, call.next);

    expect(call.statusCode).toBe(401);
    expect(call.calledNext()).toBe(false);
    // Never even asked: no role, no question.
    expect(can).not.toHaveBeenCalled();
  });

  it("turns away a permission that was not granted, and says so", async () => {
    grant(ADMIN, "eventos", "archivar");
    const call = exchange({ id: 7, id_rol: TECNICO });
    await requirePermission("eventos", "archivar")(call.req, call.res, call.next);

    expect(call.statusCode).toBe(403);
    expect(call.body?.message).toMatch(/permiso/i);
    // The point of the gate: the handler behind it never runs.
    expect(call.calledNext()).toBe(false);
  });

  it("lets a granted permission through without answering", async () => {
    grant(TECNICO, "eventos", "crear");
    const call = exchange({ id: 7, id_rol: TECNICO });
    await requirePermission("eventos", "crear")(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
    expect(call.statusCode).toBe(0);
  });

  it("asks about the module and action of this route, not another", async () => {
    grant(TECNICO, "eventos", "crear");
    const call = exchange({ id: 7, id_rol: TECNICO });
    await requirePermission("eventos", "archivar")(call.req, call.res, call.next);

    // Holding "crear" on the same module must not open "archivar" — that
    // distinction is the whole reason the matrix has four columns.
    expect(call.statusCode).toBe(403);
    expect(can).toHaveBeenCalledWith(TECNICO, "eventos", "archivar");
  });

  it("does not mistake role zero for an absent session", async () => {
    // `if (role === undefined)` rather than `if (!role)`, deliberately: a falsy
    // check would answer 401 to a role the deployment does grant.
    grant(0, "eventos", "crear");
    const call = exchange({ id: 7, id_rol: 0 });
    await requirePermission("eventos", "crear")(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
  });
});

describe("requireSelfOrPermission", () => {
  it("turns away a request that carries no session", async () => {
    const call = exchange(undefined, { id: "7" });
    await requireSelfOrPermission("seguridad", "editar")(call.req, call.res, call.next);

    expect(call.statusCode).toBe(401);
    expect(call.calledNext()).toBe(false);
  });

  it("lets the permission act on anyone", async () => {
    grant(ADMIN, "seguridad", "editar");
    const call = exchange({ id: 1, id_rol: ADMIN }, { id: "99" });
    await requireSelfOrPermission("seguridad", "editar")(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
  });

  it("lets anyone act on their own record", async () => {
    // This is why the route cannot simply be locked to the module: it is also
    // how the profile page loads the user looking at it.
    const call = exchange({ id: 7, id_rol: TECNICO }, { id: "7" });
    await requireSelfOrPermission("seguridad", "editar")(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
  });

  it("stops a user reaching for somebody else's record", async () => {
    const call = exchange({ id: 7, id_rol: TECNICO }, { id: "8" });
    await requireSelfOrPermission("seguridad", "editar")(call.req, call.res, call.next);

    expect(call.statusCode).toBe(403);
    expect(call.body?.message).toMatch(/su propio usuario/i);
    expect(call.calledNext()).toBe(false);
  });

  it("reads the parameter the route actually declared", async () => {
    // The bitácora route calls it `:id_usuario`. The previous middleware read
    // "id" unconditionally, compared undefined to the caller's id, and so
    // answered 403 to a user asking for their own activity — while the comment
    // above it promised the opposite.
    const call = exchange({ id: 7, id_rol: TECNICO }, { id_usuario: "7" });
    await requireSelfOrPermission("bitacora", "ver", "id_usuario")(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
  });

  it("does not fall back to another parameter when the named one is missing", async () => {
    const call = exchange({ id: 7, id_rol: TECNICO }, { id: "7" });
    await requireSelfOrPermission("bitacora", "ver", "id_usuario")(call.req, call.res, call.next);

    expect(call.statusCode).toBe(403);
    expect(call.calledNext()).toBe(false);
  });

  it("reads only the first value when the id arrives repeated", async () => {
    // A repeated parameter arrives as an array. Comparing an array to a number
    // is always false, so without the guard this answered 403 to a user asking
    // for their own record; with it, the extra value is ignored rather than
    // granting anything.
    const own = exchange({ id: 7, id_rol: TECNICO }, { id: ["7", "8"] });
    await requireSelfOrPermission("seguridad", "editar")(own.req, own.res, own.next);
    expect(own.calledNext()).toBe(true);

    const other = exchange({ id: 7, id_rol: TECNICO }, { id: ["8", "7"] });
    await requireSelfOrPermission("seguridad", "editar")(other.req, other.res, other.next);
    expect(other.statusCode).toBe(403);
  });

  it("refuses an id that is not a number rather than coercing it into one", async () => {
    for (const id of ["abc", "", " ", "null", "7abc"]) {
      const call = exchange({ id: 7, id_rol: TECNICO }, { id });
      await requireSelfOrPermission("seguridad", "editar")(call.req, call.res, call.next);

      expect(call.calledNext(), `id ${JSON.stringify(id)}`).toBe(false);
      expect(call.statusCode, `id ${JSON.stringify(id)}`).toBe(403);
    }
  });
});

describe("when the matrix cannot be read", () => {
  // The gates are async, and Express 4 catches only what a handler throws
  // synchronously — a rejected promise it returns is dropped, and Node ends the
  // process over it. So a failed permissions query did not answer 403 or 500:
  // it took the API down, reachable from any account with a session. The matrix
  // is cached behind one shared in-flight promise, so a single failed load
  // rejected every concurrent check at the same moment.

  /** Lets the wrapper's catch run before the assertion reads the response. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("answers 500 rather than ending the process", async () => {
    can.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const call = exchange({ id: 7, id_rol: TECNICO });
    requirePermission("eventos", "crear")(call.req, call.res, call.next);
    await settle();

    expect(call.calledNext()).toBe(false);
    expect(call.statusCode).toBe(500);
    expect(call.body?.message).toMatch(/permiso/i);
  });

  it("does not fall through to the ownership check", async () => {
    // Fail closed. Reaching your own record is a second question, and the first
    // one has not been answered: with the matrix unreadable we do not know
    // whether this role may act on anyone's record at all.
    can.mockRejectedValue(new Error("pool exhausted"));

    const call = exchange({ id: 7, id_rol: TECNICO }, { id: "7" });
    requireSelfOrPermission("seguridad", "editar")(call.req, call.res, call.next);
    await settle();

    expect(call.calledNext()).toBe(false);
    expect(call.statusCode).toBe(500);
  });

  it("leaves a response already sent alone", async () => {
    // Writing a second time on the same response throws inside the catch, which
    // is the same unhandled rejection by another road.
    can.mockRejectedValue(new Error("boom"));

    const call = exchange({ id: 7, id_rol: TECNICO });
    (call.res as unknown as { headersSent: boolean }).headersSent = true;
    requirePermission("eventos", "crear")(call.req, call.res, call.next);
    await settle();

    expect(call.statusCode).toBe(0);
  });
});
