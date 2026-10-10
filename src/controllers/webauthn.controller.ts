// Passkeys: registering one, and everything that has to happen in the same
// breath as the first one.
//
// 🔴 **The rule this file exists under, and it is not negotiable: the endpoint
// that verifies a factor has to be live in the same deploy as the one that
// registers it.** `factorInventory.ts` already wrote that down for the 4B
// plan, and with passkeys it is worse than it was with TOTP, because the
// escape hatch is behind the same door. One row in `credencial_webauthn` makes
// `tieneCredencialRegistrada` (and with it `tieneAlgunFactor`) answer true,
// which makes every later login open `parcial`, and `parcial` is left only by
// proving a factor. Ship registration
// without verification and the first person to try it — which is whoever is
// testing — cannot get back in at all, and the ten recovery codes that would
// have rescued them are themselves behind a gate that asks for the factor they
// cannot prove.

import type { Request, Response } from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import { UsuarioModel } from "../models/usuario.model.js";
import { CredencialWebauthnModel } from "../models/credencialWebauthn.model.js";
import { guardarReto, consumirReto, purgarRetosCaducados } from "../auth/retoStore.js";
import {
  esContadorDeClon,
  buscarCredencialDe,
  marcarCredencialUsada,
} from "../auth/passkeyStore.js";
import { promoverSesion, sellarPruebaDeFactor } from "../auth/sessionPromotion.js";
import { tieneAlgunFactor, tieneCredencialRegistrada } from "../auth/factorInventory.js";
import { revokeAllSessionsOf } from "../auth/sessionStore.js";
import { revokeAllRememberedDevicesOf } from "../auth/rememberedDeviceStore.js";
import { clearSessionCookie } from "../auth/sessionCookie.js";
import {
  contarCodigosRestantes,
  prepararCodigos,
  escribirCodigos,
} from "../auth/recoveryCodeStore.js";
import { sequelize } from "../database/sequelize.js";
import { WEBAUTHN_RP_NAME } from "../config/security.js";
import { configuracionWebauthn } from "../auth/webauthnConfig.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const webauthnLog = log("webauthn.controller");
const handler = makeHandler(webauthnLog);

const MENSAJE_NOMBRE_REQUERIDO = "Ponle un nombre a esta llave para reconocerla después.";
const MENSAJE_NO_VERIFICADA =
  "No se pudo verificar esta llave. Vuelve a intentarlo desde el principio.";
const MENSAJE_YA_REGISTRADA = "No se pudo registrar esta llave. Prueba con otra.";
const NOMBRE_MAX = 100;

/**
 * Hand the browser what it needs to create a passkey, and write down the
 * challenge that will let exactly one answer through.
 *
 * **`residentKey: "required"` and `userVerification: "required"`, and both are
 * load-bearing.**
 *
 * `residentKey` makes this a *discoverable* credential — one the authenticator
 * can offer without being told which account to look for. That is what phase 2
 * needs to log somebody in without a username, and it has to be decided here,
 * at registration: a credential created without it cannot be upgraded later,
 * so registering the fleet under `preferred` would mean re-enrolling everybody
 * the day passwordless login arrives.
 *
 * `userVerification` is the entire reason a passkey counts as two factors on
 * its own. The authenticator refuses to sign until it has seen a fingerprint,
 * a face or a PIN, so one gesture proves both something held and something
 * known. Downgrade it to `preferred` and an assertion can come back meaning
 * nothing more than "this laptop was unlocked" — while `mfa_satisfied_at`,
 * stamped from it, opens ten minutes of the permission matrix.
 *
 * **`userID` is the account's own id and not a fresh random value.** Omitted,
 * the library mints a random one per call, and a browser reading two different
 * ids for the same person stores two unrelated passkeys instead of recognising
 * the account it already has.
 *
 * **`excludeCredentials` is a courtesy, not a control.** It stops the
 * authenticator offering to register a credential this account already has —
 * which would otherwise fail later on the unique index with an error nobody
 * can act on. It is advisory: the server still has to survive a duplicate,
 * which `registerVerify` does.
 *
 * 🔴 **No verified-address check here, and its absence is the decision — this
 * is the exit from `onboarding` that does not need a mailbox.** `setupTotp`
 * refuses with 409 until `email_verified_at` is set (Decision 5 of the MFA
 * design, §5), and `POST /auth/email/send` is itself a gated route. That is
 * fine for the TOTP door because it is not the last one. Asking the same of
 * this route would close the last one: an account whose address bounces, is
 * mistyped, or belongs to a mailbox nobody can reach would have **no** way to
 * register any factor, and registering a factor is the only thing that ends
 * `onboarding` — every account reaches that state on its own, `MFA_GRACE_DAYS`
 * after its first login (`estadoInicialDeSesion`). The result is the sealed
 * room: 403 to the whole ERP with no door out from inside the API, and the
 * only remedy a shell in the production container. The asymmetry with
 * `setupTotp` is therefore deliberate and must not be "tidied up" into
 * consistency — the one door that depends on nothing external is what keeps
 * the mail chain from being a single point of lockout for the whole payroll.
 *
 * What still holds the line is that this route is gated: `sinVentana` means
 * the caller's own password on every request, so "no verified address needed"
 * is not "no proof needed". See `webauthn.routes.ts`.
 */
export const registerOptions = handler("registerOptions", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const cuenta = await UsuarioModel.findByPk(caller.id, { attributes: ["id", "user", "name"] });
  // Archived in the instant between `authenticate` and here — the same narrow
  // race `totp.controller.ts` answers the same way.
  if (!cuenta) return res.sendStatus(401);

  const yaTiene = await CredencialWebauthnModel.findAll({
    where: { id_usuario: caller.id },
    attributes: ["credential_id", "transports"],
  });

  const { rpID } = configuracionWebauthn();
  const opciones = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID,
    userName: cuenta.dataValues.user,
    userDisplayName: cuenta.dataValues.name ?? cuenta.dataValues.user,
    userID: new TextEncoder().encode(String(caller.id)),
    attestationType: "none",
    excludeCredentials: yaTiene.map((c) => ({
      id: c.dataValues.credential_id,
      transports: c.dataValues.transports ? c.dataValues.transports.split(",") : undefined,
    })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });

  await guardarReto(opciones.challenge, "registro", {
    id_usuario: caller.id,
    id_sesion: caller.id_sesion,
  });

  // Fire-and-forget, same shape as `purgeExpiredTokens` at login: tidying up
  // must never fail a ceremony, so the error is logged and swallowed.
  void purgarRetosCaducados().catch((err: unknown) => {
    webauthnLog.error({ err }, "no se pudieron purgar los retos caducados");
  });

  return res.json(opciones);
});

