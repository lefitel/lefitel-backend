// Recovery-code router: generating/regenerating the ten, and counting how
// many are unspent. `docs/plans/2026-09-01-factores-mfa.md` Task 10.
//
// **Not mounted anywhere yet.** Per the plan's "Un fichero de rutas por
// tarea" section, every 4B task that adds routes builds its own router and
// nobody touches `app.ts` — the final mount happens once, in one pass, when
// every 4B router exists. This module exports a `Router` meant to be mounted
// at `/api/auth/recovery-codes`, matching `auth/sessionState.ts`'s
// `ONBOARDING_EXTRA` entry of the same name.
//
// 🔴 **`POST /` carries `requireStepUp({ exigeContrasena: true })` — hallazgo
// C14.** §5 of the design spec describes this endpoint as "step-up, o un
// código de recuperación válido"; that half is wrong and deliberately not
// built (see `recoveryCodes.controller.ts`'s own header, and the spec has
// been annotated). Without `exigeContrasena`, a caller who just spent a
// recovery code to get here would land inside `requireStepUp`'s ten-minute
// window and regenerate the whole set on the strength of the sheet alone —
// exactly the "printed sheet becomes a master key" hallazgo C14 warns about.
// `exigeContrasena` asks for the password regardless of how fresh that proof
// is, which is what closes it.
//
// 🔴 **`permiteOnboarding: true` on `POST /`, matching `totp.routes.ts`'s own
// `setup`/`confirm` and for the same reason.** `requireStepUp.ts`'s own
// docstring on `permiteOnboarding` names this route by name: recovery codes
// are one of the five `ONBOARDING_EXTRA` doors that exist so an `onboarding`
// account — one with no confirmed factor yet — can finish setting itself up.
// The design spec's own §4 allows "TOTP más códigos" as a valid way to leave
// onboarding, so an account there has to be able to mint its first ten codes
// without first becoming `completa`. Refusing `onboarding` outright here
// would seal that combination away entirely, with no route able to open it.
// The account still has nothing to prove — `tieneAlgunFactor` is false while
// `onboarding` — so `requireStepUp`'s own factor check never blocks it; only
// the password is asked for, which an account fresh out of `/auth/login`
// already has.
//
// **`GET /` carries no `requireStepUp` at all.** Counting unspent codes is
// not a sensitive write — see the controller's own header for why gating a
// read like that behind a fresh password would be friction with nothing to
// defend.
import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireStepUp } from "../middleware/requireStepUp.js";
import { regenerateRecoveryCodes, countRecoveryCodes } from "../controllers/recoveryCodes.controller.js";

const router = Router();

router.post(
  "/",
  authenticate,
  requireStepUp({ permiteOnboarding: true, exigeContrasena: true }),
  regenerateRecoveryCodes,
);
router.get("/", authenticate, countRecoveryCodes);

export default router;
