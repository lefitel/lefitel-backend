// The TOTP registration router: `setup`, `confirm`, `delete`.
// `docs/plans/2026-09-01-factores-mfa.md` Tasks 6 and 8.
//
// **Mounted at `/api/auth/totp` in `app.ts`, and the path is a contract.** It
// has to match `auth/sessionState.ts`'s `ONBOARDING_EXTRA` entry of the same
// name: mounted anywhere else, an `onboarding` session never reaches the one
// screen that gets it out of `onboarding`, and nothing fails loudly — see
// `webauthn.routes.ts`, which carries the same warning at length.
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
// 🔴 **All three routes take the ten-minute window — hallazgo C1, reopened by
// the decision of 2026-10-10 (Isaias, risks put to him twice).** Hallazgo C1
// was that a stolen session cookie that waits for the owner to open a window
// registers its own factor inside it, and from that instant `tieneAlgunFactor`
// denies the real owner the password fallback too (since plan 4E a verified
// address does the same, which is why `/email/send` is in the same position):
// their next login opens `parcial`, escapable only by proving the *attacker's*
// factor. Changing the password does not help and `logout-all` revokes
// sessions, not credentials — a permanent lockout. These routes used to close
// that by asking for the password on every request (`sinVentana`). They no
// longer do: inside the window a hijacked session can register its own
// credential and delete the owner's. Accepted cost, not a property that holds.
//
// 🔴 **`permiteOnboarding: true` on all three routes, `DELETE` included —
// hallazgo F6/E-5.** `requireStepUp.ts`'s own docstring on `permiteOnboarding`
// makes the same argument for the registration routes that it makes for
// `/email/send`. Without it, `requireStepUp`'s
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
  requireStepUp({ permiteOnboarding: true }),
  setupTotp,
);
router.post(
  "/confirm",
  requireTotpKeyAvailable,
  authenticate,
  requireStepUp({ permiteOnboarding: true }),
  confirmTotp,
);
// No `requireTotpKeyAvailable` here — see the module header, hallazgo F6.
// 🔴 `toleraFactorIlegible` — and it belongs on this route and no other.
// Without it the exemption above is undone by the gate right below it: this
// DELETE stays reachable when the keyring cannot read the secret, and then
// `requireStepUp` asks for a code produced from that same unreadable secret.
// The escape hatch and the door in front of it disagreed. What replaces the
// impossible code is the password, asked on every request while the key is
// broken (that fall-through never opens a password window for an account that
// has a factor), unless a factor window is already fresh. See the option's own
// comment.
router.delete(
  "/",
  authenticate,
  requireStepUp({ permiteOnboarding: true, toleraFactorIlegible: true }),
  deleteTotp,
);

export default router;
