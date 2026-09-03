// Registering and removing your own TOTP factor.
// `docs/plans/2026-09-01-factores-mfa.md` Tasks 6 and 8, hallazgos A5, C1,
// C11, C15, B11, and Decisions 5 and 8.
//
// Everything this file writes to `factor_totp` goes through `auth/totpStore.ts`
// (Task 4) and everything it writes to `sesiones`/`usuarios.mfa_grace_until`
// goes through `auth/sessionPromotion.ts` (Task 5) — this file owns none of
// that storage, only the HTTP-shaped decisions around it: which request gets
// a 409, which secret a code is checked against, and when a deletion is
// severe enough for a `critical` bitácora line.
//
// **The password gate is not in this file, and that is deliberate.** All
// three routes mount `requireStepUp({ exigeContrasena: true })` in
// `routes/totp.routes.ts` — hallazgo C1: without it, a stolen session cookie
// with no password registers its own factor and locks the real owner out
// permanently, because `tieneAlgunFactor` then denies the victim the
// password fallback too. By the time a handler below runs, the caller has
// already typed their current password (or, for an account with a factor
// already, already proved it fresh — see `requireStepUp.ts` for why
// `exigeContrasena` demands both in that order). Nothing here re-checks that.
//
// **The secret and the `otpauth://` URI travel in the JSON body, never in a
// URL.** Hallazgo B11: `httpLogger` logs `originalUrl` — query string and
// all — without redaction. Both routes are POST; `setupTotp` answers with a
// JSON object, never a redirect or a `Location` header, so there is no code
// path here that could put either value where a log line would catch it.
//
// **Every lookup below is scoped by `req.user.id`, never by anything in the
// body.** Hallazgo C15: "factor ajeno satisface sesión propia". `confirmTotp`
// in particular reads the secret through `leerSecretoSinConfirmar(caller.id)`
// — a `secreto` field in the request body, if one were ever sent, is never
// read.

import type { Request, Response } from "express";
import { Op } from "sequelize";
import { Secret, TOTP } from "otpauth";
import { UsuarioModel } from "../models/usuario.model.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import {
  guardarSecretoSinConfirmar,
  leerSecretoSinConfirmar,
  confirmarFactor,
} from "../auth/totpStore.js";
import { promoverSesion, sellarPruebaDeFactor, apagarLaMecha } from "../auth/sessionPromotion.js";
import { sequelize } from "../database/sequelize.js";
import { tieneAlgunFactor } from "../auth/factorInventory.js";
import {
  contarCodigosRestantes,
  prepararCodigos,
  escribirCodigos,
} from "../auth/recoveryCodeStore.js";
import { revokeAllRememberedDevicesOf } from "../auth/rememberedDeviceStore.js";
import { revokeAllSessionsOf } from "../auth/sessionStore.js";
import { clearSessionCookie } from "../auth/sessionCookie.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const totpLog = log("totp");
const handler = makeHandler(totpLog);

/**
 * The RFC 6238 parameters this ERP issues every QR code and every check
 * with. Fixed, not configurable per account: an authenticator app has no way
 * to ask which values a given secret uses, so every secret this file ever
 * mints has to use the same ones the app is told (via the `otpauth://` URI)
 * to use back.
 *
 * `TOTP_WINDOW = 1` is the same ±1-step tolerance the audit's numbers
 * (hallazgos C3, C10, C12) are computed against — three valid codes at any
 * instant, not one. Widening it here would widen those numbers too.
 */
const TOTP_ISSUER = "Osefi";
const TOTP_ALGORITHM = "SHA1";
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_WINDOW = 1;
const TOTP_SECRET_BYTES = 20;

/** Twin of the message in `authenticate.ts`, `auth.controller.ts` and
 *  `email.controller.ts`; all four mean the row backing this session is gone. */
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";

/**
 * Decision 5, and the sentence the whole company reads on deploy day: **0 of
 * 9 accounts have a verified email today.** It has to say what to do, not
 * only that it refused — the "409" alone tells nobody which of the six other
 * doors gets them out.
 */
