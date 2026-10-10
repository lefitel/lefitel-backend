// `requireStepUp` — the gate on the operations a stolen session must not be
// enough for: creating and editing users, and touching roles and the
// permission matrix.
//
// This file mocks five things: `verifyOwnPassword` (the last-resort
// fallback), `tieneAlgunFactor` (whether that fallback is even reachable),
// `logAction` (the bitácora line every refusal writes), and
// `consumirCupoDeConfirmacion` plus `devolverCupoDeConfirmacion` (the atomic
// charge and refund against the shared budget the fallback spends). Those two
// are not in the original test skeleton for this task — they exist because
// `requireStepUp` shares its rate-limit bucket with
// `chargeConfirmBudgetOnSelfChange` in `usuario.routes.ts`, through the same
// `MemoryStore`, and calling the real store from here would make this file's
// assertions depend on that store's state surviving between tests rather than
// on what this gate itself decided. Mocking them keeps this file a unit test
// of `requireStepUp`'s own decisions; the store's own arithmetic — the
// atomic increment, the clamp at zero — is `loginLimiters.test.ts`'s job.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response } from "express";

const verifyOwnPassword = vi.fn();
const tieneAlgunFactor = vi.fn();
const hayFactorVerificable = vi.fn();
const metodosDeReautenticacion = vi.fn();
const logAction = vi.fn();
const consumirCupoDeConfirmacion = vi.fn();
const devolverCupoDeConfirmacion = vi.fn();
/**
 * Sixth mock, and it is not optional: the real `sellarContrasena` runs
 * `SesionModel.update` against whichever database this process is configured
 * with. Left real, every test whose password is accepted reached a genuine
 * UPDATE — nine of them turned red the moment the gate learned to seal, which
 * is how this was found rather than argued.
 */
const sellarContrasena = vi.fn();
vi.mock("../auth/sessionPromotion.js", () => ({ sellarContrasena }));
vi.mock("../auth/credentials.js", () => ({ verifyOwnPassword }));
vi.mock("../auth/factorInventory.js", () => ({
  tieneAlgunFactor,
  hayFactorVerificable,
  metodosDeReautenticacion,
}));
vi.mock("../utils/logAction.js", () => ({ logAction }));
// `importOriginal` pulls the real `PASSWORD_CONFIRM_MESSAGE` through rather
// than retyping the sentence a third time (`loginLimiters.ts` names it once,
// `requireStepUp.ts` imports it) — a third hand-typed copy is exactly the
// drift that constant exists to rule out, even one sitting only in a test.
vi.mock("./loginLimiters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loginLimiters.js")>();
  return { ...actual, consumirCupoDeConfirmacion, devolverCupoDeConfirmacion };
});

const {
  requireStepUp,
  CODIGO_STEP_UP,
  MOTIVO_ESTADO_INCOMPLETO,
  MOTIVO_SIN_FACTOR_RECIENTE,
  MOTIVO_CONTRASENA_INCORRECTA,
  MOTIVO_CONTRASENA_REQUERIDA,
} = await import("./requireStepUp.js");
const { STEP_UP_WINDOW_MINUTES, PASSWORD_CONFIRM_LIMIT } = await import("../config/security.js");

const haceMinutos = (m: number) => new Date(Date.now() - m * 60_000);

function contexto(user: Record<string, unknown> | undefined, body: unknown = {}) {
  const req = { user, body, ip: "::1", originalUrl: "/api/rol/1" } as never;
  // `as unknown as Response & typeof r`, the idiom `evento.lifecycle.test.ts`
  // already uses, and not the `as never` this file was written with.
  //
  // `never` is assignable to everything, so the handler call in every test
  // below compiled — but it is also assignable *from* nothing, so every
  // `expect(res.status)` and `expect(res.json)` in this file was the error
  // "Property 'status' does not exist on type 'never'". Seventeen of them,
  // from the day the file was written. They stayed invisible because
  // `npx tsc --noEmit` reads `tsconfig.json`, which excludes tests so
  // `npm run build` does not emit them; the test sources are only compiled by
  // `tsconfig.test.json`, which only `npm run typecheck` runs. Four review
  // rounds reported a clean typecheck truthfully and incompletely.
  //
  // The intersection keeps both halves honest: the object is a `Response` as
  // far as the handler is concerned, and `status`/`json` keep their mock types
  // so the assertions are checked rather than merely accepted.
  const r = { status: vi.fn().mockReturnThis(), json: vi.fn(), locals: {} };
  const res = r as unknown as Response & typeof r;
  return { req, res, next: vi.fn() };
}

beforeEach(() => {
  verifyOwnPassword.mockReset();
  tieneAlgunFactor.mockReset().mockResolvedValue(false);
  hayFactorVerificable.mockReset().mockResolvedValue(true);
  metodosDeReautenticacion.mockReset().mockResolvedValue(["totp"]);
  logAction.mockReset();
  // The default: plenty of room, so the charge in every test that does not
  // say otherwise lets the fallback reach `verifyOwnPassword`.
  consumirCupoDeConfirmacion.mockReset().mockResolvedValue({
    permitido: true,
    restantes: PASSWORD_CONFIRM_LIMIT - 1,
  });
  devolverCupoDeConfirmacion.mockReset().mockResolvedValue(undefined);
  sellarContrasena.mockReset().mockResolvedValue(true);
});

