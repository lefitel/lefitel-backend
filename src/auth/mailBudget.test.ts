// One daily ceiling per provider, with a reserved share for the login code
// and the security notices — plan 4E, Task 7.
//
// Since 4E there is no global counter: `crearPresupuesto` builds one per
// provider, and the relay owns them. What this file pins is the arithmetic
// of one counter — the ceiling, the reserve, the window — and, by scanning
// the sources, that the two senders which do something destructive before
// sending still ask the chain first, and that only the relay ever charges.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const error = vi.fn();
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({ log: () => ({ error, warn, info: vi.fn(), debug: vi.fn() }) }));

const { crearPresupuesto, FLUJOS_RESERVADOS } = await import("./mailBudget.js");
const { MAIL_DAILY_WINDOW_MS, MAIL_RESERVA_FRACCION } = await import("../config/security.js");

const LIBRE = "email/verificar" as const;
const RESERVADO = "mfa/codigo" as const;

beforeEach(() => {
  error.mockClear();
  warn.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("one provider's ceiling", () => {
  it("lets an unreserved flow spend up to the ceiling minus the reserve, and refuses the one after", () => {
    const p = crearPresupuesto("mailjet", 100);
    const techo = 100 - Math.floor(100 * MAIL_RESERVA_FRACCION);
    for (let i = 0; i < techo; i++) expect(p.consumir(LIBRE), `envío ${i + 1}`).toBe(true);
    expect(p.consumir(LIBRE)).toBe(false);
    expect(p.restante()).toBe(0);
  });

  // 🔴 The reserve: what keeps `/password/forgot` — which asks for no
  // credential — from spending the login out of existence.
  it("keeps the last quarter for the reserved flows once the unreserved ones are exhausted", () => {
    const p = crearPresupuesto("mailjet", 100);
    while (p.consumir(LIBRE)) {
      /* spend the unreserved share */
    }
    expect(p.hay(LIBRE)).toBe(false);
    expect(p.hay(RESERVADO)).toBe(true);
    for (let i = 0; i < Math.floor(100 * MAIL_RESERVA_FRACCION); i++) {
      expect(p.consumir(RESERVADO), `reservado ${i + 1}`).toBe(true);
    }
    expect(p.consumir(RESERVADO)).toBe(false);
  });

  it("names exactly the login code and the three security notices as reserved", () => {
    expect([...FLUJOS_RESERVADOS].sort()).toEqual(
      ["email/aviso-cambio", "mfa/codigo", "password/aviso-restablecida", "rescate/aviso"].sort(),
    );
  });

  it("is untouched by anything that only looks", () => {
    const p = crearPresupuesto("resend", 80);
    for (let i = 0; i < 200; i++) expect(p.hay(LIBRE)).toBe(true);
    expect(p.restante()).toBe(80 - Math.floor(80 * MAIL_RESERVA_FRACCION));
  });

  it("says so loudly when it refuses, naming the provider and the flow", () => {
    const p = crearPresupuesto("smtp2go", 4, 1);
    for (let i = 0; i < 3; i++) p.consumir(LIBRE);
    expect(error).not.toHaveBeenCalled();
    p.consumir("password/forgot");
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toMatchObject({ proveedor: "smtp2go", motivo: "password/forgot", tope: 4, techo: 3 });
  });

  it("warns once when crossing 80 %, not on every send above it", () => {
    const p = crearPresupuesto("resend", 10, 0);
    for (let i = 0; i < 7; i++) p.consumir(LIBRE);
    expect(warn).not.toHaveBeenCalled();
    p.consumir(LIBRE);
    expect(warn).toHaveBeenCalledTimes(1);
    p.consumir(LIBRE);
    p.consumir(LIBRE);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rounds the reserve down: a ceiling of 30 keeps 7 and spends 23", () => {
    // The one real ceiling where it matters — smtp2go's 30 makes 7.5.
    const p = crearPresupuesto("smtp2go", 30);
    for (let i = 0; i < 23; i++) expect(p.consumir(LIBRE), `envío ${i + 1}`).toBe(true);
    expect(p.consumir(LIBRE)).toBe(false);
    expect(p.hay(RESERVADO)).toBe(true);
  });

  it("frees each send only once a full window has passed since that send", () => {
    vi.useFakeTimers();
    const p = crearPresupuesto("resend", 4, 0);
    for (let i = 0; i < 4; i++) p.consumir(LIBRE);
    expect(p.consumir(LIBRE)).toBe(false);
    vi.advanceTimersByTime(MAIL_DAILY_WINDOW_MS - 1);
    expect(p.consumir(LIBRE)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(p.consumir(LIBRE)).toBe(true);
  });

  it("can be marked spent outright, when the provider itself says we are over", () => {
    const p = crearPresupuesto("elastic", 80);
    p.agotar();
    expect(p.hay(LIBRE)).toBe(false);
    expect(p.hay(RESERVADO)).toBe(false);
    expect(p.restante()).toBe(0);
  });

  it("keeps each provider's count on its own", () => {
    const a = crearPresupuesto("a", 2, 0);
    const b = crearPresupuesto("b", 2, 0);
    a.consumir(LIBRE);
    a.consumir(LIBRE);
    expect(a.hay(LIBRE)).toBe(false);
    expect(b.hay(LIBRE)).toBe(true);
  });
});

/**
 * Decision 2 of `docs/plans/2026-09-01-defectos-previos-al-4b.md`, kept
 * through plan 4E under the new name: whoever burns something before sending
 * — the pending verification link, the pending login code — asks the chain
 * first. A behavioural test cannot see this: both orders answer the same
 * uniform 200.
 */
describe("the senders that burn something ask the chain before minting", () => {
  it("has the check above the first destructive step in both token senders", () => {
    const casos: [string, string][] = [
      ["src/controllers/password.controller.ts", "await crearToken("],
      // The step that must come after the check is the transaction that
      // clears `email_verified_at` and burns every pending link — not the
      // mint further down (audit of Task 7, which also found the old anchor
      // matching a comment above the real call).
      ["src/controllers/email.controller.ts", "sequelize.transaction("],
    ];
    for (const [file, destructivo] of casos) {
      const src = readFileSync(file, "utf8");
      // The call itself, not the word: both files name the function in a
      // comment a few lines above the call.
      const check = src.indexOf("if (!hayProveedorDisponible(");
      const paso = src.indexOf(destructivo);
      expect(check, `${file} ya no pregunta si hay proveedor`).toBeGreaterThan(-1);
      expect(paso, `${file} ya no tiene el paso destructivo`).toBeGreaterThan(-1);
      expect(
        check,
        `${file}: se pregunta por el proveedor DESPUÉS de tocar algo. En un día agotado eso ` +
          "invalida lo pendiente de esa persona y no le manda nada nuevo.",
      ).toBeLessThan(paso);
    }
  });

  it("asks whether a provider can send before minting a login code (plan 4E)", () => {
    const file = "src/controllers/emailCode.controller.ts";
    const src = readFileSync(file, "utf8");
    const check = src.indexOf("if (!hayProveedorDisponible(");
    const mint = src.indexOf("await emitirCodigo(");
    expect(check, `${file} ya no pregunta si hay proveedor`).toBeGreaterThan(-1);
    expect(mint, `${file} ya no emite ningún código`).toBeGreaterThan(-1);
    expect(
      check,
      `${file}: se pregunta por el proveedor DESPUÉS de emitir. En un día agotado eso ` +
        "quema el código pendiente de esa persona y no le manda ninguno nuevo.",
    ).toBeLessThan(mint);
  });

  // Rewritten in the positive, plan 4E: the old test checked that a name
  // nobody uses any more was absent, which is green for ever. This one names
  // the only file allowed to charge a budget.
  it("only the relay ever charges a provider's budget", () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const tsFilesUnder = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? tsFilesUnder(full) : full.endsWith(".ts") ? [full] : [];
      });
    const cobran = tsFilesUnder(srcRoot)
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) => /\.consumir\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(srcRoot.length + 1).replace(/\\/g, "/"));
    expect(cobran).toEqual(["auth/mailRelay.ts"]);
  });
});
