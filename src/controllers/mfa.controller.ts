// Proving the second factor. Two endpoints, one file, because both endpoints
// answer the same question — "does this TOTP code or this recovery code
// belong to the caller's own account, right now?" — for two different
// sessions in two different states.
//
// `verify` (Task 7 of `docs/plans/2026-09-01-factores-mfa.md`) is called from
// a `parcial`/`onboarding` session that has not proved anything yet, and its
// success lifts that session to `completa`. `stepup` (Task 17) is called from
// a live `completa` session whose ten-minute step-up window
// (`STEP_UP_WINDOW_MINUTES`) has lapsed, and its success re-stamps
// `mfa_satisfied_at` without touching `estado` at all — there is nothing to
// lift, the session was never anything but complete.
//
// **Three rules bind everything in this file, and they come from the
// auditoría, not from taste:**
//
// 1. **The factor is always looked up by `req.user.id` — never by anything in
//    the body** (hallazgo C15). `/mfa/verify` in particular is called from a
//    session that has proved nothing yet, which is the single cheapest place
//    in the whole plan to get this wrong: a factor found by a body-supplied
//    id would let a stranger's TOTP satisfy the caller's own session.
// 2. **A wrong code costs exactly what a wrong password costs** (hallazgo
//    C3). Today a correct login is free in every rate-limit bucket
//    (`costsNothing`/`skipSuccessfulRequests` in `loginLimiters.ts`), and
//    `failed_attempts` only ever moves on a wrong *password*. Without this
//    file reusing that same counter, the loop "free login → five guesses →
//    session destroyed → free login again" turns a six-digit code with ±1
//    step of tolerance (three valid values in a million) into a few hundred
//    thousand requests — hours, not years, with twenty connections. Every
//    failure below — a wrong code, a corrupt row, a replay, a code that only
//    matches inside the wider clock-skew window — arms the *same*
//    `usuarios.failed_attempts` / `locked_until` pair `verifyCredentials`
//    already uses, through `siguienteBloqueo`/`estaBloqueada`
//    (`middleware/loginLimiters.ts`). It is the same machine, reused, not a
//    second one built beside it.
// 3. **One answer for every way this can fail** (hallazgo B12). A mistyped
//    code, a factor row whose `auth_tag` no longer authenticates, and a row
//    written under a key this deployment no longer holds all answer with the
//    exact same status and the exact same sentence — `descifrar` throwing is
//    caught here and folded into "invalid", never surfaced. `errorShape.test.ts`
//    only patrols `res.status(500)`, so nothing there would catch a handler
//    that leaked `err.message` into a 400 or a 401; the dedicated test for
//    that lives in `mfa.controller.test.ts`, named after the rule itself.
//
// **The clock-skew diagnosis (§6 of the spec, hallazgo C12) is real but never
// visible in the response.** The design spec's own retry-at-±10-steps exists
// so the server can eventually say "your phone's clock is off" — but doing
// that *in this response* is exactly what hallazgo C12 forbids: it would (a)
// widen the accepted window from 3 codes in a million to 21, seven times
// cheaper to brute-force, the moment the diagnostic path is allowed to
// accept, and (b) confirm a partial guess to whoever is guessing, the moment
// the wording differs from an ordinary wrong code. So the wider window here
// only ever *decides whether to write a bitácora line*; it never changes the
// status, the message, or whether the attempt counts against the lockout.
// Rule 3 of hallazgo C12 — "que exima del bloqueo por cuenta, si acaso; del
// cubo, nunca" — is answered on the conservative side: this file does not
// build any exemption at all. Every failure, skew-diagnosed or not, charges
// `failed_attempts` identically; the plan makes the exemption optional
// ("si acaso"), and no test asks for it.
//
// **Where the row's id and last-accepted step come from.** `totpStore.ts`
// exports `leerSecretoConfirmado`, which returns only the decrypted string —
// enough to *read* the secret, not enough to call `sellarPaso(id_factor, …)`
// or `pasoYaUsado(ultimo_paso, …)`, both of which this file needs. Rather
// than add a second, wider export to a module this plan lists as already
// "terminado y verificado esta noche" (off limits tonight), `leerFactorTotp`
// below reads the row itself through `FactorTotpModel.unscoped()` — the same
// pattern `mfaKeyCheck.ts` and `rotateMfaKey.ts` already use for the same
// reason — and decrypts it with the two primitives that *are* meant to be
// reused outside `totpStore.ts`: `aadDeFactorTotp` (so the AAD format has
// exactly one source, per that module's own header) and `mfaCrypto.ts`'s
// `descifrar`. Worth a real `totpStore.ts` export the next time that file is
// open; noted rather than done, since Task 7's own file list does not
// include it and both callers of this logic already live in this one file.