describe("requireStepUp", () => {
  it("lets through a factor proved inside the window", async () => {
    // tieneAlgunFactor is forced true so this exercises the scenario the
    // test is named for — an account that actually has a factor, proved
    // recently — rather than a factor-less one. Since Task 3 removed the
    // free skip a factor-less account used to fall back to, the default
    // `false` would no longer make this pass for the wrong reason: with the
    // window check deleted, a factor-less account with no password is
    // refused now, same as one that has a factor and no fresh proof.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES - 1),
    });
    await requireStepUp()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("refuses a factor proved one minute outside the window", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES + 1),
    });
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
    );
  });

  // Plan 4E: a verified email is a factor. The account that has verified its
  // address and registered nothing else used to take the "nothing to prove"
  // skip below; now it is refused like any other account with a factor, and
  // the refusal names the one method it has.
  it("refuses an account whose only factor is its verified email, naming the email as the method", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    metodosDeReautenticacion.mockResolvedValue(["correo"]);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        motivo: MOTIVO_SIN_FACTOR_RECIENTE,
        metodos: ["correo"],
      }),
    );
  });

  it("refuses a mark in the future, instead of treating it as freshly proved", async () => {
    // The window had no lower bound: it measured "no more than ten minutes
    // old" and nothing else, so a stamp *ahead* of now satisfied it for as
    // long as it stayed ahead — a session authorised until the clock caught
    // up, which for a mark an hour out is an hour of unlimited step-up.
    //
    // How a stamp gets there: a host whose clock is corrected backwards
    // (NTP after a drift, a VM resumed from a snapshot), or a write that
    // computes the instant wrongly. Latent today, because nothing writes the
    // column until plan 4B — which is exactly when a bad write would land.
    //
    // Five minutes ahead, deliberately *inside* the ten-minute width: a bound
    // written as `>= -WINDOW` instead of `>= 0` would pass this, and so would
    // the old code.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(-5),
    });
    await requireStepUp()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
    );
  });

  it("refuses a session that came in on a remembered device", async () => {
    // A remembered login leaves `mfa_satisfied_at` NULL on purpose. If it did
    // not, stealing that cookie plus the password would be enough to edit the
    // permission matrix without touching a single factor — which is the whole
    // reason the column and the remembered device are separate things.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("answers with a code the frontend can act on, not just a message", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: CODIGO_STEP_UP }),
    );
  });

  it("accepts the current password while the account has no factor at all", async () => {
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("stops accepting the password the moment a factor exists", async () => {
    // The narrow window this fallback exists for closes by itself. Somebody who
    // has a factor and only knows the password must not reach these routes —
    // that is precisely the attacker the second factor is for.
    tieneAlgunFactor.mockResolvedValue(true);
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(verifyOwnPassword).not.toHaveBeenCalled();
  });

  it("refuses an onboarding session outright, password or not", async () => {
    // Somebody still setting up must not create users or touch roles. If the
    // password alone opened these during the grace period, the second factor
    // would be optional for exactly the operations it exists to protect.
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, estado: "onboarding", mfa_satisfied_at: haceMinutos(1) },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }),
    );
  });

  describe("permiteOnboarding, for the doors that let somebody stop being onboarding", () => {
    // The option and its exact edges. `ONBOARDING_EXTRA` in
    // `auth/sessionState.ts` opens six prefixes so an account past its
    // deadline can finish setting up, and the design puts several of those
    // same operations behind step-up — changing your own address, registering
    // a factor. Without this option the two rules cancel out and the account
    // is sealed in: measured on `POST /api/auth/email/send`, where the plain
    // gate turns `app.auth.test.ts`'s "leaves the doors that finish the setup
    // open to that same session" from 400 into 403.

    it("lets an onboarding session past the state check when the route asks for it", async () => {
      // Through the same password branch a factor-less `completa` session
      // answers to since Task 3 of the reauthentication-window plan removed
      // the free skip — an onboarding account has no factor either, so this
      // is the only way through once the state check stops blocking it.
      // Sending it and reaching `next()` is what witnesses the request
      // crossing everything *after* the state check — the window, the
      // factor lookup, the password verification — not the state check on
      // its own: a broken state check would still refuse and fail this
      // test's `next()` assertion with or without a password sent.
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const { req, res, next } = contexto(
        { id: 1, estado: "onboarding", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp({ permiteOnboarding: true })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("still refuses an onboarding session whose account has a factor", async () => {
      // The line between the option and a hole. `estadoEfectivo` can hand an
      // `onboarding` state to a session on an account that does have a factor
      // — one opened before the deadline, on an account that registered
      // afterwards — and for that account a password is not an acceptable
      // answer here any more than anywhere else. The option relaxes the state
      // check and nothing below it.
      //
      // The mock reads its argument rather than answering a constant: a gate
      // that asked about some other account would be refusing for the wrong
      // reason and this would catch it.
      tieneAlgunFactor.mockImplementation(async (id: number) => id === 1);
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const { req, res, next } = contexto(
        { id: 1, estado: "onboarding", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp({ permiteOnboarding: true })(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
      );
      expect(next).not.toHaveBeenCalled();
      // The password was never even compared: with a factor on the account
      // there is no answer of that shape.
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("never lets a parcial session through, whatever the option says", async () => {
      // The option names one state and reads that state, rather than meaning
      // "anything below `completa`". `parcial` means the account has a factor
      // and has not proved it on this session, so the way through is proving
      // it — and `PARCIAL` opens none of the setup doors this option is for.
      const { req, res, next } = contexto({ id: 1, estado: "parcial", mfa_satisfied_at: null });
      await requireStepUp({ permiteOnboarding: true })(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  it("writes a bitácora line when it refuses", async () => {
    // An attacker probing these routes is invisible otherwise.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_DENIED", severity: "warning" }),
    );
  });

  it("refuses when there is no user at all", async () => {
    // Mounted behind `authenticate`, so this cannot happen — unless somebody
    // mounts it in front of it one day. Fail closed.
    const { req, res, next } = contexto(undefined);
    await requireStepUp()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("answers 500 instead of hanging when tieneAlgunFactor itself fails", async () => {
    // Express 4 does not catch a rejected promise from an `async`
    // middleware — a query that throws here, with nothing catching it,
    // would leave the request hanging until the client gave up rather than
    // answering anything at all. `authenticate.ts` wraps its whole body in
    // one try/catch for exactly this reason; this gate does the same.
    tieneAlgunFactor.mockRejectedValue(new Error("la tabla de factores no respondió"));
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it("names the inner handler stepUpGate, not an anonymous function", () => {
    // A later task walks the mounted Express stack the way
    // `routeGuards.test.ts` already does for `requirePermissionGate`, and it
    // can only tell a gated route from an open one by this name.
    expect(requireStepUp().name).toBe("stepUpGate");
  });

  describe("the password fallback's own budget", () => {
    // `requireStepUp` shares this budget with `chargeConfirmBudgetOnSelfChange`
    // (see `usuario.routes.ts`), through the same `MemoryStore` in
    // `loginLimiters.ts` — a second bucket keyed the same way would hand out
    // ten attempts a quarter of an hour to anybody willing to alternate the
    // two doors onto the same secret.
    //
    // Since Task 1 of the reauthentication-window plan (2026-09-08) this gate
    // charges *every* attempt up front, atomically, through
    // `consumirCupoDeConfirmacion` — before comparing anything — and gives the
    // charge back with `devolverCupoDeConfirmacion` when the attempt turns out
    // to be either correct or one this gate never got to compare (the budget
    // was already spent). See requireStepUp.ts's own docstring for the
    // concurrency bug that replaced ("read the count, compare, charge only if
    // wrong") produced, and why charging first closes it.

    it("no deja pasar más de PASSWORD_CONFIRM_LIMIT comparaciones lanzadas a la vez", async () => {
      // The bug this task exists to close, reproduced directly: ten requests
      // landing in the same tick, all with the wrong password. The old
      // read-then-charge gate let every one of them reach `verifyOwnPassword`,
      // because all ten read "nothing spent yet" before any of them had
      // charged anything.
      //
      // `consumirCupoDeConfirmacion` is mocked in this file (see the top of
      // it), so this does not exercise the real `MemoryStore` — that
      // atomicity is `loginLimiters.test.ts`'s job. What this mock models is
      // the *contract* `requireStepUp` has to honour: a synchronous counter,
      // with no `await` inside it, so whichever of the ten calls this
      // function first gets hit 1 and so on, with no interleaving possible in
      // between — which is exactly the guarantee the real
      // `MemoryStore.increment()` gives, and the read-then-charge version
      // never did. If `requireStepUp` itself raced past `cupo.permitido` —
      // reading it once and reusing it, say, or comparing before charging —
      // this would still go red even with a perfectly atomic counter behind
      // it.
      let hits = 0;
      consumirCupoDeConfirmacion.mockImplementation(async () => {
        hits += 1;
        return {
          permitido: hits <= PASSWORD_CONFIRM_LIMIT,
          restantes: Math.max(0, PASSWORD_CONFIRM_LIMIT - hits),
        };
      });
      verifyOwnPassword.mockResolvedValue({ ok: false });
      const gate = requireStepUp();

      const intentos = Array.from({ length: 10 }, () => {
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "mal" },
        );
        return gate(req, res, next);
      });
      await Promise.all(intentos);

      expect(verifyOwnPassword).toHaveBeenCalledTimes(PASSWORD_CONFIRM_LIMIT);
    });

    it("charges the budget before the password is looked at, and refuses for free once it was already spent", async () => {
      consumirCupoDeConfirmacion.mockResolvedValue({ permitido: false, restantes: 0 });
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(consumirCupoDeConfirmacion).toHaveBeenCalledWith(1);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      // Given back: this attempt never got to compare anything, so it must
      // not be the one left holding the charge that tipped the bucket over.
      expect(devolverCupoDeConfirmacion).toHaveBeenCalledWith(1);
      expect(next).not.toHaveBeenCalled();
      // The brief's own rule — every refusal writes one — includes this one.
      // Not through `denegar` (that would answer a second response on top of
      // the 429 above), but written all the same.
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "STEP_UP_DENIED", severity: "critical" }),
      );
    });

    it("fails closed when charging the budget itself errors, instead of comparing the password anyway", async () => {
      // A store that cannot even answer "was there room" is not a store this
      // gate can trust to have been enforcing anything.
      const fallo = new Error("el almacén del limitador no respondió");
      consumirCupoDeConfirmacion.mockRejectedValue(fallo);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalledWith(fallo);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      // Nothing was ever charged, so there is nothing to give back either.
      expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
    });

    it("fails closed when giving back an over-budget charge errors, instead of answering 429 as if it had been settled", async () => {
      const fallo = new Error("el almacén del limitador no respondió");
      consumirCupoDeConfirmacion.mockResolvedValue({ permitido: false, restantes: 0 });
      devolverCupoDeConfirmacion.mockRejectedValue(fallo);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalledWith(fallo);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      // Not the 429 this branch would otherwise answer with — the refund
      // itself failed, and that has to reach the error handler rather than
      // be swallowed under a response that claims the books balanced.
      expect(res.status).not.toHaveBeenCalled();
    });

    it("fails closed when giving back a correct password's charge errors, instead of letting the request through", async () => {
      // The refund the earlier, deferred-flag design could never do
      // synchronously: this one runs before `next()`, so a store that cannot
      // complete it must not be treated as "charge settled, request fine".
      const fallo = new Error("el almacén del limitador no respondió");
      verifyOwnPassword.mockResolvedValue({ ok: true });
      devolverCupoDeConfirmacion.mockRejectedValue(fallo);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(fallo);
      expect(res.status).not.toHaveBeenCalled();
    });

    it("fails closed when the comparison itself errors, giving back the charge instead of leaving it spent on nothing", async () => {
      // Ronda de arreglo 1: `verifyOwnPassword` (`auth/credentials.ts`) runs a
      // real `UsuarioModel.findByPk` and its own comparison, either of which
      // can reject on a database blip — and unlike the three store calls
      // around it, this one had no try/catch of its own, so the failure fell
      // through to the whole gate's outer catch-all, which answers a bare
      // 500 and never gives the charge back. That is exactly the third
      // outcome `cobrar()`'s own docstring named before this task removed
      // it: "a limiter call can fail in a way that is neither 'allowed' nor
      // 'the budget is spent'". Five database blips in a row would spend the
      // whole confirm budget — shared with "change my password" and
      // "register my email" — on nothing anybody typed.
      const fallo = new Error("la tabla de usuarios no respondió");
      verifyOwnPassword.mockRejectedValue(fallo);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      // The charge from `consumirCupoDeConfirmacion` (the default mock:
      // room, so the comparison was reached at all) must not be left on the
      // books for a comparison that never produced an answer.
      expect(devolverCupoDeConfirmacion).toHaveBeenCalledWith(1);
      expect(next).toHaveBeenCalledWith(fallo);
      // Not the outer catch-all's bare 500 — the error reaches `next` like
      // every other store failure in this branch, so the same error handler
      // deals with all of them the same way.
      expect(res.status).not.toHaveBeenCalled();
    });

    it("never touches the budget when a factor already exists", async () => {
      // Constraint: the password is only accepted while tieneAlgunFactor is
      // false, checked before the password is even looked at. The budget is
      // part of "looking at the password", so it must not be charged or
      // refunded either.
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null });
      await requireStepUp()(req, res, next);

      expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
    });

    it("never touches the budget for an onboarding session", async () => {
      const { req, res, next } = contexto(
        { id: 1, estado: "onboarding", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
    });

    it("never touches the budget when the window already satisfies the gate", async () => {
      // Same reason as "lets through a factor proved inside the window":
      // forcing a factor to exist matches the scenario this test is named
      // for — the window rule bypassing the budget for an account that
      // does have a factor, not a factor-less account whose own refusal
      // (since Task 3) also never touches it.
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto({
        id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES - 1),
      });
      await requireStepUp()(req, res, next);

      // Both assertions matter: the budget-untouched half is also true of
      // a refusal (tieneAlgunFactor's own branch never touches it either),
      // so without next() actually having been called this test cannot
      // tell "let through by the window" apart from "refused by the factor
      // check" — a fix-round review found exactly that gap.
      expect(next).toHaveBeenCalled();
      expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
    });

    it("charges the budget for a password that turns out right, and gives it straight back", async () => {
      // 🔴 Not "never charges" any more — that was the previous fix, and this
      // task's own docstring explains why it moved on: charging unconditionally
      // and refunding through the *deferred*, response-`finish`-time mechanism
      // `passwordConfirmLimiter` itself uses is what let a not-yet-refunded
      // charge inflate the count `chargeConfirmBudgetOnSelfChange`'s own,
      // separate charge on the same key read mid-request. This charge is
      // refunded synchronously, before `next()` is ever called, so nothing is
      // left outstanding for that second charge to read — see
      // requireStepUp.ts's own docstring for the full history.
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(consumirCupoDeConfirmacion).toHaveBeenCalledWith(1);
      expect(devolverCupoDeConfirmacion).toHaveBeenCalledWith(1);
      expect(next).toHaveBeenCalled();
    });

    /**
     * The account this branch used to let through for free. Task 3 of the
     * reauthentication-window plan (2026-09-08) removed that skip — `web/src`
     * has sent `stepup_password` since plan 4D, so there is no longer a
     * caller this gate cannot ask — and the tests below pin what replaced it:
     * a factor-less account is refused exactly like any other account with
     * nothing to show, never waved through on the cookie alone.
     */
    describe("an account with no factor and no password to prove it", () => {
      it("deniega a una cuenta sin factor que no manda contraseña, en cualquier ruta con puerta", async () => {
        // La rama del pase libre dejaba pasar esto con una línea STEP_UP_SKIPPED.
        // Ahora no hay nada que pasar: la contraseña es el método de esa cuenta.
        const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});
        await requireStepUp()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
        expect(cuerpo.code).toBe(CODIGO_STEP_UP);
        expect(cuerpo.motivo).toBe(MOTIVO_CONTRASENA_REQUERIDA);
        // 🔴 Sin `metodos`: el campo está documentado en `web/src/api/stepUp.ts`
        // como "Sólo en `sin-factor-reciente`" — un motivo distinto del que
        // contesta aquí, así que no hay nada que describiría.
        expect(cuerpo).not.toHaveProperty("metodos");
        // Ya no viaja `exigeContrasena` (decisión del 2026-10-10): ninguna ruta
        // pide la contraseña en cada petición, y el cliente trata la ausencia
        // del campo como `false`.
        expect(cuerpo).not.toHaveProperty("exigeContrasena");
        // Nada se comparó ni se cobró: la contraseña nunca llegó a mirarse.
        expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
        expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
        expect(verifyOwnPassword).not.toHaveBeenCalled();
      });

      it("treats an empty string the same as no password at all", async () => {
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "" },
        );
        await requireStepUp()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
        );
      });

      it("writes the refusal to the bitácora at warning severity, not critical", async () => {
        // Not critical: this is the opening move of an ordinary ceremony —
        // every factor-less account hits it on its first sensitive write —
        // see the same criterion in `registrar`'s own severity comment.
        const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});
        await requireStepUp()(req, res, next);

        expect(logAction).toHaveBeenCalledWith(
          expect.objectContaining({ action: "STEP_UP_DENIED", severity: "warning" }),
        );
      });

      it("still verifies, and still charges on a wrong guess, when a password is sent anyway", async () => {
        // The shape `web/src` actually sends since plan 4D — wrong, and
        // charged, unlike the missing-password refusal above.
        verifyOwnPassword.mockResolvedValue({ ok: false });
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "no-es-la-mia" },
        );
        await requireStepUp()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(consumirCupoDeConfirmacion).toHaveBeenCalledWith(1);
        // Wrong, so the charge stays on the books.
        expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
        // The discriminator a client acts on to know *which* remedy applies
        // — a client cannot tell "type the password again" apart from "go
        // finish onboarding" by `code` alone, since both answer the same
        // `CODIGO_STEP_UP`.
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ motivo: MOTIVO_CONTRASENA_INCORRECTA }),
        );
      });

      it("still lets a correct password through, refunding what it charged", async () => {
        verifyOwnPassword.mockResolvedValue({ ok: true });
        const { req, res, next } = contexto(
          { id: 1, estado: "completa", mfa_satisfied_at: null },
          { stepup_password: "la-de-verdad" },
        );
        await requireStepUp()(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(consumirCupoDeConfirmacion).toHaveBeenCalledWith(1);
        expect(devolverCupoDeConfirmacion).toHaveBeenCalledWith(1);
      });
    });
  });

  /**
   * Every gated route takes the ten-minute window — decision of 2026-10-10
   * (Isaias, "Todo, sin excepciones"). This block used to be `sinVentana`, the
   * option that made a route ignore a fresh window and demand the password on
   * every request; it is gone, and what is pinned here is what the routes that
   * carried it do now.
   *
   * Plan 4B seals `mfa_satisfied_at` when somebody spends a **recovery code**,
   * so a printed sheet alone now opens the window on routes that register or
   * remove a credential. That is the accepted cost the tests below name, not a
   * property the gate protects.
   */
  describe("the window on the routes that register a credential", () => {
    const cuentaSinFactor = { id: 1, estado: "completa" as const, mfa_satisfied_at: null };

    it("still demands the password of a factor-less account with nothing fresh, and announces no `exigeContrasena`", async () => {
      // If this goes red on `next()`, the gate started letting a factor-less
      // account through on the cookie alone; if it goes red on the field, the
      // wire kept a flag that no route can set to true any more.
      const { req, res, next } = contexto(cuentaSinFactor, {});
      await requireStepUp()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
      expect(cuerpo.code).toBe(CODIGO_STEP_UP);
      expect(cuerpo.motivo).toBe(MOTIVO_CONTRASENA_REQUERIDA);
      expect(cuerpo).not.toHaveProperty("exigeContrasena");
    });

    it("never puts `exigeContrasena` on the refusal for an account with a factor either, and keeps `metodos`", async () => {
      tieneAlgunFactor.mockResolvedValue(true);
      metodosDeReautenticacion.mockResolvedValue(["passkey", "totp"]);
      const { req, res, next } = contexto(cuentaSinFactor, {});
      await requireStepUp()(req, res, next);

      const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
      expect(cuerpo.motivo).toBe(MOTIVO_SIN_FACTOR_RECIENTE);
      expect(cuerpo.metodos).toEqual(["passkey", "totp"]);
      expect(cuerpo).not.toHaveProperty("exigeContrasena");
    });

    it("tells a missing password apart from a wrong one", async () => {
      // Two different sentences on screen — "type your password" and "that
      // password is wrong" — and a client can only pick between them by
      // `motivo`, since both answer the same `code`. Reusing
      // MOTIVO_CONTRASENA_INCORRECTA here would have the frontend accuse
      // somebody of mistyping a password they never typed.
      verifyOwnPassword.mockResolvedValue({ ok: false });
      const { req, res, next } = contexto(cuentaSinFactor, { stepup_password: "no-es-la-mia" });
      await requireStepUp()(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_CONTRASENA_INCORRECTA }),
      );
      expect(res.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
      );
    });

    it("treats an empty string as no password", async () => {
      const { req, res, next } = contexto(cuentaSinFactor, { stepup_password: "" });
      await requireStepUp()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
      );
    });

    it("charges nothing for a request that simply forgot the password", async () => {
      // Nothing was compared, so no bcrypt was spent and there is nothing to
      // charge. Charging here would let a buggy client — one that forgets the
      // field — spend somebody's whole confirm budget and lock them out of
      // the very screen that would fix it.
      const { req, res, next } = contexto(cuentaSinFactor, {});
      await requireStepUp()(req, res, next);

      expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("accepts the right password of a factor-less account, and seals the password window", async () => {
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const { req, res, next } = contexto(
        { ...cuentaSinFactor, id_sesion: "s1", password_confirmed_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(consumirCupoDeConfirmacion).toHaveBeenCalledWith(1);
      expect(devolverCupoDeConfirmacion).toHaveBeenCalledWith(1);
      // The next gated write of this session finds `password_confirmed_at`
      // fresh and asks for nothing: that is what the seal is for.
      expect(sellarContrasena).toHaveBeenCalledWith("s1");
    });

    it("refuses the wrong password, charges the bucket and seals nothing", async () => {
      verifyOwnPassword.mockResolvedValue({ ok: false });
      const { req, res, next } = contexto(cuentaSinFactor, { stepup_password: "no-es-la-mia" });
      await requireStepUp()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(consumirCupoDeConfirmacion).toHaveBeenCalledWith(1);
      expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(sellarContrasena).not.toHaveBeenCalled();
    });

    it("writes the refusal to the bitácora at warning severity", async () => {
      const { req, res, next } = contexto(cuentaSinFactor, {});
      await requireStepUp()(req, res, next);

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "STEP_UP_DENIED", severity: "warning" }),
      );
    });

    it("changes nothing for an account that already has a factor: no password is looked at", async () => {
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto(cuentaSinFactor, { stepup_password: "la-de-verdad" });
      await requireStepUp()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
      );
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("lets a session that just proved its factor straight through, with no password asked", async () => {
      // The case `sinVentana` used to refuse. Plan 4B seals `mfa_satisfied_at`
      // when somebody spends a **recovery code**, so whoever holds only the
      // printed sheet spends one code, lands inside the ten-minute window and
      // registers a factor with no password at all. That is the cost Isaias
      // accepted on 2026-10-10; this test is where it is written down, so a
      // later change of mind has to edit it on purpose.
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(1) },
        {},
      );
      await requireStepUp({ permiteOnboarding: true })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
    });

    it("lets a fresh factor proof through without spending the password budget, even when a password comes along", async () => {
      // Used to be "accepts a fresh factor proof together with the password",
      // the second half of a two-step ceremony. There is no second half: the
      // password is not compared, not charged and not refunded, and it leaves
      // the body.
      tieneAlgunFactor.mockResolvedValue(true);
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const body: Record<string, unknown> = { stepup_password: "la-de-verdad" };
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(1) },
        body,
      );
      await requireStepUp()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(devolverCupoDeConfirmacion).not.toHaveBeenCalled();
      expect(body).not.toHaveProperty("stepup_password");
    });

    it("still asks a stale account to prove its factor first, before any password", async () => {
      // Order matters and this pins it: with a factor and nothing fresh to
      // show, the answer is "prove the factor", not "type your password".
      // Otherwise these routes would quietly become password-only ones.
      tieneAlgunFactor.mockResolvedValue(true);
      const { req, res, next } = contexto(
        { id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES + 1) },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
      );
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("still refuses an onboarding session, which the window does not touch", async () => {
      // `permiteOnboarding` says *which states* reach the gate, not what proof
      // they owe: a route that leaves it off refuses `onboarding` whatever the
      // password.
      const { req, res, next } = contexto(
        { id: 1, estado: "onboarding", mfa_satisfied_at: null },
        { stepup_password: "la-de-verdad" },
      );
      await requireStepUp()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }),
      );
    });
  });

  /**
   * `toleraFactorIlegible` — the account HAS a factor, this server cannot read
   * it, and the route (only `DELETE /auth/totp`) falls through to the password.
   * In that fall-through `tieneFactor` is true, so the password window must be
   * neither consulted nor sealed: during a keyring outage that route costs the
   * password on every request unless a *factor* window is already fresh.
   */
  describe("toleraFactorIlegible: the password fall-through for a factor this server cannot read", () => {
    const cuentaConFactorIlegible = (extra: Record<string, unknown> = {}) => ({
      id: 1,
      id_sesion: "s1",
      estado: "completa" as const,
      mfa_satisfied_at: null,
      password_confirmed_at: null,
      ...extra,
    });

    beforeEach(() => {
      tieneAlgunFactor.mockResolvedValue(true);
      hayFactorVerificable.mockResolvedValue(false);
    });

    it("takes the password when the only factor is unreadable, and writes the bitácora line", async () => {
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const { req, res, next } = contexto(cuentaConFactorIlegible(), { stepup_password: "la-de-verdad" });
      await requireStepUp({ toleraFactorIlegible: true })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "STEP_UP_FACTOR_ILEGIBLE" }),
      );
    });

    it("does not seal a password window for it: the account has a factor", async () => {
      verifyOwnPassword.mockResolvedValue({ ok: true });
      const { req, res, next } = contexto(cuentaConFactorIlegible(), { stepup_password: "la-de-verdad" });
      await requireStepUp({ toleraFactorIlegible: true })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(sellarContrasena).not.toHaveBeenCalled();
    });

    it("does not consult a fresh password window: it costs the password every time", async () => {
      // A `password_confirmed_at` of one minute ago would let a factor-less
      // account straight through. This account has a factor, so the window is
      // not read: no password in the body means a refusal, not a pass.
      const { req, res, next } = contexto(cuentaConFactorIlegible({ password_confirmed_at: haceMinutos(1) }), {});
      await requireStepUp({ toleraFactorIlegible: true })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
      );
    });

    it("passes on a fresh factor window without asking anything, like every other route", async () => {
      const { req, res, next } = contexto(cuentaConFactorIlegible({ mfa_satisfied_at: haceMinutos(1) }), {});
      await requireStepUp({ toleraFactorIlegible: true })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(hayFactorVerificable).not.toHaveBeenCalled();
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("refuses with the factor ceremony when a factor IS readable, option or not", async () => {
      hayFactorVerificable.mockResolvedValue(true);
      const { req, res, next } = contexto(cuentaConFactorIlegible(), { stepup_password: "la-de-verdad" });
      await requireStepUp({ toleraFactorIlegible: true })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
      );
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("can be mounted without any other option: it no longer demands `sinVentana`", () => {
      expect(() => requireStepUp({ toleraFactorIlegible: true })).not.toThrow();
    });
  });
});

