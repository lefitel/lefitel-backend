// Recovery-code router: generating/regenerating the ten, and counting how
// many are unspent. `docs/plans/2026-09-01-factores-mfa.md` Task 10.
//
// **Mounted at `/api/auth/recovery-codes` in `app.ts`, and the path has to
// stay that**: it matches `auth/sessionState.ts`'s `ONBOARDING_EXTRA` entry of
// the same name, which is what lets an `onboarding` session reach this router
// at all — and then `POST /`'s own gate closes behind it, on purpose, for the
// reason two paragraphs down.
//
// 🔴 **`POST /` carries the plain `requireStepUp()` — hallazgo C14, reopened
// by the decision of 2026-10-10.** §5 of the design spec describes this
// endpoint as "step-up, o un código de recuperación válido"; the endpoint
// itself still never accepts a recovery code as its own proof (see
// `recoveryCodes.controller.ts`'s header). But a caller who spends a recovery
// code at the step-up door lands inside `requireStepUp`'s ten-minute window,
// and the window is all this route asks for: the sheet plus a cookie can
// regenerate the whole set, which is the "printed sheet becomes a master key"
// that C14 warned about. The route used to close it by asking for the password
// on every request (`sinVentana`); Isaias chose, with that stated, to give
// that up for every gated route. Accepted cost, not an oversight.
//
// 🔴 **No `permiteOnboarding` on `POST /` — removed by the 2026-09-02 closure
// audit, hallazgo F1.** An earlier version of this mount carried it, on the
// argument that the design spec's §4 allows "TOTP más códigos" as a valid
// way to leave `onboarding`, so an account there had to be able to mint its
// first ten codes without first becoming `completa`. That argument does not
// survive the timing of how an account actually leaves `onboarding`:
// confirming a factor — `POST /auth/totp/confirm`, today the only door —
// calls `promoverSesion` on the *same* session before answering, which
// rewrites that session's own `estado` to `completa` synchronously. By the
// time a legitimately-behaving caller's next request reaches this route,
// `req.user.estado` already reads `completa`; there is no request in the
// intended flow that ever needs `onboarding` to pass here at all.
//
// The only caller `permiteOnboarding` was actually admitting was the
// `onboarding` account — no confirmed factor, by construction (see
// `factorInventory.ts`'s `estadoInicialDeSesion`: that branch fires
// precisely because `tieneAlgunFactor` said `false`) — reaching this route
// to mint ten codes with nothing to back them up. `recoveryCodes.controller.ts`
// now refuses exactly that account regardless of state, so keeping the
// option open only spent the caller's own password on a request that was
// always going to end in a 409. Removing it moves the refusal to the
// cheaper, earlier gate: `requireStepUp`'s own state check answers 403 with
// `MOTIVO_ESTADO_INCOMPLETO` before a password is even asked for, which is
// also the more honest message — "finish configuring your second factor" is
// the truth, not "type your password again" for an operation that was never
// going to succeed.
//
// This matches `DELETE /api/auth/sessions/:id` (`auth.routes.ts`), the other
// `ONBOARDING_EXTRA` prefix mounted with the option deliberately **off**:
// `requireStepUp.ts`'s own docstring on `permiteOnboarding` says the two
// gates are independent by design — "there is no reading of '`onboarding`
// may reach it' [past `authenticate`] that implies 'the [step-up] gate
// should let it through'". `auth/sessionState.ts`'s `ONBOARDING_EXTRA` list
// is unchanged by this: an `onboarding` session still reaches this router at
// all, it is this route's own gate that now closes behind it, which is
// exactly the shape that comment describes.
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

router.post("/", authenticate, requireStepUp(), regenerateRecoveryCodes);
router.get("/", authenticate, countRecoveryCodes);

export default router;
