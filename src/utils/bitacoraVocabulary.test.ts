// What the audit log's codes are called on screen.
//
// The compiler holds most of this file's subject by itself: an action cannot be
// declared without a label and a family, and `logAction` cannot be handed a
// code that is not declared. What it cannot see is whether the label *says
// anything*, and the two places where the label depends on the row.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BITACORA_ACTIONS, BITACORA_ENTITIES, BITACORA_FAMILIES, BITACORA_LEGACY_ACTIONS,
  STEP_UP_DENIED_POR_MOTIVO, accionesDeFamilia, esFamilia, etiquetaDeAccion, etiquetaDeEntidad,
  type BitacoraFamily,
} from "./bitacoraVocabulary.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const todas = { ...BITACORA_ACTIONS, ...BITACORA_LEGACY_ACTIONS };

describe("every action has a name a person can read", () => {
  it("no label is empty, and none is the code over again", () => {
    // What a line added in a hurry looks like: `FOO_BAR: a("FOO_BAR", …)`
    // satisfies the type and changes nothing on screen.
    const malas = Object.entries(todas)
      .filter(([codigo, { etiqueta }]) =>
        etiqueta.trim() === "" || etiqueta === codigo || /^[A-Z0-9_]+$/.test(etiqueta));
    expect(malas).toEqual([]);
  });

  it("a code is not declared twice, once current and once retired", () => {
    const repetidas = Object.keys(BITACORA_LEGACY_ACTIONS).filter((c) => c in BITACORA_ACTIONS);
    expect(repetidas).toEqual([]);
  });

  it("no entity is named with its model name when that is not a word", () => {
    expect(etiquetaDeEntidad("credencial_webauthn")).toBe("Llave de acceso");
    expect(etiquetaDeEntidad("Sesion")).toBe("Sesión");
    expect(etiquetaDeEntidad("Solución")).toBe("Solución");
    const crudas = Object.entries(BITACORA_ENTITIES).filter(([, nombre]) => /_/.test(nombre) || nombre.trim() === "");
    expect(crudas).toEqual([]);
  });

  it("shows a code nobody declares as it is stored, rather than as nothing", () => {
    expect(etiquetaDeAccion("ALGO_DE_HACE_AÑOS")).toBe("ALGO_DE_HACE_AÑOS");
    expect(etiquetaDeEntidad("TablaVieja")).toBe("TablaVieja");
    // `in` would say yes to these; a row whose action is literally
    // "constructor" must not be labelled with a function.
    expect(etiquetaDeAccion("constructor")).toBe("constructor");
    expect(etiquetaDeAccion("toString")).toBe("toString");
  });
});

describe("the filter's families", () => {
  it("each one holds at least one code, so the filter never offers an empty option", () => {
    const vacias = (Object.keys(BITACORA_FAMILIES) as BitacoraFamily[])
      .filter((f) => accionesDeFamilia(f).length === 0);
    expect(vacias).toEqual([]);
  });

  it("together they hold every code exactly once", () => {
    const repartidas = (Object.keys(BITACORA_FAMILIES) as BitacoraFamily[]).flatMap(accionesDeFamilia);
    expect(repartidas.slice().sort()).toEqual(Object.keys(todas).sort());
  });

  it("put where a person reviewing would look, for the ones a prefix got wrong", () => {
    // The four refusals of somebody else's report are one question — "who has
    // been trying?" — and a filter by prefix sent one of them to "Eliminar".
    expect(accionesDeFamilia("rechazos")).toEqual(expect.arrayContaining([
      "READ_REPORTE_DENIED", "EDIT_REPORTE_DENIED", "DELETE_REPORTE_DENIED",
      "DUPLICATE_REPORTE_DENIED", "ROLE_CHANGE_DENIED",
    ]));
    expect(accionesDeFamilia("archivar")).not.toContain("DELETE_REPORTE_DENIED");
    // Verifying the address is how most accounts register their second factor.
    expect(accionesDeFamilia("factor")).toContain("EMAIL_VERIFIED");
    // Deleting orphans removes files; it is not an archived record.
    expect(accionesDeFamilia("archivos")).toEqual(expect.arrayContaining(["DELETE_ORPHANS", "CLEAR_BROKEN_REFS"]));
    // Retired codes are still in the table and must still be findable.
    expect(accionesDeFamilia("crear")).toContain("CREATE_SOLUCION");
  });

  it("knows a family from something that merely looks like one", () => {
    expect(esFamilia("factor")).toBe(true);
    expect(esFamilia("constructor")).toBe(false);
    expect(esFamilia(["factor"])).toBe(false);
    expect(esFamilia(undefined)).toBe(false);
  });
});

