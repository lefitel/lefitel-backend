// Every permission the system asks for has to be one the vocabulary declares.
//
// This invariant did not exist before modules declared their own actions. The
// matrix was ten modules by four verbs and every pair existed by construction,
// so `requirePermission("bitacora", "archivar")` was merely useless. Now it is a
// gate that can never open: `isActionOf` answers `false`, `buildMatrix` drops
// the row, and `can()` denies everybody — silently, permanently, and with no way
// to fix it from the Seguridad screen, because the checkbox does not exist
// either. Only a deploy gets it back.
//
// An audit found the hole by deleting `archivar` from `postes` and `editar` from
// `seguridad` and running everything: 1.199 tests, all green. Removing `editar`
// from `seguridad` takes down editing a user, unlocking one, and resetting a
// password, and nothing said a word.
//
// The reason nothing catches it is structural, not an oversight. `requirePermission`
// takes `(modulo: Module, accion: Action)` as two independent parameters — a
// deliberate decision recorded in `middleware/requirePermission.ts` — so the
// compiler cannot correlate them, and twelve test files mock `permissions/store.js`,
// so `can()` never consults `PERMISSIONS` in any of them. This file is the only
// thing standing between a one-line edit and a silently dead endpoint.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import app from "../app.js";
import { ACTION_LABELS, PERMISSIONS, isActionOf } from "./matrix.js";

interface Layer {
  route?: { stack: { handle: { permission?: string } }[]; path: string };
  handle: { stack?: Layer[]; permission?: string };
}

/**
 * Every `modulo.accion` stamped on a mounted gate.
 *
 * `requirePermission` labels the handler it returns with the pair it will ask
 * for (`middleware/requirePermission.ts`), which is what makes the pair readable
 * from outside the closure. Without that stamp all this walk could see was the
 * function's name, and every gate has the same one.
 */
function paresMontados(): { pair: string; path: string }[] {
  const salida: { pair: string; path: string }[] = [];

  const recorrer = (capas: Layer[], prefijo: string): void => {
    for (const capa of capas) {
      if (capa.route) {
        for (const s of capa.route.stack) {
          if (typeof s.handle.permission === "string") {
            salida.push({ pair: s.handle.permission, path: prefijo + capa.route.path });
          }
        }
        continue;
      }
      if (typeof capa.handle.permission === "string") {
        salida.push({ pair: capa.handle.permission, path: prefijo + "*" });
      }
      if (capa.handle.stack) recorrer(capa.handle.stack, prefijo);
    }
  };

  // Express 5 renamed `_router` to `router` and made it public. Read through
  // both so the walk does not depend on which major compiled the app, and let
  // the "cannot pass by default" assertion below catch it if neither answers.
  const held = app as unknown as { router?: { stack: Layer[] }; _router?: { stack: Layer[] } };
  recorrer((held.router ?? held._router)?.stack ?? [], "");
  return salida;
}

/** Every `can(..., "modulo", "accion")` written literally under `src/`. */
function paresEnFuente(): { pair: string; file: string }[] {
  const salida: { pair: string; file: string }[] = [];
  const raiz = join(import.meta.dirname, "..");

  const recorrer = (dir: string): void => {
    for (const entrada of readdirSync(dir)) {
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) {
        if (entrada !== "node_modules") recorrer(ruta);
        continue;
      }
      // Tests are skipped on purpose: several name deliberately impossible
      // pairs to prove they are refused, which is the opposite of this check.
      if (!entrada.endsWith(".ts") || entrada.endsWith(".test.ts")) continue;
      const texto = readFileSync(ruta, "utf8");
      for (const m of texto.matchAll(/\bcan\(\s*[^,)]+,\s*"([a-z]+)"\s*,\s*"([a-z_]+)"\s*\)/g)) {
        salida.push({ pair: `${m[1]}.${m[2]}`, file: entrada });
      }
    }
  };

  recorrer(raiz);
  return salida;
}

describe("every permission the system asks for exists", () => {
  it("finds the gates at all, so an empty walk cannot pass by default", () => {
    // Without this, a walk that silently returned nothing would satisfy every
    // assertion below and the file would be decoration. Thirty gates are mounted
    // today; the bound is loose because routes come and go.
    expect(paresMontados().length).toBeGreaterThan(20);
    expect(paresEnFuente().length).toBeGreaterThan(0);
  });

  it("names only pairs the vocabulary declares, on every mounted route", () => {
    const invalidos = paresMontados()
      .filter(({ pair }) => {
        const [modulo, accion] = pair.split(".");
        return !isActionOf(modulo, accion);
      })
      .map(({ pair, path }) => `${pair} en ${path}`);

    expect(invalidos).toEqual([]);
  });

  it("names only pairs the vocabulary declares, in every direct can() call", () => {
    // The gates are not the whole surface: controllers ask `can()` themselves,
    // and those calls never pass through a route stack, so the walk above cannot
    // see them.
    const invalidos = paresEnFuente()
      .filter(({ pair }) => {
        const [modulo, accion] = pair.split(".");
        return !isActionOf(modulo, accion);
      })
      .map(({ pair, file }) => `${pair} en ${file}`);

    expect(invalidos).toEqual([]);
  });

  it("keeps a label for every action any module declares", () => {
    // A module can only declare an action `ACTIONS` already has — the `satisfies`
    // in matrix.ts enforces that at compile time. This is the runtime half: an
    // action with no label is a column the Seguridad screen draws blank.
    for (const [modulo, acciones] of Object.entries(PERMISSIONS)) {
      for (const accion of acciones) {
        expect(ACTION_LABELS[accion], `${modulo}.${accion}`).toBeTruthy();
      }
    }
  });
});
