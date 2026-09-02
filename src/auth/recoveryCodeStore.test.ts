// The recovery-code store: generating/regenerating the ten, counting how
// many are left, and spending one — hallazgos B6, B7 and C14 of
// `.superpowers/sdd/2026-09-01-plan-4b/auditoria-cuatro-agentes.md`, and
// Tasks 9-11 of `docs/plans/2026-09-01-factores-mfa.md`.
//
// This file's scope stops at the store. Two of Task 11's named tests are
// deliberately **not** here:
//
// - "consumes the code and seals the session in one transaction" needs
//   `sessionPromotion.ts` wired in by whichever controller calls
//   `gastarCodigo` — that composition is out of scope for this task (see the
//   agent's report), and `recoveryCodeStore.ts`'s own docblock on
//   `gastarCodigo` names the gap in `promoverSesion` that composition runs
//   into today.
// - "never writes a code to the log or the bitácora" is split: this file
//   proves the store itself never logs a code (below), but the *bitácora*
//   entry for a regeneration or a spend needs a request (an IP, who to
//   notify) this module never has — that write belongs to the controller.
//
// **Fake table, not canned numbers** — the same rule `factorInventory.test.ts`
// and `mfaKeyCheck.test.ts` apply, and for the same reason: a mock that
// returns a fixed answer regardless of `where` passes even when a query
// drops its `id_usuario` filter. The fake below holds real rows and decides
// matches by reading the `where` clause, so a query that forgets a condition
// reddens the test named for that condition instead of the whole suite
// staying green.
//
// **bcryptjs is mocked deterministically, not stubbed to a fixed boolean.**
// `hash` and `compare` here actually agree with each other (`compare` checks
// the exact string `hash` produced), so a wrong-code test is a real mismatch
// against a real fake hash, not a canned `true`/`false` that would pass
// however the arguments got scrambled. This also keeps the suite fast:
// hallazgo B7 measured *real* bcryptjs at 2646 ms for ten compares, and nine
// of this file's tests could not afford to pay any part of that.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface Fila {
  id: number;
  id_usuario: number;
  codigo_hash: string;
  prefijo: string;
  used_at: Date | null;
  created_at: Date;
}

let filas: Fila[] = [];
let siguienteId = 1;

/** Whether one fake row satisfies a `where` clause. Every clause this module produces is flat equality (including against `null`), so nothing fancier than `===` is needed here. */
function coincide(fila: Fila, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([campo, valor]) => fila[campo as keyof Fila] === valor);
}

// Bare spies, so `.mock.calls` below can inspect exactly what each call was
// given — the real fake-table behaviour lives in the factory's own methods,
// which call these purely to record the arguments (mirroring how
// `mfaKeyCheck.test.ts` keeps its fake table's logic inline rather than
// behind a typed wrapper, which is what a spread-tuple wrapper around a
// strictly-typed `vi.fn(impl)` fights against).
const countMock = vi.fn();
const updateMock = vi.fn();
const bulkCreateMock = vi.fn();
const findAllMock = vi.fn();

vi.mock("../models/codigoRecuperacion.model.js", () => ({
  CodigoRecuperacionModel: {
    count: async (opciones: { where: Record<string, unknown> }) => {
      countMock(opciones);
      return filas.filter((f) => coincide(f, opciones.where)).length;
    },
    update: async (
      valores: Record<string, unknown>,
      opciones: { where: Record<string, unknown>; transaction?: unknown },
    ) => {
      updateMock(valores, opciones);
      // Deliberately synchronous — no `await` before the mutation. That is
      // what makes the fake behave atomically across the concurrent test
      // below the same way a real `UPDATE ... WHERE used_at IS NULL` does:
      // each call's match-then-mutate happens in one uninterrupted turn, so
      // a second call arriving after the first already flipped `used_at`
      // sees the row as no longer matching, exactly like a real second
      // transaction would after the first commits.
      const afectadas = filas.filter((f) => coincide(f, opciones.where));
      for (const fila of afectadas) Object.assign(fila, valores);
      return [afectadas.length];
    },
    bulkCreate: async (filasNuevas: Omit<Fila, "id">[], opciones?: { transaction?: unknown }) => {
      bulkCreateMock(filasNuevas, opciones);
      const creadas = filasNuevas.map((f) => ({ id: siguienteId++, ...f }));
      filas.push(...creadas);
      return creadas;
    },
    unscoped: () => ({
      findAll: async (opciones: { where: Record<string, unknown> }) => {
        findAllMock(opciones);
        return filas.filter((f) => coincide(f, opciones.where)).map((f) => ({ get: () => f }));
      },
    }),
  },
}));