import type { Request, Response } from "express";
import { Op } from "sequelize";
import * as OTPAuth from "otpauth";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { SesionModel } from "../models/sesion.model.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { descifrar } from "../auth/mfaCrypto.js";
import { aadDeFactorTotp, sellarPaso, pasoYaUsado } from "../auth/totpStore.js";
import { gastarCodigo } from "../auth/recoveryCodeStore.js";
import { tieneAlgunFactor } from "../auth/factorInventory.js";
import { promoverSesion, sellarPruebaDeFactor } from "../auth/sessionPromotion.js";
import type { FuenteMfa } from "../auth/sessionState.js";
import { estaBloqueada, siguienteBloqueo } from "../middleware/loginLimiters.js";
import { acunarDispositivo, setRememberedDeviceCookie } from "../auth/rememberedDeviceIssue.js";
import { REMEMBER_DEVICE_FIELD, LOCKOUT_AFTER_FAILURES } from "../config/security.js";
import { permissionsFor } from "../permissions/store.js";
import bcryptjs from "bcryptjs";
import type { Transaction } from "sequelize";
import { fillerHash } from "../config/security.js";
import { cobrarIntento, liquidarCodigo } from "../auth/emailCodeStore.js";
import { admitirIntentoDeCorreo } from "../auth/emailCodeVerifyBudget.js";
import { logAction } from "../utils/logAction.js";
import type { BitacoraAction } from "../utils/bitacoraVocabulary.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const mfaLog = log("mfa");
const handler = makeHandler(mfaLog);

/** The one body field both endpoints read a code from — a TOTP digit string,
 *  a recovery code or, since plan 4E, the six digits sent by email. */
const CAMPO_CODIGO = "codigo";

/**
 * Which kind of code the body carries — plan 4E. Optional: **absent means
 * what it always meant**, six digits are a TOTP and anything else a recovery
 * code, so no client in flight changes behaviour. Present, it picks the arm
 * whatever the shape says, which is the only way an email code (six digits,
 * like a TOTP) can reach its own check. `"passkey"` is a method the step-up
 * window may *offer* (`MetodoReautenticacion`) but not one these two routes
 * take — the ceremony has its own endpoints — so it is refused here like any
 * unknown value, before anything is spent.
 */
const CAMPO_METODO = "metodo";
type Metodo = "totp" | "codigo" | "correo";
const METODOS = new Set<string>(["totp", "codigo", "correo"]);

/** Exactly six ASCII digits: what `otpauth`'s default `digits: 6` produces
 *  and the only shape that is ever attempted as a TOTP code. Anything else —
 *  including the 26-character recovery codes `recoveryCodeStore.ts` issues —
 *  falls to the recovery-code path below. The two never overlap: a recovery
 *  code is always 26 characters (`recoveryCodeStore.ts`'s `LONGITUD_CODIGO`),
 *  never six. */
const FORMA_TOTP = /^\d{6}$/;

/** ±1 step (30 s each way): the window a code is actually *accepted* in —
 *  hallazgo C10 and §6 of the design spec. */
const VENTANA_ACEPTACION = 1;

/** ±10 steps: the wider window `otpauth.TOTP.validate` is asked to search so
 *  a genuine clock-skew case can be told apart from garbage — diagnostic
 *  only, per hallazgo C12. Never the window a code is accepted in. */
const VENTANA_DIAGNOSTICO = 10;

/**
 * Exported, not just used internally: `mfa.controller.test.ts` compares
 * against this constant by name rather than a hardcoded string, so a
 * reworded message cannot silently make the B12 "same response for three
 * causes" test pass for the wrong reason.
 */
export const CODIGO_MFA_INVALIDO = "Código incorrecto o ya utilizado.";
export const CODIGO_REQUERIDO =
  "Introduce el código de tu aplicación de autenticación, el código que te enviamos por correo " +
  "o uno de tus códigos de recuperación.";
export const METODO_DESCONOCIDO = "Método de verificación desconocido.";
export const DEMASIADOS_INTENTOS_CORREO =
  "Demasiados intentos con el código por correo. Espera unos minutos o usa otro método.";
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";

/**
 * Thrown, and only ever caught, inside the recovery-code transaction below —
 * never let past it. It is how "the code was valid but there was nothing
 * left to promote/re-seal" rolls back the `used_at` write that already
 * happened in the same transaction, instead of leaving somebody down one of
 * ten codes for a session that gained nothing from it (Task 11 Step 4: "si
 * el consumo cuaja y el sellado no, la persona gastó un código para nada").
 */
class NadaQueSellar extends Error {}

/** Who the caller is, per `authenticate` — never trusted from the body. */
function callerOf(req: Request): NonNullable<Request["user"]> | null {
  return req.user ?? null;
}

/**
 * The `metodo` field, validated: `undefined` when absent, the value when it is
 * one of the three, `null` when it is anything else.
 */
function metodoDe(body: unknown): Metodo | undefined | null {
  const crudo = (body as Record<string, unknown> | undefined)?.[CAMPO_METODO];
  if (crudo === undefined) return undefined;
  return typeof crudo === "string" && METODOS.has(crudo) ? (crudo as Metodo) : null;
}

