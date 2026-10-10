import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyOwnPassword } from "../auth/credentials.js";
import {
  tieneAlgunFactor,
  hayFactorVerificable,
  metodosDeReautenticacion,
  type MetodoReautenticacion,
} from "../auth/factorInventory.js";
import { sellarContrasena } from "../auth/sessionPromotion.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import {
  consumirCupoDeConfirmacion,
  devolverCupoDeConfirmacion,
  PASSWORD_CONFIRM_MESSAGE,
} from "./loginLimiters.js";
import { STEP_UP_WINDOW_MINUTES, STEP_UP_PASSWORD_FIELD } from "../config/security.js";

const gateLog = log("step-up");

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
 * **An account with nothing to prove has to type its password.** Task 3 of the
 * reauthentication-window plan (2026-09-08) removed the branch that used to let
 * a factor-less account through on the cookie alone: `web/src` has sent
 * `STEP_UP_PASSWORD_FIELD` since plan 4D, so there is no longer a caller this
 * gate cannot ask. Correct, and it opens the gate; wrong or missing, and it is
 * refused — missing for free, wrong **and charged** against the shared budget.
 * See the password branch below for exactly what each answer costs.
 *
 * **And a correct one buys that account ten minutes**, the same width a
 * proved factor gets, stamped on the session row by `sellarContrasena` and
 * read back on the next request. Task 5 of the same plan added it, and it is
 * what keeps "type your password on every sensitive write" from being the
 * whole day's experience for the accounts that have no factor to prove — the
 * exact annoyance this arc exists to remove. The window does not renew itself:
 * the ten minutes run from the *first* confirmation, never the latest.
 *
 * **Every gated route takes the window — decision of 2026-10-10 (Isaias,
 * "Todo, sin excepciones", taken twice with the risks put to him).** No route
 * asks for the password on every request any more; the `sinVentana` option
 * that did that is gone. The accepted cost: inside the ten minutes a hijacked
 * session can register its own credential and delete the owner's, archive
 * accounts (not reversible from the app), create accounts, assign roles and
 * rewrite permissions. See "Revisión 4" in
 * `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md`.
 *
 * **The fallback that does spend something is rate-limited, and shares its
 * budget with `chargeConfirmBudgetOnSelfChange`** (`usuario.routes.ts`) rather
 * than counting its own guesses in a bucket of its own. `verifyOwnPassword`
 * deliberately does not move the per-account lockout — see its own comment —
 * so without a limit somewhere, an authenticated caller could compare an
 * unlimited number of *real* guesses against this gate, which for whoever has
 * stolen a session is an oracle for the password behind it.
 *
 * **It charges every attempt, right or wrong, and refunds a right one on the
 * spot — not the deferred, response-`finish`-time refund `passwordConfirmLimiter`
 * itself does for every other caller.** That distinction is the fix Task 1 of
 * the reauthentication-window plan (2026-09-08) made, and the reason it is
 * not the same shape as the version this paragraph used to describe.
 *
 * The version before it read the counter with `getKey`, compared the
 * password (a `bcrypt` call, ~250ms), and only charged afterwards if the
 * comparison was wrong. Concurrent requests all read "nothing spent yet"
 * before any of them had charged anything, so a stolen session bought as many
 * guesses as fit in one `bcrypt` round trip, not `PASSWORD_CONFIRM_LIMIT` —
 * see `consumirCupoDeConfirmacion`'s own docstring in `loginLimiters.ts` for
 * the measurement. Charging first and refunding the right answers closes
 * that gap: the charge and the "was there room" verdict are one atomic call
 * into the store (`consumirCupoDeConfirmacion`), so two requests racing each
 * other cannot both read zero.
 *
 * **This is not the same shape as the bug an earlier version of this gate had
 * for a different reason, and the difference is what makes it safe.** That
 * earlier version also charged before knowing the answer — through
 * `passwordConfirmLimiter` itself, whose `skipSuccessfulRequests` design
 * defers the refund decision to the response's own `finish` event, reading a
 * flag (`res.locals.stepUpPasswordWrong`) off a `Response` this gate shares
 * with `chargeConfirmBudgetOnSelfChange`'s own, independent charge on
 * `PUT /usuario/userpass/:id`. That flag
 * could only ever say "this one costs"; there was no way to say the opposite
 * for a right answer, so a right answer here landing on the same final 401 as
 * a wrong `oldPass` check went un-refunded — both charges cost, not one,
 * halving the real budget. `consumirCupoDeConfirmacion` and
 * `devolverCupoDeConfirmacion` below never touch `passwordConfirmLimiter` or
 * its deferred machinery at all: the refund happens synchronously, before
 * `next()` is ever called, so nothing is left outstanding for
 * `chargeConfirmBudgetOnSelfChange`'s own charge — which still goes through
 * `passwordConfirmLimiter` unchanged — to collide with. `confirmCostsNothing`
 * in `loginLimiters.ts` still exists and still reads that flag, for whatever
 * future caller of `passwordConfirmLimiter` itself needs a 403 to cost like a
 * 401 — this gate is simply no longer one of them.
 */
