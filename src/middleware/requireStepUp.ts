import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyOwnPassword } from "../auth/credentials.js";
import { tieneAlgunFactor } from "../auth/factorInventory.js";
import { logAction } from "../utils/logAction.js";
import { passwordConfirmLimiter, passwordConfirmKey } from "./loginLimiters.js";
import {
  STEP_UP_WINDOW_MINUTES,
  STEP_UP_PASSWORD_FIELD,
  PASSWORD_CONFIRM_LIMIT,
} from "../config/security.js";

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
 * **An account with nothing to prove is let through, and that is not the same
 * gate weakened — it is the same gate correctly scoped.** Between the deploy
 * of plan 4A and the plan that wires up a real factor challenge, nobody has
 * one to prove, and `web/src` does not yet send `STEP_UP_PASSWORD_FIELD` —
 * that frontend is the later plan's job. A version of this file that refused
 * unconditionally whenever `tieneAlgunFactor` said no was not a stricter
 * gate: with no factor anywhere and no client able to answer a password
 * fallback, it refused *every* gated write on a live deployment — saving the
 * permission matrix, creating a role, an account changing its own password —
 * for every account, always. A gate nothing can satisfy is not a gate, it is
 * an outage, and it shipped that way once before this comment existed to
 * prevent it happening again. See the branch below for exactly what is let
 * through and what still is not, and its own comment for why the skip is
 * temporary by construction rather than by promise.
 *
 * **A caller that does send a password is still held to it.** The later
 * frontend plan will send `stepup_password` on these routes, and from that
 * moment the fallback below behaves exactly as this section always said:
 * correct, and it opens the gate; wrong, and it is refused **and charged**
 * against the shared budget, never for free. The normal first request today
 * sends nothing, precisely because no client sends it yet — that is what
 * lets it through rather than the field being optional once it exists.
 *
 * **The fallback that does spend something is rate-limited, and shares its
 * budget with `chargeConfirmBudgetOnSelfChange`** (`usuario.routes.ts`) rather
 * than counting its own guesses in a bucket of its own. `verifyOwnPassword`
 * deliberately does not move the per-account lockout — see its own comment —
 * so without a limit somewhere, an authenticated caller could compare an
 * unlimited number of *real* guesses against this gate, which for whoever has
 * stolen a session is an oracle for the password behind it.
 *
 * **It only ever calls the real limiter — the one that actually increments the
 * shared counter — when this gate's own comparison came back wrong**, never
 * when it came back right and never merely to check the budget. Two things
 * follow, and both were fixed in the round that added this comment rather than
 * designed in from the start. First: a *correct* `stepup_password` never
 * touches the counter at all, so there is nothing to refund and nothing that
 * can be misread. Second, and the reason that matters here specifically: on
 * `PUT /usuario/username/:id` and `PUT /usuario/userpass/:id`,
 * `chargeConfirmBudgetOnSelfChange` makes its own, independent charge against
 * this same key right after this gate. An earlier version of this file
 * charged unconditionally and refunded a correct answer afterwards — which
 * left a moment, inside a single request, where both charges were on the
 * books at once before either refund settled. That moment was enough to trip
 * `chargeConfirmBudgetOnSelfChange`'s own "is the account over budget" check
 * one attempt early: a caller with the right `stepup_password` and a run of
 * wrong `oldPass` guesses hit the shared 429 on the fifth wrong guess instead
 * of the sixth, because this gate's own not-yet-refunded charge was
 * temporarily inflating the count `chargeConfirmBudgetOnSelfChange` read.
 * Never charging on a right answer removes the charge that caused it — there
 * is nothing left on the books to inflate anything with. `confirmCostsNothing`
 * in `loginLimiters.ts` still reads a flag this gate sets on a wrong answer,
 * since that answer is a uniform 403 rather than the 401 the rest of that
 * bucket's callers use — and it still consumes that flag on read, as defence
 * in depth against a future change reintroducing two charges in one request,
 * even though nothing in this file does that today.
 */
export const CODIGO_STEP_UP = "STEP_UP_REQUIRED";

const MENSAJE =
  "Esta operación necesita que confirmes tu identidad. Vuelve a autenticarte y repite la acción.";
const MENSAJE_ONBOARDING =
  "Termina de configurar tu segundo factor antes de realizar esta operación.";