describe("a label that depends on the row", () => {
  it("tells the server asking for the password apart from a wrong password", () => {
    // One code, five motives. Two are the ordinary first step of a protected
    // operation, and "Operación sensible rechazada" made each read as an
    // incident — on the very row this work started from.
    const pedido = etiquetaDeAccion("STEP_UP_DENIED", { motivo: "contraseña-requerida" });
    const fallo = etiquetaDeAccion("STEP_UP_DENIED", { motivo: "contraseña-incorrecta" });
    expect(pedido).toBe("Se le pidió confirmar su identidad");
    expect(fallo).toBe("Contraseña incorrecta al confirmar identidad");
    expect(etiquetaDeAccion("STEP_UP_DENIED", { motivo: "sin-factor-reciente" })).toBe(pedido);
  });

  it("falls back to the code's own label for a motive it does not know, or none", () => {
    const base = BITACORA_ACTIONS.STEP_UP_DENIED.etiqueta;
    expect(etiquetaDeAccion("STEP_UP_DENIED", { motivo: "uno-nuevo" })).toBe(base);
    expect(etiquetaDeAccion("STEP_UP_DENIED", null)).toBe(base);
    expect(etiquetaDeAccion("STEP_UP_DENIED", { motivo: "constructor" })).toBe(base);
    expect(etiquetaDeAccion("STEP_UP_DENIED")).toBe(base);
  });

  it("names every motive the gate can write, and no other", () => {
    // Read from the gate's source: this file has no imports on purpose, so the
    // motives are literals here and this is what keeps them the same list.
    const fuente = readFileSync(join(AQUI, "../middleware/requireStepUp.ts"), "utf8");
    const escritos = new Set([
      ...Array.from(fuente.matchAll(/export const MOTIVO_\w+ = "([^"]+)";/g), (m) => m[1]),
      ...Array.from(fuente.matchAll(/registrar\(req, "([^"]+)"\)/g), (m) => m[1]),
    ]);
    expect(escritos.size, "no se leyeron los motivos de requireStepUp").toBeGreaterThanOrEqual(5);
    expect(Object.keys(STEP_UP_DENIED_POR_MOTIVO).sort()).toEqual([...escritos].sort());
  });

  it("does not say a rescue was carried out when it was not", () => {
    // The same code is written when the rescue fails or collides. A label in
    // the past tense said "restablecido" over an operation that did not happen.
    const hecho = etiquetaDeAccion("RESCUE_MFA_RESET", { resultado: "ok" });
    expect(etiquetaDeAccion("RESCUE_MFA_RESET", { resultado: "error" })).toBe(`${hecho} (no se completó)`);
    expect(etiquetaDeAccion("RESCUE_EMAIL_SET", { resultado: "conflicto" })).toMatch(/no se completó/);
    expect(hecho).not.toMatch(/no se completó/);
    // And no rescue label states an outcome by itself.
    const afirman = Object.entries(BITACORA_ACTIONS)
      .filter(([c, { etiqueta }]) => c.startsWith("RESCUE_") && /(ado|ada|ados|adas)$/.test(etiqueta));
    expect(afirman).toEqual([]);
    // Only rescues: another code with a `resultado` in its metadata is left alone.
    expect(etiquetaDeAccion("UPDATE_ROL", { resultado: "error" })).toBe(BITACORA_ACTIONS.UPDATE_ROL.etiqueta);
  });
});
