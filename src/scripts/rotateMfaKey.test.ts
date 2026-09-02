// The rotation command's own tests — Task 3, finding B4, Decision 3 of
// `docs/plans/2026-09-01-factores-mfa.md`.
//
// **Nothing here touches a real database.** Task 15 (the shared test harness
// that lets endpoint tests write to `factor_totp` safely) does not exist yet
// — see the common encargo. This file mocks `../database/sequelize.js` and
// `../models/factorTotp.model.js` itself, with a small in-memory fake that
// actually honours transaction semantics (a write inside a transaction only
// lands once that transaction's callback returns without throwing) — that
// realism is not decoration, it is what makes "dies half way" a real test
// rather than one that would pass no matter how the production code is
// written. `../auth/mfaKeyring.js` and `../auth/mfaCrypto.js` are the real,
// already-verified Task 1 modules, driven with `vi.stubEnv` exactly the way
// `mfaCrypto.test.ts` drives them — real encryption round trips, on fake rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op } from "sequelize";
import { cifrar } from "../auth/mfaCrypto.js";
// The real AAD convention (Task 4), never a literal string of this test's
// own invention — see `rotateMfaKey.ts`'s own header for why hard-coding it
// twice is exactly the drift that broke this file's first draft.
import { aadDeFactorTotp } from "../auth/totpStore.js";

const CLAVE_1 = "1".repeat(64);
const CLAVE_2 = "2".repeat(64);

interface FilaFalsa {
  id: number;
  key_version: number;
  secreto_cifrado: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
}

/** Mutated in place by `sembrarFilas`, read by the fakes below. */
let filas: FilaFalsa[] = [];

/**
 * A transaction-shaped enough fake to make "one transaction per row" an
 * actually-tested property, not an assumption.
 *
 * Writes made through the fake `FactorTotpModel.update` during one
 * `sequelize.transaction(cb)` call are buffered on the transaction token
 * itself and only merged into `filas` once `cb` returns without throwing —
 * the same thing a Postgres `COMMIT` does, and a `ROLLBACK` (this callback
 * throwing) undoes by simply never merging the buffer. That is what lets the
 * "dies half way" test tell a correct per-row-transaction implementation
 * apart from a single transaction wrapping the whole loop: under the latter,
 * one throw anywhere discards every buffered write, row 1 included.
 */
const transactionMock = vi.fn(async (cb: (t: { buffer: Array<{ id: number; values: Partial<FilaFalsa> }> }) => Promise<unknown>) => {
  const t = { buffer: [] as Array<{ id: number; values: Partial<FilaFalsa> }> };
  const resultado = await cb(t);
  for (const escritura of t.buffer) {
    const fila = filas.find((f) => f.id === escritura.id);
    if (fila) Object.assign(fila, escritura.values);
  }
  return resultado;
});

vi.mock("../database/sequelize.js", () => ({
  sequelize: {
    transaction: (cb: unknown) => transactionMock(cb as never),
    close: (...a: unknown[]) => closeMock(...a),
  },
}));

const closeMock = vi.fn();

function coincideWhere(fila: FilaFalsa, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [campo, condicion] of Object.entries(where)) {
    const valor = (fila as unknown as Record<string, unknown>)[campo];
    if (condicion !== null && typeof condicion === "object" && Op.ne in (condicion as object)) {
      if (valor === (condicion as Record<symbol, unknown>)[Op.ne]) return false;
      continue;
    }
    // Finding A2: the row-picking query has to be able to exclude ids the
    // current run already found irrecoverable, or the loop reselects the
    // exact same unreadable row forever.
    if (condicion !== null && typeof condicion === "object" && Op.notIn in (condicion as object)) {
      const lista = (condicion as Record<symbol, unknown>)[Op.notIn] as unknown[];
      if (lista.includes(valor)) return false;
      continue;
    }
    if (valor !== condicion) return false;
  }
  return true;
}

type TokenTransaccion = { buffer: Array<{ id: number; values: Partial<FilaFalsa> }> };