// 🔴 Bloque de primer nivel, y la indentación lo dice ahora. Estaba escrito con
// dos espacios, como si viviera dentro de `describe("requireStepUp")`, que
// cierra más arriba. Hoy da igual porque el `beforeEach` que resetea los mocks
// es de fichero — pero es exactamente la forma en que un bloque de tests deja
// de recibir sus hooks el día que alguien mueva ese `beforeEach` dentro del
// describe padre, y entonces pasan por un motivo que nadie eligió.
describe("what the refusal tells the client (plan 4D, tarea 2)", () => {
  const cuentaSinFactor = { id: 1, estado: "completa" as const, mfa_satisfied_at: null };
  const cuentaConFactor = { id: 1, estado: "completa" as const, mfa_satisfied_at: null };

  // ── exigeContrasena is gone from the wire ─────────────────────────────

  it("does not announce `exigeContrasena` on the refusal, for any account", async () => {
    // Until 2026-10-10 this refusal said `exigeContrasena: true` on the routes
    // that wanted the password on top of the factor, so one window could ask
    // for both. No route does that any more. The web client treats an absent
    // field as false, and the two repos deploy together.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto(cuentaConFactor, {});
    await requireStepUp()(req, res, next);

    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo.motivo).toBe(MOTIVO_SIN_FACTOR_RECIENTE);
    expect(cuerpo).not.toHaveProperty("exigeContrasena");
  });

  it("never lets the extra fields overwrite the three the contract is built on", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto(cuentaConFactor, {});
    await requireStepUp()(req, res, next);

    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo.code).toBe(CODIGO_STEP_UP);
    expect(cuerpo.motivo).toBe(MOTIVO_SIN_FACTOR_RECIENTE);
    expect(typeof cuerpo.message).toBe("string");
  });

  // ── intentosRestantes, so nobody walks into a lockout blind ────────────

  it("counts down the guesses left after a wrong password", async () => {
    // Imported rather than retyped: a test that hard-codes 5 keeps passing
    // after somebody changes the constant, while the countdown on screen has
    // silently started lying.
    const { PASSWORD_CONFIRM_LIMIT } = await import("../config/security.js");
    // The budget is shared with "change my password" and "register my
    // email" — the two screens somebody would go to next. Spending it
    // without ever being told is how a person ends up locked out of the
    // very screen that would fix their problem.
    //
    // The count itself — the arithmetic that turns "one hit charged" into
    // "four left" — now lives in `consumirCupoDeConfirmacion`
    // (`loginLimiters.ts`), which is mocked in this file; that arithmetic has
    // its own tests there. What this test pins is that `denegar` relays
    // `cupo.restantes` untouched, rather than recomputing it or dropping it.
    consumirCupoDeConfirmacion.mockResolvedValue({ permitido: true, restantes: PASSWORD_CONFIRM_LIMIT - 1 });
    verifyOwnPassword.mockResolvedValue({ ok: false });
    const { req, res, next } = contexto(cuentaSinFactor, { stepup_password: "no-es-la-mia" });
    await requireStepUp()(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        motivo: MOTIVO_CONTRASENA_INCORRECTA,
        intentosRestantes: PASSWORD_CONFIRM_LIMIT - 1,
      }),
    );
  });

  it("relays a `restantes` of zero rather than substituting anything for it", async () => {
    // 🔴 The edge this used to pin directly (`Math.max` clamping a negative
    // count to zero) now lives inside `consumirCupoDeConfirmacion` itself —
    // see `loginLimiters.test.ts` for that arithmetic. What is still this
    // gate's own job is not silently turning a legitimate zero into
    // `undefined` or dropping the field.
    consumirCupoDeConfirmacion.mockResolvedValue({ permitido: true, restantes: 0 });
    verifyOwnPassword.mockResolvedValue({ ok: false });
    const { req, res, next } = contexto(cuentaSinFactor, { stepup_password: "no-es-la-mia" });
    await requireStepUp()(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ intentosRestantes: 0 }),
    );
  });

  it("files the routine refusals as warnings and the alarming ones as critical", async () => {
    // 🔴 If everything is critical, nothing is. `sin-factor-reciente` and
    // `contraseña-requerida` are the *opening move* of an ordinary
    // ceremony — with the 4D interceptor they happen on every protected
    // operation, twice on the routes that want both proofs. A wrong
    // password from inside a live session is a different animal: that is
    // the shape of a stolen cookie being tested.
    tieneAlgunFactor.mockResolvedValue(true);
    const rutinario = contexto(cuentaConFactor, {});
    await requireStepUp()(rutinario.req, rutinario.res, rutinario.next);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_DENIED", severity: "warning" }),
    );

    logAction.mockReset();
    tieneAlgunFactor.mockResolvedValue(false);
    verifyOwnPassword.mockResolvedValue({ ok: false });
    const alarmante = contexto(cuentaSinFactor, { stepup_password: "no-es-la-mia" });
    await requireStepUp()(alarmante.req, alarmante.res, alarmante.next);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_DENIED", severity: "critical" }),
    );
  });

  it("keeps estado-incompleto critical: it is the refusal that closed a real attack", async () => {
    const { req, res, next } = contexto({ id: 1, estado: "onboarding", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_ESTADO_INCOMPLETO }),
    );
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STEP_UP_DENIED", severity: "critical" }),
    );
  });

  it("no deja la contraseña en el cuerpo que llega al controlador", async () => {
    // 🔴 `rol.controller.ts` escribe `after: req.body` **entero** en la
    // bitácora al editar un rol. Sin borrarla aquí, una petición que llegue
    // allí con la contraseña dentro la deja guardada en claro en la tabla de
    // auditoría, que además se pinta en una pantalla.
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(cuentaSinFactor, {
      nombre: "algo",
      stepup_password: "la-mia",
    });

    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    const cuerpo = (req as unknown as { body: Record<string, unknown> }).body;
    expect(cuerpo).not.toHaveProperty("stepup_password");
    // Y lo demás sigue ahí: la puerta consume su campo, no vacía la petición.
    expect(cuerpo.nombre).toBe("algo");
  });

  it("says nothing about guesses when the password was never compared", async () => {
    // A missing password costs nothing and is charged nothing — see the
    // branch's own comment. Reporting a countdown here would tell somebody
    // they had spent a guess they never spent.
    const { req, res, next } = contexto(cuentaSinFactor, {});
    await requireStepUp()(req, res, next);

    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo.motivo).toBe(MOTIVO_CONTRASENA_REQUERIDA);
    expect(cuerpo).not.toHaveProperty("intentosRestantes");
  });
});