/**
 * The email-code arm, shared by `verify` and `stepup` — plan 4E, design §3.5.
 * What differs between the two is only how the session is sealed, and the
 * caller passes that in.
 *
 * The order is the design:
 *
 * 1. **Shape, then the bucket, before any database work.** Six digits or
 *    nothing — a recovery code sent with `metodo: "correo"` costs no bcrypt.
 *    `admitirIntentoDeCorreo` bounds what one account can make the server
 *    compute per quarter hour; see `emailCodeVerifyBudget.ts`.
 * 2. **Charge the attempt, then compare.** `cobrarIntento` is one row-locked
 *    `UPDATE … RETURNING`: the increment, the burn at the cap and the read of
 *    the hash are a single statement, so N concurrent guesses are N charged
 *    attempts and from the fifth on none of them sees the hash. Outside any
 *    transaction, because what follows is bcrypt.
 * 3. **Compare, uniformly.** With no live code — none, expired, spent, burned,
 *    address changed — the compare runs against `fillerHash()`, so "there is
 *    no code" takes as long as "wrong code". The repo measured that gap in the
 *    login and closes it the same way (`credentials.ts`).
 * 4. **Spend and seal together.** `liquidarCodigo` marks the row by id while
 *    it is still unspent — a concurrent request with the same correct code
 *    loses here, not at the compare — and the seal runs in the same
 *    transaction; when the seal finds no session (`NadaQueSellar`, the shape
 *    the recovery-code arm already has) the spend rolls back with it and the
 *    code stays usable. **The last allowed attempt is the exception**: the
 *    charge that reaches the cap burns the row in the statement that read
 *    the hash (`agotado`), so a correct last code seals without spending —
 *    spending would find that burn and call it a loss. An audit caught the
 *    first draft answering the correct fifth code as wrong, and locking the
 *    account on it. The charged attempt itself is never rolled back: a
 *    correct code that finds no session to seal costs one attempt, as the
 *    recovery-code arm's does.
 *
 * Returns which of the four outcomes happened; the caller maps them to the
 * one uniform 400 (`"forma"`, `"invalido"`), the 429 (`"cubo"`), or success.
 */
async function probarCodigoDeCorreo(
  id_usuario: number,
  crudo: string,
  sellar: (transaction: Transaction) => Promise<boolean>,
): Promise<"ok" | "forma" | "cubo" | "invalido"> {
  if (!FORMA_TOTP.test(crudo)) return "forma";
  if (!admitirIntentoDeCorreo(id_usuario)) return "cubo";

  const cobrado = await cobrarIntento(id_usuario);
  const coincide = await bcryptjs.compare(crudo, cobrado ? cobrado.codigo_hash : await fillerHash());
  if (!cobrado || !coincide) return "invalido";

  try {
    await sequelize.transaction(async (transaction) => {
      // Burned by the charge itself on the last allowed attempt: nothing
      // left to spend, and spending would report its own burn as a loss.
      if (!cobrado.agotado && !(await liquidarCodigo(cobrado.id, { transaction }))) throw new NadaQueSellar();
      if (!(await sellar(transaction))) throw new NadaQueSellar();
    });
  } catch (err) {
    if (!(err instanceof NadaQueSellar)) throw err;
    return "invalido";
  }
  return "ok";
}

interface FilaFactorTotp {
  id: number;
  secreto_cifrado: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  ultimo_paso: string | null;
}

/**
 * This account's confirmed TOTP factor, decrypted — or `null` for "nothing
 * to check against", which covers three different reasons on purpose and
 * without telling them apart: no confirmed row at all (the account's only
 * factor is a passkey, or none), a row whose `auth_tag` no longer
 * authenticates, and a row whose `key_version` names a key this process does
 * not hold. Hallazgo B12: every one of those has to look identical from the
 * outside, and folding them into one `null` here is what makes that
 * automatic for every caller below instead of something each has to
 * remember.
 */
async function leerFactorTotp(id_usuario: number): Promise<FilaFactorTotp | null> {
  const fila = await FactorTotpModel.unscoped().findOne({
    where: { id_usuario, confirmed_at: { [Op.ne]: null } },
  });
  if (!fila) return null;
  const datos = fila.get() as FilaFactorTotp;
  return datos;
}

async function secretoDe(fila: FilaFactorTotp, id_usuario: number): Promise<string | null> {
  try {
    return descifrar(
      {
        ciphertext: fila.secreto_cifrado,
        iv: fila.iv,
        auth_tag: fila.auth_tag,
        key_version: fila.key_version,
      },
      aadDeFactorTotp(fila.id),
    );
  } catch (err) {
    // Never reaches a response — see the module header, hallazgo B12. Logged
    // here so an operator can tell "somebody mistyped a code" apart from
    // "this row or this key is actually broken" without either fact ever
    // reaching the caller. `error`, not `warn` (hallazgo F5/A5/C-4): a row
    // this process cannot open — a rotated key, an orphaned `key_version`, a
    // partial restore — is the server's fault, not a shrug-worthy user typo,
    // and it is the one cause of "invalid code" this file can and should
    // surface to whoever watches the logs, since `verify`/`stepup` below
    // deliberately never charge the account's lockout budget for it.
    mfaLog.error({ err, id_usuario, id_factor: fila.id }, "no se pudo descifrar el factor TOTP");
    return null;
  }
}

/** What checking a TOTP code actually found — never just "yes or no".
 *  `fallaCriptografica` is the one bit `verify`/`stepup` need and `boolean`
 *  alone could not carry: whether the failure was a crypto/key problem this
 *  process caused, as opposed to a wrong code, a replay, or a diagnostic-only
 *  match. Hallazgo F5/A5/C-4 — see `secretoDe` above and both callers below. */
interface ResultadoTotp {
  valido: boolean;
  fallaCriptografica: boolean;
}

const NO_VALIDO: ResultadoTotp = { valido: false, fallaCriptografica: false };

