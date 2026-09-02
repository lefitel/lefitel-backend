// The boot check: `llaveActiva()` has to resolve even with zero rows, and the
// first confirmed row (by id) has to actually decrypt. And the property that
// matters most about this whole file: none of it may be reachable from
// `src/scripts/rescue.ts` (finding A6) — the last test walks that import
// graph on the real files on disk, not on a mock, because a mock cannot catch
// someone wiring this into a module rescue reaches six months from now.
//
// The `factor_totp` fake table follows `factorInventory.test.ts`'s own
// approach and for the same reason: it holds rows and reads the `where` to
// decide which match, rather than being handed a canned answer, so a query
// that stops excluding unconfirmed rows (or stops ordering by `id`) reddens
// the test named for that rule instead of passing it by accident.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cifrar } from "./mfaCrypto.js";

const here = dirname(fileURLToPath(import.meta.url));

const CLAVE_1 = "1".repeat(64);
const CLAVE_2 = "2".repeat(64);

function usarLlaveUnica(): void {
  vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_1);
  vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
}

interface FilaFake {
  id: number;
  secreto_cifrado: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  confirmed_at: Date | null;
}

let filas: FilaFake[] = [];

vi.mock("../models/factorTotp.model.js", () => ({
  FactorTotpModel: {
    unscoped: () => ({
      findOne: async (opciones: {
        where?: { confirmed_at?: unknown };
        order?: [string, "ASC" | "DESC"][];
      }) => {
        // The only shape this check ever asks for. Anything else throws
        // rather than silently matching everything — the same "the fake
        // shrugs at nothing" rule `factorInventory.test.ts` documents.
        if (opciones.where && "confirmed_at" in opciones.where) {
          const clausula = opciones.where.confirmed_at as Record<symbol, unknown> | undefined;
          const simbolos = clausula ? Object.getOwnPropertySymbols(clausula) : [];
          if (simbolos.length !== 1 || simbolos[0].description !== "ne") {
            throw new Error("the fake table only understands confirmed_at: { [Op.ne]: null }");
          }
        } else {
          throw new Error("the fake table expects a confirmed_at filter");
        }

        const confirmadas = filas.filter((f) => f.confirmed_at !== null);
        if (confirmadas.length === 0) return null;

        const [[campo, direccion]] = opciones.order ?? [["id", "ASC"]];
        if (campo !== "id") throw new Error("the fake table only orders by id");
        const ordenadas = [...confirmadas].sort((a, b) =>
          direccion === "ASC" ? a.id - b.id : b.id - a.id,
        );
        const elegida = ordenadas[0];
        return { get: () => elegida };
      },
    }),
  },
}));

const { comprobarLlaveAlArrancar, totpEstaDisponible } = await import("./mfaKeyCheck.js");