export const MENSAJE_CORREO_NO_VERIFICADO =
  "Debes verificar tu correo antes de configurar un segundo factor. " +
  "Solicita el enlace de verificación desde tu perfil y confírmalo desde tu bandeja de entrada; " +
  "después vuelve a intentar este registro.";

/**
 * Hallazgo C11's 409. `setup` never destroys a confirmed row to get here —
 * see `setupTotp`'s own comment for the four possible writes and why three of
 * them are wrong.
 */
export const MENSAJE_FACTOR_YA_CONFIGURADO =
  "Ya tienes un factor de autenticación configurado. Elimínalo antes de registrar uno nuevo.";

export const MENSAJE_CODIGO_REQUERIDO = "Debes indicar el código de verificación.";

export const MENSAJE_SIN_SETUP_PENDIENTE =
  "No hay ningún registro de factor pendiente de confirmar. Vuelve a iniciar el proceso.";

export const MENSAJE_CODIGO_INCORRECTO =
  "El código no es válido. Comprueba la hora de tu dispositivo e inténtalo de nuevo.";

export const MENSAJE_FACTOR_CONFIRMADO = "Segundo factor configurado correctamente.";

export const MENSAJE_SIN_FACTOR = "No tienes ningún factor de autenticación registrado.";

export const MENSAJE_FACTOR_ELIMINADO = "Factor de autenticación eliminado.";

/**
 * El caso del último factor, que **no** puede compartir mensaje con el anterior.
 *
 * Borrar el último factor revoca todas las sesiones vivas de la cuenta,
 * incluida la pestaña desde la que se pulsó el botón — ver la nota junto a
 * `revokeAllSessionsOf` más abajo para por qué no lleva `except`. Con el
 * mensaje genérico, esa persona lee «eliminado», y acto seguido la aplicación
 * la echa con «tu sesión se cerró», que suena a que algo falló.
 *
 * Dos hechos y una instrucción, en ese orden, porque es lo que necesita saber:
 * qué pasó, qué implica, y qué hacer ahora.
 */
export const MENSAJE_ULTIMO_FACTOR_ELIMINADO =
  "Factor de autenticación eliminado. Era el último que te quedaba, así que a partir de ahora " +
  "entrarás solo con tu contraseña, y hemos cerrado tus sesiones en todos los dispositivos. " +
  "Vuelve a iniciar sesión.";

/**
 * `POST /auth/totp/setup` — start registering a TOTP factor.
 *
 * **Step-up already ran** (see the module header): the caller has typed
 * their current password, or proved an existing factor fresh, before this
 * handler ever executes.
 *
 * **The 409 for an unverified email (Decision 5) comes before anything else
 * this handler could refuse for**, matching the plan's own step order:
 * an account cannot be mid-registration and also missing its address, so
 * checking this first never hides a more specific error behind a vaguer one.
 *
 * **The UNIQUE-constraint problem, hallazgo C11, and why this is a `findOne`
 * and not a try/catch around the write.** `factor_totp.id_usuario` is
 * `UNIQUE`, so calling this route twice has four possible outcomes, and this
 * function has to land on exactly one of them:
 *
 * | Write | Result |
 * |---|---|
 * | plain `INSERT` | an ugly 500 |
 * | `upsert` / `destroy`+`create` | 🔴 destroys a *confirmed*, working factor |
 * | `findOrCreate` | safe only while the row is unconfirmed |
 * | 409 | correct for a confirmed row |
 *
 * So: look for a row with `confirmed_at IS NOT NULL` first, and answer 409
 * without writing anything if one exists. If none does,
 * `guardarSecretoSinConfirmar` (Task 4) is what actually decides which row it
 * may replace — the *unconfirmed* one, and only that one, deleting it inside
 * the same transaction as the fresh insert. An unconfirmed row never counted
 * as a factor for `tieneAlgunFactor`, so replacing it changes nobody's
 * security state; a confirmed row is never touched by that function at all,
 * and if this check ever raced and let one through, the `UNIQUE` constraint
 * fails the `INSERT` loudly rather than silently destroying it — the same
 * belt-and-suspenders `guardarSecretoSinConfirmar`'s own comment describes.
 *
 * **A fresh secret and a fresh IV on every call**, with no caching or reuse
 * anywhere in this handler: `new Secret(...)` draws new random bytes, and
 * `guardarSecretoSinConfirmar` → `cifrar()` (Task 1) draws a new IV. Calling
 * this route twice in a row for the same account, whether or not the first
 * QR was ever scanned, always answers with a secret nobody has seen before.
 */