const TRANSACCION = { id: "una-transaccion" };
const transactionMock = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...a: [(t: unknown) => Promise<unknown>]) => transactionMock(...a) },
}));

// `hash`/`compare` agree with each other through the string they share, so a
// mismatch in this suite is a genuine "wrong plaintext for this hash", not a
// stub answering the same way regardless of input. `BCRYPT_COST` (12) is
// hard-coded here rather than imported, the same way `credentials.test.ts`
// hard-codes it in its own bcryptjs mock and assertions — asserting against
// the literal is what actually pins the cost, since asserting against the
// constant the source imports would pass even if that constant changed.
const hashMock = vi.fn(async (texto: string, costo: number) => `hash(${costo}):${texto}`);
const compareMock = vi.fn(async (texto: string, hash: string) => hash === `hash(12):${texto}`);
vi.mock("bcryptjs", () => ({
  default: {
    hash: (...a: [string, number]) => hashMock(...a),
    compare: (...a: [string, string]) => compareMock(...a),
  },
}));

const { regenerarCodigos, contarCodigosRestantes, gastarCodigo } = await import("./recoveryCodeStore.js");

/**
 * Three codes, each exactly 26 characters drawn only from the module's
 * documented alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ` — no `0`, `1`, `I`,
 * `L`, `O`). Hard-coded rather than generated, so a test seeding a row with
 * `CODE_A` and later spending it is asserting against a value this file
 * controls, not one `generarUnCodigo` happened to produce.
 */
const CODE_A = "23456789ABCDEFGHJKMNPQRSTU"; // 26 chars, prefix "23456789"
const CODE_B = "789ABCDEFGHJKMNPQRSTUVWXYZ"; // 26 chars, prefix "789ABCDE"
const CODE_C = "56789ABCDEFGHJKMNPQRSTUVWX"; // 26 chars, prefix "56789ABC"