/**
 * Read-your-own-writes: a row's buffered-but-uncommitted values (from an
 * `update` earlier in the *same* transaction) overlay the committed state.
 * Real Postgres gives every transaction this for free; the fake has to build
 * it deliberately, because it is exactly what makes the "one transaction for
 * the whole table" mutation a meaningful thing to try (see the mutation note
 * on `rotarUnaFila`'s test below): without it, that mutation would just spin
 * forever re-finding the same already-"written" row instead of producing the
 * wrong-but-plausible result a real reviewer could actually be fooled by.
 */
function conBufferAplicado(fila: FilaFalsa, transaction: unknown): FilaFalsa {
  const t = transaction as TokenTransaccion | undefined;
  if (!t) return fila;
  const propios = t.buffer.filter((w) => w.id === fila.id).reduce((acc, w) => ({ ...acc, ...w.values }), {});
  return { ...fila, ...propios };
}

const findOneMock = vi.fn(
  async (options: { where?: Record<string, unknown>; order?: unknown; transaction?: unknown }) => {
    const candidatas = filas
      .map((f) => conBufferAplicado(f, options.transaction))
      .filter((f) => coincideWhere(f, options.where))
      .sort((a, b) => a.id - b.id);
    return candidatas[0] ? { ...candidatas[0] } : null;
  },
);

const countMock = vi.fn(async (options?: { where?: Record<string, unknown>; transaction?: unknown }) => {
  return filas
    .map((f) => conBufferAplicado(f, options?.transaction))
    .filter((f) => coincideWhere(f, options?.where)).length;
});

/**
 * The fake's `update` requires a transaction token from `transactionMock`
 * above and buffers into it — calling it outside a transaction (a bug this
 * suite wants to catch on its own, independent of the six named tests) is a
 * thrown error rather than a silent direct mutation.
 */
const updateMock = vi.fn(
  async (
    values: Partial<FilaFalsa>,
    options: { where: { id: number }; transaction?: { buffer: Array<{ id: number; values: Partial<FilaFalsa> }> } },
  ) => {
    if (!options.transaction) {
      throw new Error("update() llamado sin transacción — cada fila tiene que escribirse dentro de la suya");
    }
    options.transaction.buffer.push({ id: options.where.id, values });
    return [1];
  },
);

vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: {
    unscoped: () => ({ findOne: findOneMock, count: countMock }),
    update: (...a: unknown[]) => (updateMock as unknown as (...a: unknown[]) => unknown)(...a),
  },
}));

const { rotarClaveMfa, main, run, USO } = await import("./rotateMfaKey.js");

/** Snapshot taken the instant the module above finished loading — see
 *  `rescue.test.ts`'s identical guard for why this has to run before the
 *  first `beforeEach` clears the very mocks it inspects. Under vitest,
 *  `process.argv[1]` is the test runner's own entry point, never this file,
 *  so the module's `executedDirectly` guard has to read `false`. */
const llamadasAlImportar = {
  transaction: transactionMock.mock.calls.length,
  findOne: findOneMock.mock.calls.length,
  count: countMock.mock.calls.length,
  update: updateMock.mock.calls.length,
  close: closeMock.mock.calls.length,
};

/** Encrypts `secreto` as if it had been written while `version` was active,
 *  without disturbing whatever env the calling test has already stubbed. */
function cifrarBajoVersion(
  secreto: string,
  aad: string,
  version: 1 | 2,
): Pick<FilaFalsa, "secreto_cifrado" | "iv" | "auth_tag"> {
  const activaPrevia = process.env.MFA_ENCRYPTION_KEY_ACTIVE;
  vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", String(version));
  const cifrado = cifrar(secreto, aad);
  if (activaPrevia === undefined) vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "");
  else vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", activaPrevia);
  return { secreto_cifrado: cifrado.ciphertext, iv: cifrado.iv, auth_tag: cifrado.auth_tag };
}

function sembrarFilas(nuevas: FilaFalsa[]): void {
  filas = nuevas;
}