export const CODIGO_STEP_UP = "STEP_UP_REQUIRED";

/**
 * The reasons this gate ever refuses with `CODIGO_STEP_UP`, exported so
 * a client can act on *which* one rather than matching the Spanish sentence —
 * the same reasoning `CODIGO_STEP_UP` itself is built on, one level down.
 * `code` alone told a client "you must re-authenticate"; it could not tell it
 * *how*, and the three answers are different actions: finish onboarding,
 * supply a factor, or type the current password again. This is the
 * discriminator that was already going to the bitácora as `motivo` — now
 * also on the response, beside `code`, under the same name. No new
 * information reaches the caller: every one of the three facts is about
 * their own account, which an authenticated caller already knows.
 */
export const MOTIVO_ESTADO_INCOMPLETO = "estado-incompleto";
export const MOTIVO_SIN_FACTOR_RECIENTE = "sin-factor-reciente";
export const MOTIVO_CONTRASENA_INCORRECTA = "contraseña-incorrecta";
/**
 * The fourth: an account with no factor and no fresh password window reached
 * the password branch and the body carried no password.
 *
 * **Deliberately not `MOTIVO_CONTRASENA_INCORRECTA`**, even though the remedy
 * looks the same from here. The two are different sentences on screen — "type
 * your password" against "that password is wrong" — and `code` alone cannot
 * separate them, so a client folding them together accuses somebody of
 * mistyping a password they never typed. The whole reason these constants
 * exist beside `code` is that one class of refusal can have several remedies.
 */
export const MOTIVO_CONTRASENA_REQUERIDA = "contraseña-requerida";

const MENSAJE =
  "Esta operación necesita que confirmes tu identidad. Vuelve a autenticarte y repite la acción.";
const MENSAJE_ONBOARDING =
  "Termina de configurar tu segundo factor antes de realizar esta operación.";
const MENSAJE_CONTRASENA_REQUERIDA =
  "Introduce tu contraseña actual para completar esta operación.";

export interface OpcionesStepUp {
  /**
   * Let an `onboarding` session past the state check — and past that check
   * only. Off by default, and every administrative mount leaves it off.
   *
   * **For the doors `onboarding` opens in order to stop being `onboarding`.**
   * `ONBOARDING_EXTRA` in `auth/sessionState.ts` is the list of prefixes that
   * state reaches at all — most of them are that kind of door: the email, TOTP,
   * WebAuthn registration, the stored credentials. `/api/auth/sessions` and
   * `/api/auth/recovery-codes` are not, and they are the ones worth stating the
   * rule against: both take this gate with the option **off**, and refusing
   * `onboarding` on the first of them is the whole of what closed a
   * demonstrated attack (see `auth.routes.ts`). Which mount carries which
   * option is `STEP_UP_OPTIONS` in `routeGuards.test.ts`, not a tally here.
   * That is the shape of this option: it is decided per route, never per
   * state, and there is no reading of "`onboarding` may reach it" that implies
   * "the gate should let it through".
   *
   * The specification puts several of those same operations behind step-up —
   * "cambiar el email propio", "dar de alta o de baja cualquier factor" — and,
   * in the same section, says which of them `onboarding` is shut out of: "un
   * usuario en `onboarding` no puede hacer las operaciones **administrativas**
   * de la lista: responden 403, nunca pasan" (the emphasis is this comment's).
   * Administrative. Setting up your own account is the other kind, and the two
   * rules only contradict each other if that word is dropped.
   *
   * **Measured, not argued.** Mounting the gate without this option on `POST
   * /api/auth/email/send` turns `app.auth.test.ts`'s "leaves the doors that
   * finish the setup open to that same session" from 400 into 403. That is not
   * a stricter gate, it is a sealed room: `POST /auth/totp/setup` answers 409
   * until the address is verified (§5 of the design, and `setupTotp`'s own
   * check), the address cannot be registered without this route, and a
   * registered factor is the only thing that ends `onboarding`. Every account
   * reaches that state on its own, `MFA_GRACE_DAYS` after its first login —
   * see `estadoInicialDeSesion` — so this would be the whole payroll with only
   * the passkey door left, which is the one factor that needs no mailbox. The
   * registration routes carry this option for the same reason, and have since
   * plan 4B: `totp.routes.ts` and `webauthn.routes.ts`.
   *
   * **What it does not do.** `parcial` is still refused: that state means the
   * account *has* a factor and has not proved it on this session, so the way
   * through is proving it, not typing a password. And an `onboarding` session
   * whose account does have a factor — which `estadoEfectivo` can produce for
   * a session opened before the deadline and predating the registration — is
   * refused one line further down by the factor check, which does not consult
   * this option at all. So all this option ever buys is that an account with
   * nothing to prove reaches the password branch below, and gets there exactly
   * as a factor-less `completa` session does: it types its current password.
   * It is not a way past the gate, only past the state check.
   */
  permiteOnboarding?: boolean;