export const setupTotp = handler("setupTotp", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const cuenta = await UsuarioModel.findByPk(caller.id, {
    attributes: ["id", "user", "email_verified_at"],
  });
  // Archived in the instant between `authenticate` and here — the same
  // narrow race `email.controller.ts` answers the same way.
  if (!cuenta) {
    return res.status(401).json({ message: CUENTA_INACTIVA });
  }

  if (cuenta.dataValues.email_verified_at === null) {
    return res.status(409).json({ message: MENSAJE_CORREO_NO_VERIFICADO });
  }

  // `.unscoped()` even though only `id` is requested: every other read of
  // this model in the 4B codebase (`mfaKeyCheck.ts`, `rotateMfaKey.ts`,
  // `totpStore.ts`, `mfa.controller.ts`) reaches for it before touching
  // `factor_totp` at all, rather than relying on an explicit `attributes`
  // list to interact predictably with `defaultScope`'s own `exclude` — one
  // fewer thing to get subtly wrong across a Sequelize version.
  const confirmado = await FactorTotpModel.unscoped().findOne({
    where: { id_usuario: caller.id, confirmed_at: { [Op.ne]: null } },
    attributes: ["id"],
  });
  if (confirmado) {
    return res.status(409).json({ message: MENSAJE_FACTOR_YA_CONFIGURADO });
  }

  const secret = new Secret({ size: TOTP_SECRET_BYTES });
  const secreto = secret.base32;
  await guardarSecretoSinConfirmar(caller.id, secreto);

  // The label is what the authenticator app shows under the issuer name.
  // `cuenta.dataValues.user` is the username `authenticate` logged this
  // session in with; falling back to the numeric id only guards against a
  // row with no username ever set, which nothing in this codebase produces
  // today but which costs nothing to guard against here.
  const totp = new TOTP({
    issuer: TOTP_ISSUER,
    label: (cuenta.dataValues.user as string | null) || `usuario-${caller.id}`,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret,
  });

  // Body only — see the module header. `totp.toString()` builds the
  // `otpauth://` URI from `secret.base32` itself, so both values below carry
  // the same secret; nothing here or downstream ever puts either in a query
  // string, a redirect or a header.
  res.status(200).json({ secreto, otpauth: totp.toString() });
});