function sembrar(fila: Partial<Fila> & { id_usuario: number; codigo: string }): Fila {
  const { codigo, ...resto } = fila;
  const nueva: Fila = {
    id: siguienteId++,
    id_usuario: resto.id_usuario,
    codigo_hash: `hash(12):${codigo}`,
    prefijo: codigo.slice(0, 8),
    used_at: resto.used_at ?? null,
    created_at: resto.created_at ?? new Date("2026-01-01T00:00:00Z"),
  };
  filas.push(nueva);
  return nueva;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  filas = [];
  siguienteId = 1;
  transactionMock.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** Every code any assertion below wrote to `console.*`, joined into one haystack — used to prove none of them ever appear. */
function todoLoImpreso(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join("\n");
}

describe("regenerarCodigos", () => {
  it("returns ten codes, each of the canonical shape", async () => {
    const codigos = await regenerarCodigos(1);
    expect(codigos).toHaveLength(10);
    for (const codigo of codigos) {
      expect(codigo).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{26}$/);
    }
    // Ten independent draws from 31^26 possibilities colliding is not a
    // scenario worth defending against, but it is one worth noticing if the
    // RNG is ever wired up wrong (e.g. seeded, or reused per call).
    expect(new Set(codigos).size).toBe(10);
  });

  it("stores the whole code hashed, and the first 8 characters as the prefix, never the code itself", async () => {
    const codigos = await regenerarCodigos(1);
    expect(filas).toHaveLength(10);
    for (const fila of filas) {
      const codigo = codigos.find((c) => fila.codigo_hash === `hash(12):${c}`);
      expect(codigo).toBeDefined();
      // The hash covers the *entire* code, not just the part that is also
      // stored in clear — a hash of only the last 18 characters would still
      // satisfy a naive round-trip test while leaving the prefix's 8
      // characters completely unverified.
      expect(hashMock).toHaveBeenCalledWith(codigo, 12);
      expect(fila.prefijo).toBe((codigo as string).slice(0, 8));
      // Nowhere on the row is the plaintext code itself, only its hash and
      // its 8-character prefix.
      expect(Object.values(fila)).not.toContain(codigo);
    }
  });

  it("never prints a code", async () => {
    await regenerarCodigos(1);
    const codigos = await regenerarCodigos(1);
    for (const codigo of codigos) {
      expect(todoLoImpreso()).not.toContain(codigo);
    }
  });

  it("invalidates every previously outstanding code for the account when regenerating", async () => {
    const primeros = await regenerarCodigos(1);
    const segundos = await regenerarCodigos(1);

    const filasDePrimeraTanda = filas.filter((f) => primeros.some((c) => f.codigo_hash === `hash(12):${c}`));
    expect(filasDePrimeraTanda).toHaveLength(10);
    for (const fila of filasDePrimeraTanda) {
      expect(fila.used_at).not.toBeNull();
    }

    const filasDeSegundaTanda = filas.filter((f) => segundos.some((c) => f.codigo_hash === `hash(12):${c}`));
    expect(filasDeSegundaTanda).toHaveLength(10);
    for (const fila of filasDeSegundaTanda) {
      expect(fila.used_at).toBeNull();
    }
  });

  it("leaves a code that was genuinely spent with its real used_at, not the regeneration time", async () => {
    const fila = sembrar({ id_usuario: 1, codigo: CODE_A, used_at: new Date("2026-02-02T00:00:00Z") });
    await regenerarCodigos(1);
    expect(fila.used_at).toEqual(new Date("2026-02-02T00:00:00Z"));
  });

  it("does not touch another account's codes", async () => {
    const ajena = sembrar({ id_usuario: 2, codigo: CODE_A });
    await regenerarCodigos(1);
    expect(ajena.used_at).toBeNull();
  });

  it("a first issue, with nothing outstanding, still produces ten fresh codes", async () => {
    expect(filas).toHaveLength(0);
    const codigos = await regenerarCodigos(1);
    expect(codigos).toHaveLength(10);
    expect(filas.filter((f) => f.used_at === null)).toHaveLength(10);
  });

  it("invalidates the old ten and writes the new ten inside the same transaction", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    await regenerarCodigos(1);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]?.[1]?.transaction).toBe(TRANSACCION);
    expect(bulkCreateMock.mock.calls[0]?.[1]?.transaction).toBe(TRANSACCION);
  });
});

describe("contarCodigosRestantes", () => {
  it("counts only this account's still-unused codes", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    sembrar({ id_usuario: 1, codigo: CODE_B });
    sembrar({ id_usuario: 1, codigo: CODE_C, used_at: new Date() });
    sembrar({ id_usuario: 2, codigo: CODE_A });
    sembrar({ id_usuario: 2, codigo: CODE_B });

    await expect(contarCodigosRestantes(1)).resolves.toBe(2);
    await expect(contarCodigosRestantes(2)).resolves.toBe(2);
  });

  it("answers zero for an account with nothing outstanding", async () => {
    await expect(contarCodigosRestantes(1)).resolves.toBe(0);
  });

  it("never returns a code, only the count", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    const resultado = await contarCodigosRestantes(1);
    expect(typeof resultado).toBe("number");
  });
});