/**
 * Tarea 8 del plan 4C. Hasta aquí el 403 decía *que* faltaba probar un factor
 * y no *cuál*, porque sólo había uno que probar. Con las passkeys hay dos y no
 * se parecen en nada en pantalla.
 */
describe("requireStepUp — el 403 dice qué puede cubrirlo", () => {
  const caducada = () => ({
    id: 1,
    estado: "completa" as const,
    mfa_satisfied_at: haceMinutos(STEP_UP_WINDOW_MINUTES + 1),
  });

  it("names what the account can offer, in the order the server chose", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    metodosDeReautenticacion.mockResolvedValue(["passkey", "codigo"]);
    const { req, res, next } = contexto(caducada());
    await requireStepUp()(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        motivo: MOTIVO_SIN_FACTOR_RECIENTE,
        metodos: ["passkey", "codigo"],
      }),
    );
  });

  // 🔴 The account this whole task exists for. Sent `["totp"]` by mistake, the
  // window draws a six-digit field for somebody who has no way to produce
  // one, and five attempts at it lock the account behind this same gate.
  it("asks the inventory rather than assuming a six-digit code", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    metodosDeReautenticacion.mockResolvedValue(["passkey"]);
    const { req, res, next } = contexto(caducada());
    await requireStepUp()(req, res, next);

    expect(metodosDeReautenticacion).toHaveBeenCalledWith(1);
    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo.metodos).toEqual(["passkey"]);
  });

  // `metodos` is the one extra field this refusal carries now that
  // `exigeContrasena` is gone, and it must still travel with the motivo.
  it("travels beside `motivo`, and nothing else rides with it", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    metodosDeReautenticacion.mockResolvedValue(["passkey", "totp"]);
    const { req, res, next } = contexto(caducada(), {});
    await requireStepUp()(req, res, next);

    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(cuerpo).sort()).toEqual(["code", "message", "metodos", "motivo"]);
    expect(cuerpo.metodos).toEqual(["passkey", "totp"]);
  });

  // The refusal that means "you have nothing to prove, type your password".
  // A list there would be empty by construction and would only invite a
  // client to branch on it.
  it("is absent from a `contraseña-requerida` refusal", async () => {
    tieneAlgunFactor.mockResolvedValue(false);
    const { req, res, next } = contexto({ id: 1, estado: "completa", mfa_satisfied_at: null }, {});
    await requireStepUp()(req, res, next);

    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo.motivo).toBe(MOTIVO_CONTRASENA_REQUERIDA);
    expect(cuerpo).not.toHaveProperty("metodos");
    expect(metodosDeReautenticacion).not.toHaveBeenCalled();
  });

  // `estado-incompleto` is refused before any factor question is asked, and
  // costs no query at all. Naming what the account holds there would answer a
  // caller who is barred from the route for a different reason entirely.
  it("is absent from an `estado-incompleto` refusal, and costs no query", async () => {
    const { req, res, next } = contexto({ id: 1, estado: "onboarding", mfa_satisfied_at: null });
    await requireStepUp()(req, res, next);

    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo.motivo).toBe(MOTIVO_ESTADO_INCOMPLETO);
    expect(cuerpo).not.toHaveProperty("metodos");
    expect(metodosDeReautenticacion).not.toHaveBeenCalled();
  });

  // 🔴 An account that has a factor — so the gate must refuse — and no way to
  // prove it: a confirmed TOTP secret this server cannot decrypt, no passkey,
  // no unspent codes. The empty list has to travel as `[]` and not be omitted,
  // because omitted means "this server is too old to say" and the window
  // answers that by drawing the usual form. Here the usual form is a dead end.
  it("sends an empty list rather than omitting the field when nothing can be proved", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    metodosDeReautenticacion.mockResolvedValue([]);
    const { req, res, next } = contexto(caducada());
    await requireStepUp()(req, res, next);

    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo).toHaveProperty("metodos");
    expect(cuerpo.metodos).toEqual([]);
  });

  // 🔴 Three COUNTs is three more ways a dropped connection turns a
  // well-formed refusal into a 500 — and the client's interceptor only opens
  // the window on a 403 carrying `code`, so a 500 here does not degrade the
  // ceremony, it removes it. Omitting the field already means "this server
  // cannot say", which is exactly true when the query failed.
  it("still refuses properly, without the list, when the inventory query fails", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    metodosDeReautenticacion.mockRejectedValue(new Error("la base de datos dijo que no"));
    const { req, res, next } = contexto(caducada());
    await requireStepUp()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const cuerpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo.code).toBe(CODIGO_STEP_UP);
    expect(cuerpo.motivo).toBe(MOTIVO_SIN_FACTOR_RECIENTE);
    expect(cuerpo).not.toHaveProperty("metodos");
    expect(next).not.toHaveBeenCalled();
  });

  // The extra COUNTs are bought on the refusal and nowhere else. A session
  // inside its window is the hot path of every gated write in the ERP.
  it("costs nothing on a session that is let through", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto({
      id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(1),
    });
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(metodosDeReautenticacion).not.toHaveBeenCalled();
  });
});