/**
 * Check a TOTP code against this account's confirmed factor, sealing the
 * step it actually matched on success.
 *
 * **Order matters, and it is hallazgo C10 and C12 both enforced in one
 * place.** One `validate` call searches ±`VENTANA_DIAGNOSTICO` steps, so a
 * match can land anywhere in that range; the anti-replay check
 * (`pasoYaUsado`) runs on *whichever* step matched, before anything decides
 * whether that match is inside the acceptance window or only in the wider
 * diagnostic one — "el anti-repetición va antes que el diagnóstico". Without
 * that order, a stale code that was accepted minutes ago and has since
 * drifted outside ±1 relative to *now* would read as fresh evidence of clock
 * skew instead of the replay it actually is.
 *
 * Only a match inside ±`VENTANA_ACEPTACION` is ever accepted. A match only in
 * the wider window is logged — once, and only when it is not itself a
 * replay — as a diagnostic signal for §6's clock-skew message, and then
 * refused exactly like any other wrong code: same status, same message, same
 * charge against the lockout (hallazgo C12, rules 1 and 3).
 *
 * **`pasoYaUsado` here is a cheap pre-check, never the final word (hallazgo
 * F4/C-3/A-8).** It reads a snapshot of `ultimo_paso` taken a moment ago by
 * `leerFactorTotp`; a step it already calls "used" cannot un-become unused,
 * so it is safe as a fast reject and as the gate for the diagnostic log. But
 * two requests carrying the same code can both read that snapshot *before*
 * either one writes, both compute `repetido = false`, and both reach
 * `sellarPaso` believing they are first. `sellarPaso`'s own `WHERE` is what
 * actually decides that atomically; its returned count of `0` means exactly
 * what `pasoYaUsado` returning `true` means, and is treated identically.
 */
async function verificarTotp(id_usuario: number, codigo: string, ip: string | null): Promise<ResultadoTotp> {
  const fila = await leerFactorTotp(id_usuario);
  if (!fila) return NO_VALIDO;
  const secreto = await secretoDe(fila, id_usuario);
  if (secreto === null) return { valido: false, fallaCriptografica: true };

  const secret = OTPAuth.Secret.fromBase32(secreto);
  const timestamp = Date.now();
  const counterActual = OTPAuth.TOTP.counter({ timestamp });
  const delta = OTPAuth.TOTP.validate({ token: codigo, secret, timestamp, window: VENTANA_DIAGNOSTICO });
  if (delta === null) return NO_VALIDO; // No match anywhere in ±10 steps: garbage.

  const pasoCandidato = BigInt(counterActual + delta);
  const repetido = pasoYaUsado(fila.ultimo_paso, pasoCandidato);

  if (Math.abs(delta) > VENTANA_ACEPTACION) {
    // Diagnostic range only. Never accepted — hallazgo C12 rule 1 — and the
    // message never says so — rule 2. `!repetido` guards the log: a stale,
    // already-sealed step surfacing here as time moves on is not new
    // evidence of anything, it is the anti-replay rule doing its job one
    // window later.
    if (!repetido) {
      logAction({
        id_usuario,
        action: "MFA_CLOCK_SKEW_DETECTED",
        entity: "Usuario",
        entity_id: id_usuario,
        detail: "Un código TOTP encajó fuera de la ventana normal de ±1 paso: posible reloj desincronizado",
        metadata: { delta_pasos: delta },
        severity: "info",
        ip_address: ip,
      });
    }
    return NO_VALIDO;
  }

  if (repetido) return NO_VALIDO;

  const selladas = await sellarPaso(fila.id, pasoCandidato);
  if (selladas === 0) return NO_VALIDO; // Lost the race — someone else sealed it first.
  return { valido: true, fallaCriptografica: false };
}

/**
 * The account-level lockout, reused rather than reinvented (hallazgo C3):
 * the exact same `failed_attempts` / `locked_until` pair, the exact same
 * `siguienteBloqueo` arithmetic `verifyCredentials` (`auth/credentials.ts`)
 * already uses for a wrong password. What is duplicated here is only the
 * glue — increment, re-read, conditionally lock, log — because
 * `credentials.ts` exports no standalone version of it to call instead; the
 * throttling math itself is imported, not rewritten.
 */
/**
 * @returns how many wrong answers are left before the account locks, or `null`
 * when that cannot be established (the row vanished mid-request). `0` means
 * this failure was the one that locked it.
 *
 * **Why it is returned at all.** Five wrong codes lock the whole ERP account —
 * 1, 2, 4, 8, up to 15 minutes — and until this returned something, nothing on
 * screen said so. Worse, every way to fail answers the same sentence ("Código
 * incorrecto o ya utilizado"), and once locked, the *login* answers "Usuario o
 * contraseña incorrectos", which is indistinguishable from mistyping a
 * password. So somebody with a phone whose clock has drifted — enough on its
 * own, `verificarTotp` refuses outside ±1 step — walks from "my code is not
 * working" to "I cannot log in at all" without ever reading a warning, and the
 * button that lifts the lock is one an administrator has to press.
 */
