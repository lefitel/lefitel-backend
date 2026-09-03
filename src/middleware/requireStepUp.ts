import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyOwnPassword } from "../auth/credentials.js";
import {
  tieneAlgunFactor,
  hayFactorVerificable,
  metodosDeReautenticacion,
  type MetodoReautenticacion,
} from "../auth/factorInventory.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { passwordConfirmLimiter, passwordConfirmKey, PASSWORD_CONFIRM_MESSAGE } from "./loginLimiters.js";
import {
  STEP_UP_WINDOW_MINUTES,
  STEP_UP_PASSWORD_FIELD,
  PASSWORD_CONFIRM_LIMIT,
} from "../config/security.js";

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
 * this same key right after this gate. The very first version of this file
 * charged unconditionally, before comparing anything, and marked a wrong
 * answer with a flag `confirmCostsNothing` read as "this one 403 costs" —
 * with no way to say the opposite for a *right* answer. So on a request
 * where this gate's own check was correct and `chargeConfirmBudgetOnSelfChange`'s
 * own `oldPass` check was wrong, both charges landed on the same final 401
 * and **neither** refunded — the right answer had no flag telling
 * `confirmCostsNothing` to let it go, so it read the same as the wrong one.
 * Measured against a real run: every such attempt cost 2, not 1, so the
 * nominal five-guess budget was gone by the third attempt instead of the
 * sixth — closer to halved than merely trimmed by one. Never charging on a
 * right answer removes the charge that caused it — there is nothing left on
 * the books for a wrong answer's own charge to share a verdict with.
 * `confirmCostsNothing` in `loginLimiters.ts` still reads a flag this gate
 * sets on a wrong answer, since that answer is a uniform 403 rather than the
 * 401 the rest of that bucket's callers use — and it still consumes that
 * flag on read, as defence in depth against a future change reintroducing
 * two charges in one request, even though nothing in this file does that
 * today.
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
 * The fourth, and the only one a route has to opt into: `exigeContrasena`
 * asked for a password and the body carried none.
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
   * `ONBOARDING_EXTRA` in `auth/sessionState.ts` opens six prefixes, and
   * **five** of them are that: the email, TOTP, WebAuthn registration, the
   * stored credentials, the recovery codes. The sixth is `/api/auth/sessions`,
   * which is not — the write behind it takes this gate with the option **off**,
   * and refusing `onboarding` there is the whole of what closed a demonstrated
   * attack (see `auth.routes.ts`). That is the shape of this option, stated
   * against the one prefix that disproves the lazy version of it: it is decided
   * per route, never per state, and there is no reading of "`onboarding` may
   * reach it" that implies "the gate should let it through".
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
   * a stricter gate, it is a sealed room: `/auth/totp/*` and
   * `/auth/webauthn/register/*` answer 409 until the address is verified (§5
   * of the design), the address cannot be registered without this route, and a
   * registered factor is the only thing that ends `onboarding`. Every account
   * reaches that state on its own, `MFA_GRACE_DAYS` after its first login —
   * see `estadoInicialDeSesion` — so this would be the whole payroll, with no
   * way out from inside the API. Plan 4B will need the same option on the
   * registration routes for the same reason.
   *
   * **What it does not do.** `parcial` is still refused: that state means the
   * account *has* a factor and has not proved it on this session, so the way
   * through is proving it, not typing a password. And an `onboarding` session
   * whose account does have a factor — which `estadoEfectivo` can produce for
   * a session opened before the deadline and predating the registration — is
   * refused one line further down by the factor check, which does not consult
   * this option at all. So what this ever lets through is the case where the
   * account has nothing to prove: the same treatment, and the same bitácora
   * line, a factor-less `completa` session already gets.
   */
  permiteOnboarding?: boolean;

  /**
   * Demand the password from an account that has no factor at all, instead of
   * letting the write through. Off by default, so every route mounted today
   * behaves exactly as it did.
   *
   * **For the routes that register or remove a credential**, which plan 4B is
   * about to mount. The skip below is correct for everything mounted today and
   * becomes a permanent lockout the moment a route can create a factor — see
   * its own comment for the sequence, which its author described without
   * noticing where it led.
   *
   * Independent of `permiteOnboarding`: that one says *which states* reach the
   * factor-less branch, this one says *what proof* that branch accepts. A route
   * that wants both asks for both.
   */
  exigeContrasena?: boolean;

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
   * **Why this is not a weakening.** The one route that reads it also carries
   * `exigeContrasena`, so what replaces the impossible code is the password —
   * something a stolen cookie does not have. And demanding proof of a factor
   * the server itself reports as unreadable is not a stricter gate, it is an
   * unsatisfiable one: the same shape as the outage the factor-less branch
   * below already exists to avoid.
   *
   * **Deliberately narrow, and it has to be.** Read by one route rather than
   * applied to every route that carries the gate, because everywhere else the honest answer to a
   * broken key is still "prove your factor or spend a recovery code" — those
   * codes are bcrypt, never encrypted, so they survive exactly this failure.
   * Widening it would mean that during a configuration fault the password
   * alone reaches every sensitive write in the ERP. The narrow door is the
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
 * `next()`, and both `next(err)` — not only the one that verified it.**
 *
 * Until Task 10 of plan 4C it left on exactly one. The fresh-window shortcut
 * passed it through untouched, and a request can carry the field there: the
 * client's interceptor serialises concurrent refusals onto one ceremony and
 * injects the same password into every retried body, so a route that never
 * asked for it receives it the moment it shares a ceremony with one that did.
 * Downstream, `rol.controller.ts` writes `req.body` whole into the bitácora as
 * `after` — a table rendered on a screen. An administrator's plaintext
 * password in `bitacora.metadata` was one unlucky pair of tabs away.
 *
 * **Honestly: D6 itself closed that particular hole**, by putting
 * `exigeContrasena` on every `rol` route so the shortcut is no longer reachable
 * there. What this rule protects now is the two mounts that keep the plain
 * gate, any mount added later, and the error handler — none of which log the
 * body today, and the next Sentry hook or `req.body` in a log line would. A
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
  exigeContrasena = false,
  toleraFactorIlegible = false,
}: OpcionesStepUp = {}): RequestHandler {
  /**
   * 🔴 La combinación que convertiría esta puerta en un pase libre, rechazada
   * al montar la ruta y no en producción.
   *
   * `toleraFactorIlegible` hace que un factor que el servidor no puede leer
   * deje de exigirse, y cae a la rama de la contraseña. Si esa rama no pide
   * contraseña —`exigeContrasena` apagado— lo que queda es `next()` con una
   * línea de bitácora, o sea una escritura sensible servida sólo con la cookie.
   * Y peor: esa línea afirmaría «la cuenta no tiene ningún factor registrado»,
   * que sería mentira, porque sí lo tiene y sólo está ilegible.
   *
   * Hoy la única ruta que activa la opción lleva las dos, así que no hay
   * agujero. Esto es lo que impide que deje de ser verdad en un descuido: un
   * error al arrancar es imposible de pasar por alto, y una comprobación en
   * tiempo de petición llegaría tarde.
   */
  if (toleraFactorIlegible && !exigeContrasena) {
    throw new Error(
      "requireStepUp: `toleraFactorIlegible` exige `exigeContrasena`. Sin la contraseña, " +
        "una cookie robada bastaría para una escritura sensible cuando la clave del TOTP falla.",
    );
  }

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
      // **This refuses somebody for real, on one route today.** It used to be
      // unreachable — every mount lived under `/api/usuario`, `/api/rol` or
      // `/api/permisos`, none of which the `parcial` or `onboarding`
      // allowlists in `auth/sessionState.ts` open, so `authenticate` had
      // already answered 401 or 403 before this gate ran. `DELETE
      // /api/auth/sessions/:id` changed that: `ONBOARDING_EXTRA` opens
      // `/api/auth/sessions`, so an `onboarding` session reaches this line,
      // and this line is the only thing that stops it. That is the whole of
      // what closed the attack an audit demonstrated — see the route's own
      // comment in `auth.routes.ts`.
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
       * A fresh proof is enough on its own for every route mounted today, and
       * **deliberately not enough** for one that asked for `exigeContrasena`:
       * there the two are wanted together, something held and something known.
       *
       * The case that forces this, and it is not hypothetical — plan 4B seals
       * this very column when somebody spends a **recovery code**. Without this
       * clause, whoever holds only the printed sheet spends one code, lands
       * inside the window, and registers their own factor with no password at
       * all — which is exactly the bound `exigeContrasena` exists to draw. The
       * option has to mean one thing: this route wants the password, always.
       *
       * An account that has a factor and no fresh proof still gets refused
       * below and has to prove it first. So on these routes the ceremony is two
       * steps, in this order: prove the factor, then type the password.
       */
      if (satisfecho && !exigeContrasena) {
        soltarContrasena(req);
        next();
        return;
      }

      // Asked before the password is even looked at: with a factor on the
      // account and nothing fresh to show for it, no password is an acceptable
      // answer here, and checking it first would spend a bcrypt comparison to
      // reach the same refusal.
      //
      // Skipped when the window is already satisfied — that can only be reached
      // with `exigeContrasena` on, and there the factor has just been proved,
      // so asking whether one exists is both answered and beside the point.
      if (!satisfecho && (await tieneAlgunFactor(user.id))) {
        // The factor exists. Whether it can be *proved* is a second question,
        // and only the route that undoes a dead factor ever asks it — see
        // `toleraFactorIlegible`. Asked second, and only when that option is
        // on, so the ordinary path still pays for one pair of COUNTs rather
        // than two: this is the hot path of every gated write.
        if (!toleraFactorIlegible || (await hayFactorVerificable(user.id))) {
          // 🔴 `exigeContrasena` travels with this refusal, and the whole
          // ceremony depends on it. On these routes the server demands two
          // things in a fixed order — prove the factor, *then* type the
          // password — and it only ever names one of them per refusal. A
          // client that cannot see the second one coming has no choice but to
          // ask twice: one window for the code, and, after a round trip, a
          // second window for the password, on the two most delicate
          // operations there are. Saying it now is what lets one window ask
          // for both. Absent means false, so nothing that ignores it changes.
          // 🔴 **And `metodos` names what the window has to draw.** This
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
          denegar(req, res, MENSAJE, MOTIVO_SIN_FACTOR_RECIENTE, {
            exigeContrasena,
            ...(metodos ? { metodos } : {}),
          });
          return;
        }
        // Falls through to the password branch below, which that one route
        // mounts with `exigeContrasena` — enforced at mount time above, so
        // this can never reach the free skip.
        //
        // 🔴 Y queda constancia, porque es un evento que un operador querría
        // poder contar durante una avería de claves: el servidor acaba de
        // aceptar una contraseña **en lugar de** un factor que él mismo declara
        // ilegible. Sin esta línea la operación no aparecía en ninguna parte.
        logAction({
          id_usuario: user.id,
          action: "STEP_UP_FACTOR_ILEGIBLE",
          entity: "Sesion",
          entity_id: null,
          detail:
            "La cuenta tiene un factor que este servidor no puede verificar: se acepta la contraseña en su lugar",
          metadata: { ruta: req.originalUrl, id_sesion: user.id_sesion },
          severity: "critical",
          ip_address: req.ip ?? null,
        });
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
       * account registers a factor — or, since plan 4E, verifies its email
       * address, which is a factor on its own — `tieneAlgunFactor` above
       * starts answering `true` and this branch stops being reached for it at
       * all — the block above already refuses outright rather than falling
       * here. Until then, the bitácora line below is the whole of what this
       * skip costs: a record that a sensitive write ran without the extra
       * proof, on an account that had no extra proof to give.
       *
       * **What that means on the `exigeContrasena` routes, said once so nobody
       * is surprised on deploy day (plan 4E, §1.2.1 of its design):** an
       * account whose only factor is its verified address is refused above
       * with `metodos: ["correo"]` and `exigeContrasena: true`, so editing a
       * user, a role or the permission matrix costs it an email code *and* the
       * password, once per `STEP_UP_WINDOW_MINUTES`. Isaias chose that over the
       * alternative — letting the password alone through when the only factor
       * is the email — because the alternative leaves a stolen session plus the
       * password one step from the matrix, which is what `exigeContrasena`
       * exists to prevent.
       *
       * **And that self-closing property is the attack, not the reassurance.**
       * The window in which this branch is still open is exactly the window in
       * which somebody registers a factor — so the sentence above describes the
       * mechanism and stops one step short of where it leads. Whoever holds a
       * stolen session cookie and not the password calls the registration route
       * with an empty body, passes here, and confirms their own factor. From
       * that instant `tieneAlgunFactor` answers `true`, so this gate stops
       * offering *the owner* the password route, and the owner cannot even
       * delete the attacker's factor. Their next login opens `parcial`, which
       * is left only by proving the attacker's factor; changing the password
       * does not help, and `logout-all` revokes sessions, not credentials.
       *
       * That is why `exigeContrasena` exists and why **every route that
       * registers or removes a credential must be mounted with it on**. It is
       * not a hardening knob to turn on later: on those routes, off is a
       * permanent lockout.
       *
       * A caller that *does* send `stepup_password` — the shape the later
       * frontend plan will use, and the only shape this ever refuses for a
       * factor-less account — still has to get it right; see below.
       */
      const password = (req.body as Record<string, unknown> | undefined)?.[STEP_UP_PASSWORD_FIELD];
      if (typeof password !== "string" || password === "") {
        // The route asked for the password and none came. Refused for free:
        // nothing was compared, so no bcrypt was spent and there is nothing to
        // charge — and charging here would let a client that simply forgets
        // the field burn somebody's whole confirm budget, locking them out of
        // the very screen that would fix it.
        if (exigeContrasena) {
          denegar(req, res, MENSAJE_CONTRASENA_REQUERIDA, MOTIVO_CONTRASENA_REQUERIDA);
          return;
        }

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
        // Reached only with the field absent, so there is nothing to drop —
        // called anyway, so that the rule "every `next()` drops it" has no
        // exception for the next reader to reason about.
        soltarContrasena(req);
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
      /**
       * Kept from that same read so a wrong answer can tell the caller how
       * many guesses are left — see the `denegar` call at the end of this
       * branch. Reading it again after the charge would cost a second round
       * trip to say something this value already knows.
       */
      let gastados: number;
      try {
        const info = await passwordConfirmLimiter.getKey(passwordConfirmKey(req));
        gastados = info?.totalHits ?? 0;
        agotado = gastados >= PASSWORD_CONFIRM_LIMIT;
      } catch (err) {
        soltarContrasena(req);
        next(err);
        return;
      }
      if (agotado) {
        registrar(req, "presupuesto-agotado");
        // The exact same sentence the real limiter itself answers with when it
        // is the one deciding "spent" — imported rather than retyped, so this
        // early read-only refusal can never drift from that one.
        res.status(429).json({ message: PASSWORD_CONFIRM_MESSAGE });
        return;
      }

      const confirmacion = await verifyOwnPassword({ id: user.id, pass: password, ip: req.ip ?? null });
      if (confirmacion.ok) {
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

      /**
       * How many guesses are left, counted from the read above plus the charge
       * this branch just made.
       *
       * **It reveals nothing.** The limit is a constant in a source file, the
       * answer only ever goes to an already-authenticated caller, and it is
       * about that caller's own account. What it buys is the difference
       * between somebody who stops after the third try and somebody who walks
       * into a fifteen-minute lockout on the shared budget — a budget that
       * also holds "change my password" and "register my email", which are the
       * two screens they would go to next.
       *
       * `Math.max` because the two reads are not one atomic operation: a
       * concurrent request can charge between them, and a negative number on
       * screen is worse than a zero.
       */
      const intentosRestantes = Math.max(0, PASSWORD_CONFIRM_LIMIT - gastados - 1);
      denegar(req, res, MENSAJE, MOTIVO_CONTRASENA_INCORRECTA, { intentosRestantes });
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
   * that *a* step-up gate is on a route, never which one. Task 10 of plan 4C
   * turned `exigeContrasena` on across eleven administrative mounts, and
   * without this a revert of any one of them left every test green.
   *
   * The **resolved** locals, not the argument: `requireStepUp()` would stamp
   * `{}` and `requireStepUp({ exigeContrasena: true })` a partial, and the
   * table comparing against them would have to spell the defaults out twice.
   * Stamping what the closure reads is the only thing that keeps the metadata
   * from drifting away from the behaviour.
   */
  Object.defineProperty(stepUpGate, "opciones", {
    // Frozen: the property cannot be reassigned, but the object behind it
    // could be edited in place, and a table that compares whole objects
    // would then read a lie that nothing in the closure shares.
    value: Object.freeze({ permiteOnboarding, exigeContrasena, toleraFactorIlegible }),
    enumerable: true,
  });
  return stepUpGate;
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
      soltarContrasena(req);
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
    /**
     * 🔴 Not every refusal is an incident, and until the client could answer
     * this gate, they all looked like one.
     *
     * `sin-factor-reciente` and `contraseña-requerida` are the two the server
     * says *first*, as the opening move of an ordinary ceremony: they mean
     * "the window is about to ask you for something", and the plan 4D
     * interceptor produces one of them on **every** protected operation — two
     * of them on the routes that want both the factor and the password. One
     * person saving the permission matrix would file two critical lines.
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
  // break the day somebody improves the wording. `motivo` is which of the
  // three (`MOTIVO_ESTADO_INCOMPLETO` / `MOTIVO_SIN_FACTOR_RECIENTE` /
  // `MOTIVO_CONTRASENA_INCORRECTA`) is what tells it *how*: finish
  // onboarding, supply a factor, or retype the password — three different
  // remedies a single `code` cannot distinguish.
  // 🔴 `extra` last, but it can never overwrite the three above: nothing passes
  // `code`, `motivo` or `message` in it, and a future caller that tried would
  // be silently redefining the contract this whole file is about. The two
  // three fields it does carry today are `exigeContrasena`, `metodos` and
  // `intentosRestantes`.
  res.status(403).json({ message, code: CODIGO_STEP_UP, motivo, ...extra });
}