/**
 * Verify the passkey the browser just created, and do everything else the
 * first factor of an account has to trigger.
 *
 * 🔴 **Five writes, and not one of them is inherited.** `confirmTotp` does the
 * same work for the TOTP path; a new endpoint gets none of it for free, and
 * each omission has its own distinct failure:
 *
 * 1. **The credential row.** The obvious one.
 * 2. **`promoverSesion`** — without it an `onboarding` session stays
 *    `onboarding` after registering, `requireStepUp` refuses it with
 *    `estado-incompleto`, and the client's interceptor **never retries that
 *    reason**. The only way out is logging out and back in.
 * 3. **`sellarPruebaDeFactor`, but only when the promotion found nothing** —
 *    finding F2/B-1. A `completa` session inside the grace period registers a
 *    passkey; `promoverSesion` matches no row (its `WHERE` covers only
 *    `parcial` and `onboarding`) and returns false; nobody stamps
 *    `mfa_satisfied_at`. From that instant `tieneAlgunFactor` says true, so
 *    the gate stops accepting the password on its own and starts demanding a
 *    factor proved recently — which that session has never proved. **Every
 *    protected write answers `sin-factor-reciente` until the person proves the
 *    passkey they just registered**, one more ceremony at
 *    `/webauthn/login/verify` for somebody who had already done exactly that a
 *    second earlier.
 * 4. **`mfa_satisfied_at` only when `userVerified`** — see `registerOptions`.
 * 5. 🔴 **The ten recovery codes, when the account has none.** This is the one
 *    that gets forgotten, and for a passkey-only account it is the difference
 *    between a lost phone and a lost account. Today they are minted in exactly
 *    one place — confirming a TOTP — and the manual endpoint that issues them
 *    sits behind a gate this account cannot pass.
 *
 * **The condition is `contarCodigosRestantes(id) === 0`, never
 * `tieneAlgunFactor`.** `totp.controller.ts` explains why: gating on the
 * factor count would kill a printed sheet that is still perfectly valid.
 *
 * 🔴 **A sixth write was here and is gone: clearing `usuarios.mfa_grace_until`.**
 * This route was the cheapest way to renew the fourteen-day deadline for ever,
 * because it is the only factor a person can register and delete without a
 * mailbox: register a passkey (the deadline was cleared), delete it, log in
 * again, and the login stamps a whole new fourteen days, since a cleared
 * deadline reads as "the clock never started". The tombstone at the foot of
 * `auth/sessionPromotion.ts` has the reasoning and the cost.
 *
 * 🔴 **And the bcrypt runs outside the transaction.** Ten hashes at cost 12 are
 * **2646 ms measured**; inside, they hold row locks on three tables and one of
 * the pool's fifteen connections while doing arithmetic that touches no
 * database. The read that decides is cheap and happens outside as a discard;
 * **the real decision is taken again inside**, because another request fits
 * between the two.
 */