async function cargarIntentoFallido(
  id_usuario: number,
  ip: string | null,
  accion: BitacoraAction,
  detalle: string,
): Promise<number | null> {
  await UsuarioModel.increment("failed_attempts", { where: { id: id_usuario } });
  const actualizado = await UsuarioModel.findOne({
    where: { id: id_usuario },
    attributes: ["failed_attempts"],
  });
  let intentosRestantes: number | null = null;
  if (actualizado) {
    const fallos = actualizado.dataValues.failed_attempts ?? 0;
    // Same reasoning as `verifyCredentials`: the database already added one,
    // so `siguienteBloqueo` is given the count *before* this failure and
    // adds it itself, rather than the arithmetic running twice.
    const { locked_until } = siguienteBloqueo(fallos - 1);
    // Counted off the same `fallos` the lockout decision uses, so the number
    // on screen and the moment the door shuts can never disagree.
    intentosRestantes = locked_until ? 0 : Math.max(0, LOCKOUT_AFTER_FAILURES - fallos);
    if (locked_until) {
      await UsuarioModel.update({ locked_until }, { where: { id: id_usuario } });
      logAction({
        id_usuario,
        action: "ACCOUNT_LOCKED",
        entity: "Usuario",
        entity_id: id_usuario,
        detail: `Cuenta bloqueada tras ${fallos} intentos fallidos de segundo factor`,
        metadata: { failed_attempts: fallos, locked_until },
        severity: "critical",
        ip_address: ip,
      });
    }
  }
  logAction({
    id_usuario,
    action: accion,
    entity: "Usuario",
    entity_id: id_usuario,
    detail: detalle,
    metadata: null,
    severity: "warning",
    ip_address: ip,
  });
  return intentosRestantes;
}

/** Clears a stale lockout on success, the same way a correct password does
 *  in `verifyCredentials` — otherwise yesterday's four failures and today's
 *  one correct code lock an account that never got two wrong in a row. */
async function limpiarFallosPrevios(
  id_usuario: number,
  datos: { failed_attempts?: number; locked_until?: Date | null },
): Promise<void> {
  if ((datos.failed_attempts ?? 0) > 0 || datos.locked_until) {
    await UsuarioModel.update({ failed_attempts: 0, locked_until: null }, { where: { id: id_usuario } });
  }
}

/**
 * `POST /api/auth/mfa/verify` — Task 7. Proves a TOTP code or a recovery
 * code from a session that has not proved anything yet, and lifts it to
 * `completa`.
 */
