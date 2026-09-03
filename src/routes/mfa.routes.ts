// Task 7 and Task 17 of `docs/plans/2026-09-01-factores-mfa.md`: proving a
// second factor from a `parcial`/`onboarding` session (`POST /auth/mfa/verify`)
// and re-proving one from a live `completa` session whose ten-minute step-up
// window has lapsed (`POST /auth/stepup`). Both live in one router because
// both live in one controller, `mfa.controller.ts` — the file that actually
// checks a TOTP code or a recovery code against the caller's own account.
//
// **Neither route carries `requireStepUp`, and that is not an omission.**
// `/mfa/verify` is what *lifts* a session out of `parcial`/`onboarding` —
// gating it behind the very state it produces would be circular, and nobody
// in `parcial` could ever leave it. `/stepup` is what a client calls
// *instead of* logging out when some other route's own `requireStepUp` gate
// has already answered 403 with `MOTIVO_SIN_FACTOR_RECIENTE` — gating this
// one the same way would ask for step-up to be allowed to step up.
//
// **Neither route carries an `express-rate-limit` bucket of its own either.**
// Both share the ordinary account lockout instead — `failed_attempts` /
// `locked_until`, the same pair a wrong password already arms — from inside
// `mfa.controller.ts` (hallazgo C3, Task 7 Step 1). A wrong code costs
// exactly what a wrong password costs; no second budget is needed beside it.
//
// **Who may reach these two is decided in two different places, on
// purpose, and neither is this file.** `/mfa/verify` sits under
// `/api/auth/mfa`, which `auth/sessionState.ts`'s `PARCIAL` list already
// opens — a session with a factor to prove has to be able to reach the door
// that proves it, and nothing here needs to say so again. `/stepup` needs no
// entry added there at all: only a `completa` session ever has a step-up
// window to let lapse, and `PERMITIDAS.completa` is already `"todo"` (Task 17
// Step 3 — verified against `estadoInicialDeSesion`, not assumed: an account
// with no factor never opens anything but `parcial`/`onboarding`, so
// `onboarding` never reaches this router at all, factor or not).
//
// Mounting this router itself, alongside `totp.routes.ts` and
// `recoveryCodes.routes.ts`, is `src/app.ts`'s job in the coordinator's final
// pass once every 4B route file exists — see the plan's "Un fichero de rutas
// por tarea, y el montaje al final".

//
// **`POST /mfa/email-code` (plan 4E) rides here for the same reasons.** It is
// how a `parcial` session obtains the code it will then hand to `/mfa/verify`
// with `metodo: "correo"`, so it can carry no `requireStepUp` either — it is
// a means of satisfying one — and it sits under the same `/api/auth/mfa`
// prefix `PARCIAL` already opens. It carries no bucket for the same reason
// as the other two, and a better one: its limits are per account and in the
// database (`auth/emailCodeStore.ts` — cooldown, hourly and daily caps), so a
// restart forgets nothing and a second process would see the same numbers.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { verify, stepup } from "../controllers/mfa.controller.js";
import { sendEmailCode } from "../controllers/emailCode.controller.js";

const router = Router();

router.post("/mfa/verify", authenticate, verify);
router.post("/mfa/email-code", authenticate, sendEmailCode);
router.post("/stepup", authenticate, stepup);

export default router;
