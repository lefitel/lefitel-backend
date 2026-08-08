// The role gate.
//
// Seventeen statements that decide who reaches a module, and nothing exercised
// them. Every case here is a way in: a request with no session, a role that was
// never granted, and — the one that actually serves two purposes — a user
// reaching for someone else's record on an endpoint that must still let them
// reach their own.

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireRole, requireSelfOrRole } from "./requireRole.js";

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
    req: { user: user, params } as unknown as Request,
    res: res as unknown as Response,
    next: next as unknown as NextFunction,
    calledNext: () => (next as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0,
    get statusCode() {
      return res.statusCode;
    },
    get body() {
      return res.body as { message?: string } | undefined;
    },
  };
}

const ADMIN = 1;
const SUPERVISOR = 2;
const TECNICO = 3;

describe("requireRole", () => {
  it("turns away a request that carries no session", () => {
    const call = exchange(undefined);
    requireRole(ADMIN)(call.req, call.res, call.next);

    expect(call.statusCode).toBe(401);
    expect(call.calledNext()).toBe(false);
  });

  it("turns away a role that was not granted, and says so", () => {
    const call = exchange({ id: 7, id_rol: TECNICO });
    requireRole(ADMIN, SUPERVISOR)(call.req, call.res, call.next);

    expect(call.statusCode).toBe(403);
    expect(call.body?.message).toMatch(/permiso/i);
    // The point of the gate: the handler behind it never runs.
    expect(call.calledNext()).toBe(false);
  });

  it("lets a granted role through without answering", () => {
    const call = exchange({ id: 7, id_rol: SUPERVISOR });
    requireRole(ADMIN, SUPERVISOR)(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
    expect(call.statusCode).toBe(0);
  });

  it("does not mistake role zero for an absent session", () => {
    // `if (role === undefined)` rather than `if (!role)`, deliberately: a falsy
    // check would answer 401 to a role the deployment does grant.
    const call = exchange({ id: 7, id_rol: 0 });
    requireRole(0)(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
  });

  it("grants nothing when the list of roles is empty", () => {
    const call = exchange({ id: 7, id_rol: ADMIN });
    requireRole()(call.req, call.res, call.next);

    expect(call.statusCode).toBe(403);
    expect(call.calledNext()).toBe(false);
  });
});

describe("requireSelfOrRole", () => {
  it("turns away a request that carries no session", () => {
    const call = exchange(undefined, { id: "7" });
    requireSelfOrRole(ADMIN)(call.req, call.res, call.next);

    expect(call.statusCode).toBe(401);
    expect(call.calledNext()).toBe(false);
  });

  it("lets a listed role act on anyone", () => {
    const call = exchange({ id: 1, id_rol: ADMIN }, { id: "99" });
    requireSelfOrRole(ADMIN)(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
  });

  it("lets anyone act on their own record", () => {
    // This is why the route cannot simply be locked to administrators: it is
    // also how the profile page loads the user looking at it.
    const call = exchange({ id: 7, id_rol: TECNICO }, { id: "7" });
    requireSelfOrRole(ADMIN)(call.req, call.res, call.next);

    expect(call.calledNext()).toBe(true);
  });

  it("stops a user reaching for somebody else's record", () => {
    const call = exchange({ id: 7, id_rol: TECNICO }, { id: "8" });
    requireSelfOrRole(ADMIN)(call.req, call.res, call.next);

    expect(call.statusCode).toBe(403);
    expect(call.body?.message).toMatch(/su propio usuario/i);
    expect(call.calledNext()).toBe(false);
  });

  it("reads only the first value when the id arrives repeated", () => {
    // A repeated query parameter arrives as an array. Comparing an array to a
    // number is always false, so without the guard this answered 403 to a user
    // asking for their own record; with it, the extra value is ignored rather
    // than granting anything.
    const own = exchange({ id: 7, id_rol: TECNICO }, { id: ["7", "8"] });
    requireSelfOrRole(ADMIN)(own.req, own.res, own.next);
    expect(own.calledNext()).toBe(true);

    const other = exchange({ id: 7, id_rol: TECNICO }, { id: ["8", "7"] });
    requireSelfOrRole(ADMIN)(other.req, other.res, other.next);
    expect(other.statusCode).toBe(403);
  });

  it("refuses an id that is not a number rather than coercing it into one", () => {
    for (const id of ["abc", "", " ", "null", "7abc"]) {
      const call = exchange({ id: 7, id_rol: TECNICO }, { id });
      requireSelfOrRole(ADMIN)(call.req, call.res, call.next);

      expect(call.calledNext(), `id ${JSON.stringify(id)}`).toBe(false);
      expect(call.statusCode, `id ${JSON.stringify(id)}`).toBe(403);
    }
  });
});