let logs: string[];
let errors: string[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_1);
  vi.stubEnv("MFA_ENCRYPTION_KEY_2", CLAVE_2);
  vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "2");
  filas = [];
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("the direct-execution guard", () => {
  it("importing this module does not rotate anything as a side effect", () => {
    expect(llamadasAlImportar).toEqual({ transaction: 0, findOne: 0, count: 0, update: 0, close: 0 });
  });
});

describe("rotarClaveMfa", () => {
  it("re-encrypts every row that is not already on the active version", async () => {
    // Both rows were written while key 1 was active; key 2 is active now.
    sembrarFilas([
      { id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) },
      { id: 3, key_version: 1, ...cifrarBajoVersion("secreto tres", aadDeFactorTotp(3), 1) },
    ]);

    const resultado = await rotarClaveMfa();

    expect(resultado).toEqual({
      totalFilas: 2,
      yaEnVersionActiva: 0,
      pendientesAlEmpezar: 2,
      filasRotadas: 2,
      filasIrrecuperables: 0,
      pendientesAlTerminar: 0,
    });
    expect(filas.every((f) => f.key_version === 2)).toBe(true);
    // One transaction per row, never one transaction for the whole table.
    expect(transactionMock).toHaveBeenCalledTimes(3); // 2 conversions + the final "nothing left" check
    // Round-tripping through the real cipher proves the re-encryption used
    // the same AAD to decrypt (old key) and to encrypt (new key): a mismatch
    // would have thrown inside `rotarUnaFila` and failed this test already,
    // but decrypting again here is the check that it produced usable rows,
    // not merely rows that happened not to throw.
    const { descifrar } = await import("../auth/mfaCrypto.js");
    const fila1 = filas.find((f) => f.id === 1)!;
    expect(
      descifrar(
        { ciphertext: fila1.secreto_cifrado, iv: fila1.iv, auth_tag: fila1.auth_tag, key_version: fila1.key_version },
        aadDeFactorTotp(1),
      ),
    ).toBe("secreto uno");
  });

  it("skips the rows that are already on the active version", async () => {
    sembrarFilas([
      { id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) },
      { id: 2, key_version: 2, ...cifrarBajoVersion("secreto dos", aadDeFactorTotp(2), 2) },
    ]);

    const resultado = await rotarClaveMfa();

    expect(resultado.filasRotadas).toBe(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(expect.anything(), { where: { id: 1 }, transaction: expect.anything() });
  });

  it("can be run twice in a row and the second run does nothing", async () => {
    sembrarFilas([
      { id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) },
      { id: 2, key_version: 1, ...cifrarBajoVersion("secreto dos", aadDeFactorTotp(2), 1) },
    ]);

    await rotarClaveMfa();
    updateMock.mockClear();
    const segunda = await rotarClaveMfa();

    expect(segunda).toEqual({
      totalFilas: 2,
      yaEnVersionActiva: 2,
      pendientesAlEmpezar: 0,
      filasRotadas: 0,
      filasIrrecuperables: 0,
      pendientesAlTerminar: 0,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("leaves the rows it already converted converted when it dies half way", async () => {
    sembrarFilas([
      { id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) },
      { id: 2, key_version: 1, ...cifrarBajoVersion("secreto dos", aadDeFactorTotp(2), 1) },
      { id: 3, key_version: 1, ...cifrarBajoVersion("secreto tres", aadDeFactorTotp(3), 1) },
    ]);

    // Row ids are converted in ascending order (see `rotarUnaFila`'s
    // `order`), so the second row processed is id 2. Simulate the process
    // dying while writing it: the update for id 2 throws, the update for id 1
    // (already committed, in its own earlier transaction) is untouched.
    updateMock.mockImplementation(async (values, options) => {
      if (options.where.id === 2) throw new Error("simulated crash mid-row");
      options.transaction.buffer.push({ id: options.where.id, values });
      return [1];
    });

    await expect(rotarClaveMfa()).rejects.toThrow("simulated crash mid-row");

    const fila1 = filas.find((f) => f.id === 1)!;
    const fila2 = filas.find((f) => f.id === 2)!;
    const fila3 = filas.find((f) => f.id === 3)!;
    expect(fila1.key_version).toBe(2); // already converted before the crash
    expect(fila2.key_version).toBe(1); // died mid-write, never committed
    expect(fila3.key_version).toBe(1); // never even reached

    // Resuming: a fresh call finds exactly what is left, reports having
    // found the one already-converted row, and finishes the other two.
    updateMock.mockImplementation(
      async (values: Partial<FilaFalsa>, options: { where: { id: number }; transaction: { buffer: Array<{ id: number; values: Partial<FilaFalsa> }> } }) => {
        options.transaction.buffer.push({ id: options.where.id, values });
        return [1];
      },
    );
    const resumida = await rotarClaveMfa();
    expect(resumida).toEqual({
      totalFilas: 3,
      yaEnVersionActiva: 1,
      pendientesAlEmpezar: 2,
      filasRotadas: 2,
      filasIrrecuperables: 0,
      pendientesAlTerminar: 0,
    });
    expect(filas.every((f) => f.key_version === 2)).toBe(true);
    expect(logs.join("\n")).toContain("Ya en la versión activa (2): 1");
  });

  // Finding A2. Before this fix, `rotarUnaFila` always re-selected "the
  // pending row with the lowest id" — so a row that cannot decrypt (a
  // corrupted `auth_tag` from a partial restore, an orphaned `key_version`)
  // made every single call pick that exact row again, throw again, and the
  // whole run never made progress on anything, healthy rows included.
  describe("a row that will not decrypt (finding A2)", () => {
    /** A row whose `auth_tag` a healthy key still cannot open — the shape a
     *  partial restore leaves behind. */
    function filaCorrupta(id: number, secreto: string): FilaFalsa {
      const sana = cifrarBajoVersion(secreto, aadDeFactorTotp(id), 1);
      const tagAlterado = Buffer.from(sana.auth_tag);
      tagAlterado[0] ^= 0xff;
      return { id, key_version: 1, ...sana, auth_tag: tagAlterado };
    }

    it("skips it, keeps rotating the healthy rows around it, and reports it as irrecuperable rather than aborting the whole run", async () => {
      sembrarFilas([
        { id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) },
        filaCorrupta(2, "secreto dos"),
        { id: 3, key_version: 1, ...cifrarBajoVersion("secreto tres", aadDeFactorTotp(3), 1) },
      ]);

      const resultado = await rotarClaveMfa();

      expect(resultado).toEqual({
        totalFilas: 3,
        yaEnVersionActiva: 0,
        pendientesAlEmpezar: 3,
        filasRotadas: 2,
        filasIrrecuperables: 1,
        pendientesAlTerminar: 1,
      });
      // The healthy rows either side of the bad one actually got rotated —
      // the property that dies under the old "always the same row" bug.
      expect(filas.find((f) => f.id === 1)!.key_version).toBe(2);
      expect(filas.find((f) => f.id === 3)!.key_version).toBe(2);
      // The unreadable row was never written to: still on its original
      // version, still carrying the tampered tag.
      expect(filas.find((f) => f.id === 2)!.key_version).toBe(1);

      expect(errors.join("\n")).toContain("factor_totp.id=2");
      // The go-ahead-and-delete-the-old-key message must not appear: one
      // row is still stuck on it.
      expect(logs.join("\n")).not.toContain("Ya puedes borrar la clave vieja");
      expect(errors.join("\n")).toContain("NO borres la clave vieja");
    });

    it("finishes cleanly (no crash, no exception) instead of throwing the way an update-failure still does", async () => {
      sembrarFilas([filaCorrupta(1, "secreto uno")]);

      await expect(rotarClaveMfa()).resolves.toMatchObject({
        filasRotadas: 0,
        filasIrrecuperables: 1,
        pendientesAlTerminar: 1,
      });
    });

    it("does not spin forever with more than one unreadable row mixed in with healthy ones", async () => {
      sembrarFilas([
        filaCorrupta(1, "secreto uno"),
        { id: 2, key_version: 1, ...cifrarBajoVersion("secreto dos", aadDeFactorTotp(2), 1) },
        filaCorrupta(3, "secreto tres"),
        { id: 4, key_version: 1, ...cifrarBajoVersion("secreto cuatro", aadDeFactorTotp(4), 1) },
      ]);

      const resultado = await rotarClaveMfa();

      expect(resultado.filasRotadas).toBe(2);
      expect(resultado.filasIrrecuperables).toBe(2);
      expect(resultado.pendientesAlTerminar).toBe(2);
      expect(errors.join("\n")).toContain("factor_totp.id=1");
      expect(errors.join("\n")).toContain("factor_totp.id=3");
    });

    it("keeps reporting the same unreadable row as irrecuperable on a second run, without re-touching the rows already converted", async () => {
      sembrarFilas([
        { id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) },
        filaCorrupta(2, "secreto dos"),
      ]);

      await rotarClaveMfa();
      updateMock.mockClear();
      const segunda = await rotarClaveMfa();

      expect(segunda.filasRotadas).toBe(0); // row 1 already converted, nothing left to do for it
      expect(segunda.filasIrrecuperables).toBe(1);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it("still throws (and does not call it merely irrecoverable) when the failure is in the write itself, not the decrypt", async () => {
      // A genuine crash mid-write — e.g. a lost database connection — is not
      // "this one row is unreadable"; papering over it the same way would
      // hide a systemic fault behind a per-row label it does not deserve.
      sembrarFilas([{ id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) }]);
      // `Once`, not a standing override: this must not leak into later tests
      // the way `beforeEach`'s `vi.clearAllMocks()` would not undo a
      // standing `mockImplementation` — see the other tests in this file
      // that restore theirs by hand for the same reason.
      updateMock.mockImplementationOnce(async () => {
        throw new Error("connection lost mid-write");
      });

      await expect(rotarClaveMfa()).rejects.toThrow("connection lost mid-write");
    });
  });

  it("prints the go-ahead to delete the old key only once every row is actually on the active version", async () => {
    sembrarFilas([{ id: 1, key_version: 1, ...cifrarBajoVersion("secreto uno", aadDeFactorTotp(1), 1) }]);

    await rotarClaveMfa();

    expect(logs.join("\n")).toContain("Ya puedes borrar la clave vieja");
    expect(errors.join("\n")).toBe("");
  });

  it("refuses to start when the active key is not in the keyring", async () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "3"); // no MFA_ENCRYPTION_KEY_3 configured
    sembrarFilas([{ id: 1, key_version: 1, ...cifrarBajoVersion("secreto", aadDeFactorTotp(1), 1) }]);

    await expect(rotarClaveMfa()).rejects.toThrow(/MFA_ENCRYPTION_KEY_3/);
    expect(updateMock).not.toHaveBeenCalled();
    expect(findOneMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });
});

describe("main and run", () => {
  it("--help prints the danger warning and touches nothing", async () => {
    const codigo = await main(["--help"]);
    expect(codigo).toBe(0);
    expect(logs.join("\n")).toContain(USO);
    expect(USO).toMatch(/NO BORRES LA CLAVE VIEJA/);
    expect(countMock).not.toHaveBeenCalled();
  });

  it("main reports the underlying error and exits nonzero instead of throwing", async () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "9");
    const codigo = await main([]);
    expect(codigo).toBe(1);
    expect(errors.join("\n")).toContain("MFA_ENCRYPTION_KEY_9");
  });

  it("run closes the sequelize pool after a clean run", async () => {
    const argvOriginal = [...process.argv];
    process.argv = [argvOriginal[0], argvOriginal[1]];
    sembrarFilas([]);
    await run();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
    process.argv = argvOriginal;
  });

  it("run closes the pool even when rotation throws", async () => {
    const argvOriginal = [...process.argv];
    process.argv = [argvOriginal[0], argvOriginal[1]];
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "9");
    await run();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    process.argv = argvOriginal;
  });
});