/**
 * `POST /auth/totp/confirm` — prove the secret `setupTotp` just handed out.
 *
 * **The secret compared against is always `leerSecretoSinConfirmar(caller.id)`'s
 * — never anything the request body carries.** Hallazgo C15's line for this
 * endpoint is "factor ajeno satisface sesión propia"; the fix is that there is
 * no code path here that reads a `secreto` field from the body at all, so
 * there is nothing for one to override.
 *
 * **Which time step gets sealed, hallazgo C10's third rule.** `TOTP.validate`
 * returns a *delta* — how many periods away from "now" the matching code sat
 * — not a boolean. The step that actually matched is
 * `TOTP.counter({ timestamp }) + delta`, not `TOTP.counter({ timestamp })` on
 * its own: with ±1 step of tolerance those are not always the same step, and
 * sealing the wrong one leaves the neighbouring one still open to replay.
 * `sellarPaso` (Task 4) is handed exactly that value.
 *
 * **On success, four or five writes, in this order, matching the plan's own
 * ordering:** mark the row confirmed, seal the step that matched, promote
 * the session that just proved it (`sessionPromotion.ts`, Task 5 — without
 * this, `estadoEfectivo` only ever narrows and an `onboarding` or `parcial`
 * session that just registered its factor stays exactly what it was) —
 * and the fifth, conditional write: if there was no `parcial`/`onboarding`
 * row for `promoverSesion` to promote, because this session opened
 * `completa` already (an account with no factor, still inside its grace
 * period — see `estadoInicialDeSesion`), seal this session's own proof
 * anyway (`sellarPruebaDeFactor`, hallazgo F2/B-1). Skipping that fifth
 * write is exactly the bug it fixes: the account that registers its factor
 * *on time* would leave this endpoint with `mfa_satisfied_at` still NULL,
 * and every step-up gate would refuse it for the rest of the session's
 * life — while somebody who registers late, whose session opened
 * `onboarding`, sails through `promoverSesion` and is fine. Finally, clear
 * the fourteen-day deadline (`apagarLaMecha`) so it does not read as "still
 * overdue" for an account that just did what it was asked.
 *
 * The bitácora line is `critical`: hallazgo (Task 6 Step 7) — registering a
 * credential is a security event worth a permanent record even though
 * `MAIL_SECURITY_TO` is not configured today and no mail goes out for it; the
 * bitácora line is the constancy that actually exists, matching
 * `rescueCore.ts`'s own precedent for an expected, unsent notice.
 *
 * **Sixth write, conditional: the first ten recovery codes (Isaias,
 * 2026-09-02).** Before this decision, confirming a factor never produced a
 * backup net — recovering it required remembering, unprompted, to visit a
 * different screen and type the password again. Whoever scanned the QR and
 * closed the tab had exactly one working factor and no way back in if it
 * ever broke, and had no way to know that. From this decision on, confirming
 * mints the ten codes in the same request and hands them back in this same
 * response — GitHub and Google both already do it this way.
 *
 * **Only when nothing is already outstanding — `contarCodigosRestantes`,
 * never `tieneAlgunFactor`.** An account can reach this endpoint a *second*
 * time with `tieneAlgunFactor` having read `false` a moment earlier: delete a
 * confirmed TOTP factor (`deleteTotp` never touches `codigo_recuperacion`,
 * see its own comment) and register a new one, and the ten codes printed the
 * first time are still perfectly good. Gating on factor count would
 * regenerate there and silently turn a sheet already sitting in a drawer
 * into ten dead strings — reproducing, from the other direction, the exact
 * failure this whole feature exists to close. Reading the codes table's own
 * outstanding count is the one check that answers the question that
 * actually matters — "would generating now destroy something that still
 * works" — regardless of how many factors the account happens to hold at
 * this instant. `regenerateRecoveryCodes` in `recoveryCodes.controller.ts`
 * remains the only way to get a *fresh* ten once any exist; this handler
 * only ever fills an empty hand.
 *
 * **Inside this function's own transaction, not after it commits — the
 * atomicity decision.** Two outcomes are each worse than refusing the
 * confirmation outright: `regenerarCodigos` succeeding while the writes
 * above roll back would mint a live backup net for a factor the account does
 * not actually have; the factor confirming while code generation then fails
 * would leave the account's first factor live with **no** net and no signal
 * that it needs one, since the whole point of this feature is that nobody
 * reliably goes and checks. Reading the count and, if it calls for it,
 * generating the ten both receive this function's own `{ transaction }` —
 * the same one `confirmarFactor`/`promoverSesion`/`apagarLaMecha` already
 * carry — so a real failure in either one rolls back every write in this
 * block together: this codebase has no `useCLS` wired up (verified in the
 * 4A closure audit), so a call that does not explicitly receive the
 * transaction runs on a second pooled connection and commits or fails on its
 * own, independent of the rest.
 *
 * `codigos` in the response is the ten fresh plaintext codes, or `null` when
 * an outstanding sheet already existed and nothing was generated — never
 * omitted, so the client can tell "nothing to show" apart from "the field
 * does not exist yet" without guessing.
 */