/**
 * Tarea 10 del plan 4C — dos cosas que la puerta no hacía.
 */
describe("requireStepUp — what leaves with the request", () => {
  // 🔴 The fresh-window shortcut let the field through untouched. The client
  // injects the same password into every request sharing a ceremony, and
  // `rol.controller.ts` writes `req.body` whole into the bitácora: an
  // administrator's plaintext password on a screen, one pair of tabs away.
  it("drops stepup_password from the body on the fresh-window path", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const body: Record<string, unknown> = { name: "x", stepup_password: "la-de-verdad" };
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(1) },
      body,
    );
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(body).not.toHaveProperty("stepup_password");
    expect(body.name).toBe("x");
  });

  // Built by hand and not through `contexto`, whose `body` parameter has a
  // `{}` default: passing `undefined` there hands the gate an empty object,
  // and this test passed with the guard deleted. A body-less DELETE arrives
  // with `req.body` genuinely undefined, and that is what has to survive.
  it("survives a body-less request on that same path", async () => {
    tieneAlgunFactor.mockResolvedValue(true);
    const req = {
      user: { id: 1, estado: "completa", mfa_satisfied_at: haceMinutos(1) },
      body: undefined,
      ip: "::1",
      originalUrl: "/api/rol/1",
    } as never;
    const r = { status: vi.fn().mockReturnThis(), json: vi.fn(), locals: {} };
    const res = r as unknown as Response & typeof r;
    const next = vi.fn();
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // 🔴 Found while rewriting the password branch for Task 3 of the
  // reauthentication-window plan: the budget-exhausted 429 answered without
  // calling `soltarContrasena`, the one exit out of this gate that did not
  // — see `soltarContrasena`'s own docstring, "the password leaves the body
  // on every path out of this gate".
  it("drops stepup_password from the body on the budget-exhausted 429 too", async () => {
    consumirCupoDeConfirmacion.mockResolvedValue({ permitido: false, restantes: 0 });
    const body: Record<string, unknown> = { stepup_password: "la-de-verdad" };
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      body,
    );
    await requireStepUp()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty("stepup_password");
  });
});