export const registerVerify = handler("registerVerify", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const cuerpo = req.body as Record<string, unknown> | undefined;
  const nombre = typeof cuerpo?.nombre === "string" ? cuerpo.nombre.trim() : "";
  // Refused here rather than by Postgres: the column is NOT NULL VARCHAR(100),
  // and letting either limit be enforced down there turns a typo into a raw
  // constraint error in the response.
  if (nombre.length === 0 || nombre.length > NOMBRE_MAX) {
    return res.status(400).json({ message: MENSAJE_NOMBRE_REQUERIDO });
  }

  const { rpID, origenes } = configuracionWebauthn();

  // Captured out of the `expectedChallenge` callback below, which is the only
  // place the redeemed row is visible.
  //
  // A box rather than a bare `let`, and the reason is a type-checking one
  // worth naming: TypeScript cannot see that the callback ran, so after the
  // `await` it narrows a plain variable back to its initial `null` and every
  // read of it needs a cast. A cast there would be load-bearing — it guards
  // the ownership check below — and a cast that guards a security check is
  // exactly the kind that gets "simplified" later. A property on an object is
  // not narrowed that way, so the check reads as itself.
  const consumido: { fila: { id_usuario: number | null; id_sesion: string | null } | null } = {
    fila: null,
  };

  let verificacion: VerifiedRegistrationResponse;
  try {
    verificacion = await verifyRegistrationResponse({
      response: cuerpo?.respuesta as never,
      /**
       * 🔴 **The challenge is spent here, inside the verification, and that is
       * deliberate.** The library calls this before doing the expensive
       * cryptographic work, so a challenge that is expired, already spent,
       * minted for another ceremony or issued to another session costs one
       * `UPDATE` and stops — rather than a signature verification first.
       *
       * Spending it even when the signature later turns out to be bad is the
       * correct behaviour, not a leak: a challenge is single-use by
       * definition, and letting a failed attempt hand it back would make it
       * retryable, which is exactly the replay this table exists to stop.
       *
       * `id_sesion` is passed and constrains the lookup, so a challenge issued
       * to one session cannot be redeemed from another that got hold of it.
       */
      expectedChallenge: async (challenge: string) => {
        consumido.fila = await consumirReto(challenge, "registro", {
          id_sesion: caller.id_sesion,
        });
        return consumido.fila !== null;
      },
      expectedOrigin: origenes,
      expectedRPID: rpID,
      // Explicit rather than left to the default. The default is already
      // `true`, and it staying that way is what makes a passkey worth two
      // factors — see `registerOptions`. Written out so that a future edit
      // turning it off has to type the word.
      requireUserVerification: true,
    });
  } catch {
    // The library throws for a malformed response as well as for a failed
    // check, and the two are the same answer to the caller: start again.
    return res.status(400).json({ message: MENSAJE_NO_VERIFICADA });
  }

  if (!verificacion.verified || !verificacion.registrationInfo) {
    return res.status(400).json({ message: MENSAJE_NO_VERIFICADA });
  }

  /**
   * 🔴 The challenge said whose it was; the session says whose it should be.
   *
   * Belt and braces over the `id_sesion` already inside `consumirReto`'s
   * `WHERE`: the row's owner has to be the account making the request. It
   * costs one comparison and closes the whole family of bugs where a ceremony
   * started by one account is finished against another.
   */
  if (consumido.fila?.id_usuario !== caller.id) {
    return res.status(400).json({ message: MENSAJE_NO_VERIFICADA });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verificacion.registrationInfo;

  // See the docstring: the cheap discard runs out here, the real decision runs
  // inside the transaction, and the 2.6 seconds of bcrypt happen in between —
  // outside both.
  const yaTieneCodigos = (await contarCodigosRestantes(caller.id)) > 0;
  const preparados = yaTieneCodigos ? null : await prepararCodigos(caller.id);

  // Declared without an initialiser on purpose: every path out of the `catch`
  // below either returns or rethrows, so an initial `null` would be a value
  // nothing can ever read — and the linter is right to say so.
  let codigosRecuperacion: string[] | null;
  // The row's id, captured through a box for the same reason `consumido` is
  // above: it is assigned inside the callback and read after it, and a plain
  // `let` reads as `null` to the compiler at that point.
  const registrada: { id: number | null } = { id: null };
  try {
    codigosRecuperacion = await sequelize.transaction(async (transaction) => {
      const creada = await CredencialWebauthnModel.create(
        {
          id_usuario: caller.id,
          credential_id: credential.id,
          public_key: Buffer.from(credential.publicKey),
          // A string, because the column is BIGINT and `pg` hands it back as
          // one — see `ICredencialWebauthn.counter`. The library gives a
          // number here; this is the one place the two shapes meet.
          counter: String(credential.counter),
          transports: credential.transports?.join(",") ?? null,
          nombre,
          created_at: new Date(),
        },
        { transaction },
      );
      registrada.id = creada.dataValues.id;

      const promovida = await promoverSesion(caller.id_sesion, "passkey", { transaction });
      if (!promovida) {
        await sellarPruebaDeFactor(caller.id_sesion, "passkey", { transaction });
      }

      // Decided again in here: the read above ran outside and another request
      // could have issued codes in between. Regenerating over a sheet that
      // already exists would kill it.
      if (!preparados) return null;
      const restantes = await contarCodigosRestantes(caller.id, { transaction });
      if (restantes > 0) return null;
      await escribirCodigos(caller.id, preparados, transaction);
      return preparados.codigos;
    });
  } catch (err) {
    // 🔴 `credential_id` is unique across the whole table, so this fires for a
    // credential another account already registered as well as for one of this
    // account's own. Neither may be distinguishable in the answer: saying "that
    // credential is already registered" confirms to a caller that some other
    // account holds it.
    if (err instanceof Error && err.name === "SequelizeUniqueConstraintError") {
      webauthnLog.warn({ id_usuario: caller.id }, "credential_id ya registrado");
      return res.status(400).json({ message: MENSAJE_YA_REGISTRADA });
    }
    throw err;
  }

  /**
   * 🔴 Load-bearing, not decorative. `credencial_webauthn` has no soft delete,
   * so this line is the only record that the credential ever existed — and an
   * attacker who registers their own passkey is invisible without it.
   */
  await logAction({
    id_usuario: caller.id,
    action: "WEBAUTHN_REGISTERED",
    entity: "credencial_webauthn",
    // 🔴 The id, so that this line and the `WEBAUTHN_DELETED` that may follow
    // it years later can be read as a pair. Without it the bitácora shows a
    // key being removed and the logins it opened, and nothing anywhere says
    // when it was created — half an investigation.
    entity_id: registrada.id,
    detail: `Passkey registrada: ${nombre}`,
    metadata: {
      nombre,
      // Recorded in the bitácora rather than in a column, because the table has
      // nowhere to put them yet. A synced credential lives in somebody's Apple
      // or Google account, which changes what "something you have" means; the
      // screen cannot show that today, and this is at least a trail.
      tipo: credentialDeviceType,
      respaldada: credentialBackedUp,
    },
    // `critical`, matching `TOTP_CONFIRMED`: registering a credential is the
    // exact event a stolen cookie produces when it is used to take an account,
    // and the whole argument for `sinVentana` rests on somebody being
    // able to notice it. `info` was a line nobody would read.
    severity: "critical",
    ip_address: req.ip ?? null,
  });

  if (codigosRecuperacion) {
    // Its own line, apart from the one above, because they are two distinct
    // facts and only one of them happens every time — the same split
    // `confirmTotp` makes.
    // The same shape and severity as the line `confirmTotp` writes under this
    // name — entity, id, count, `critical`. One verb with two forms is a
    // report that counts the sheets issued on TOTP and misses the ones issued
    // on a first passkey.
    await logAction({
      id_usuario: caller.id,
      action: "RECOVERY_CODES_ISSUED",
      entity: "Usuario",
      entity_id: caller.id,
      detail: "Se emitieron diez códigos de recuperación al registrar la primera passkey",
      metadata: { id_sesion: caller.id_sesion, cantidad: codigosRecuperacion.length },
      severity: "critical",
      ip_address: req.ip ?? null,
    });
  }

  return res.status(201).json({
    message: "Llave registrada.",
    // Only ever returned here, in the one response that mints them. There is
    // no endpoint that reads them back.
    codigosRecuperacion,
  });
});

const MENSAJE_SIN_PASSKEYS = "Esta cuenta no tiene ninguna llave registrada.";
const MENSAJE_NO_RECONOCIDA = "No se pudo comprobar esa llave. Inténtalo otra vez.";