beforeEach(() => {
  filas = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Builds a confirmed `factor_totp` row whose secret genuinely decrypts. */
function filaSana(id: number, secreto = "JBSWY3DPEHPK3PXP"): FilaFake {
  const cifrado = cifrar(secreto, `factor:${id}`);
  return {
    id,
    secreto_cifrado: cifrado.ciphertext,
    iv: cifrado.iv,
    auth_tag: cifrado.auth_tag,
    key_version: cifrado.key_version,
    confirmed_at: new Date("2026-08-20T09:00:00.000Z"),
  };
}

describe("comprobarLlaveAlArrancar", () => {
  it("passes when the first row decrypts", async () => {
    usarLlaveUnica();
    filas = [filaSana(1)];

    const resultado = await comprobarLlaveAlArrancar();

    expect(resultado.ok).toBe(true);
    expect(totpEstaDisponible()).toBe(true);
  });

  it("fails when the first row does not decrypt, and says which key version it tried", async () => {
    usarLlaveUnica();
    const rota = filaSana(1);
    // Flip one bit of the tag: a corrupt row a healthy key still cannot open.
    const tagAlterado = Buffer.from(rota.auth_tag);
    tagAlterado[0] ^= 0xff;
    filas = [{ ...rota, auth_tag: tagAlterado }];

    const resultado = await comprobarLlaveAlArrancar();

    expect(resultado.ok).toBe(false);
    expect(resultado.detalle).toContain("factor_totp.id=1");
    expect(resultado.detalle).toContain("versión 1");
    expect(totpEstaDisponible()).toBe(false);
  });

  it("fails when a row's key_version names a key that was never rotated in", async () => {
    usarLlaveUnica();
    // The row claims key_version 2, but only key 1 is configured — the shape
    // a restored-from-before-the-rotation-finished backup would take.
    const fila = filaSana(1);
    filas = [{ ...fila, key_version: 2 }];

    const resultado = await comprobarLlaveAlArrancar();

    expect(resultado.ok).toBe(false);
    expect(resultado.detalle).toContain("versión 2");
  });

  it("passes when there are no rows at all", async () => {
    usarLlaveUnica();
    filas = [];

    const resultado = await comprobarLlaveAlArrancar();

    expect(resultado.ok).toBe(true);
    expect(totpEstaDisponible()).toBe(true);
  });

  it("fails at boot when MFA_ENCRYPTION_KEY_ACTIVE does not resolve, even with zero rows", () => {
    // Step 4's actual point: a check written as "only look when there is a
    // row" would let a deploy with no usable key at all boot silently, and
    // nobody would notice until the first person tried to register a factor.
    // No `usarLlaveUnica()` here — the variable is simply unset.
    filas = [];

    return comprobarLlaveAlArrancar().then((resultado) => {
      expect(resultado.ok).toBe(false);
      expect(resultado.detalle).toContain("MFA_ENCRYPTION_KEY_ACTIVE");
      expect(totpEstaDisponible()).toBe(false);
    });
  });

  it("chooses the first confirmed row by id, skipping an unconfirmed one with a lower id", async () => {
    usarLlaveUnica();
    const sinConfirmar: FilaFake = { ...filaSana(1), confirmed_at: null };
    const confirmadaMasAlta = filaSana(5);
    const confirmadaMasBaja = filaSana(3);
    filas = [sinConfirmar, confirmadaMasAlta, confirmadaMasBaja];

    // A corrupt row 3 has to be the one that fails this check, proving 3 —
    // not 1 (unconfirmed) and not 5 — is the one actually read.
    const tagAlterado = Buffer.from(confirmadaMasBaja.auth_tag);
    tagAlterado[0] ^= 0xff;
    filas = [sinConfirmar, confirmadaMasAlta, { ...confirmadaMasBaja, auth_tag: tagAlterado }];

    const resultado = await comprobarLlaveAlArrancar();

    expect(resultado.ok).toBe(false);
    expect(resultado.detalle).toContain("factor_totp.id=3");
  });

  it("decrypts a row written under an older, still-configured key after rotation", async () => {
    // Row encrypted while key 1 was active; key 2 is now the active one, but
    // key 1's variable is still present — the state between the two deploys
    // Task 3's rotation procedure describes.
    vi.stubEnv("MFA_ENCRYPTION_KEY_1", CLAVE_1);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "1");
    const filaVieja = filaSana(9);
    vi.stubEnv("MFA_ENCRYPTION_KEY_2", CLAVE_2);
    vi.stubEnv("MFA_ENCRYPTION_KEY_ACTIVE", "2");
    filas = [filaVieja];

    const resultado = await comprobarLlaveAlArrancar();

    expect(resultado.ok).toBe(true);
  });
});

describe("A6 — lives only where src/index.ts can reach it, never where rescue.ts can", () => {
  /** Every `from "..."` / `export ... from "..."` / `import("...")` target in one file's source. */
  function importsDe(archivo: string): string[] {
    const src = readFileSync(archivo, "utf8");
    const rutas: string[] = [];

    // Anchored at the start of a (trimmed) line so a comment that merely
    // mentions the word "from" — this codebase writes prose comments, never
    // code samples with a leading "//" stripped — cannot be mistaken for a
    // real import. Every source file here uses `//` line comments, never
    // `/* */` blocks that could hide a bare `import ... from "..."` line.
    // `[^;]*?` — not `[^;\n]*?` — on purpose: a multi-line named import (one
    // symbol per line, `rescue.ts` itself imports `rescueCore.js` that way)
    // puts `from` on a different line than `import`, and excluding newlines
    // here would silently stop the walk one hop short of it.
    const estatico = /^[ \t]*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/gm;
    let m: RegExpExecArray | null;
    while ((m = estatico.exec(src))) rutas.push(m[1]);

    // 🔴 The side-effect form, `import "./x.js";`, which carries no `from` at
    // all and so is invisible to the pattern above. Added after the coordinator
    // mutated `rescueCore.ts` with exactly that line and **this test stayed
    // green** — the one guard standing between a wrong key and the rescue
    // console did not see it.
    //
    // And it is the likeliest accidental shape of all: somebody who wants the
    // boot check to actually run writes `import "./mfaKeyCheck.js";` and names
    // nothing, which is precisely the edit this test exists to refuse.
    const efectoLateral = /^[ \t]*import\s*["']([^"']+)["']/gm;
    while ((m = efectoLateral.exec(src))) rutas.push(m[1]);
    const dinamico = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dinamico.exec(src))) rutas.push(m[1]);

    return rutas;
  }

  /** Resolves a relative import (`.js`, as this project's NodeNext ESM writes them) to its `.ts` source. Bare specifiers (packages, `node:*`) return `null` — they are not part of the graph this test walks. */
  function resolverRuta(desde: string, ruta: string): string | null {
    if (!ruta.startsWith(".")) return null;
    let resuelto = resolve(dirname(desde), ruta);
    if (resuelto.endsWith(".js")) resuelto = resuelto.slice(0, -3);
    return `${resuelto}.ts`;
  }

  /** Every file reachable from `entrada` by import, `entrada` itself included. */
  function grafoDeImports(entrada: string): Set<string> {
    const visitados = new Set<string>();
    const pila = [entrada];
    while (pila.length > 0) {
      const actual = pila.pop() as string;
      if (visitados.has(actual)) continue;
      visitados.add(actual);
      if (!existsSync(actual)) continue; // a bogus "from" match — nothing to expand
      for (const ruta of importsDe(actual)) {
        const resuelto = resolverRuta(actual, ruta);
        if (resuelto && !visitados.has(resuelto)) pila.push(resuelto);
      }
    }
    return visitados;
  }

  it("does not import anything that src/scripts/rescue.ts imports", () => {
    const entrada = resolve(here, "../scripts/rescue.ts");
    const grafo = grafoDeImports(entrada);

    // Sanity check on the walker itself: if this ever comes back empty, the
    // test below passes for the wrong reason (nothing was walked, so of
    // course the forbidden file is not in it).
    expect(grafo.size).toBeGreaterThan(1);
    expect(grafo).toContain(resolve(here, "rescueCore.ts"));

    expect(grafo).not.toContain(resolve(here, "mfaKeyCheck.ts"));
  });
});