export const verify = handler("verify", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const encontrado = await UsuarioModel.findByPk(caller.id, {
    attributes: ["failed_attempts", "locked_until"],
  });
  if (!encontrado) return res.status(401).json({ message: CUENTA_INACTIVA });
  const datosUsuario = encontrado.dataValues;

  // Resting exactly like a locked login: answered uniformly, with nothing
  // compared and nothing charged further — the account is already paying
  // for this.
  if (estaBloqueada(datosUsuario)) {
    // Cero, igual que en `/auth/stepup`. La frase sigue siendo la misma que la
    // de un código erróneo —una cuenta bloqueada no se le confirma a nadie que
    // esté sondeando—, pero el cero le dice a quien lleva un minuto tecleando
    // códigos correctos que insistir ya no es el remedio.
    return res.status(400).json({ message: CODIGO_MFA_INVALIDO, intentosRestantes: 0 });
  }

  const crudo = (req.body as Record<string, unknown> | undefined)?.[CAMPO_CODIGO];
  if (typeof crudo !== "string" || crudo === "") {
    // Nothing was attempted — no charge, the same shape `CREDENCIALES_INCOMPLETAS`
    // takes in the login for an equally empty submission.
    return res.status(400).json({ message: CODIGO_REQUERIDO });
  }

  // Plan 4E: an explicit `metodo` picks the arm; absent, the shape does, as
  // it always did. An unknown value is refused before anything is spent.
  const metodo = metodoDe(req.body);
  if (metodo === null) {
    return res.status(400).json({ message: METODO_DESCONOCIDO });
  }
  const rama: Metodo = metodo ?? (FORMA_TOTP.test(crudo) ? "totp" : "codigo");

  const ip = req.ip ?? null;
  let fuente: FuenteMfa | null = null;
  let fallaCriptografica = false;
  let sinFactorConfirmado = false;
  let detalleDeFallo: string | null = null;

  if (rama === "correo") {
    const resultado = await probarCodigoDeCorreo(caller.id, crudo, async (transaction) => {
      // Same row, same two halves as the other arms: promote what is
      // `parcial`/`onboarding`, seal what is already `completa`.
      if (await promoverSesion(caller.id_sesion, "correo", { transaction })) return true;
      return sellarPruebaDeFactor(caller.id_sesion, "correo", { transaction });
    });
    if (resultado === "cubo") {
      return res.status(429).json({ message: DEMASIADOS_INTENTOS_CORREO });
    }
    if (resultado === "ok") fuente = "correo";
    else detalleDeFallo = "Código por correo incorrecto, caducado o ya utilizado";
  } else if (rama === "totp") {
    const resultado = await verificarTotp(caller.id, crudo, ip);
    if (resultado.valido) {
      // `promoverSesion` is not composed transactionally with `sellarPaso`
      // here: `totpStore.ts`'s `sellarPaso` takes no `transaction` parameter
      // (only the recovery-code path below was built to need one — Task 11
      // Step 4).
      //
      // 🔴 **And its return value is checked, which it was not.** The comment
      // that stood here said an unpromoted session "was already `completa` and
      // has nothing left to promote". That is false for one reachable row, and
      // the consequence is a lockout: `estadoEfectivo` answers `onboarding`
      // for a session **stored** `completa` whose deadline has passed and
      // which carries no `mfa_satisfied_at` — the shape of any session that
      // was already open when its owner registered their first factor from
      // another device. `promoverSesion` matches on the *stored* state, finds
      // nothing, and writes nothing; this endpoint then answered "Segundo
      // factor verificado" having sealed nothing at all, and the next request
      // asked for the factor again. For ever.
      //
      // `sellarPruebaDeFactor` is the same second half `confirmTotp` and
      // `loginVerify` already use for this exact row, and it is why that
      // function exists.
      const subio = await promoverSesion(caller.id_sesion, "totp");
      if (!subio) await sellarPruebaDeFactor(caller.id_sesion, "totp");
      fuente = "totp";
    }
    fallaCriptografica = resultado.fallaCriptografica;
  } else {
    // Hallazgo F1/C-2/D-1: a recovery code rescues an existing factor, it is
    // never one of its own (`factorInventory.ts`'s own header). Without this,
    // a password alone gets ten codes from `/recovery-codes` — which does not
    // check for a factor either, that is this fix's other half — and one of
    // them promotes straight to `completa`, indefinitely, since the account
    // can always regenerate ten more with the same password. Refused before
    // even asking whether `crudo` names a real code: an account with nothing
    // confirmed has nothing to rescue, so there is nothing here worth
    // spending one of ten codes on. `sinFactorConfirmado` only ever changes
    // what this failure's own bitácora line says — never the HTTP response,
    // which stays the one answer this file gives for every way a recovery
    // code can fail (hallazgo B12).
    if (!(await tieneAlgunFactor(caller.id))) {
      sinFactorConfirmado = true;
    } else {
      // Task 11 Step 4: spending the code and sealing the session it proves
      // succeed or fail together, or the person burns one of ten codes for
      // nothing and has no trace of why.
      try {
        const promovido = await sequelize.transaction(async (transaction) => {
          const gastado = await gastarCodigo(caller.id, crudo, { transaction });
          if (!gastado) return false;
          // Same row, same reason as the TOTP branch above — and here the
          // old behaviour failed the other way round: a perfectly valid
          // recovery code was rolled back and answered "código incorrecto",
          // every time, on the one session state that most needed it.
          //
          // `NadaQueSellar` stays, and now means what it says: **neither**
          // write found a session. That is the case where spending one of ten
          // printed codes buys nothing, so the transaction unwinds and the
          // code stays unspent.
          const ok = await promoverSesion(caller.id_sesion, "codigo", { transaction });
          if (!ok) {
            const sellado = await sellarPruebaDeFactor(caller.id_sesion, "codigo", { transaction });
            if (!sellado) throw new NadaQueSellar();
          }
          return true;
        });
        if (promovido) fuente = "codigo";
      } catch (err) {
        if (!(err instanceof NadaQueSellar)) throw err;
        // Rolled back: the code stays unspent, since promoting bought nothing.
      }
    }
  }

  if (fuente === null) {
    /**
     * 🔴 Se responde **siempre**, también cuando no se ha cargado nada.
     *
     * La primera versión lo omitía en el fallo criptográfico, razonando que no
     * había nada que contar. Un test que lleva aquí desde el 4B lo cazó: su
     * trabajo es garantizar que un código erróneo, una fila corrupta y una
     * clave mala se contesten **idénticamente**, para que nadie los distinga
     * sondeando. Un campo presente en dos casos y ausente en el tercero es
     * exactamente esa distinción.
     *
     * Así que aquí se informa del contador **tal y como está**, leído de la
     * fila que ya se consultó arriba y sin incrementarlo: el número es cierto,
     * no cuesta una consulta más, y la respuesta sigue siendo indistinguible.
     */
    let intentosRestantes: number | null = Math.max(
      0,
      LOCKOUT_AFTER_FAILURES - (datosUsuario.failed_attempts ?? 0),
    );
    if (fallaCriptografica) {
      // Hallazgo F5/A5/C-4: a row this process cannot decrypt is the
      // server's fault, never the caller's — `secretoDe` already logged it at
      // `error` severity, with the row and key version an operator needs.
      // Charging `failed_attempts` here would lock out the very person a
      // broken key or a bad rotation already failed; skipping it is the only
      // thing this branch does differently; the response below is identical
      // either way, on purpose (same status, same message, same shape).
    } else {
      const cargado = await cargarIntentoFallido(
        caller.id,
        ip,
        "MFA_VERIFY_FAILED",
        detalleDeFallo ??
          (sinFactorConfirmado
            ? "Se intentó un código de recuperación sin ningún factor confirmado en la cuenta: nada que rescatar"
            : "Código de segundo factor incorrecto, repetido o ya utilizado"),
      );
      // Ver la nota gemela en `stepup`: `null` es «no se pudo establecer».
      if (cargado !== null) intentosRestantes = cargado;
    }
    /**
     * 🔴 La cuenta atrás **sobre todo aquí**, y durante un rato estuvo sólo en
     * la ruta hermana.
     *
     * El ejemplo con el que se justificó este contador —un móvil cuyo reloj se
     * ha desviado, que basta para que todos los códigos fallen— ocurre al
     * entrar, o sea en esta ruta, no en `/auth/stepup`. Sin él, cinco intentos
     * idénticos y sin aviso llevan de «mi código no funciona» a «no puedo
     * entrar», porque a partir del bloqueo el login contesta «Usuario o
     * contraseña incorrectos» y nadie relaciona las dos cosas.
     *
     * Omitido cuando vale `null` —fallo criptográfico, que no carga nada—
     * para no decirle a alguien que ha gastado un intento que no gastó.
     */
    return res
      .status(400)
      .json({ message: CODIGO_MFA_INVALIDO, intentosRestantes });
  }

  await limpiarFallosPrevios(caller.id, datosUsuario);

  /**
   * "Remember this machine", and **this is the only place it can be granted**.
   *
   * The login renews a cookie that is already valid; it never mints a first
   * one, and deliberately — at that point nobody has proved anything beyond a
   * password. So without this branch the whole feature is chicken-and-egg:
   * renewal requires a cookie, and nothing can ever hand out the first. The
   * comment in `auth.controller.ts` that describes minting assumes it happens
   * here, and nothing did until now.
   *
   * Gated on the body asking (`REMEMBER_DEVICE_FIELD`), never automatic — same
   * rule the login's renewal follows. And after the factor is proved, never
   * before: a cookie that skips the second factor is only ever handed to
   * somebody who just showed one.
   *
   * Failure is logged and swallowed rather than turned into a 5xx, for the same
   * reason the login gives: the session is already promoted and works without
   * this cookie, and refusing here would cost somebody their whole verification
   * over a convenience that saves them typing six digits.
   *
   * Not on `/auth/stepup` below, on purpose: that is re-proving inside a session
   * that already exists, not arriving at one.
   */
  if ((req.body as Record<string, unknown> | undefined)?.[REMEMBER_DEVICE_FIELD] === true) {
    try {
      const token = await acunarDispositivo(caller.id, req);
      setRememberedDeviceCookie(res, token);
    } catch (err) {
      mfaLog.error(
        { err, id_usuario: caller.id },
        "no se pudo recordar el dispositivo: el segundo factor sí quedó verificado",
      );
    }
  }

  logAction({
    id_usuario: caller.id,
    action: "MFA_VERIFIED",
    entity: "Usuario",
    entity_id: caller.id,
    detail: `Segundo factor verificado (${fuente})`,
    metadata: { id_sesion: caller.id_sesion, fuente },
    severity: "info",
    ip_address: ip,
  });

  return res.status(200).json({
    message: "Segundo factor verificado.",
    permisos: await permissionsFor(caller.id_rol),
  });
});