export const confirmTotp = handler("confirmTotp", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const codigo = (req.body as Record<string, unknown> | undefined)?.codigo;
  if (typeof codigo !== "string" || codigo.length === 0) {
    return res.status(400).json({ message: MENSAJE_CODIGO_REQUERIDO });
  }

  const pendiente = await leerSecretoSinConfirmar(caller.id);
  if (!pendiente) {
    return res.status(400).json({ message: MENSAJE_SIN_SETUP_PENDIENTE });
  }

  const totp = new TOTP({
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(pendiente.secreto),
  });

  const ahora = Date.now();
  const delta = totp.validate({ token: codigo, timestamp: ahora, window: TOTP_WINDOW });
  if (delta === null) {
    return res.status(400).json({ message: MENSAJE_CODIGO_INCORRECTO });
  }

  // The step that actually matched — see this function's own docstring for
  // why `+ delta` is not optional. `BigInt(delta)` is safe on either sign:
  // `TOTP.validate`'s delta is a small integer (bounded by `TOTP_WINDOW`),
  // never a float.
  const pasoAceptado = BigInt(TOTP.counter({ period: TOTP_PERIOD, timestamp: ahora })) + BigInt(delta);

  /**
   * The writes that finish a registration, together or not at all.
   *
   * They were four separate statements, and the states in between are the kind
   * nobody notices until somebody is in one. Confirmed-but-not-sealed leaves the
   * very code that just registered the factor still acceptable to a concurrent
   * verify. Confirmed-but-not-promoted is worse to be on the receiving end of:
   * the person scanned the QR, typed the code, saw it accepted, and the ERP goes
   * on refusing them until they log out and back in — which is exactly the
   * complaint this whole endpoint exists to stop.
   *
   * `confirmarFactor` also folds the first two into one statement, since both
   * columns live on the same row.
   *
   * **Hallazgo F2/B-1: `promoverSesion`'s own return has to be looked at.**
   * It writes nothing when this session opened `completa` already — an
   * account with no factor, still inside its grace period — and the bug
   * this whole block exists to close was exactly a caller that ran
   * `promoverSesion` and never checked whether it did anything.
   * `sellarPruebaDeFactor` is the sibling that seals proof on that same row
   * unconditionally; see its own docstring in `sessionPromotion.ts` for why
   * it is a separate function rather than a flag on `promoverSesion` itself.
   * Called only when `promoverSesion` found nothing to promote, so a session
   * that *did* just get promoted is not written to twice.
   */
  /**
   * 🔴 **El hashing va fuera de la transacción, y esto está medido.**
   *
   * Los diez `bcrypt` a coste 12 cuestan **2646 ms**. Hacerlos dentro de la
   * transacción —que es lo que pasaba antes de este cambio— retenía durante
   * esos 2,6 segundos los bloqueos de fila sobre `factor_totp`, `sesiones` y
   * `usuarios`, y una de las quince conexiones del pool, para hacer aritmética
   * que no toca la base de datos. Se prepara antes y dentro sólo se escribe.
   *
   * La lectura de aquí es un descarte barato: si ya hay códigos vigentes no se
   * gastan los 2,6 segundos para nada. **La decisión de verdad se vuelve a
   * tomar dentro de la transacción**, porque entre esta lectura y la escritura
   * cabe otra petición — y regenerar sobre una hoja que ya existe la mataría.
   */
  const yaTieneCodigos = (await contarCodigosRestantes(caller.id)) > 0;
  const preparados = yaTieneCodigos ? null : await prepararCodigos(caller.id);

  const codigosRecuperacion = await sequelize.transaction(async (transaction) => {
    await confirmarFactor(pendiente.id, pasoAceptado, { transaction });
    const promovida = await promoverSesion(caller.id_sesion, "totp", { transaction });
    if (!promovida) {
      await sellarPruebaDeFactor(caller.id_sesion, "totp", { transaction });
    }
    await apagarLaMecha(caller.id, { transaction });

    // Sixth write, conditional — see this function's own docstring for why
    // the check is against outstanding codes rather than against the factor
    // count, and why the write carries this same transaction.
    //
    // Se vuelve a contar **dentro**: la lectura de arriba corrió fuera y otra
    // petición pudo emitir códigos entre medias. Ésta es la que decide.
    if (!preparados) return null;
    const restantes = await contarCodigosRestantes(caller.id, { transaction });
    if (restantes > 0) return null;
    await escribirCodigos(caller.id, preparados, transaction);
    return preparados.codigos;
  });

  if (codigosRecuperacion) {
    /**
     * Diez credenciales nuevas merecen su propia línea, y no la tenían.
     *
     * El camino hermano —`regenerateRecoveryCodes`, cuando alguien los pide a
     * mano— sí escribe `RECOVERY_CODES_REGENERATED`. Desde que confirmar el
     * factor los emite solo, **la mayoría** de los juegos del sistema iban a
     * existir sin rastro de cuándo ni desde qué dirección se emitieron: dos
     * caminos al mismo hecho, uno registrando y el otro no.
     *
     * Aparte de `TOTP_CONFIRMED` y no dentro: son dos hechos distintos, y sólo
     * uno de los dos ocurre siempre.
     */
    logAction({
      id_usuario: caller.id,
      action: "RECOVERY_CODES_ISSUED",
      entity: "Usuario",
      entity_id: caller.id,
      detail: "Se emitieron diez códigos de recuperación al confirmar el primer segundo factor",
      metadata: { id_sesion: caller.id_sesion, cantidad: codigosRecuperacion.length },
      severity: "critical",
      ip_address: req.ip ?? null,
    });
  }

  logAction({
    id_usuario: caller.id,
    action: "TOTP_CONFIRMED",
    entity: "FactorTotp",
    entity_id: pendiente.id,
    detail: "Confirmó el registro de un segundo factor TOTP",
    metadata: { id_sesion: caller.id_sesion },
    severity: "critical",
    ip_address: req.ip ?? null,
  });

  res.status(200).json({ message: MENSAJE_FACTOR_CONFIRMADO, codigos: codigosRecuperacion });
});

