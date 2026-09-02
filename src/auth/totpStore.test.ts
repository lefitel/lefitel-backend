// The `factor_totp` store: writing a fresh secret, reading it back
// decrypted, and the anti-replay comparison against a `BIGINT` that arrives
// as a string. Task 4 of `docs/plans/2026-09-01-factores-mfa.md`.
//
// `FactorTotpModel` and `sequelize` are both mocked against a tiny in-memory
// table, the same approach `rememberedDeviceStore.test.ts` and
// `tokenStore.test.ts` use and for the same reason: a canned return value
// cannot show a real round trip, and this module's whole point — the AAD
// tied to the row's own id surviving a write and still opening on read — is
// exactly a round-trip property. `nextval` is faked through `sequelize.query`,
// returning ids as strings, the same shape Postgres actually hands back for
// any bigint-typed expression.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op } from "sequelize";

interface Fila {
  id: number;
  id_usuario: number;
  secreto_cifrado: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  ultimo_paso: number | null;
  confirmed_at: Date | null;
  created_at: Date;
}

let filas: Fila[] = [];

/**
 * Decides whether one row satisfies a Sequelize `where`, understanding only
 * the shapes this module actually produces: plain equality (including
 * against `null`) and `{ [Op.ne]: null }`. Anything else throws rather than
 * quietly matching everything — the same "the fake shrugs at nothing" rule
 * `factorInventory.test.ts` and `mfaKeyCheck.test.ts` document, so a query
 * that grows a condition this fake does not understand fails loudly instead
 * of passing by accident.
 */
function matches(row: Fila, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([campo, clausula]) => {
    const valor = (row as unknown as Record<string, unknown>)[campo];
    if (clausula !== null && typeof clausula === "object" && !(clausula instanceof Date)) {
      const simbolos = Object.getOwnPropertySymbols(clausula);
      if (simbolos.length !== 1 || simbolos[0] !== Op.ne) {
        throw new Error("the fake table only understands { [Op.ne]: value }");
      }
      return valor !== (clausula as Record<symbol, unknown>)[Op.ne];
    }
    return valor === clausula;
  });
}

const create = vi.fn();
const destroyMock = vi.fn();
const updateMock = vi.fn();

vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: {
    create: (...a: unknown[]) => create(...a),
    destroy: (...a: unknown[]) => destroyMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    unscoped: () => ({
      findOne: (opciones: { where: Record<string, unknown> }) => {
        const encontrada = filas.find((f) => matches(f, opciones.where));
        return Promise.resolve(encontrada ? { get: () => ({ ...encontrada }) } : null);
      },
    }),
  },
}));

const query = vi.fn();
const transaction = vi.fn();

vi.mock("../database/sequelize.js", () => ({
  sequelize: {
    query: (...a: unknown[]) => query(...a),
    transaction: (...a: unknown[]) => transaction(...a),
  },
}));

const { aadDeFactorTotp, guardarSecretoSinConfirmar, leerSecretoConfirmado, leerSecretoSinConfirmar, sellarPaso, pasoYaUsado } =
  await import("./totpStore.js");

const CLAVE = "1".repeat(64);

function usarLlaveUnica(): void {
  vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE);
  vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
}

