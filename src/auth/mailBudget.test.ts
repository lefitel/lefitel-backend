import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const error = vi.fn();
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({ log: () => ({ error, warn, info: vi.fn() }) }));

const { consumirPresupuestoDeCorreo, reiniciarPresupuestoDeCorreo, presupuestoRestante } =
  await import("./mailBudget.js");
const { MAIL_DAILY_BUDGET, MAIL_DAILY_WINDOW_MS } = await import("../config/security.js");

beforeEach(() => {
  reiniciarPresupuestoDeCorreo();
  error.mockClear();
  warn.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("the daily mail budget", () => {
  it("allows exactly the budget and refuses the one after it", () => {
    for (let i = 0; i < MAIL_DAILY_BUDGET; i++) {
      expect(consumirPresupuestoDeCorreo("prueba"), `envío ${i + 1}`).toBe(true);
    }
    expect(consumirPresupuestoDeCorreo("prueba")).toBe(false);
    expect(presupuestoRestante()).toBe(0);
  });

  /**
   * The reason this exists at all, stated as a test: what it counts is sends.
   * The mechanism it replaced was middleware, so it could only count requests
   * — and fifty requests that send nothing were enough to shut recovery off
   * for everybody for a day while spending none of the quota it was guarding.
   * Nothing here can be spent without a caller having decided to send.
   */
  it("is untouched by anything that does not ask to send", () => {
    expect(presupuestoRestante()).toBe(MAIL_DAILY_BUDGET);
  });

  it("says so loudly when it runs out, because nobody would notice otherwise", () => {
    for (let i = 0; i < MAIL_DAILY_BUDGET; i++) consumirPresupuestoDeCorreo("prueba");
    expect(error).not.toHaveBeenCalled();

    consumirPresupuestoDeCorreo("password/forgot");
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toMatchObject({ motivo: "password/forgot", tope: MAIL_DAILY_BUDGET });
  });

  it("warns on the way up, while there is still time to act", () => {
    const umbral = Math.ceil(MAIL_DAILY_BUDGET * 0.8);
    for (let i = 0; i < umbral - 1; i++) consumirPresupuestoDeCorreo("prueba");
    expect(warn).not.toHaveBeenCalled();
    consumirPresupuestoDeCorreo("prueba");
    expect(warn).toHaveBeenCalled();
  });

  /**
   * A sliding window, not one that resets on a clock boundary. With a fixed
   * window, whoever wanted the budget gone could spend it twice within a
   * couple of minutes either side of the reset — 160 sends against a quota
   * of 100.
   */
  it("frees each send only once a full window has passed since that send", () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAIL_DAILY_BUDGET; i++) consumirPresupuestoDeCorreo("prueba");
    expect(consumirPresupuestoDeCorreo("prueba")).toBe(false);

    // One millisecond short of the window: still spent.
    vi.advanceTimersByTime(MAIL_DAILY_WINDOW_MS - 1);
    expect(consumirPresupuestoDeCorreo("prueba")).toBe(false);

    vi.advanceTimersByTime(2);
    expect(consumirPresupuestoDeCorreo("prueba")).toBe(true);
  });

  it("leaves room under the Resend ceiling for the security copies", () => {
    // 80 against 100/day. The twenty left are not slack: `securityNotice.ts`
    // sends the copies that make an account takeover visible to somebody who
    // is not the attacker, and those are consequences of sends already counted
    // here. A takeover warning dropped because a stranger burned the budget is
    // the one message this mechanism must never be the reason for.
    expect(MAIL_DAILY_BUDGET).toBe(80);
    expect(MAIL_DAILY_BUDGET).toBeLessThan(100);
  });
});

/**
 * The ordering both callers depend on, pinned against the source.
 *
 * `crearToken` marks whatever was already pending for that account as used.
 * So asking the budget *after* minting would destroy a link that may still be
 * sitting in somebody's inbox and give them nothing in return — on a day the
 * budget has run out, the mechanism meant to protect the quota would be
 * costing people the link they already had.
 *
 * A behavioural test cannot see this: both orders answer the same uniform 200.
 */
describe("both senders ask the budget before minting a token", () => {
  const CALLERS = [
    "src/controllers/password.controller.ts",
    "src/controllers/email.controller.ts",
  ];

  it("has the check above the mint in every file that sends", () => {
    for (const file of CALLERS) {
      const src = readFileSync(file, "utf8");
      const check = src.indexOf("consumirPresupuestoDeCorreo(");
      const mint = src.indexOf("await crearToken(");
      expect(check, `${file} ya no consulta el presupuesto de correo`).toBeGreaterThan(-1);
      expect(mint, `${file} ya no acuña ningún token`).toBeGreaterThan(-1);
      expect(
        check,
        `${file}: el presupuesto se consulta DESPUÉS de acuñar. En un día agotado eso ` +
          "invalida el enlace pendiente de esa persona y no le manda ninguno nuevo.",
      ).toBeLessThan(mint);
    }
  });
});