/**
 * `DELETE /auth/totp` — remove the caller's own TOTP factor.
 *
 * **Deletes an unconfirmed row exactly like a confirmed one, hallazgo C11's
 * tail.** A `setup` that was never confirmed still holds the `UNIQUE
 * (id_usuario)` slot; if this only matched `confirmed_at IS NOT NULL`, a
 * half-finished registration would be permanently undeletable and `setup`
 * would fail on that account forever. The lookup below has no `confirmed_at`
 * filter at all — it finds whatever row this account has, either way.
 *
 * **Whether the bitácora line is `critical` depends on what was actually
 * destroyed, not merely on what remains.** An unconfirmed row was never a
 * factor by `tieneAlgunFactor`'s own rule, so deleting one changes nothing
 * about the account's security state — logged, but not as a lost factor.
 * Only deleting a *confirmed* row that leaves the account with nothing else
 * (`tieneAlgunFactor` false afterwards) is the event Task 8 Step 3 asks to be
 * loud about: somebody who keeps ten recovery codes after this still gets
 * back in with a password alone, silently, because codes are deliberately
 * not counted as a factor — this line is the only place that says so.
 *
 * **Revoking remembered devices, traced while building Task 13 and not in
 * the original audit.** A device remembered while this factor was confirmed
 * carries a live, unexpiring exemption from ever being asked for it again —
 * `estadoEfectivo`'s clause 3 only narrows once the *account* has no
 * evidence of a factor at all. Deleting the confirmed row without also
 * calling `revokeAllRememberedDevicesOf` leaves that cookie able to open a
 * `completa` session on an account that, as of this call, has nothing behind
 * it. Same treatment archiving a user and changing a password already give —
 * removing a credential invalidates whatever trusted it.
 *
 * **Revoking every live session, hallazgo F7/C-5/B-3 — `factorInventory.ts`
 * calls this out by name as a non-optional duty of this endpoint.** A
 * session already stored as `completa` is never rewritten by anything in
 * `src/`; `estadoEfectivo` only ever narrows, and it exits on its very first
 * clause whenever `guardado === "completa"`, never re-checking whether the
 * account still holds a factor. So a browser that logged in while this
 * factor existed goes on being `completa` for up to `SESSION_ABSOLUTE_DAYS`
 * after this call — and the instant `tieneAlgunFactor` starts answering
 * `false`, `requireStepUp`'s "nothing to prove" branch treats that stale
 * session exactly like an account that never had a factor at all, waving
 * gated writes through on the cookie alone wherever a route does not also
 * demand a password. A stolen cookie from before this call becomes a
 * password-free key to the whole security panel, for as long as that cookie
 * has left to live.
 *
 * **Revoke, not degrade — decided here, not left to whoever reads this
 * next.** Degrading in place would mean writing some `estado` short of
 * `completa` onto rows that, by construction, belong to an account with
 * *zero* factors left: there is nothing for `/mfa/verify` to check against
 * to lift them back out, so a degraded session would be stuck exactly where
 * it landed — a worse failure than the one being fixed, and a silent one.
 * Revoking is what `revokeAllSessionsOf` already does at its other four call
 * sites (`logoutAll`, an administrator's password reset, archiving an
 * account, the rescue console) whenever an account's security posture
 * changes enough that its old cookies should not survive it; deleting your
 * last factor is exactly that kind of change, not a smaller one.
 *
 * **No `except` — this ends the caller's own session too, in the same tab
 * that just clicked delete.** `changePassword` spares nobody either, for a
 * far more frequent action than this one, and does so by rotating a fresh
 * cookie in for the caller right after — see its own comment in
 * `usuario.controller.ts`. Building that same rotation here would be new
 * machinery for a rare, deliberate action, not the routine one it exists
 * for; simply asking the person to log back in is the correct cost; the
 * next login opens the account with the same "nothing to prove" treatment
 * every zero-factor account already gets, so it is no friction beyond
 * typing the password again. Sparing the caller's own session here would
 * leave exactly the exposure this fix closes, just narrowed to one browser
 * instead of several — the same hole, smaller, not gone.
 */