/**
 * The verb, exported for the passwordless door (`webauthnPasswordless.controller.ts`),
 * which writes the same line for a refused anonymous assertion: one name for
 * one event, whichever door refused it, so a count by `action` sees both.
 */
export const WEBAUTHN_ASSERTION_FAILED = "WEBAUTHN_ASSERTION_FAILED";

/**
 * The line every refused assertion leaves behind — **and the other half of the
 * decision not to charge the account lockout.**
 *
 * 🔴 Isaias's decision of 2026-09-02 exempts a failed signature from
 * `failed_attempts`, and the argument for it is sound: an ECDSA signature is
 * not guessed, so charging the guesser defends nothing and only lets a
 * fingerprint reader having a bad morning shut a colleague out of the ERP for
 * a quarter of an hour. But an exemption granted on its own leaves these two
 * routes with **no charge, no rate limiter and no record**: somebody holding a
 * stolen cookie could sit on `/login/verify` all night and the only trace
 * would be the web server's access log. The exemption was always meant to come
 * with this line — the plan says so in as many words — and without it the
 * trade is not "record instead of charge", it is nothing instead of charge.
 *
 * **Written down here, answered uniformly out there.** `motivo` separates a
 * malformed body from a credential that is not this account's from a signature
 * the library refused; the caller sees the same sentence for all of them, for
 * the reason `MENSAJE_NO_RECONOCIDA` exists. The distinction is for whoever
 * reads the bitácora afterwards, and it is the difference between a broken
 * reader and somebody working through a list of credentials.
 *
 * `warning`, not `critical`: a cancelled system dialog and a mistyped ceremony
 * land here too, so this is a thing to count rather than a thing to wake up
 * for. The one genuinely alarming case — a counter that went backwards, which
 * means a credential was **copied** — keeps its own `critical` line.
 */
async function registrarAsercionFallida(
  req: Request,
  caller: { id: number; id_sesion: string },
  motivo: string,
  id_credencial: number | null,
): Promise<void> {
  await logAction({
    id_usuario: caller.id,
    action: WEBAUTHN_ASSERTION_FAILED,
    entity: "credencial_webauthn",
    entity_id: id_credencial,
    detail: `Intento de probar una passkey rechazado: ${motivo}`,
    metadata: { id_sesion: caller.id_sesion, motivo },
    severity: "warning",
    ip_address: req.ip ?? null,
  });
}

/**
 * Hand the browser what it needs to prove a passkey this account already has.
 *
 * Reached by a `parcial` session finishing its login, and by a `completa` one
 * refreshing its step-up window — one pair of endpoints for both, because the
 * ceremony is identical and only what happens afterwards differs.
 * `sessionState.ts` already opens `/api/auth/webauthn/login` to `parcial`,
 * which is the state this exists for.
 *
 * **`allowCredentials` is filled in here, unlike the passwordless ceremony of
 * phase 2 which must send it empty.** The difference is not a preference: here
 * the session already names the account, so listing its credentials costs
 * nothing and lets the authenticator go straight to the right one instead of
 * offering every passkey on a shared machine. In phase 2 no account is named
 * yet, and asking for one in order to build this list would be an oracle — it
 * answers with a list for somebody who has a passkey and an empty one for
 * somebody who does not, which is precisely who to phish for a password.
 */
export const loginOptions = handler("loginOptions", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const credenciales = await CredencialWebauthnModel.findAll({
    where: { id_usuario: caller.id },
    attributes: ["credential_id", "transports"],
  });
  // Not an oracle: the caller is already authenticated as this account, so
  // this tells them only about themselves.
  if (credenciales.length === 0) {
    return res.status(400).json({ message: MENSAJE_SIN_PASSKEYS });
  }

  const { rpID } = configuracionWebauthn();
  const opciones = await generateAuthenticationOptions({
    rpID,
    allowCredentials: credenciales.map((c) => ({
      id: c.dataValues.credential_id,
      transports: c.dataValues.transports ? c.dataValues.transports.split(",") : undefined,
    })),
    // Same reason as at registration: without it an assertion can mean nothing
    // more than "this device was unlocked", and what it stamps opens ten
    // minutes of the ERP's most sensitive writes.
    userVerification: "required",
  });

  await guardarReto(opciones.challenge, "segundo_factor", {
    id_usuario: caller.id,
    id_sesion: caller.id_sesion,
  });

  // 🔴 Same fire-and-forget purge as `registerOptions`, and **this** is the
  // one that keeps the table from growing. Registering a passkey happens once
  // or twice in an account's life; proving one happens on every login and
  // again every ten minutes of step-up, so hanging the only cleanup off the
  // rare ceremony left the frequent one writing rows nothing ever removed.
  // The rows do go eventually — `id_sesion` cascades when
  // `purgeExpiredSessions` takes the session — but that is thirty days later
  // and only for challenges that had a session.
  void purgarRetosCaducados().catch((err: unknown) => {
    webauthnLog.error({ err }, "no se pudieron purgar los retos caducados");
  });

  return res.json(opciones);
});