  /**
   * Stop demanding proof of a factor **this server has just declared it cannot
   * read**. Off by default, and exactly one route turns it on:
   * `DELETE /auth/totp`, the one whose entire purpose is undoing that factor.
   *
   * **The seam it closes.** `totp.routes.ts:14-26` deliberately leaves
   * `requireTotpKeyAvailable` off that DELETE — in its own words, "para que una
   * llave equivocada no encierre a nadie en un factor muerto" — and then mounts
   * this gate on it, which asks for a code produced from the very secret the
   * keyring can no longer decrypt. The route stays open and the gate in front
   * of it is shut. Both pieces are right; the seam is the lockout.
   *
   * **What it costs.** What replaces the impossible code is the password. In
   * that fall-through the account HAS a factor, so the password window
   * (`password_confirmed_at`) is neither consulted nor sealed: during a keyring
   * outage this route asks for the password on every request, unless a
   * *factor* window (`mfa_satisfied_at`) is already fresh — which passes first,
   * like on every other route. Demanding proof of a factor the server itself
   * reports as unreadable is not a stricter gate, it is an unsatisfiable one —
   * nothing this account could ever send would open it.
   *
   * **Deliberately narrow, and it has to be.** Read by one route rather than
   * applied to every route that carries the gate, because everywhere else the honest answer to a
   * broken key is still "prove your factor or spend a recovery code" — those
   * codes are bcrypt, never encrypted, so they survive exactly this failure.
   * Widening it would mean that during a configuration fault the password
   * alone reaches every sensitive write in the ERP, on every request. The narrow door is the
   * escape hatch; the wide one would be the hole.
   *
   * 🔴 **This is a remedy, not a fix.** With an unreadable TOTP the lockout
   * that bites first is not this gate at all: `estadoInicialDeSesion` opens the
   * session `parcial`, and `parcial` is left only by proving the factor — so
   * that person never gets a session for this gate to guard. Their real way
   * back in is a recovery code, which is why those are now issued when the
   * factor is confirmed instead of waiting to be asked for.
   */
  toleraFactorIlegible?: boolean;
}

/**
 * 🔴 **The password leaves the body on every path out of this gate — every
 * `next()`, and every `next(err)` — not only the one that verified it.**
 *
 * Until Task 10 of plan 4C it left on exactly one. The fresh-window shortcut
 * passed it through untouched, and a request can carry the field there: the
 * client's interceptor serialises concurrent refusals onto one ceremony and
 * injects the same password into every retried body, so a route that never
 * asked for it receives it the moment it shares a ceremony with one that did.
 * Downstream, `rol.controller.ts` writes the body into the bitácora as `after`
 * — `assignable()` drops four names from it and `stepup_password` is not one of
 * them — and that is a table rendered on a screen. An administrator's plaintext
 * password in `bitacora.metadata` was one unlucky pair of tabs away.
 *
 * D6 closed that particular hole for a week, by keeping the `rol` routes off
 * the shortcut. 🔴 **It is reachable again**: §4.1 of the reauthentication
 * design (2026-09-08) put the four `rol` writes back inside the window, and
 * the 2026-10-10 decision did the same for every other gated route, so the
 * exact pair described above — the shortcut and a controller that files the
 * body — is live, and this line is what stands between them. It also covers every other mount that takes the
 * window, any mount added later, and the error handler; none of the rest file
 * the body today, and the next Sentry hook or `req.body` in a log line would. A
 * rule with no exceptions is the only one the next reader can build on.
 *
 * Guarded, because a body-less DELETE arrives with `req.body` undefined.
 */
function soltarContrasena(req: Request): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (body) delete body[STEP_UP_PASSWORD_FIELD];
}