describe("requireStepUp — what it says about itself", () => {
  // What `routeGuards.test.ts` reads to tell one mount from another. The
  // resolved pair, defaults filled in, so a table can compare whole objects.
  it("stamps its resolved options on the gate it returns", () => {
    expect((requireStepUp() as unknown as { opciones: unknown }).opciones).toEqual({
      permiteOnboarding: false, toleraFactorIlegible: false,
    });
    expect(
      (requireStepUp({ permiteOnboarding: true }) as unknown as { opciones: unknown }).opciones,
    ).toEqual({ permiteOnboarding: true, toleraFactorIlegible: false });
  });

  it("keeps the name Express mounts, which is what the walker finds it by", () => {
    expect(requireStepUp().name).toBe("stepUpGate");
  });

  // The property cannot be reassigned, but the object behind it could be
  // edited in place — and a table that compares whole objects would then read
  // a lie that nothing in the closure shares.
  it("hands out options nobody can edit in place", () => {
    const opciones = (requireStepUp() as unknown as { opciones: object }).opciones;
    expect(Object.isFrozen(opciones)).toBe(true);
  });
});

describe("requireStepUp — the password leaves on the error paths too", () => {
  // The rule is "every way out drops it", and `next(err)` is a way out. The
  // error handler does not log the body today; the next Sentry hook would.
  it("drops stepup_password before handing a limiter failure to next(err)", async () => {
    consumirCupoDeConfirmacion.mockRejectedValue(new Error("el almacén dijo que no"));
    const body: Record<string, unknown> = { stepup_password: "la-de-verdad" };
    const { req, res, next } = contexto(
      { id: 1, estado: "completa", mfa_satisfied_at: null },
      body,
    );
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(body).not.toHaveProperty("stepup_password");
  });
});