const MENSAJE_DEMASIADOS_INTENTOS =
  "Demasiados intentos. Espere unos minutos antes de volver a confirmar.";

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

    /**
     * The account has nothing to prove beyond its session, and nothing was
     * sent to prove anyway — let the write through, and say so.
     *
     * This is not the hole it looks like. An account with no factor is
     * exactly as far as the whole ERP already stood before this task: a
     * cookie is the only thing anybody has ever had to hold to reach these
     * routes. `web/src` does not send `STEP_UP_PASSWORD_FIELD` yet — that
     * frontend is a later plan's job — so refusing here unconditionally, as
     * an earlier version of this file did, was not a stricter gate: with no
     * factor registered anywhere and no client able to answer the fallback,
     * it refused *every* gated write on a live deployment. Saving the
     * permission matrix, creating a role, changing your own password —
     * all of it, for every account, always. A gate nothing can satisfy is
     * not a gate, it is an outage.
     *
     * **It closes itself, with nothing to remember.** The moment this
     * account registers a factor, `tieneAlgunFactor` above starts answering
     * `true` and this branch stops being reached for it at all — the block
     * above already refuses outright rather than falling here. Until then,
     * the bitácora line below is the whole of what this skip costs: a record
     * that a sensitive write ran without the extra proof, on an account that
     * had no extra proof to give.
     *
     * A caller that *does* send `stepup_password` — the shape the later
     * frontend plan will use, and the only shape this ever refuses for a
     * factor-less account — still has to get it right; see below.
     */
    const password = (req.body as Record<string, unknown> | undefined)?.[STEP_UP_PASSWORD_FIELD];
    if (typeof password !== "string" || password === "") {
      logAction({
        id_usuario: req.user?.id,
        action: "STEP_UP_SKIPPED",
        entity: "Sesion",
        entity_id: null,
        detail: "Operación sensible realizada sin step-up: la cuenta no tiene ningún factor registrado",
        metadata: { ruta: req.originalUrl, id_sesion: req.user?.id_sesion },
        severity: "warning",
        ip_address: req.ip ?? null,
      });
      next();
      return;
    }

    /**
     * Refuse before comparing anything, the same way the login's own lockout
     * refuses a resting account before comparing anything — but *read* the
     * budget rather than *spend* it to find out. `passwordConfirmLimiter`
     * itself would tell us this by incrementing and checking, but every
     * invocation of it registers a charge that has to be settled later, and
     * settling it later is exactly the timing problem this gate's docstring
     * explains: a charge made here and refunded only once the whole response
     * finishes is briefly on the books for `chargeConfirmBudgetOnSelfChange`'s
     * own, separate charge on the same key to read. `getKey` costs nothing to
     * ask and commits to nothing.
     */
    let agotado: boolean;
    try {
      const info = await passwordConfirmLimiter.getKey(passwordConfirmKey(req));
      agotado = (info?.totalHits ?? 0) >= PASSWORD_CONFIRM_LIMIT;
    } catch (err) {
      next(err);
      return;
    }
    if (agotado) {
      registrar(req, "presupuesto-agotado");
      res.status(429).json({ message: MENSAJE_DEMASIADOS_INTENTOS });
      return;
    }

    const confirmacion = await verifyOwnPassword({ id: user.id, pass: password, ip: req.ip ?? null });
    if (confirmacion.ok) {
      // Nothing was ever charged for this attempt — see the docstring above
      // for why that is the point, not an oversight.
      next();
      return;
    }

    // Wrong, and only now does this gate ever call the real limiter: it
    // increments the shared counter for real, and marks the response so
    // `confirmCostsNothing` charges this uniform 403 the way it would charge
    // the 401 the rest of that bucket's callers use.
    res.locals.stepUpPasswordWrong = true;
    const cobro = await cobrar(req, res, next);
    if (cobro === "error") {
      // `next(err)` already ran inside `cobrar`; there is nothing left to
      // answer here, and answering anyway would race whatever the error
      // handler sends.
      return;
    }
    if (cobro === "denegado") {
      // Reached only if a concurrent request crossed the limit between the
      // read above and this charge — the real limiter already answered its
      // own 429, which is the sentence that says to wait, not the one that
      // says the password is wrong.
      registrar(req, "presupuesto-agotado");
      return;
    }

    denegar(req, res, MENSAJE, "contraseña-incorrecta");
  };
}

/**
 * Makes the one charge this gate ever makes against the shared budget: a
 * confirmed-wrong password. Three outcomes, not two, because a limiter call
 * can fail in a way that is neither "allowed" nor "the budget is spent":
 * `express-rate-limit` wraps its middleware so that any error the store
 * throws reaches the third argument as `next(error)` rather than the second
 * one a plain success/failure callback would expect. `MemoryStore` (the only
 * store configured today) never does that, which is exactly why this was easy
 * to get wrong and leave untested: the Redis store `loginLimiters.ts` already
 * anticipates elsewhere throws on a dropped connection, and a callback that
 * ignored its own error argument would let this gate treat that failure as
 * "charged successfully" and answer the caller as if the password had simply
 * been wrong, with the error itself vanishing.
 */
async function cobrar(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<"cobrado" | "denegado" | "error"> {
  let resultado: "cobrado" | "denegado" | "error" = "denegado";
  await passwordConfirmLimiter(req, res, (err?: unknown) => {
    if (err) {
      resultado = "error";
      next(err);
      return;
    }
    resultado = "cobrado";
  });
  return resultado;
}

/** The bitácora half of a refusal, on its own so the budget-exhausted path —
 *  which must not send a second response on top of the limiter's own 429 —
 *  can still write the line without calling `denegar`. */
function registrar(req: Request, motivo: string): void {
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
}

function denegar(req: Request, res: Response, message: string, motivo: string): void {
  registrar(req, motivo);
  // The code, not just the message: the frontend opens the re-authentication
  // dialog off this and retries the request. Matching on the Spanish text
  // instead would break the day somebody improves the wording.
  res.status(403).json({ message, code: CODIGO_STEP_UP });
}