export function requireStepUp({
  permiteOnboarding = false,
  toleraFactorIlegible = false,
}: OpcionesStepUp = {}): RequestHandler {
  // Named, not anonymous: a later task walks the mounted Express stack the
  // way `routeGuards.test.ts` already does for `requirePermissionGate`, and it
  // can only tell this gate apart from an ordinary handler by this name
  // surviving on the function Express actually calls.
  const stepUpGate = async function stepUpGate(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user;
      if (!user) {
        // Unreachable while this is mounted behind `authenticate`, which is
        // everywhere it is mounted today. Written anyway, and closed rather than
        // open, because the day somebody mounts it first this must refuse.
        res.status(401).json({ message: "Su sesión expiró. Vuelva a iniciar sesión." });
        return;
      }

      // An `onboarding` session is not a lesser version of a complete one for
      // the administrative routes: it is refused outright. Otherwise the
      // password alone would edit the permission matrix for the whole of the
      // grace period — the specification's own words, and the reason this is
      // asked ahead of the window and the factor lookup rather than after
      // them.
      //
      // **This refuses somebody for real.** It used to be unreachable — every
      // mount lived under `/api/usuario`, `/api/rol` or `/api/permiso`, none
      // of which the `parcial` or `onboarding` allowlists in
      // `auth/sessionState.ts` open, so `authenticate` had already answered
      // 401 or 403 before this gate ran. The gated routes under `/api/auth`
      // changed that: `ONBOARDING_EXTRA` opens the prefixes they sit on, so an
      // `onboarding` session reaches this line, and on the ones that leave
      // `permiteOnboarding` off this line is the only thing that stops it.
      // `DELETE /api/auth/sessions/:id` is where that closed an attack an
      // audit demonstrated — see the route's own comment in `auth.routes.ts`;
      // `POST /api/auth/recovery-codes/` is the other, and
      // `recoveryCodes.routes.ts` explains why it wants this refusal rather
      // than a password prompt. Which mounts leave the option off is
      // `STEP_UP_OPTIONS` in `routeGuards.test.ts`.
      //
      // **And it is why `permiteOnboarding` exists**, for the opposite kind of
      // route: the doors `onboarding` opens *in order to stop being*
      // `onboarding`. See the option's own comment above for why refusing
      // those is an outage rather than a stricter gate. `parcial` is refused
      // either way — the option names one state and reads it, rather than
      // meaning "any state below `completa`".
      const estadoAceptable =
        user.estado === "completa" || (permiteOnboarding && user.estado === "onboarding");
      if (!estadoAceptable) {
        denegar(req, res, MENSAJE_ONBOARDING, MOTIVO_ESTADO_INCOMPLETO);
        return;
      }

      // How long ago the factor was proved, in milliseconds — and it has to be
      // *ago*. The window used to be bounded on one side only: anything not
      // older than ten minutes satisfied it, so a stamp in the **future**
      // satisfied it too, and went on doing so for as long as it stayed in the
      // future. An hour-ahead mark is an hour of unlimited step-up on that
      // session; a clock corrected backwards, or one bad write, is all it
      // takes. `>= 0` is the missing side.
      //
      // Latent until plan 4B, which is the first thing that ever writes this
      // column — and therefore the first thing that can write it wrong.
      //
      // NULL and an unreadable date both give `NaN`, and every comparison
      // against `NaN` is false, so both refuse. That is the safe direction and
      // it is why the null check is folded in here rather than left as a
      // separate `!== null`: one expression, one answer, no second spelling of
      // "there is no usable stamp" to keep in step with this one.
      const probadoHace =
        user.mfa_satisfied_at === null
          ? NaN
          : Date.now() - new Date(user.mfa_satisfied_at).getTime();
      const satisfecho = probadoHace >= 0 && probadoHace <= STEP_UP_WINDOW_MINUTES * 60_000;

      /**
       * A fresh proof is enough on its own, on every route. That includes a
       * stamp sealed by spending a **recovery code** (plan 4B): the printed
       * sheet alone opens the window, with no password. Accepted by the
       * 2026-10-10 decision, not overlooked — see "Revisión 4" in the design.
       */
      if (satisfecho) {
        soltarContrasena(req);
        next();
        return;
      }

      /**
       * Asked before the password is even looked at: with a factor on the
       * account and nothing fresh to show for it, no password is an acceptable
       * answer here, and checking it first would spend a bcrypt comparison to
       * reach the same refusal.
       *
       * A plain boolean: a fresh `mfa_satisfied_at` has already returned above,
       * so this is always asked. `true` is the only state in which the factor
       * branch applies; `false` is the only one in which the password branch
       * below may consult or seal `password_confirmed_at`.
       */
      const tieneFactor = await tieneAlgunFactor(user.id);

      if (tieneFactor) {
        // The factor exists. Whether it can be *proved* is a second question,
        // and only the route that undoes a dead factor ever asks it — see
        // `toleraFactorIlegible`. Asked second, and only when that option is
        // on, so the ordinary path still pays for one pair of COUNTs rather
        // than two: this is the hot path of every gated write.
        if (!toleraFactorIlegible || (await hayFactorVerificable(user.id))) {
          // 🔴 **`metodos` names what the window has to draw.** This
          // refusal says "prove a factor" and, until passkeys existed, there
          // was only one thing that could mean, so the window hard-coded a
          // six-digit field. There are two now and they look nothing alike.
          // Getting it wrong is not cosmetic: an account whose only factor is
          // a passkey would be shown a form asking for a code it cannot
          // produce, and five attempts at it lock the account — behind this
          // same gate. See `metodosDeReautenticacion` for what goes in the list and
          // what is deliberately left out of it.
          //
          // **Four reads, and three of them repeat what `tieneAlgunFactor`
          // just asked** (two COUNTs and the verified address; the fourth is
          // the recovery-code count). Bought knowingly. This refusal is not
          // the hot path it looks like: `mfa_satisfied_at` is good for
          // `STEP_UP_WINDOW_MINUTES`, so a session lands here at most once
          // every ten minutes, and what follows is a human running a WebAuthn
          // ceremony or reading six digits off a phone. The alternative was
          // one function returning both answers, which saves three indexed
          // reads and costs a nullable local here to keep the `&&` from
          // short-circuiting — a worse trade at this volume.
          //
          // 🔴 And the two answers are **not** the same question, which is the
          // reason they stayed two calls: an account whose only TOTP secret
          // this server cannot decrypt has a factor (`tieneAlgunFactor` is
          // true, so the gate must refuse) and no method (`metodos` is empty,
          // because there is nothing it could truthfully offer). That gap is
          // the seam `toleraFactorIlegible` exists for, and collapsing it into
          // one boolean is how it gets lost.
          //
          // 🔴 **And a failure to answer it may not become a 500.** Three
          // COUNTs is three more ways a dropped connection turns a
          // well-formed `403 STEP_UP_REQUIRED` into a bare server error — and
          // the client's interceptor only opens the window on a 403 carrying
          // `code`, so a 500 here does not degrade the ceremony, it removes
          // it. Omitting the field is already defined as "this server cannot
          // say", which is exactly true when the query failed, so that is
          // what a failure answers with.
          let metodos: MetodoReautenticacion[] | undefined;
          try {
            metodos = await metodosDeReautenticacion(user.id);
          } catch (err) {
            gateLog.error(
              { err, id_usuario: user.id },
              "no se pudo averiguar con qué puede probarse la cuenta: se rechaza sin decirlo",
            );
          }
          denegar(req, res, MENSAJE, MOTIVO_SIN_FACTOR_RECIENTE, metodos ? { metodos } : {});
          return;
        }
        // Falls through to the password branch below with `tieneFactor` true:
        // the password window is not consulted (it never stands in for a
        // factor) and a correct password does not seal one.
        //
        // 🔴 Y queda constancia, porque es un evento que un operador querría
        // poder contar durante una avería de claves: el servidor acaba de
        // pedir una contraseña **en lugar de** un factor que él mismo declara
        // ilegible. Sin esta línea la operación no aparecía en ninguna parte.
        //
        // 🔴 **Se escribe aquí, antes de mirar la contraseña, así que la línea
        // sale también para un intento que acaba rechazado** — por no mandar
        // ninguna, o por mandarla mal. Es deliberado: lo que un operador quiere
        // contar durante la avería es a cuánta gente mandó la clave rota por
        // este camino, no a cuánta le salió bien. Por eso el texto dice
        // «se intenta» y no «se acepta»: era falso en los dos desenlaces
        // rechazados, que son la mayoría de los que caen aquí.
        //
        // Mover la línea detrás de la comprobación cambiaría **qué se cuenta**,
        // así que es una decisión de producto y no un arreglo de redacción;
        // queda anotada como deuda. `totp.routes.test.ts` la vigila desde la
        // Tarea 17, así que quien la mueva se enterará.
        logAction({
          id_usuario: user.id,
          action: "STEP_UP_FACTOR_ILEGIBLE",
          entity: "Sesion",
          entity_id: null,
          detail:
            "La cuenta tiene un factor que este servidor no puede verificar: se intenta la contraseña en su lugar",
          metadata: { ruta: req.originalUrl, id_sesion: user.id_sesion },
          severity: "critical",
          ip_address: req.ip ?? null,
        });
      } else {
        /**
         * The window of an account with **no factor at all**, which is the
         * whole of what this branch is about — and it is consulted here,
         * rather than thirty lines up in `satisfecho`, for a reason that is
         * about security and not about tidiness.
         *
         * `satisfecho` is computed *before* the factor lookup. As an `OR`
         * there, this column would let an account that **does** have a factor
         * be held open by the password alone, with the factor never proved —
         * and the separate column (§5 of the design) exists to prevent exactly
         * that. Down here, `tieneAlgunFactor` has already answered `false`:
         * there is no factor for a password to stand in for.
         *
         * `NaN` for a missing or unreadable stamp, and `>= 0` on the other
         * side, for exactly the reasons the `mfa_satisfied_at` window above
         * gives: every comparison against `NaN` is false, so both refuse, and
         * a date in the future must not buy an hour of open gate.
         */
        const confirmadoHace =
          user.password_confirmed_at === null
            ? NaN
            : Date.now() - new Date(user.password_confirmed_at).getTime();
        const ventanaDeContrasena =
          confirmadoHace >= 0 && confirmadoHace <= STEP_UP_WINDOW_MINUTES * 60_000;
        if (ventanaDeContrasena) {
          // The password leaves the body here too. This is a path out of the
          // gate like any other, and a request can arrive carrying the field
          // even on a route that never asked for it — see `soltarContrasena`.
          soltarContrasena(req);
          next();
          return;
        }
      }

      const password = (req.body as Record<string, unknown> | undefined)?.[STEP_UP_PASSWORD_FIELD];
      if (typeof password !== "string" || password === "") {
        // Refusada gratis: no se comparó nada, así que no hay nada que cobrar.
        // Cobrar aquí dejaría que un cliente que olvide el campo quemase el
        // cupo de otra persona y la encerrase fuera de la pantalla que lo arregla.
        //
        // 🔴 **Sin `metodos`.** No por lo que haría el cliente con la lista —
        // el campo está documentado en `web/src/api/stepUp.ts` como "Sólo en
        // `sin-factor-reciente`": ese es su contrato, no una casualidad de
        // esta rama. Este refusal contesta `contraseña-requerida`, un motivo
        // distinto, así que no hay nada que el campo tendría que describir.
        denegar(req, res, MENSAJE_CONTRASENA_REQUERIDA, MOTIVO_CONTRASENA_REQUERIDA);
        soltarContrasena(req);
        return;
      }

      /**
       * Charge before comparing anything — atomically, through the store
       * directly, not through `passwordConfirmLimiter` itself. See this
       * function's own top-of-file docstring for why that used to be a
       * read (`getKey`) instead, and the concurrency bug that produced, and
       * `consumirCupoDeConfirmacion`'s own docstring in `loginLimiters.ts`
       * for how the atomicity holds under `MemoryStore` specifically.
       *
       * Kept in a local so a wrong answer below can say how many guesses are
       * left without a second call to the store to ask something this value
       * already knows.
       */
      let cupo: { permitido: boolean; restantes: number };
      try {
        cupo = await consumirCupoDeConfirmacion(user.id);
      } catch (err) {
        soltarContrasena(req);
        next(err);
        return;
      }
      if (!cupo.permitido) {
        try {
          // Given back: this attempt never got to compare anything, so it
          // must not be the one left holding the charge that tipped the
          // bucket over — that charge belongs to whichever request actually
          // got here first.
          await devolverCupoDeConfirmacion(user.id);
        } catch (err) {
          soltarContrasena(req);
          next(err);
          return;
        }
        registrar(req, "presupuesto-agotado");
        // Every path out of this gate drops the password from the body — see
        // `soltarContrasena`'s own docstring — and this 429 is one, same as
        // every other exit below it. Missing until Task 3 of the
        // reauthentication-window plan found it while rewriting the branch
        // just above this one.
        soltarContrasena(req);
        // The exact same sentence the real limiter itself answers with when it
        // is the one deciding "spent" — imported rather than retyped, so this
        // refusal can never drift from that one.
        res.status(429).json({ message: PASSWORD_CONFIRM_MESSAGE });
        return;
      }

      /**
       * 🔴 Its own try/catch, found missing in fix round 1 — the third gap
       * `cobrar()`'s own docstring named before this task deleted that
       * function: "a limiter call can fail in a way that is neither
       * 'allowed' nor 'the budget is spent'". This branch had the same shape
       * of failure and none of the guard: without this, a rejection here
       * fell through to the whole gate's outer catch-all, which answers a
       * bare 500 and never runs `devolverCupoDeConfirmacion` — so the charge
       * `consumirCupoDeConfirmacion` just made stayed spent for the full
       * fifteen-minute window on a comparison that never produced an
       * answer. `verifyOwnPassword` (`auth/credentials.ts`) runs a real
       * `UsuarioModel.findByPk` and its own `bcrypt` comparison, either of
       * which a database blip can reject.
       */
      let confirmacion: { ok: boolean };
      try {
        confirmacion = await verifyOwnPassword({ id: user.id, pass: password, ip: req.ip ?? null });
      } catch (err) {
        /**
         * Neither right nor wrong — the comparison itself never finished, so
         * nothing was learned about this password. Given back so a database
         * blip does not spend a fifth of this account's whole confirm
         * budget — shared with "change my password" and "register my
         * email" — on nothing anybody typed.
         *
         * Best effort: a refund failure here does not replace the original
         * error, only logs alongside it. `next(err)` still has to carry
         * *this* failure — masking it behind the refund's own would leave
         * the caller thinking their password was somehow wrong instead of
         * that the server could not check it.
         */
        try {
          await devolverCupoDeConfirmacion(user.id);
        } catch (refundErr) {
          gateLog.error(
            { err: refundErr, id_usuario: user.id },
            "no se pudo devolver el cupo tras un fallo de verifyOwnPassword: queda cobrado hasta que expire la ventana",
          );
        }
        soltarContrasena(req);
        next(err);
        return;
      }
      if (confirmacion.ok) {
        try {
          // Right, so the charge above is given back on the spot — not
          // deferred to any response event. A correct password never costs
          // anything, which is `security.ts`'s own promise for this bucket.
          await devolverCupoDeConfirmacion(user.id);
        } catch (err) {
          soltarContrasena(req);
          next(err);
          return;
        }

        /**
         * 🔴 **Y se abre la ventana de diez minutos, sólo para una cuenta sin
         * ningún factor.** Una cuenta **con** factor llega aquí únicamente por
         * `toleraFactorIlegible` (su factor existe pero este servidor no puede
         * leerlo): sellar entonces escribiría una ventana de contraseña a
         * nombre de una cuenta con factor, que es exactamente el estado que
         * la auditoría prohíbe — `password_confirmed_at` no puede hacer de
         * factor (§5 del diseño). Esa ruta sigue costando la contraseña en
         * cada petición durante la avería.
         *
         * 🔴 **Con `await`, no con `void`.** Sin él, `next()` corre antes de
         * que el UPDATE haya llegado a la base de datos, y la siguiente
         * petición de la ventana — que el interceptor manda en cuanto vuelve
         * ésta — lee una fila todavía sin sellar y contesta 403. Es la
         * molestia que este arco existe para quitar, reaparecida por una
         * carrera de milisegundos.
         *
         * 🔴 **Y con su propio `try/catch`, que no deja caer la operación.**
         * Quien llega hasta aquí acaba de demostrar su identidad
         * correctamente: tumbarle con un 500 una escritura ya autorizada
         * porque falló un UPDATE **de comodidad** es cobrarle a esa persona un
         * problema de nuestra infraestructura. Lo que decide el caso es a qué
         * degrada cada opción. Dejar que la excepción suba al `catch` de la
         * puerta contesta 500, la operación no ocurre, y nada de lo que se ve
         * en pantalla lo explica. Registrarlo y seguir deja la ventana sin
         * abrir, así que la siguiente operación vuelve a pedir la contraseña
         * — que es **exactamente el comportamiento de antes de esta tarea**,
         * un estado que ya sabemos seguro y que la persona ya conoce. Se
         * degrada hacia lo conocido y seguro, nunca hacia el 500.
         *
         * La línea de bitácora es `warning` y no `error` por lo mismo: no ha
         * fallado ninguna comprobación de seguridad, sólo se ha perdido una
         * comodidad. Lleva la sesión dentro porque, si esto empieza a pasar
         * seguido, lo que un operador querrá contar es a cuánta gente se le
         * está pidiendo la contraseña de más.
         */
        if (!tieneFactor) {
          try {
            await sellarContrasena(user.id_sesion);
          } catch (err) {
            gateLog.warn(
              { err, id_usuario: user.id, id_sesion: user.id_sesion },
              "no se pudo abrir la ventana de reautenticación: la operación sigue, pero volverá a pedirse la contraseña",
            );
            logAction({
              id_usuario: user.id,
              action: "STEP_UP_VENTANA_NO_ABIERTA",
              entity: "Sesion",
              entity_id: null,
              detail:
                "La contraseña era correcta pero no se pudo sellar la ventana: la operación continúa y volverá a pedirse la contraseña",
              metadata: { ruta: req.originalUrl, id_sesion: user.id_sesion },
              severity: "warning",
              ip_address: req.ip ?? null,
            });
          }
        }

        /**
         * 🔴 Se borra del cuerpo antes de dejar pasar, y hay un sitio concreto
         * donde importa: `rol.controller.ts` escribe `after: req.body` **entero**
         * en la bitácora al editar un rol. Sin esta línea, una petición que
         * llegara ahí con la contraseña dentro la dejaría guardada **en claro**
         * en la tabla de auditoría, que además se pinta en una pantalla.
         *
         * Hoy esa ruta no pide contraseña por sí misma, así que sólo puede
         * llevarla si comparte ceremonia con otra que sí la pidió. Es un camino
         * estrecho y un descuido de una línea; ninguna de las dos cosas es
         * motivo para dejar la contraseña dando vueltas por los controladores,
         * que no tienen ningún uso para ella.
         */
        soltarContrasena(req);
        next();
        return;
      }

      /**
       * Wrong, and the charge above stays on the books — there is nothing
       * left to do here but say how many guesses remain.
       *
       * **It reveals nothing.** The limit is a constant in a source file, the
       * answer only ever goes to an already-authenticated caller, and it is
       * about that caller's own account. What it buys is the difference
       * between somebody who stops after the third try and somebody who walks
       * into a fifteen-minute lockout on the shared budget — a budget that
       * also holds "change my password" and "register my email", which are the
       * two screens they would go to next.
       */
      denegar(req, res, MENSAJE, MOTIVO_CONTRASENA_INCORRECTA, { intentosRestantes: cupo.restantes });
    } catch (err) {
      // The whole body is one try/catch, matching `authenticate.ts`'s own
      // reasoning exactly: this runs in front of every write this gate
      // guards, and Express 4 does not catch a rejected promise from an
      // `async` middleware — it never reaches an error handler, it just
      // leaves the request hanging until the client gives up. A `tieneAlgunFactor`
      // query against a broken connection must turn into a 500 here, not
      // into a request nobody ever answers.
      gateLog.warn({ err, url: req.originalUrl }, "fallo inesperado en requireStepUp");
      if (!res.headersSent) {
        res.status(500).json({ message: "Ocurrió un error al procesar la petición." });
      }
    }
  };

  /**
   * The options, readable off the function Express actually mounts — the same
   * shape `requirePermission` gives `permission`, and for the same reader:
   * `routeGuards.test.ts` walks the assembled app and can otherwise tell only
   * that *a* step-up gate is on a route, never which one. `STEP_UP_OPTIONS`
   * in that file is the canonical list of which options each mount carries —
   * not a count here, which is exactly the kind of comment that drifts out
   * of step with that table without anyone noticing — and without this stamp
   * a revert of any one of those mounts left every test green.
   *
   * The **resolved** locals, not the argument: `requireStepUp()` would stamp
   * `{}` and `requireStepUp({ permiteOnboarding: true })` a partial, and the
   * table comparing against them would have to spell the defaults out twice.
   * Stamping what the closure reads is the only thing that keeps the metadata
   * from drifting away from the behaviour.
   */
  Object.defineProperty(stepUpGate, "opciones", {
    // Frozen: the property cannot be reassigned, but the object behind it
    // could be edited in place, and a table that compares whole objects
    // would then read a lie that nothing in the closure shares.
    value: Object.freeze({ permiteOnboarding, toleraFactorIlegible }),
    enumerable: true,
  });
  return stepUpGate;
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
    /**
     * 🔴 Not every refusal is an incident, and until the client could answer
     * this gate, they all looked like one.
     *
     * `sin-factor-reciente` and `contraseña-requerida` are the two the server
     * says *first*, as the opening move of an ordinary ceremony: they mean
     * "the window is about to ask you for something", and the plan 4D
     * interceptor produces one of them on **every** protected operation — two
     * of them for an account that has a factor and a stale window. One
     * person saving the permission matrix would file critical lines for it.
     * Marking those critical is how a log stops being read: if everything is
     * critical, nothing is.
     *
     * The other two stay. `contraseña-incorrecta` is a failed guess against
     * somebody's own password from inside a live session — the shape of a
     * stolen cookie being tested. `estado-incompleto` is an account reaching
     * an administrative route it is barred from, which is the refusal that
     * closed a demonstrated attack (see `auth.routes.ts`). Both are worth
     * waking up for; the first two are worth counting.
     */
    severity:
      motivo === MOTIVO_SIN_FACTOR_RECIENTE || motivo === MOTIVO_CONTRASENA_REQUERIDA
        ? "warning"
        : "critical",
    ip_address: req.ip ?? null,
  });
}

function denegar(
  req: Request,
  res: Response,
  message: string,
  motivo: string,
  /**
   * Extra fields for the client, merged into the same body. Additive by
   * construction: anything that ignores them behaves exactly as before, which
   * is why they are safe to add to a contract already in use.
   */
  extra: Record<string, unknown> = {},
): void {
  registrar(req, motivo);
  // `code` is the stable class a client checks to know it must
  // re-authenticate at all — matching on the Spanish `message` instead would
  // break the day somebody improves the wording. `motivo` is what tells it
  // *how*: finish onboarding, supply a factor, type the password it never
  // sent, or retype one that was wrong — different remedies a single `code`
  // cannot distinguish. The `MOTIVO_*` constants at the top of this file are
  // the whole vocabulary; each carries its own comment saying when it is sent.
  // 🔴 `extra` last, but it can never overwrite the three above: nothing passes
  // `code`, `motivo` or `message` in it, and a future caller that tried would
  // be silently redefining the contract this whole file is about. The fields
  // it does carry today are `metodos` and `intentosRestantes`.
  res.status(403).json({ message, code: CODIGO_STEP_UP, motivo, ...extra });
}