/**
 * Check the assertion, and turn it into a proved factor.
 *
 * 🔴 **The credential is looked up by `(credential_id, id_usuario)`, and the
 * account comes from the session — never from the request.** The full attack
 * this closes is written out in `buscarCredencialDe`; the short version is
 * that a colleague who knows your password can otherwise finish your login
 * with **their own** fingerprint, on a shared machine, with an assertion that
 * is cryptographically perfect. The model's own comment argues for the unsafe
 * lookup, because it was written for the passwordless ceremony where it is the
 * correct one.
 *
 * **A failed assertion does not touch `failed_attempts`** — Isaias's decision
 * of 2026-09-02, and it matches the exemption already carved for a
 * cryptographic failure in `mfa.controller.ts`. The account lockout exists
 * against a guessable secret: a six-digit code with one step of tolerance
 * either way is three valid values in a million, so guessing is a real threat
 * and charging the guesser is the defence. An ECDSA signature is not guessed.
 * Keeping the lockout here would only mean that a fingerprint reader having a
 * bad morning, or somebody with a grudge, can shut a colleague out of the ERP
 * for a quarter of an hour. What it does instead is leave a line — see
 * `registrarAsercionFallida`, which is the other half of that decision and not
 * an optional flourish on it.
 *
 * **Two asymmetries with the TOTP doors, both decided rather than overlooked.**
 *
 * 1. **A locked account may still finish here.** `/auth/mfa/verify` and
 *    `/auth/stepup` both refuse one up front, and this does not. That follows
 *    from the same reasoning: the lockout defends a guessable secret, and if a
 *    failed assertion may not *charge* it, then letting it *block* the one
 *    credential that cannot be guessed would hand an attacker a denial of
 *    service — five wrong passwords from anywhere and the real owner's passkey
 *    stops working for fifteen minutes.
 * 2. **It never clears the lockout either, and does not mint a "remember this
 *    device" cookie.** `limpiarFallosPrevios` would have been the symmetric
 *    move, and it clears `locked_until` as well as the counter — which would
 *    quietly turn a passkey into an unlock mechanism, today the preserve of an
 *    administrator or the clock. That is a policy question, not a consistency
 *    edit, so it is left alone until somebody decides it. The remembered-device
 *    cookie is the same shape of question and a smaller one: it exists to save
 *    typing six digits, and a passkey is already a single gesture.
 */
