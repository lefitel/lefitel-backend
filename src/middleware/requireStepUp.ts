import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyOwnPassword } from "../auth/credentials.js";
import { tieneAlgunFactor } from "../auth/factorInventory.js";
import { logAction } from "../utils/logAction.js";
import { passwordConfirmLimiter } from "./loginLimiters.js";
import { STEP_UP_WINDOW_MINUTES, STEP_UP_PASSWORD_FIELD } from "../config/security.js";

/**
 * The gate on the operations that a stolen session must not be enough for.
 *
 * Being logged in is not the question this asks. The question is whether a
 * *factor* was proved recently — which is a different thing from having a live
 * cookie, and deliberately so: a laptop left unlocked carries a perfectly valid
 * session, and the operations behind this gate (handing out permissions,
 * creating accounts, registering another factor) are the ones where that must
 * not be enough.
 *
 * **A remembered device does not satisfy it.** Those logins leave
 * `mfa_satisfied_at` NULL on purpose; see the column's comment in the
 * migration. Anything that changes that turns "remember this browser" into
 * "this browser is permanently step-up authorised".
 *
 * **The password fallback closes by itself.** Between the deploy of plan 4A and
 * plan 4B nobody has a factor to prove, so a literal reading of the rule would
 * lock every administrator out of user and role management. So the current
 * password is accepted instead — but only while `tieneAlgunFactor` says the
 * account has nothing better. The moment somebody registers a factor, their
 * password stops opening this gate, and so does an attacker's copy of it.
 *
 * **That fallback is rate-limited, and shares its budget with
 * `chargeConfirmBudgetOnSelfChange`** (`usuario.routes.ts`) rather than
 * counting its own guesses in a bucket of its own. `verifyOwnPassword`
 * deliberately does not move the per-account lockout — see its own comment —
 * so without a limit somewhere, an authenticated caller could compare an
 * unlimited number of passwords against this gate, which for whoever has
 * stolen a session is an oracle for the password behind it. See
 * `confirmCostsNothing` in `loginLimiters.ts` for how a bucket built around
 * "a wrong password answers 401" was widened to recognise this gate's uniform
 * 403 as well.
 */
export const CODIGO_STEP_UP = "STEP_UP_REQUIRED";

const MENSAJE =
  "Esta operación necesita que confirmes tu identidad. Vuelve a autenticarte y repite la acción.";
const MENSAJE_ONBOARDING =
  "Termina de configurar tu segundo factor antes de realizar esta operación.";

export function requireStepUp(): RequestHandler {
  // Named, not anonymous: a later task walks the mounted Express stack the
  // way `routeGuards.test.ts` already does for `requirePermissionGate`, and it
  // can only tell this gate apart from an ordinary handler by this name
  // surviving on the function Express actually calls.
  return async function stepUpGate(req: Request, res: Response, next: NextFunction) {
    const user = req.user;
    if (!user) {
      // Unreachable while this is mounted behind `authenticate`, which is
      // everywhere it is mounted today. Written anyway, and closed rather than
      // open, because the day somebody mounts it first this must refuse.
      res.status(401).json({ message: "Su sesión expiró. Vuelva a iniciar sesión." });
      return;
    }

    // An `onboarding` session is not a lesser version of a complete one for
    // these routes: it is refused outright. Otherwise the password alone would
    // edit the permission matrix for the whole of the grace period.
    if (user.estado !== "completa") {
      denegar(req, res, MENSAJE_ONBOARDING, "estado-incompleto");
      return;
    }

    const satisfecho =
      user.mfa_satisfied_at !== null &&
      Date.now() - new Date(user.mfa_satisfied_at).getTime() <= STEP_UP_WINDOW_MINUTES * 60_000;
    if (satisfecho) {
      next();
      return;
    }

    // Asked before the password is even looked at: with a factor on the
    // account, no password is an acceptable answer here, and checking it first
    // would spend a bcrypt comparison to reach the same refusal.
    if (await tieneAlgunFactor(user.id)) {
      denegar(req, res, MENSAJE, "sin-factor-reciente");
      return;
    }

    // The budget check runs before the password is looked at too, the same way
    // the login's own lockout refuses a resting account before comparing
    // anything: an account that has already spent this window's five wrong
    // passwords gets no further bcrypt comparison out of a sixth attempt.
    if (!(await bajoPresupuesto(req, res))) {
      // The limiter already answered its own 429 — "Demasiados intentos..." —
      // there is nothing left for this gate to add.
      return;
    }

    const confirmacion = await verifyOwnPassword({
      id: user.id,
      pass: (req.body as Record<string, unknown> | undefined)?.[STEP_UP_PASSWORD_FIELD],
      ip: req.ip ?? null,
    });
    if (confirmacion.ok) {
      next();
      return;
    }

    // Marks this response for `confirmCostsNothing`: every refusal this gate
    // makes answers the same 403, so the status code alone cannot tell a wrong
    // password apart from a stale window or a missing factor. This flag is the
    // one thing that can, and it is what keeps the shared budget from
    // refunding every guess.
    res.locals.stepUpPasswordWrong = true;
    denegar(req, res, MENSAJE, "contraseña-incorrecta");
  };
}

/**
 * Whether the caller may even attempt the password fallback right now.
 *
 * Runs the exact `passwordConfirmLimiter` `chargeConfirmBudgetOnSelfChange`
 * shares on the rename and password-change routes (see `usuario.routes.ts`),
 * called directly rather than mounted as a route-level middleware: only this
 * function knows, at this point in the gate, whether the password branch is
 * even being attempted, and that decision cannot be pushed onto the route
 * without duplicating everything above it.
 *
 * `next` is only ever invoked when the limiter lets the request through — the
 * real limiter answers its own 429 directly and never calls it when the
 * budget is spent, so `allowed` stays `false` and this resolves accordingly.
 * Awaiting the call itself (rather than only its callback) is what makes this
 * safe to use this way: the limiter's own async body does not settle until
 * either branch has fully run, callback included, so there is nothing left
 * to race.
 */
async function bajoPresupuesto(req: Request, res: Response): Promise<boolean> {
  let allowed = false;
  await passwordConfirmLimiter(req, res, () => {
    allowed = true;
  });
  return allowed;
}

function denegar(req: Request, res: Response, message: string, motivo: string): void {
  logAction({
    id_usuario: req.user?.id,
    action: "STEP_UP_DENIED",
    entity: "Sesion",
    entity_id: null,
    detail: `Operación sensible rechazada por falta de step-up: ${motivo}`,
    metadata: { ruta: req.originalUrl, motivo, id_sesion: req.user?.id_sesion },
    severity: "critical",
    ip_address: req.ip ?? null,
  });
  // The code, not just the message: the frontend opens the re-authentication
  // dialog off this and retries the request. Matching on the Spanish text
  // instead would break the day somebody improves the wording.
  res.status(403).json({ message, code: CODIGO_STEP_UP });
}