describe("gastarCodigo", () => {
  it("rejects a value with the wrong shape before touching bcrypt", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    const invalidos = [
      "demasiado-corto",
      CODE_A + "X", // 27 characters, one too many
      CODE_A.slice(0, 25), // 25 characters, one too few
      CODE_A.replace("2", "0"), // '0' is not in the alphabet
      CODE_A.replace("3", "1"), // '1' is not in the alphabet
      CODE_A.replace("A", "O"), // 'O' is not in the alphabet
      CODE_A.replace("B", "I"), // 'I' is not in the alphabet
      CODE_A.replace("C", "L"), // 'L' is not in the alphabet
      "",
      "x".repeat(500),
    ];
    for (const invalido of invalidos) {
      expect(await gastarCodigo(1, invalido)).toBe(false);
    }
    // The whole point of the shape check: none of the above should ever
    // have reached bcrypt, let alone the database.
    expect(compareMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("accepts a code typed with spaces, dashes and lower case", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    const escritoAMano = `  ${CODE_A.slice(0, 4).toLowerCase()}-${CODE_A.slice(4, 13).toLowerCase()}-${CODE_A.slice(13).toLowerCase()}  `;
    expect(await gastarCodigo(1, escritoAMano)).toBe(true);
  });

  it("spends exactly the row whose hash matches, leaving the account's other codes alone", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    const otra = sembrar({ id_usuario: 1, codigo: CODE_B });

    expect(await gastarCodigo(1, CODE_A)).toBe(true);
    expect(filas.find((f) => f.codigo_hash === `hash(12):${CODE_A}`)?.used_at).not.toBeNull();
    expect(otra.used_at).toBeNull();
  });

  it("refuses a code whose prefix matches but whose hash does not", async () => {
    // Same 8-character prefix as CODE_A, different remainder — the exact
    // shape a prefix collision, or a typo past character 8, would take.
    const parecido = CODE_A.slice(0, 8) + CODE_B.slice(8);
    sembrar({ id_usuario: 1, codigo: CODE_A });

    expect(await gastarCodigo(1, parecido)).toBe(false);
    expect(filas[0].used_at).toBeNull();
  });

  it("only ever looks at codes belonging to the given account", async () => {
    // The same code, minted for someone else's account. Hallazgo C15's
    // shape: without an id_usuario filter, this would let one account spend
    // a code that was never issued to it.
    sembrar({ id_usuario: 2, codigo: CODE_A });

    expect(await gastarCodigo(1, CODE_A)).toBe(false);
    expect(filas[0].used_at).toBeNull();
  });

  it("marks the code used in the same statement that checks it is unused — a second spend of the same code fails", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });

    expect(await gastarCodigo(1, CODE_A)).toBe(true);
    expect(await gastarCodigo(1, CODE_A)).toBe(false);

    const [, opciones] = updateMock.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(opciones.where.used_at).toBeNull();
  });

  it("lets exactly one of ten concurrent attempts at the same code through — hallazgo B6", async () => {
    // Ten promises created together, not ten sequential `await`s: run in
    // series this passes even with `SELECT`-then-`UPDATE`, which is exactly
    // the shape hallazgo B6 measured as a 2.6-second race. Only launching
    // them together can catch that regression.
    sembrar({ id_usuario: 1, codigo: CODE_A });

    const resultados = await Promise.all(Array.from({ length: 10 }, () => gastarCodigo(1, CODE_A)));

    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(await contarCodigosRestantes(1)).toBe(0);
  });

  it("passes a given transaction through to the write that consumes the code", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    const propia = { id: "la-transaccion-del-llamante" };

    // `as unknown as never`, same escape hatch `tokenStore.test.ts` uses for
    // the same reason: this module's real `transaction?: Transaction` type
    // demands the full Sequelize `Transaction` shape (commit, rollback,
    // ...), and a fake standing in for it in a test that never opens a real
    // connection cannot honestly implement any of that.
    await gastarCodigo(1, CODE_A, { transaction: propia as unknown as never });

    const [, opciones] = updateMock.mock.calls[0] as [unknown, { transaction?: unknown }];
    expect(opciones.transaction).toBe(propia);
  });

  it("never prints a code, on success or on failure", async () => {
    sembrar({ id_usuario: 1, codigo: CODE_A });
    await gastarCodigo(1, CODE_A);
    await gastarCodigo(1, "esto-no-tiene-forma-de-codigo");
    expect(todoLoImpreso()).not.toContain(CODE_A);
  });
});
