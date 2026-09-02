// The TOTP registration router: `setup`, `confirm`, `delete`.
// `docs/plans/2026-09-01-factores-mfa.md` Tasks 6 and 8.
//
// **Not mounted anywhere yet.** Per the plan's "Un fichero de rutas por
// tarea" section, every 4B task that adds routes builds its own router and
// nobody touches `app.ts` — the final mount happens once, in one pass, when
// every 4B router exists, which is also the only moment `routeGuards.test.ts`
// can be checked against what is actually wired up. This module exports a
// `Router` meant to be mounted at `/api/auth/totp`, matching
// `auth/sessionState.ts`'s `ONBOARDING_EXTRA` entry of the same name and the
// plan's own interface line ("Produces: POST /api/auth/totp/setup and POST
// /api/auth/totp/confirm").
//
// **The availability gate runs before `authenticate`, on `/setup` and
// `/confirm` only — not on `DELETE`, hallazgo F6/B-5/E-5.** Decision 2 of the
// plan: a bad `MFA_ENCRYPTION_KEY_ACTIVE` must not take down the rest of the
// ERP, only the two routes that actually need to decrypt or encrypt the
// stored secret. `DELETE` never touches it — `deleteTotp` destroys the row by
// `id_usuario`, the same way the rescue console does, without decrypting
// anything — so mounting the gate ahead of it too (the original shape, a
// single `router.use` covering all three) meant a wrong key locked people
// into a dead TOTP factor they could never remove: every verify failed,
// every login burned a recovery code, and the one operation that would have
// let them register a working factor answered 503. Nothing about *who* is
// asking changes the 503 either, so there is no reason to spend a session
// lookup finding out first on the two routes that do carry it.
//
// 🔴 **`exigeContrasena: true` on all three routes — hallazgo C1.** Without
// it, a stolen session cookie with no password registers its own factor, and
// from that instant `tieneAlgunFactor` denies the real owner the password
// fallback too: their next login opens `parcial`, escapable only by proving
// the *attacker's* factor. Changing the password does not help and
// `logout-all` revokes sessions, not credentials — a permanent lockout. See
// `requireStepUp.ts`'s own docstring on `exigeContrasena` for the mechanism.
//
// 🔴 **`permiteOnboarding: true` on all three routes, `DELETE` included —
// hallazgo F6/E-5.** `requireStepUp.ts`'s own docstring on `permiteOnboarding`
// names this by name: "Plan 4B will need the same option on the registration
// routes for the same reason" `/email/send` does. Without it, `requireStepUp`'s
// *own* state check (independent of, and in addition to, the `onboarding`
// allowlist `auth/sessionState.ts` already opens for `/api/auth/totp`) would
// refuse every `onboarding` session outright — and `onboarding` is exactly
// the state an account that has never registered anything sits in from day
// `MFA_GRACE_DAYS` onward. Sealing registration away from that state would
// mean nobody who ever reaches `onboarding` could register the one thing
// that gets them out of it (Decision 8, hallazgo D2 and A11).
//
// `DELETE` used to leave this off, on the reasoning that an `onboarding`
// account has no *confirmed* factor, so there is nothing behind this route
// for that state to reach for. True about the data, wrong about what the
// caller sees: leaving it off meant the state check itself refused first,
// with "Termina de configurar tu segundo factor antes de realizar esta
// operación" — on the very screen that button lives on, directly under
// "Añadir", which is deliberately the first control on that form (hallazgo
// A5). Turning it on lets that same `onboarding` account reach the
// controller, which already answers correctly: 404 "no tienes ningún factor
// de autenticación registrado", which the client already renders as a plain
// `toast.info`. `parcial` is still refused either way — the option names one
// state and reads it, never "anything short of completa".
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireStepUp } from "../middleware/requireStepUp.js";
import { totpEstaDisponible } from "../auth/mfaKeyCheck.js";
import { setupTotp, confirmTotp, deleteTotp } from "../controllers/totp.controller.js";

export const MENSAJE_TOTP_NO_DISPONIBLE =
  "El registro de factores de autenticación no está disponible en este momento. " +
  "Vuelve a intentarlo más tarde.";

/**
 * Decision 2's switch, read once per request rather than once at boot: the
 * check itself (`comprobarLlaveAlArrancar`) only ever runs from
 * `src/index.ts`, and `totpEstaDisponible()` is the cheap module-level flag
 * it leaves behind. Exported so `totp.routes.test.ts` can pull this exact
 * function out of the router's own stack and prove it is really mounted,
 * rather than trusting a description of where it sits.
 */
export function requireTotpKeyAvailable(req: Request, res: Response, next: NextFunction): void {
  if (!totpEstaDisponible()) {
    res.status(503).json({ message: MENSAJE_TOTP_NO_DISPONIBLE });
    return;
  }
  next();
}

const router = Router();

router.post(
  "/setup",
  requireTotpKeyAvailable,
  authenticate,
  requireStepUp({ permiteOnboarding: true, exigeContrasena: true }),
  setupTotp,
);
router.post(
  "/confirm",
  requireTotpKeyAvailable,
  authenticate,
  requireStepUp({ permiteOnboarding: true, exigeContrasena: true }),
  confirmTotp,
);
// No `requireTotpKeyAvailable` here — see the module header, hallazgo F6.
router.delete(
  "/",
  authenticate,
  requireStepUp({ permiteOnboarding: true, exigeContrasena: true }),
  deleteTotp,
);

export default router;
