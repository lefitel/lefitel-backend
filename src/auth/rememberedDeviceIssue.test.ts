// `acunarDispositivo` and `comprobarDispositivo` — minting a "remember this
// device" cookie and deciding whether an existing one still counts.
//
// The fake table reads the `where` it is handed by meaning, the same
// discipline `rememberedDeviceStore.test.ts` and `factorInventory.test.ts`
// already follow: a mock that answers a canned value regardless of its
// argument would let `id_usuario` quietly fall out of the query and still
// show every test here green.
//
// Task 12's own list names five tests. Four of them are about this module —
// minting, and the three refusals of `comprobarDispositivo`'s WHERE. The
// fifth, "does not exempt a remembered login from the account lockout", is
// about `login`'s own ordering (password checked before the cookie is ever
// looked at) rather than about either function here, so it lives in
// `auth.controller.test.ts` beside the rest of that handler's behaviour.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";
import type { Request } from "express";

type Fila = Record<string, unknown>;

let tabla: Fila[] = [];

/**
 * Decides whether one row satisfies the `where` `comprobarDispositivo` sends.
 * Only the operator that query actually uses (`Op.gt`) is understood; a
 * clause built with anything else throws rather than quietly matching
 * everything, the same choice the other fake tables in this arc make.
 */
function matches(row: Fila, where: Fila): boolean {
  return Object.entries(where).every(([columna, clausula]) => {
    const valor = row[columna];
    if (clausula === null || clausula instanceof Date || typeof clausula !== "object") {
      return valor === clausula;
    }
    return Object.getOwnPropertySymbols(clausula).every((op) => {
      const limite = (clausula as Record<symbol, unknown>)[op];
      if (op === Op.gt) return valor instanceof Date && limite instanceof Date && valor > limite;
      throw new Error(`the fake table does not understand the operator ${String(op)}`);
    });
  });
}

const create = vi.fn(async (valores: Fila) => {
  tabla.push({ ...valores });
  return { dataValues: valores };
});
const findOne = vi.fn(async ({ where }: { where: Fila }) => {
  const fila = tabla.find((f) => matches(f, where));
  return fila ? { dataValues: fila } : null;
});

vi.mock("../models/dispositivoRecordado.model.js", () => ({
  DispositivoRecordadoModel: {
    create: (...a: unknown[]) => create(a[0] as Fila),
    findOne: (...a: unknown[]) => findOne(a[0] as { where: Fila }),
  },
}));

const { acunarDispositivo, comprobarDispositivo, setRememberedDeviceCookie, readRememberedDeviceCookie } =
  await import("./rememberedDeviceIssue.js");
const { hashOpaqueToken } = await import("./opaqueToken.js");
const { REMEMBERED_DEVICE_COOKIE_NAME } = await import("../config/security.js");

const DUENO = 7;
const AJENO = 99;

function reqFake(overrides: Partial<Request> = {}): Request {
  return {
    headers: { "user-agent": "TestRunner" },
    ip: "203.0.113.9",
    ...overrides,
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  tabla = [];
});

describe("acunarDispositivo", () => {
  it("mints a token that is only ever stored hashed", async () => {
    const token = await acunarDispositivo(DUENO, reqFake());

    expect(create).toHaveBeenCalledOnce();
    const escrito = tabla[0];
    // The row never carries the plaintext, only a 64-character hex digest of it.
    expect(escrito.token_hash).toBe(hashOpaqueToken(token));
    expect(escrito.token_hash).not.toBe(token);
    expect(escrito.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes the account, the metadata and an expiry in the same row", async () => {
    const token = await acunarDispositivo(DUENO, reqFake({ ip: "198.51.100.7" } as Partial<Request>));

    const escrito = tabla[0];
    expect(escrito.id_usuario).toBe(DUENO);
    expect(escrito.user_agent).toBe("TestRunner");
    expect(escrito.ip_address).toBe("198.51.100.7");
    expect(escrito.revoked_at).toBeNull();
    expect(escrito.expires_at).toBeInstanceOf(Date);
    expect((escrito.expires_at as Date).getTime()).toBeGreaterThan(Date.now());
    // Round-trips through the check it exists for.
    expect(await comprobarDispositivo(token, DUENO)).toBe(true);
  });
});

describe("comprobarDispositivo", () => {
  it("accepts a token that was really minted for this account", async () => {
    const token = await acunarDispositivo(DUENO, reqFake());
    expect(await comprobarDispositivo(token, DUENO)).toBe(true);
  });

  it("refuses a token that belongs to another account", async () => {
    // The whole point of the four-condition WHERE (hallazgo C15): checked on
    // the hash alone, this cookie would skip a stranger's second factor.
    const token = await acunarDispositivo(DUENO, reqFake());
    expect(await comprobarDispositivo(token, AJENO)).toBe(false);
  });

  it("refuses a revoked device", async () => {
    const token = "token-de-prueba-revocado";
    tabla.push({
      id_usuario: DUENO,
      token_hash: hashOpaqueToken(token),
      revoked_at: new Date(),
      expires_at: new Date(Date.now() + 10_000),
    });

    expect(await comprobarDispositivo(token, DUENO)).toBe(false);
  });

  it("refuses an expired device", async () => {
    const token = "token-de-prueba-caducado";
    tabla.push({
      id_usuario: DUENO,
      token_hash: hashOpaqueToken(token),
      revoked_at: null,
      expires_at: new Date(Date.now() - 10_000),
    });

    expect(await comprobarDispositivo(token, DUENO)).toBe(false);
  });

  it("refuses a token nothing ever minted", async () => {
    expect(await comprobarDispositivo("nunca-existio", DUENO)).toBe(false);
  });
});

describe("the cookie itself", () => {
  it("sets it httpOnly, Strict, and scoped to the login route", () => {
    const cookie = vi.fn();
    setRememberedDeviceCookie({ cookie } as unknown as Parameters<typeof setRememberedDeviceCookie>[0], "un-token");

    const [name, value, options] = cookie.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(name).toBe(REMEMBERED_DEVICE_COOKIE_NAME);
    expect(value).toBe("un-token");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/api/auth/login" });
    expect(options.expires).toBeInstanceOf(Date);
  });

  it("reads back what a real request carries", () => {
    const req = { cookies: { [REMEMBERED_DEVICE_COOKIE_NAME]: "el-valor" } } as unknown as Request;
    expect(readRememberedDeviceCookie(req)).toBe("el-valor");
  });

  it("ignores a cookie-parser JSON value instead of throwing", () => {
    // `cookie-parser` runs `JSONCookies` regardless of secret, so a raw value
    // starting with `j:` arrives already parsed — here, the number `1`, not a
    // string. Passing that to `hashOpaqueToken` would throw.
    const req = { cookies: { [REMEMBERED_DEVICE_COOKIE_NAME]: 1 } } as unknown as Request;
    expect(readRememberedDeviceCookie(req)).toBeUndefined();
  });

  it("returns undefined when no cookie was sent at all", () => {
    const req = { cookies: {} } as unknown as Request;
    expect(readRememberedDeviceCookie(req)).toBeUndefined();
  });
});