export const loginVerify = handler("loginVerify", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const cuerpo = req.body as Record<string, unknown> | undefined;
  const respuesta = cuerpo?.respuesta as { id?: unknown } | undefined;
  if (!respuesta || typeof respuesta.id !== "string") {
    // 🔴 **No line for this one**, unlike the three refusals below, and the
    // asymmetry is the point. Nothing was attempted here: no assertion was
    // offered, so there is nothing to record about a passkey and the phrase
    // "intento de probar una passkey rechazado" would be a lie in the one
    // table people go to for the truth. `mfa.controller.ts` makes exactly this
    // distinction for a missing code — *"Nothing was attempted — no charge"*.
    // It is also the cheapest request an attacker can send, so it is the one
    // that must not turn into a row.
    return res.status(400).json({ message: MENSAJE_NO_RECONOCIDA });
  }

  // 🔴 The owner comes from `req.user`, and this line is the whole finding.
  const credencial = await buscarCredencialDe(respuesta.id, caller.id);
  if (!credencial) {
    // The same sentence a bad signature gets. A caller must not be able to
    // tell "no such credential" from "not yours" — the second answer would
    // confirm that a credential they hold belongs to somebody else here.
    // The bitácora may tell them apart; the response may not.
    await registrarAsercionFallida(req, caller, "credencial-ajena-o-inexistente", null);
    return res.status(400).json({ message: MENSAJE_NO_RECONOCIDA });
  }

  const { rpID, origenes } = configuracionWebauthn();
  const guardado = credencial.counter;

  let verificacion: VerifiedAuthenticationResponse;
  try {
    verificacion = await verifyAuthenticationResponse({
      response: respuesta as never,
      // Spent inside the verification, before the expensive cryptography, and
      // scoped to this session — the same shape and the same reasoning as
      // `registerVerify`. For a synced passkey this single-use redemption is
      // the *only* replay defence there is: those credentials report a counter
      // of 0 forever, so the check further down can never catch a clone of one.
      expectedChallenge: async (challenge: string) => {
        const fila = await consumirReto(challenge, "segundo_factor", {
          id_sesion: caller.id_sesion,
        });
        return fila !== null && fila.id_usuario === caller.id;
      },
      expectedOrigin: origenes,
      expectedRPID: rpID,
      credential: {
        id: credencial.credential_id,
        publicKey: new Uint8Array(credencial.public_key),
        // 🔴 `Number(...)`, and this conversion is the whole reason
        // `ICredencialWebauthn.counter` is declared `string`. The column is
        // BIGINT, `pg` hands it back as text, and the library's parameter is a
        // number — this is the one point where the two shapes meet, so it is
        // the one place the conversion may happen. A `signCount` is an
        // unsigned 32-bit integer by specification, so `Number` is exact here
        // and loses nothing.
        counter: Number(guardado),
        transports: undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    // Where a spent or expired challenge lands, and where the library's own
    // counter rule lands too — it throws one indistinguishable error for all
    // of them, which is why the branch further down still exists.
    await registrarAsercionFallida(req, caller, "verificacion-rechazada", credencial.id);
    return res.status(400).json({ message: MENSAJE_NO_RECONOCIDA });
  }

  if (!verificacion.verified) {
    await registrarAsercionFallida(req, caller, "firma-invalida", credencial.id);
    return res.status(400).json({ message: MENSAJE_NO_RECONOCIDA });
  }

  const recibido = verificacion.authenticationInfo.newCounter;

  /**
   * 🔴 Detection, not refusal — the library already refused, and by a stricter
   * rule (see `esContadorDeClon`). Reaching this branch means the library
   * accepted and this did not, which with today's two rules cannot happen; it
   * is kept because the rules are independent, and the day either one moves, a
   * counter going backwards is the single signal that a credential has been
   * **copied**. That deserves a line somebody will see rather than
   * disappearing into the same 400 as a mistyped ceremony.
   */
  if (esContadorDeClon(guardado, recibido)) {
    await logAction({
      id_usuario: caller.id,
      action: "WEBAUTHN_COUNTER_REGRESSION",
      entity: "credencial_webauthn",
      entity_id: credencial.id,
      detail: `El contador de firmas retrocedió: guardado ${guardado}, recibido ${recibido}.`,
      severity: "critical",
      ip_address: req.ip ?? null,
    });
    return res.status(400).json({ message: MENSAJE_NO_RECONOCIDA });
  }

  const promovida = await sequelize.transaction(async (transaction) => {
    await marcarCredencialUsada(credencial.id, recibido, { transaction });
    // Both, in this order, for the reason `registerVerify` sets out: the
    // promotion only matches `parcial` and `onboarding`, so a `completa`
    // session refreshing its step-up window needs the seal instead — and
    // without it nothing stamps `mfa_satisfied_at` and the window never opens.
    const subio = await promoverSesion(caller.id_sesion, "passkey", { transaction });
    if (!subio) {
      await sellarPruebaDeFactor(caller.id_sesion, "passkey", { transaction });
    }
    return subio;
  });

  /**
   * 🔴 **The trail, and it was missing.** Every other way of proving a factor
   * writes one — `MFA_VERIFIED` when a login completes, `STEP_UP_REPROVED`
   * when a live session re-opens its ten-minute window — and until this line
   * existed, a passkey was the one credential in the ERP that could open
   * either of those doors leaving nothing behind. That is precisely the
   * credential worth following: it is the one that syncs into somebody's Apple
   * or Google account, so "who proved a factor, from where, and when" stops
   * being answerable for exactly the method most likely to be used from a
   * device nobody in the office has seen.
   *
   * **The two existing names rather than a third of our own.** This endpoint
   * serves both ceremonies — `promoverSesion` returning `true` means a session
   * just finished logging in, `false` means a `completa` one refreshed its
   * window — so it files each under the name that already means that, and puts
   * `passkey` in `fuente` exactly as the TOTP paths put `totp` or `codigo`.
   * A new verb would have meant every saved search and every report that reads
   * this column silently stopped counting a whole method.
   *
   * `await`ed like the registration line above: `logAction` swallows its own
   * failures, so this costs one insert and never turns a proved factor into a
   * 500.
   */
  await logAction({
    id_usuario: caller.id,
    action: promovida ? "MFA_VERIFIED" : "STEP_UP_REPROVED",
    entity: "Usuario",
    entity_id: caller.id,
    detail: promovida
      ? "Segundo factor verificado (passkey)"
      : "Sesión re-acreditada sin cerrar sesión (passkey)",
    metadata: {
      id_sesion: caller.id_sesion,
      fuente: "passkey",
      // Which key, of the several an account may hold. Without it the line
      // says a passkey was used and not *which*, and the one question worth
      // asking after a credential is found to be copied is which sessions it
      // opened.
      id_credencial: credencial.id,
    },
    severity: "info",
    ip_address: req.ip ?? null,
  });

  return res.json({ message: "Identidad confirmada." });
});


const MENSAJE_LLAVE_NO_ENCONTRADA = "Esa llave no existe.";
const MENSAJE_LLAVE_ELIMINADA = "Llave eliminada.";
const MENSAJE_ULTIMA_LLAVE_ELIMINADA =
  "Llave eliminada. Era tu último factor: se han cerrado todas tus sesiones y entrarás sólo con tu contraseña. Vuelve a iniciar sesión.";
// Plan 4E's case: the last *credential* went, but the verified address is a
// factor on its own, so nothing is logged out. The remembered devices are
// revoked all the same — they were trusted on the strength of the key.
const MENSAJE_ULTIMA_LLAVE_QUEDA_CORREO =
  "Llave eliminada. Era tu última llave o aplicación: a partir de ahora entrarás con un código enviado a tu correo. Hemos olvidado los equipos recordados; tus sesiones siguen abiertas.";
// The failure twin of the sentence above, plan 4E: only the remembered
// devices were at stake, so the person is not told their sessions are open
// with nothing behind them. `logout-all` from the profile revokes both.
const MENSAJE_EQUIPOS_NO_OLVIDADOS =
  "Llave eliminada, pero no pudimos olvidar tus equipos recordados. Cierra sesión en todos tus dispositivos desde tu perfil para que ninguno siga entrando sin pedirte el código.";
// The third outcome, and it may not borrow the sentence above: telling
// somebody with two keys left that they just deleted their *last* factor
// leaves them concluding the ERP ate the other two.
const MENSAJE_SESIONES_CERRADAS_PRECAUCION =
  "Llave eliminada. No pudimos comprobar si te quedaba otro factor, así que hemos cerrado tus sesiones por precaución. Vuelve a iniciar sesión.";
const CODIGO_REVOCACION_FALLIDA = "REVOCACION_FALLIDA";
const MENSAJE_REVOCACION_FALLIDA =
  "La llave se eliminó, pero no se pudieron cerrar tus sesiones. Cierra sesión en todos tus dispositivos desde el panel de seguridad.";

/**
 * The passkeys this account has registered.
 *
 * **What it returns, and what it deliberately leaves out.** `id`, `nombre`,
 * `created_at`, `last_used_at`, `transports` — enough to recognise a key and
 * to name the one to delete. Not `public_key`, which the model's `defaultScope`
 * and its `toJSON` both already strip and which no client has ever needed. Not
 * `counter`, which says only how many times a device has signed. And **not
 * `credential_id`**: the browser sees it during a ceremony because the
 * authenticator needs it, but it is a stable, globally unique handle for one
 * key, and a screen that lists keys has no use for it. Asked for by name rather
 * than trimmed afterwards, so the column list here is the whole answer to "what
 * leaves the process".
 *
 * 🔴 **`last_used_at` and `created_at` are not decoration, they are the
 * disambiguator.** `credencial_webauthn.nombre` has no per-user uniqueness —
 * written down as open debt in this plan — so two keys called "mi móvil" are
 * possible, and telling them apart is the one job this list has. The dates are
 * what make that possible without a migration. `last_used_at` is null until a
 * key has been used once.
 *
 * Scoped to `req.user.id`, never to anything in the request.
 */
export const listCredentials = handler("listCredentials", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const filas = await CredencialWebauthnModel.findAll({
    where: { id_usuario: caller.id },
    attributes: ["id", "nombre", "created_at", "last_used_at", "transports"],
    order: [["created_at", "ASC"]],
  });

  // An object with a named field, never a bare array — the shape every other
  // list in this API answers with (`{ sesiones }`, `{ codigos }`). A bare
  // array cannot grow a sibling field later without breaking the client that
  // consumes it, and this is the moment the shape gets decided.
  return res.json({ credenciales: filas.map((f) => f.dataValues) });
});

/**
 * Remove one passkey.
 *
 * 🔴 **`id` and `id_usuario` in the same `WHERE`, and this is the whole
 * security property.** The id comes off the URL, where anybody can put any
 * number; the owner comes off `req.user`, which `authenticate` read from the
 * session row. Deleting by id alone would let anybody remove anybody else's
 * second factor — an IDOR this repository has a history of, in this exact
 * shape. The same statement that deletes is the one that checks ownership, so
 * there is no window between the two and no second query to forget.
 *
 * A row that did not match is answered 404 with the same sentence whether it
 * never existed or belongs to somebody else. Telling those apart would turn
 * this into a probe for which credential ids are registered here.
 *
 * 🔴 **Losing the last factor revokes sessions *and* remembered devices**, the
 * same pair `deleteTotp` revokes and for the same reason: `estadoEfectivo`
 * never walks back an `mfa_source` already written — it returns on its first
 * line for a row that says `completa` — so a cookie minted before the deletion
 * would go on holding the whole ERP, with no factor behind it, for up to
 * `SESSION_ABSOLUTE_DAYS`. That cookie is a key to the security panel with no
 * password attached.
 *
 * 🔴 **And the count is asked AFTER the row is gone, with no transaction
 * around either — which is the opposite of the instinct and is what makes it
 * correct.** With N passkeys the question is not "did I have a factor" but "is
 * there one left", so it can only be asked afterwards. And it must be asked of
 * *committed* state: `tieneCredencialRegistrada` (and, when that says no,
 * `tieneAlgunFactor` — plan 4E's two questions) is called here without a
 * transaction, on purpose — wrapping the delete in one and passing it along
 * would have it count the row this request is in the middle of removing, find it, and never
 * revoke anything. Two tabs deleting two
 * different keys at once cannot both miss, either, precisely because each
 * counts only after its own delete has committed — the later count sees an
 * empty table.
 *
 * The bitácora line is load-bearing for the same reason the registration one
 * is: this table has no soft delete, so afterwards nothing anywhere records
 * that the credential ever existed.
 */
export const deleteCredential = handler("deleteCredential", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  // Parsed, not trusted: `:id` is a string and the column is an integer, so
  // a non-numeric path segment must be a 404 rather than something Sequelize
  // is asked to compare against a number.
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ message: MENSAJE_LLAVE_NO_ENCONTRADA });
  }

  // Read before the delete only for what the bitácora needs to say — the
  // name is gone the moment the row is. Scoped like the delete below, so a
  // miss here and a miss there mean the same thing.
  const fila = await CredencialWebauthnModel.findOne({
    where: { id, id_usuario: caller.id },
    attributes: ["id", "nombre"],
  });

  const destruidas = await CredencialWebauthnModel.destroy({
    where: { id, id_usuario: caller.id },
  });
  if (destruidas === 0 || !fila) {
    return res.status(404).json({ message: MENSAJE_LLAVE_NO_ENCONTRADA });
  }

  // 🔴 **Written first, before anything below it can fail.** The row is gone
  // and the table has no soft delete, so from this instant the bitácora is
  // the only record the key ever existed. Every `await` between the delete
  // and this line was a way to lose that record for good.
  //
  // Best effort, not a guarantee, and the difference is worth stating:
  // `logAction` swallows its own failures, so in the one failure mode this
  // ordering was chosen against — the database stops answering — this INSERT
  // is lost too. What the ordering does buy is every failure that is *not*
  // the database: a thrown revocation, a bug in the tail, a blip between
  // statements. A variant of `logAction` that reported whether it wrote
  // would close the rest; it does not exist yet.
  await logAction({
    id_usuario: caller.id,
    action: "WEBAUTHN_DELETED",
    entity: "credencial_webauthn",
    entity_id: fila.dataValues.id,
    detail: `Eliminó la llave «${fila.dataValues.nombre}»`,
    metadata: { id_sesion: caller.id_sesion, nombre: fila.dataValues.nombre },
    severity: "warning",
    ip_address: req.ip ?? null,
  });

  // 🔴 **The tail may not become a mute 500, and it fails closed.** The row
  // is already gone. If the count below throws and this handler simply dies,
  // the account is left with no factor and every `completa` session alive
  // with `mfa_source = 'passkey'` — the exact hole the revocation exists to
  // close — and the retry cannot fix it: the second DELETE finds nothing and
  // leaves through the 404 above. The person reads "esa llave no existe",
  // concludes it is done, and a cookie stolen before the deletion goes on
  // opening the security panel with no password for up to
  // `SESSION_ABSOLUTE_DAYS`.
  //
  // So an unanswerable count is treated as "it was the last one". The cost
  // of being wrong that way is a re-login for somebody who still holds
  // another key; the cost of being wrong the other way is permanent.
  //
  // **One retry first.** What makes two COUNTs throw is almost always
  // transient — a pool momentarily exhausted, one dropped connection — and
  // the `destroy` that just succeeded says the database was alive a
  // millisecond ago. A second attempt turns most blips into the right answer
  // and leaves the closed failure as the net, not the road.
  // Two questions since plan 4E, and the header of `factorInventory.ts` says
  // why they split: "is there a *credential* left" (another key, or an app)
  // decides whether anything happens at all and whether the remembered
  // devices go — they were trusted on the strength of a credential; "is there
  // a *factor* left" (which a verified address now is) decides whether the
  // sessions go too. An unanswerable count is treated as "nothing left" on
  // both, for the reason above.
  let quedaCredencial: boolean;
  let quedaAlgunFactor: boolean;
  let recuentoFallido = false;
  try {
    ({ credencial: quedaCredencial, factor: quedaAlgunFactor } = await contarConUnReintento(caller.id));
  } catch (err) {
    webauthnLog.error(
      { err, id_usuario: caller.id },
      "no se pudo saber si queda algún factor tras borrar la llave: se revoca como si no quedara",
    );
    quedaCredencial = false;
    quedaAlgunFactor = false;
    recuentoFallido = true;
  }
  if (quedaCredencial) {
    return res.status(200).json({ message: MENSAJE_LLAVE_ELIMINADA, sesion_cerrada: false });
  }

  // `null` until each half has run, so the failure line below can say which
  // of the two got done — whoever reads it afterwards has to know whether the
  // remembered devices are gone or still waiting to skip the factor. The
  // sessions half runs only when no factor at all remains: an account that
  // can still prove itself by email keeps them.
  let dispositivosRevocados: number | null = null;
  let sesionesRevocadas: number | null = null;
  try {
    dispositivosRevocados = await revokeAllRememberedDevicesOf(caller.id);
    if (!quedaAlgunFactor) sesionesRevocadas = await revokeAllSessionsOf(caller.id);
  } catch (err) {
    // The one outcome that must not look like success. The key is gone, the
    // revocation did not happen, and the retry is a 404: the answer has to
    // say what to do instead, and `logout-all` — which revokes both sessions
    // and devices — is reachable from every state this route is.
    //
    // Two shapes, plan 4E: with a verified address left, what failed was the
    // remembered-device revocation and the sessions were never at risk — a
    // `warning` with its own verb and a sentence that does not tell the
    // person their sessions are open with no factor behind them, because
    // they are not. Without one, it is the last factor and the original
    // `critical` line.
    webauthnLog.error(
      { err, id_usuario: caller.id, queda_correo: quedaAlgunFactor },
      quedaAlgunFactor
        ? "no se pudieron revocar los equipos recordados tras borrar la última llave"
        : "no se pudieron revocar las sesiones tras borrar la última llave",
    );
    await logAction({
      id_usuario: caller.id,
      action: quedaAlgunFactor ? "LAST_CREDENTIAL_REVOCATION_FAILED" : "LAST_FACTOR_REVOCATION_FAILED",
      entity: "Usuario",
      entity_id: caller.id,
      detail: quedaAlgunFactor
        ? "Se eliminó la última llave y NO se pudieron revocar los equipos recordados; le queda el correo verificado como factor"
        : "Se eliminó el último factor y NO se pudieron revocar las sesiones: la cuenta sigue abierta sin factor",
      metadata: {
        id_sesion: caller.id_sesion,
        factor: "passkey",
        id_credencial: fila.dataValues.id,
        queda_correo: quedaAlgunFactor,
        // Which half ran. `null` means the devices were never reached either.
        dispositivos_revocados: dispositivosRevocados,
      },
      severity: quedaAlgunFactor ? "warning" : "critical",
      ip_address: req.ip ?? null,
    });
    // `code`, the way every refusal of this API carries one: the screen must
    // tell "the revocation failed, use logout-all" from an ordinary 500
    // without matching a Spanish sentence.
    return res.status(500).json({
      message: quedaAlgunFactor ? MENSAJE_EQUIPOS_NO_OLVIDADOS : MENSAJE_REVOCACION_FALLIDA,
      code: CODIGO_REVOCACION_FALLIDA,
    });
  }

  if (quedaAlgunFactor) {
    // Plan 4E: the verified address remains, so this is not the loss of the
    // last factor and must not be counted as one — its own verb, with what
    // was and was not revoked.
    await logAction({
      id_usuario: caller.id,
      action: "LAST_CREDENTIAL_REMOVED",
      entity: "Usuario",
      entity_id: caller.id,
      detail: "Eliminó su última llave; le queda el correo verificado como segundo factor. Equipos recordados revocados, sesiones intactas",
      metadata: {
        id_sesion: caller.id_sesion,
        factor: "passkey",
        id_credencial: fila.dataValues.id,
        queda_correo: true,
        dispositivos_revocados: dispositivosRevocados,
      },
      severity: "warning",
      ip_address: req.ip ?? null,
    });
    return res.status(200).json({ message: MENSAJE_ULTIMA_LLAVE_QUEDA_CORREO, sesion_cerrada: false });
  }

  // Two verbs, because a count is done by `action` and nobody reads the
  // prose: `LAST_FACTOR_REMOVED` must mean what it says, and an account that
  // still holds two keys and got logged out as a precaution is a different
  // fact, worth counting on its own.
  await logAction({
    id_usuario: caller.id,
    action: recuentoFallido ? "SESSIONS_REVOKED_PRECAUTION" : "LAST_FACTOR_REMOVED",
    entity: "Usuario",
    entity_id: caller.id,
    detail: recuentoFallido
      ? "Eliminó una llave y no se pudo comprobar si quedaba otro factor: se han revocado todas las sesiones por precaución"
      : "Eliminó su último factor de autenticación; la cuenta queda sin ningún factor registrado",
    metadata: {
      id_sesion: caller.id_sesion,
      factor: "passkey",
      id_credencial: fila.dataValues.id,
      recuento_fallido: recuentoFallido,
      sesiones_revocadas: sesionesRevocadas,
      dispositivos_revocados: dispositivosRevocados,
    },
    severity: "critical",
    ip_address: req.ip ?? null,
  });

  // The caller's own session is among the revoked, and the message says so.
  // Without this the browser keeps a dead cookie and the next request is a
  // bare 401 — `logoutAll` and `endSession` both clear it for the same reason.
  clearSessionCookie(res);
  // `sesion_cerrada`, so the client does not have to string-match three
  // sentences to know its own session just ended: it must show the message as
  // a toast (inline text dies with the navigation the next 401 causes) and
  // must not refetch the list, or a second, contradictory toast lands on top.
  return res.status(200).json({
    message: recuentoFallido ? MENSAJE_SESIONES_CERRADAS_PRECAUCION : MENSAJE_ULTIMA_LLAVE_ELIMINADA,
    sesion_cerrada: true,
  });
});

/**
 * The two questions of `factorInventory.ts`, asked in order: a credential
 * left answers both, so the second read runs only when the first said no.
 */
async function contarLoQueQueda(id_usuario: number): Promise<{ credencial: boolean; factor: boolean }> {
  const credencial = await tieneCredencialRegistrada(id_usuario);
  const factor = credencial || (await tieneAlgunFactor(id_usuario));
  return { credencial, factor };
}

/**
 * `contarLoQueQueda`, tried twice. See the call site for why once is not
 * enough and why three would be theatre: the second attempt catches the blip,
 * and what survives two is not a blip.
 */
async function contarConUnReintento(id_usuario: number): Promise<{ credencial: boolean; factor: boolean }> {
  try {
    return await contarLoQueQueda(id_usuario);
  } catch {
    return await contarLoQueQueda(id_usuario);
  }
}