export const deleteTotp = handler("deleteTotp", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  // `.unscoped()` — see the same note on `setupTotp`'s confirmed-row check.
  const fila = await FactorTotpModel.unscoped().findOne({
    where: { id_usuario: caller.id },
    attributes: ["id", "confirmed_at"],
  });
  if (!fila) {
    return res.status(404).json({ message: MENSAJE_SIN_FACTOR });
  }

  const eraConfirmado = fila.dataValues.confirmed_at !== null;

  await FactorTotpModel.destroy({ where: { id_usuario: caller.id } });

  if (!eraConfirmado) {
    // Discarding a half-finished setup never changed anybody's security
    // state — see the docstring above — so this never calls
    // `tieneAlgunFactor` or `revokeAllRememberedDevicesOf` at all.
    logAction({
      id_usuario: caller.id,
      action: "TOTP_SETUP_DISCARDED",
      entity: "FactorTotp",
      entity_id: fila.dataValues.id,
      detail: "Eliminó un registro de factor TOTP pendiente de confirmar",
      metadata: { id_sesion: caller.id_sesion },
      severity: "info",
      ip_address: req.ip ?? null,
    });
    return res.status(200).json({ message: MENSAJE_FACTOR_ELIMINADO });
  }

  const quedaAlgunFactor = await tieneAlgunFactor(caller.id);
  if (!quedaAlgunFactor) {
    await revokeAllRememberedDevicesOf(caller.id);
    const sesionesRevocadas = await revokeAllSessionsOf(caller.id);
    logAction({
      id_usuario: caller.id,
      action: "TOTP_DELETED",
      entity: "FactorTotp",
      entity_id: fila.dataValues.id,
      detail: "Eliminó su último factor de autenticación; la cuenta queda sin ningún factor registrado",
      metadata: { id_sesion: caller.id_sesion, ultimo_factor: true, sesiones_revocadas: sesionesRevocadas },
      severity: "critical",
      ip_address: req.ip ?? null,
    });
  } else {
    logAction({
      id_usuario: caller.id,
      action: "TOTP_DELETED",
      entity: "FactorTotp",
      entity_id: fila.dataValues.id,
      detail: "Eliminó su factor de autenticación TOTP",
      metadata: { id_sesion: caller.id_sesion, ultimo_factor: false },
      severity: "warning",
      ip_address: req.ip ?? null,
    });
  }

  // The caller's own session was among the revoked, and the message says so.
  // Without this the browser keeps a dead cookie and the next request is a
  // bare 401 — the same one-liner `logoutAll` and `endSession` already do.
  // Found while auditing the passkey twin of this route (plan 4C, Task 9).
  if (!quedaAlgunFactor) clearSessionCookie(res);
  res.status(200).json({
    message: quedaAlgunFactor ? MENSAJE_FACTOR_ELIMINADO : MENSAJE_ULTIMO_FACTOR_ELIMINADO,
  });
});