/**
 * `POST /api/auth/stepup` — Task 17, hallazgo C13. Re-seals `mfa_satisfied_at`
 * on a live `completa` session whose step-up window has lapsed, without
 * touching `estado` — there is nothing to promote, this session was never
 * anything but complete.
 *
 * **The three rules that bound this endpoint, all satisfied by what this
 * handler does *not* read:** it never looks at a remembered-device cookie,
 * it never accepts a password field, and passkeys are 4C's. The only inputs
 * are `req.user` (never the body) and `CAMPO_CODIGO`, so there is no code
 * path here a stolen "remember this device" cookie or a bare password could
 * ever walk through.
 *
 * `promoverSesion` cannot be reused here: its `WHERE` deliberately excludes
 * `estado = 'completa'` (that exclusion is what makes the *original*
 * promotion idempotent), so calling it from a session that is already
 * `completa` would always answer "nothing changed" instead of re-sealing it.
 * This handler writes `sesiones` directly instead, with the same `id_sesion`
 * + `id_usuario` ownership pair hallazgo C15 asks for everywhere else, plus
 * `estado: 'completa'` so this can never re-seal a row that should not
 * exist as a target for it in the first place.
 */
export const stepup = handler("stepup", async (req: Request, res: Response) => {
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const encontrado = await UsuarioModel.findByPk(caller.id, {
    attributes: ["failed_attempts", "locked_until"],
  });
  if (!encontrado) return res.status(401).json({ message: CUENTA_INACTIVA });
  const datosUsuario = encontrado.dataValues;

  // Same bucket as `verify` (Task 17's own text: "mismo cubo por cuenta que
  // la Task 7") — the same account-wide counter, not a second one.
  if (estaBloqueada(datosUsuario)) {
    // `intentosRestantes: 0` and not silence. The sentence is the same one a
    // wrong code gets — deliberately, so a locked account is not confirmed to
    // anybody probing — but the person who has been typing correct codes into
    // a window for the last minute needs to know that trying again is not the
    // remedy. Zero is what says "this is no longer about the code".
    return res.status(400).json({ message: CODIGO_MFA_INVALIDO, intentosRestantes: 0 });
  }

  const crudo = (req.body as Record<string, unknown> | undefined)?.[CAMPO_CODIGO];
  if (typeof crudo !== "string" || crudo === "") {
    return res.status(400).json({ message: CODIGO_REQUERIDO });
  }

  const metodo = metodoDe(req.body);
  if (metodo === null) {
    return res.status(400).json({ message: METODO_DESCONOCIDO });
  }
  const rama: Metodo = metodo ?? (FORMA_TOTP.test(crudo) ? "totp" : "codigo");

  const ip = req.ip ?? null;
  let fuente: FuenteMfa | null = null;
  let fallaCriptografica = false;
  let sinFactorConfirmado = false;
  let detalleDeFallo: string | null = null;

  if (rama === "correo") {
    // The seal is the direct `UPDATE` with `estado: "completa"` this endpoint
    // uses for the other two arms — not `sellarPruebaDeFactor`, which has no
    // state filter and would let a `parcial` session seal itself through the
    // step-up door.
    const resultado = await probarCodigoDeCorreo(caller.id, crudo, async (transaction) => {
      const [count] = await SesionModel.update(
        { mfa_satisfied_at: new Date(), mfa_source: "correo" },
        { where: { id: caller.id_sesion, id_usuario: caller.id, estado: "completa" }, transaction },
      );
      return count > 0;
    });
    if (resultado === "cubo") {
      return res.status(429).json({ message: DEMASIADOS_INTENTOS_CORREO });
    }
    if (resultado === "ok") fuente = "correo";
    else detalleDeFallo = "Reautenticación de step-up por correo incorrecta, caducada o ya utilizada";
  } else if (rama === "totp") {
    const resultado = await verificarTotp(caller.id, crudo, ip);
    if (resultado.valido) {
      const [count] = await SesionModel.update(
        { mfa_satisfied_at: new Date(), mfa_source: "totp" },
        { where: { id: caller.id_sesion, id_usuario: caller.id, estado: "completa" } },
      );
      if (count > 0) fuente = "totp";
    }
    fallaCriptografica = resultado.fallaCriptografica;
  } else if (!(await tieneAlgunFactor(caller.id))) {
    // Hallazgo F1's guard, which `verify` above has carried since plan 4B
    // and this endpoint did not — plan 4E's audit (S11). It mattered little
    // while nothing but an app or a key could have minted codes; it matters
    // now that an account whose only factor is its verified address may hold
    // a sheet of them, then change its address and have no factor at all,
    // and still be `completa` under a fresh grace clock. A code re-sealing
    // that session would open every gated write short of the ones mounted
    // with `sinVentana` — `STEP_UP_OPTIONS` in `routeGuards.test.ts` names
    // them, and D6's original "every administrative write" is no longer the
    // answer — to a sheet plus a cookie. Same rule, same sentence, same charge
    // as `verify`.
    sinFactorConfirmado = true;
  } else {
    try {
      const promovido = await sequelize.transaction(async (transaction) => {
        const gastado = await gastarCodigo(caller.id, crudo, { transaction });
        if (!gastado) return false;
        const [count] = await SesionModel.update(
          { mfa_satisfied_at: new Date(), mfa_source: "codigo" },
          {
            where: { id: caller.id_sesion, id_usuario: caller.id, estado: "completa" },
            transaction,
          },
        );
        if (count === 0) throw new NadaQueSellar();
        return true;
      });
      if (promovido) fuente = "codigo";
    } catch (err) {
      if (!(err instanceof NadaQueSellar)) throw err;
    }
  }

  if (fuente === null) {
    // Hallazgo F5/A5/C-4 — same exemption `verify` above makes, for the same
    // reason: a row this process cannot decrypt is the server's fault, not
    // the caller's, and must not spend the account's lockout budget.
    // `secretoDe` already logged it at `error` severity.
    // Mismo criterio que en `verify`, y por el mismo motivo: se responde
    // siempre, también cuando no se cargó nada, para que un fallo del servidor
    // no se distinga de un código erróneo por la forma de la respuesta.
    let intentosRestantes: number | null = Math.max(
      0,
      LOCKOUT_AFTER_FAILURES - (datosUsuario.failed_attempts ?? 0),
    );
    if (!fallaCriptografica) {
      const cargado = await cargarIntentoFallido(
        caller.id,
        ip,
        "MFA_VERIFY_FAILED",
        detalleDeFallo ??
          (sinFactorConfirmado
            ? "Se intentó un código de recuperación en el step-up sin ningún factor confirmado en la cuenta: nada que rescatar"
            : "Reautenticación de step-up incorrecta, repetida o ya utilizada"),
      );
      // `null` significa «no se pudo establecer», no «cero»: sobrescribir con
      // él descartaría el valor honrado que ya se leyó de la fila y, además,
      // haría que este caso se distinguiera de los demás por la forma de la
      // respuesta.
      if (cargado !== null) intentosRestantes = cargado;
    }
    // 🔴 The countdown rides on the *same* answer every failure gives, and the
    // sentence itself stays deliberately uniform — see `CODIGO_MFA_INVALIDO`'s
    // own reasoning. What changes is that the person can now see the door
    // closing. Omitted entirely on a cryptographic failure, where nothing was
    // charged and there is nothing to count down.
    return res
      .status(400)
      .json({ message: CODIGO_MFA_INVALIDO, intentosRestantes });
  }

  await limpiarFallosPrevios(caller.id, datosUsuario);

  logAction({
    id_usuario: caller.id,
    action: "STEP_UP_REPROVED",
    entity: "Usuario",
    entity_id: caller.id,
    detail: `Sesión re-acreditada sin cerrar sesión (${fuente})`,
    metadata: { id_sesion: caller.id_sesion, fuente },
    severity: "info",
    ip_address: ip,
  });

  return res.status(200).json({ message: "Identidad confirmada." });
});