beforeEach(() => {
  vi.clearAllMocks();
  filas = [];

  create.mockImplementation((valores: Record<string, unknown>) => {
    filas.push({ ...(valores as unknown as Fila) });
    return Promise.resolve({ get: () => valores });
  });

  destroyMock.mockImplementation((opciones: { where: Record<string, unknown> }) => {
    const antes = filas.length;
    filas = filas.filter((f) => !matches(f, opciones.where));
    return Promise.resolve(antes - filas.length);
  });

  updateMock.mockImplementation(
    (valores: Record<string, unknown>, opciones: { where: Record<string, unknown> }) => {
      let contador = 0;
      filas = filas.map((f) => {
        if (!matches(f, opciones.where)) return f;
        contador += 1;
        return { ...f, ...(valores as Partial<Fila>) };
      });
      return Promise.resolve([contador]);
    },
  );

  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn({ id: "tx" }));
  query.mockResolvedValue([{ id: "1" }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("aadDeFactorTotp", () => {
  it("is the single format every reader and writer of this table shares", () => {
    // Pinned literally, not just round-tripped: `mfaKeyCheck.ts` and
    // `mfaCrypto.test.ts`'s own fixtures already hard-code this exact
    // string ("factor:1", "factor:7", ...). A change here has to be a
    // deliberate, visible diff in this test, not something that slips
    // through because every caller in this file re-derives it the same way.
    expect(aadDeFactorTotp(7)).toBe("factor:7");
  });
});

describe("guardarSecretoSinConfirmar / leerSecretoConfirmado / leerSecretoSinConfirmar", () => {
  it("round-trips a secret through the store", async () => {
    usarLlaveUnica();
    query.mockResolvedValueOnce([{ id: "9" }]);

    const { id } = await guardarSecretoSinConfirmar(1, "JBSWY3DPEHPK3PXP");
    expect(id).toBe(9);

    expect(await leerSecretoSinConfirmar(1)).toEqual({ id: 9, secreto: "JBSWY3DPEHPK3PXP" });
    // Not a confirmed factor yet — confirmed_at is still NULL.
    expect(await leerSecretoConfirmado(1)).toBeNull();

    // The confirm step itself belongs to Task 6's controller, not this
    // store; simulating it directly on the fake table is enough to prove
    // the confirmed read path opens the same ciphertext once it is set.
    filas = filas.map((f) => ({ ...f, confirmed_at: new Date("2026-09-01T09:00:00.000Z") }));
    expect(await leerSecretoConfirmado(1)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("writes ciphertext, iv, auth_tag and key_version in the same statement", async () => {
    usarLlaveUnica();
    query.mockResolvedValueOnce([{ id: "3" }]);

    await guardarSecretoSinConfirmar(1, "un secreto cualquiera");

    expect(create).toHaveBeenCalledTimes(1);
    const [valores] = create.mock.calls[0] as [Record<string, unknown>];
    // All four together, in the one INSERT — not a create followed by an
    // update that could plausibly touch fewer than four columns.
    expect(valores).toMatchObject({
      id: 3,
      secreto_cifrado: expect.any(Buffer),
      iv: expect.any(Buffer),
      auth_tag: expect.any(Buffer),
      key_version: 1,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("cannot read a row whose id was changed underneath it", async () => {
    usarLlaveUnica();
    query.mockResolvedValueOnce([{ id: "5" }]);
    await guardarSecretoSinConfirmar(1, "secreto de la fila 5");

    // The row's own anchor id changing underneath it — not id_usuario,
    // which Decision 6 already protects against, but the value the AAD is
    // actually tied to. A read has to recompute the AAD from the row's
    // *current* id, so this has to break decryption, loudly, rather than
    // silently returning either the wrong plaintext or the right one under
    // an authentication that no longer means anything.
    filas = filas.map((f) => ({ ...f, id: 6 }));

    await expect(leerSecretoSinConfirmar(1)).rejects.toThrow();
  });
});

describe("pasoYaUsado", () => {
  it("treats a step that arrives as a string the way a number would be treated", () => {
    // `ultimo_paso` never arrives as a JS number — pg hands BIGINT columns
    // back as strings. This is that shape, not a simplification of it.
    const guardado = "58012345";
    expect(pasoYaUsado(guardado, 58012345n)).toBe(true); // the same step: reject
    expect(pasoYaUsado(guardado, 58012346n)).toBe(false); // a later step: accept
    expect(pasoYaUsado(guardado, 58012344n)).toBe(true); // an earlier step: reject
  });

  it("rejects a step it has already sealed", () => {
    // This is the test hallazgo C10 names directly: with `guardado` kept as
    // the string Postgres actually returns, changing this function's `<=`
    // to `===` makes this assertion fail, because a bigint is never
    // strictly equal to a string no matter its value — see
    // `pasoYaUsado`'s own comment. A version of this test that builds
    // `guardado` as `58012345n` instead of `"58012345"` would stay green
    // under that same mutation, which is exactly why it is not written
    // that way.
    expect(pasoYaUsado("58012345", 58012345n)).toBe(true);
  });

  it("accepts any step on a factor that has never been used", () => {
    // ultimo_paso is NULL until the first accepted code. `?? -1n` is what
    // makes that acceptance a deliberate branch rather than an accident of
    // how `null` happens to compare.
    expect(pasoYaUsado(null, 0n)).toBe(false);
    expect(pasoYaUsado(null, 999_999n)).toBe(false);
  });
});

describe("sellarPaso", () => {
  it("stores the exact step it is given, on the row it is given", async () => {
    filas = [
      {
        id: 4,
        id_usuario: 1,
        secreto_cifrado: Buffer.alloc(0),
        iv: Buffer.alloc(12),
        auth_tag: Buffer.alloc(16),
        key_version: 1,
        ultimo_paso: null,
        confirmed_at: new Date(),
        created_at: new Date(),
      },
    ];

    await sellarPaso(4, 58012345n);

    const [valores, opciones] = updateMock.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    // A **string**, not a number. `BIGINT` round-trips as a string on the way
    // out, so writing it as one keeps both directions in the same shape — and
    // `Number(paso)` is exact for today's step values, which is precisely what
    // makes it the kind of shortcut that stays invisible until the day it is
    // not.
    expect(valores.ultimo_paso).toBe("58012345");
    expect(opciones.where).toEqual({ id: 4 });
  });

  it("does not accept the step it just sealed", () => {
    // The round trip that matters, in the shape the database really produces:
    // seal 58012345, read it back as the string `pg` hands over, and the
    // anti-replay rule must reject that same step. Written as `===` — the way
    // the spec words it — this is false for every value and the same six digits
    // stay usable for ninety seconds.
    const guardadoPorLaBase = "58012345";
    expect(pasoYaUsado(guardadoPorLaBase, 58012345n)).toBe(true);
    expect(pasoYaUsado(guardadoPorLaBase, 58012346n)).toBe(false);
  });
});