/**
 * La ventana de diez minutos de una cuenta sin ningún factor — Tarea 5 del
 * plan de reautenticación (2026-09-08).
 *
 * Aquí se prueban las **decisiones** de la puerta. Que la fecha llegue de
 * verdad desde la fila de `sesiones` hasta `req.user`, atravesando el modelo,
 * `findLiveSession` y `authenticate`, es lo que mide `app.auth.test.ts` por la
 * app montada: nada de este fichero lo vería, porque aquí `req.user` se
 * construye a mano.
 */
describe("requireStepUp — la ventana que abre una contraseña correcta", () => {
  const haceMinutosLaContrasena = (m: number) => ({
    id: 1,
    estado: "completa" as const,
    id_sesion: "s1",
    mfa_satisfied_at: null,
    password_confirmed_at: haceMinutos(m),
  });

  it("deja pasar sin contraseña dentro de los diez minutos", async () => {
    const { req, res, next } = contexto(haceMinutosLaContrasena(STEP_UP_WINDOW_MINUTES - 1));
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    // Sin cobrar nada: no se comparó ninguna contraseña.
    expect(consumirCupoDeConfirmacion).not.toHaveBeenCalled();
  });

  it("vuelve a pedirla un minuto fuera de la ventana", async () => {
    const { req, res, next } = contexto(haceMinutosLaContrasena(STEP_UP_WINDOW_MINUTES + 1));
    await requireStepUp()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_CONTRASENA_REQUERIDA }),
    );
  });

  it("no acepta un sello en el futuro", async () => {
    // La misma cota inferior que `mfa_satisfied_at`, y por el mismo motivo:
    // un reloj corregido hacia atrás dejaría la puerta abierta hasta que el
    // reloj real alcanzase la fecha. Cinco minutos por delante, dentro del
    // ancho de la ventana a propósito: una cota escrita `>= -VENTANA` en vez
    // de `>= 0` pasaría este test.
    const { req, res, next } = contexto(haceMinutosLaContrasena(-5));
    await requireStepUp()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("no consulta la ventana de una cuenta que tiene un factor", async () => {
    // 🔴 El hallazgo de la auditoría, escrito como test. Si esta columna
    // entrase en `satisfecho` — treinta líneas antes de la comprobación de
    // factor — una cuenta CON factor pasaría por aquí con la ventana abierta
    // y sin probar nada. La cuenta de este test tiene factor y una ventana de
    // contraseña recién sellada: lo que tiene que recibir es el 403 que le
    // pide el factor.
    tieneAlgunFactor.mockResolvedValue(true);
    const { req, res, next } = contexto(haceMinutosLaContrasena(1));
    await requireStepUp()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ motivo: MOTIVO_SIN_FACTOR_RECIENTE }),
    );
  });

  it("sella la sesión cuando acepta la contraseña de una cuenta sin factor", async () => {
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, id_sesion: "s1", estado: "completa", mfa_satisfied_at: null, password_confirmed_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    // Con el id de la sesión del propio `req.user`, nunca con nada del cuerpo.
    expect(sellarContrasena).toHaveBeenCalledWith("s1");
  });

  it("no sella cuando la contraseña era incorrecta", async () => {
    verifyOwnPassword.mockResolvedValue({ ok: false });
    const { req, res, next } = contexto(
      { id: 1, id_sesion: "s1", estado: "completa", mfa_satisfied_at: null, password_confirmed_at: null },
      { stepup_password: "no-es-la-mia" },
    );
    await requireStepUp()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(sellarContrasena).not.toHaveBeenCalled();
  });

  it("ni compara ni sella la contraseña de una cuenta que ya probó su factor", async () => {
    // 🔴 El otro lado del mismo hallazgo. Una cuenta que acaba de probar su
    // factor pasa por `satisfecho` antes de que nadie mire la contraseña, y
    // `tieneAlgunFactor` ni siquiera se pregunta. Sellar una ventana de
    // contraseña a nombre de una cuenta CON factor es exactamente el estado
    // desde el que se podría sostener indefinidamente el alta y la baja de
    // credenciales con la contraseña sola (§5 del diseño).
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      {
        id: 1,
        id_sesion: "s1",
        estado: "completa",
        mfa_satisfied_at: haceMinutos(1),
        password_confirmed_at: null,
      },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(verifyOwnPassword).not.toHaveBeenCalled();
    expect(sellarContrasena).not.toHaveBeenCalled();
  });

  it("espera al sellado antes de llamar a next()", async () => {
    // 🔴 Con `void` en vez de `await`, `next()` corre antes de que el UPDATE
    // haya llegado a la base de datos, y la siguiente petición de la ventana
    // —que el interceptor manda en cuanto vuelve ésta— lee una fila todavía
    // sin sellar y contesta 403. Se mide como un orden de sucesos, que es lo
    // único que distingue las dos versiones: las dos acaban sellando.
    const orden: string[] = [];
    sellarContrasena.mockImplementation(async () => {
      orden.push("sellado empieza");
      await new Promise((listo) => setTimeout(listo, 0));
      orden.push("sellado termina");
      return true;
    });
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, id_sesion: "s1", estado: "completa", mfa_satisfied_at: null, password_confirmed_at: null },
      { stepup_password: "la-de-verdad" },
    );
    next.mockImplementation(() => orden.push("next"));

    await requireStepUp()(req, res, next);

    expect(orden).toEqual(["sellado empieza", "sellado termina", "next"]);
  });

  it("deja pasar la operación aunque el sellado falle, en vez de tumbarla con un 500", async () => {
    // 🔴 La decisión de Isaias, y el razonamiento importa más que el test:
    // quien llega aquí acaba de demostrar su identidad correctamente. Un 500
    // por una escritura **de comodidad** le cobra a esa persona un problema de
    // nuestra infraestructura, y encima sin explicárselo. Registrar y seguir
    // degrada a «la siguiente operación vuelve a pedir la contraseña», que es
    // exactamente el comportamiento anterior a esta tarea: un estado ya
    // conocido y ya seguro.
    sellarContrasena.mockRejectedValue(new Error("la base de datos dijo que no"));
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, id_sesion: "s1", estado: "completa", mfa_satisfied_at: null, password_confirmed_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("y lo deja anotado como warning, no como incidente", async () => {
    // `warning` y no `error`: no ha fallado ninguna comprobación de seguridad,
    // sólo se ha perdido una comodidad. Lleva la sesión dentro porque lo que
    // un operador querría contar, si esto empieza a pasar seguido, es a cuánta
    // gente se le está pidiendo la contraseña de más.
    sellarContrasena.mockRejectedValue(new Error("la base de datos dijo que no"));
    verifyOwnPassword.mockResolvedValue({ ok: true });
    const { req, res, next } = contexto(
      { id: 1, id_sesion: "s1", estado: "completa", mfa_satisfied_at: null, password_confirmed_at: null },
      { stepup_password: "la-de-verdad" },
    );
    await requireStepUp()(req, res, next);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        id_usuario: 1,
        metadata: expect.objectContaining({ id_sesion: "s1" }),
      }),
    );
  });

  it("suelta la contraseña del cuerpo también al salir por la ventana", async () => {
    // Una petición puede llevar el campo en una ruta que no lo pidió: el
    // interceptor inyecta la misma contraseña en todos los cuerpos que
    // reencola tras una ceremonia. `rol.controller.ts` escribe `req.body`
    // entero en la bitácora.
    const body: Record<string, unknown> = { stepup_password: "la-de-verdad" };
    const { req, res, next } = contexto(haceMinutosLaContrasena(1), body);
    await requireStepUp()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(body).not.toHaveProperty("stepup_password");
  });
});
