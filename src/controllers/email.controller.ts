// Registering and confirming the address on your own account.
//
// Both routes sit behind `authenticate` — see `auth.routes.ts` — but for two
// different reasons, and the difference matters for how each handler reads
// its input:
//
// - `POST /email/send` acts on the caller's *own* row. `req.user.id` is who
//   gets written to.
// - `POST /email/verify` does not. The account that gets `email_verified_at`
//   set is whoever `consumirToken` says the token belongs to — never
//   `req.user.id`, and never anything the request body says either. A
//   verification link is meant to be opened from an email client, and
//   `authenticate` here is a floor ("some session must exist to reach this
//   endpoint at all") rather than a match check against the token's own
//   owner — `consumirToken`'s single atomic UPDATE has no way to take an
//   identity argument to compare against (see Global Constraint #4, and
//   `tokenStore.ts`'s own comment on why redemption cannot accept one), so
//   there is nothing here to compare `req.user.id` against even if the design
//   wanted to.
//
// `handler()` used to be its own small copy here rather than an import from
// `auth.controller.ts`, which already had one — importing it would have
// pulled that module's entire import graph (`sessionStore.js`,
// `credentials.js`, `permissions/store.js`, `bcryptjs`) into this file's
// tests just to load one trivial wrapper safely. That was right about the
// coupling and wrong about the fix: `../utils/handler.js` is what actually
// removes it, by taking the logger as a parameter instead of assuming
// `auth.controller.ts`'s. See that module's header for the rest of the
// reasoning, including the third copy this was starting to become.
//
// `callerOf()` did not move anywhere — it was one line, `req.user ?? null`,
// and is written out inline below instead.

import type { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import { TokenUsoUnicoModel } from "../models/tokenUsoUnico.model.js";
import { sequelize } from "../database/sequelize.js";
import { crearToken, consumirToken } from "../auth/tokenStore.js";
import { enviarCorreo } from "../auth/mailer.js";
import { consumirPresupuestoDeCorreo } from "../auth/mailBudget.js";
import { avisarCorreoCambiado } from "../auth/securityNotice.js";
import { verifyOwnPassword } from "../auth/credentials.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { allowedOrigins, DEV_FRONTEND_ORIGIN } from "../config/security.js";

const emailLog = log("email");
const handler = makeHandler(emailLog);

/** Twin of the message in `authenticate.ts` and `auth.controller.ts`; both mean the row is gone. */
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";

/**
 * Same wording as `usuario.controller.ts`'s exports of the same name — a
 * second, deliberate copy rather than an import, for the same reason
 * `handler()` used to be one before it moved to `utils/handler.js`:
 * importing either constant from `usuario.controller.ts` pulls that file's
 * own import graph (`RolModel`, `permissions/store.js`'s `can`, `bcryptjs`)
 * into this file's tests to load two sentences. Flagged in the report —
 * if a third caller ever needs these, they are the next candidate for the
 * treatment `handler()` got, in a module with no imports of its own.
 */
export const CURRENT_PASSWORD_REQUIRED_MESSAGE = "Debe proporcionar su contraseña actual.";
export const CURRENT_PASSWORD_WRONG_MESSAGE = "La contraseña actual suministrada no es correcta.";

/**
 * One answer for "no email in the body" and "that string is not shaped like
 * an email" — both are about the request, not about anyone's account, so
 * there is nothing to keep uniform between them.
 */
export const EMAIL_INVALIDO = "Debe indicar una dirección de correo válida.";

/**
 * What `/email/send` answers, always, whatever actually happened.
 *
 * Global Constraint #1: the same body, the same code, whether the address
 * belongs to nobody yet, already belongs to another unverified account (the
 * collision this endpoint deliberately does not check — see the module
 * comment on `/email/verify` below for where that collision does get
 * caught), or Resend itself is down. A caller who gets a different sentence
 * for any of those has just been told something about an address that is
 * not their own.
 */
export const EMAIL_ENVIO_RESPUESTA =
  "Si la dirección es válida, se envió un enlace de verificación.";

export const TOKEN_REQUERIDO = "Debe indicar el token.";

/**
 * The one answer `/email/verify` gives for every way of failing.
 *
 * Collapses four different causes on purpose: the token never existed, it
 * expired, it was already used, or (the case the design in
 * `tokenStore.ts` calls out by name) the address it names was claimed by
 * another account in the meantime and the partial unique index refused the
 * write. None of the four is told apart in the response — Task 9's own
 * screen already renders "caducado", "usado" and "inexistente" as the same
 * sentence, and this is that sentence's source.
 */
export const TOKEN_INVALIDO = "Este enlace ya no es válido. Solicite uno nuevo.";

const EMAIL_VERIFICADO_MENSAJE = "Correo verificado.";

/** A loose, deliberately non-RFC shape check — see the report for why. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `usuarios.email` is VARCHAR(255); refusing here is cheaper than a DB error. */
const EMAIL_MAX_LENGTH = 255;

function normalizedEmailFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) return null;
  if (!EMAIL_SHAPE.test(trimmed)) return null;
  // Same normalisation `usuario.model.ts`'s setter applies on every write —
  // computed here too because `email_destino` (for the token and the
  // mail) has to be the exact string that ends up in the column, and
  // re-deriving it after the write would mean reading the row back.
  return trimmed.toLowerCase();
}

/**
 * True for a Postgres unique-violation on `usuarios_email_verificado_uniq`
 * specifically — the partial index from `20260825000001-add-email-fields.ts`
 * that lets two accounts hold the same unverified address but only one ever
 * verify it. Same shape as `isUsernameUniqueViolation` in
 * `usuario.controller.ts`, checked against a different constraint name.
 */
function isEmailUniqueViolation(error: unknown): boolean {
  const err = error as { name?: string; parent?: { constraint?: string }; message?: string } | null;
  if (!err || err.name !== "SequelizeUniqueConstraintError") return false;
  return (
    err.parent?.constraint === "usuarios_email_verificado_uniq" ||
    /usuarios_email_verificado_uniq/i.test(err.message ?? "")
  );
}

/**
 * The link a verification email points at.
 *
 * **Placeholder pending Tasks 8/10, flagged in the report.** Nothing in the
 * frontend reads this yet — `PerfilPage.tsx`'s email block is Task 8's, not
 * built at the time this was written. `/perfil` is where that block is
 * specified to live, and the token rides in the URL *fragment* rather than
 * the query, matching the reasoning `task-9-brief.md` already gives for the
 * password-reset link: a fragment never reaches a server log or a `Referer`
 * header, a query does.
 *
 * **The path is `/app/perfil`, and it was `/perfil` until the final review
 * caught it.** `PerfilPage` is nested under `/app` in `web/src/App.tsx`, so
 * `/perfil` matched nothing, fell through to that file's catch-all `<Route
 * path="*">`, and `Navigate` dropped the fragment on the way to the home
 * page. Every verification link ever sent was inert: no account could reach
 * `email_verified_at`, and `/password/forgot` only operates on verified
 * addresses, so the whole feature was dead and said nothing about it.
 *
 * This comment used to end by asking whoever built that page to confirm the
 * path. Nobody did, which is what a comment addressed to a future reader
 * buys. `frontendLinks.test.ts` now reads the route table out of `App.tsx`
 * and fails if this string stops matching it.
 *
 * `allowedOrigins(...)[0]` is the same "primary configured frontend origin"
 * `app.auth.test.ts` already reads off this function; the fallback to
 * `DEV_FRONTEND_ORIGIN` only matters for a misconfigured environment where
 * that list is empty, so the link is still something rather than nothing.
 */
function verificationLinkFor(token: string): string {
  const origin = allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0] ?? DEV_FRONTEND_ORIGIN;
  return `${origin}/app/perfil#verify_email=${encodeURIComponent(token)}`;
}

function verificationEmailBody(enlace: string): { html: string; texto: string } {
  return {
    html: [
      "<p>Hola,</p>",
      "<p>Recibimos una solicitud para verificar esta dirección de correo en tu cuenta de Osefi.</p>",
      `<p><a href="${enlace}">Verificar mi correo</a></p>`,
      "<p>Este enlace caduca en una hora. Si no fuiste tú, puedes ignorar este mensaje.</p>",
    ].join("\n"),
    texto: [
      "Hola,",
      "",
      "Recibimos una solicitud para verificar esta dirección de correo en tu cuenta de Osefi.",
      "",
      "Verifica tu correo abriendo este enlace:",
      enlace,
      "",
      "Este enlace caduca en una hora. Si no fuiste tú, puedes ignorar este mensaje.",
    ].join("\n"),
  };
}

/**
 * `nueva@osefi.net` → `n***@osefi.net`.
 *
 * The notice below goes to a mailbox this account may no longer control —
 * that is the whole reason it is sent — so the new address is not spelled
 * out in it: enough for the real owner to recognise their own account did
 * this, not enough to hand the new address to whoever now reads the old
 * inbox. A fixed run of asterisks rather than one per real character, so the
 * mask does not also leak the new address's length.
 */
function enmascarada(email: string): string {
  const [usuario, dominio] = email.split("@");
  if (!usuario || !dominio) return "***";
  return `${usuario.slice(0, 1)}***@${dominio}`;
}

/**
 * The security notice that goes to the *previous* address when it was
 * already verified — see the long comment on `sendVerificationEmail` for
 * why this is the real defence in the whole flow: it is the one message in
 * this file that reaches a mailbox nobody who just ran `/email/send` can
 * have redirected.
 */
function previousAddressNoticeBody(nuevaEnmascarada: string): { html: string; texto: string } {
  return {
    html: [
      "<p>Hola,</p>",
      `<p>La dirección de correo de recuperación de tu cuenta de Osefi se cambió a ${nuevaEnmascarada}.</p>`,
      "<p>Si no fuiste tú quien hizo este cambio, contacta con administración de inmediato.</p>",
    ].join("\n"),
    texto: [
      "Hola,",
      "",
      `La dirección de correo de recuperación de tu cuenta de Osefi se cambió a ${nuevaEnmascarada}.`,
      "",
      "Si no fuiste tú quien hizo este cambio, contacta con administración de inmediato.",
    ].join("\n"),
  };
}

/**
 * `POST /auth/email/send` — register (or replace) the address on my account
 * and ask me to confirm it.
 *
 * **Requires the caller's current password. This is the fix for a real
 * account-takeover chain, not a nicety.** Without it: steal a live session
 * (an unattended office machine is enough) → set the recovery address to one
 * you control → verify it → wait for the owner to log out → `/password/forgot`
 * → reset the password, which revokes every session — and the legitimate
 * owner is now locked out, by the very feature this plan exists to give them
 * a way back through. The spec had this in its step-up list all along
 * ("cambiar el email propio — y se avisa a la dirección anterior"); it did
 * not make it into this task's brief, and this is that gap closed.
 *
 * Required for the **first** address too, not only when replacing a verified
 * one: the attack above works identically against an account with no
 * recovery address yet, and the moment somebody is establishing their own way
 * back in is exactly the moment a confirmation is worth the one extra field.
 *
 * Does not touch Global Constraint #1. That constraint is about the
 * *destination* address — whether it is free, already claimed, or whether
 * Resend is up — and nothing here depends on any of those three. The caller
 * is already authenticated, so a 401 for a missing or wrong password reveals
 * nothing about who has an account; it is the same shape as
 * `usuario.controller.ts`'s `updateUserName`, reusing the exact same pieces:
 * `verifyOwnPassword` (never a fresh `bcryptjs.compare` — see its own
 * comment for the filler hash and the levelled timings that come with it)
 * and `passwordConfirmLimiter`, mounted on this route in `auth.routes.ts`
 * exactly as `chargeConfirmBudgetOnSelfChange` mounts it on the two
 * `usuario` routes — same shared budget, same account, same secret.
 *
 * Once confirmed, always the same four things, in this order, for the
 * account behind `req.user.id`:
 *
 * 1. Write `email` (normalised) and `email_verified_at = NULL`, and in the
 *    *same* transaction, mark every still-pending `token_uso_unico` row of
 *    this account used — any purpose, not only `verify_email`. Global
 *    Constraint #7, and the migration's own comment on why it is code's job
 *    and not the database's: "ending a user's pending tokens is code's job
 *    (see the email-change path in a later task)". `crearToken` below would
 *    invalidate a same-purpose pending token on its own, but only that one
 *    purpose and only in its own, later transaction — it does not reach a
 *    `reset_password` row, and it cannot make the write atomic with this
 *    one. Both of those are why this step exists here instead of being left
 *    to it.
 * 2. Mint a fresh `verify_email` token and mail it to the new address.
 * 3. If the address just replaced was already verified, mail a notice to
 *    the *previous* one, with the new address masked — see
 *    `previousAddressNoticeBody`. This is the second half of the fix, and
 *    arguably the half that matters more: it is the only message in this
 *    whole flow that lands in a mailbox the attacker does not hold. Without
 *    it, step 2 of the attack above is completely silent.
 * 4. Answer the one uniform sentence — see `EMAIL_ENVIO_RESPUESTA` — whether
 *    either mail actually went out or not.
 *
 * No collision check against other accounts: the design in
 * `task-4-brief.md` is explicit that checking here would itself be the leak
 * ("comprobarla sería decir «esa dirección ya es de alguien»"), and the
 * partial unique index is what actually decides who gets to keep an address
 * — at verification time, in `verifyEmail` below, which is the one place a
 * collision can be told apart from success without telling the *asker*
 * anything.
 */
export const sendVerificationEmail = handler("sendVerificationEmail", async (req: Request, res: Response) => {
  const caller = req.user ?? null;
  if (!caller) return res.sendStatus(401);

  const destino = normalizedEmailFrom((req.body as { email?: unknown } | undefined)?.email);
  if (!destino) {
    return res.status(400).json({ message: EMAIL_INVALIDO });
  }

  const pass = (req.body as { pass?: unknown } | undefined)?.pass;
  // Not a string is not a password, and an empty one is not a confirmation —
  // refused before the round trip, the same way `verifyOwnPassword` refuses
  // them, so the two cannot disagree about what counts as "sent nothing".
  if (typeof pass !== "string" || pass === "") {
    return res.status(400).json({ message: CURRENT_PASSWORD_REQUIRED_MESSAGE });
  }
  const confirmacion = await verifyOwnPassword({ id: caller.id, pass, ip: req.ip ?? null });
  if (!confirmacion.ok) {
    // Archived between `authenticate` and here — the narrow race
    // `verifyOwnPassword` names. Answered the same way `/api/auth/me`
    // answers it, and pointedly not as a wrong password: sending somebody
    // hunting for a typo in a password that was never compared is worse
    // than telling them their session is over.
    if (confirmacion.reason === "no-account") {
      return res.status(401).json({ message: CUENTA_INACTIVA });
    }
    return res.status(401).json({ message: CURRENT_PASSWORD_WRONG_MESSAGE });
  }

  const found = await UsuarioModel.findByPk(caller.id, {
    attributes: ["id", "email", "email_verified_at"],
  });
  // Archived in the instant between `verifyOwnPassword`'s own lookup and
  // this one — narrower still than the race above, and answered the same way.
  if (!found) {
    return res.status(401).json({ message: CUENTA_INACTIVA });
  }

  const direccionAnterior = found.dataValues.email;
  const eraVerificada = found.dataValues.email_verified_at !== null;

  await sequelize.transaction(async (transaction) => {
    await UsuarioModel.update(
      { email: destino, email_verified_at: null },
      { where: { id: caller.id }, transaction },
    );
    await TokenUsoUnicoModel.update(
      { used_at: new Date() },
      { where: { id_usuario: caller.id, used_at: null }, transaction },
    );
  });

  logAction({
    id_usuario: caller.id,
    action: "EMAIL_SEND",
    entity: "Usuario",
    entity_id: caller.id,
    detail: "Solicitó verificar una dirección de correo",
    metadata: { email_destino: destino },
    severity: "info",
    ip_address: req.ip ?? null,
  });
  if (eraVerificada) {
    // `critical`, not `info`: replacing an already-verified address is the
    // one event in this file that changes who a recovery email would reach.
    logAction({
      id_usuario: caller.id,
      action: "EMAIL_CHANGED",
      entity: "Usuario",
      entity_id: caller.id,
      detail: "Sustituyó una dirección de correo ya verificada",
      metadata: { email_anterior: direccionAnterior, email_destino: destino },
      severity: "critical",
      ip_address: req.ip ?? null,
    });
  }

  // The daily mail budget, asked before the token is minted — see
  // `auth/mailBudget.ts`. This route had no daily ceiling at all until the
  // final review did the arithmetic: five calls an hour per account, up to
  // three messages each, is 360 a day from one logged-in account against a
  // Resend quota of 100 for the whole company. `passwordConfirmLimiter` in
  // front of it does not help — it refunds everything that is not a wrong
  // password, which is exactly what a well-formed request is.
  //
  // Before minting, for the same reason `/password/forgot` asks first:
  // `crearToken` marks whatever was pending for this account as used, so a
  // token that cannot be mailed would destroy a link already sitting in
  // somebody's inbox and give them nothing back. And the response stays the
  // uniform one — a caller who could tell "the budget ran out" apart from
  // "sent" learns nothing useful, and Constraint #1 says the answer does not
  // move for anything.
  if (!consumirPresupuestoDeCorreo("email/send")) {
    return res.status(200).json({ message: EMAIL_ENVIO_RESPUESTA });
  }

  // Constant #2: the token this mints is never logged, never put in the
  // bitácora, never echoed in a response — `crearToken` hands it back
  // exactly once, and the only thing done with it below is putting it in the
  // one email it is for.
  const token = await crearToken({ id_usuario: caller.id, email_destino: destino, proposito: "verify_email" });
  const cuerpo = verificationEmailBody(verificationLinkFor(token));
  await enviarCorreo({
    para: destino,
    asunto: "Verifica tu correo — Osefi",
    html: cuerpo.html,
    texto: cuerpo.texto,
  });

  if (eraVerificada && direccionAnterior) {
    // The real defence in this whole flow — see the handler's own comment.
    // Sent to the address that is *leaving* the account, never the new one,
    // and never blocking or altering the response: same contract as the
    // verification mail above.
    const aviso = previousAddressNoticeBody(enmascarada(destino));
    await enviarCorreo({
      para: direccionAnterior,
      asunto: "Tu dirección de recuperación cambió — Osefi",
      html: aviso.html,
      texto: aviso.texto,
    });
  }
  // Neither `enviarCorreo` call's `{ ok }` is read here — branching the
  // response on it is exactly the oracle Global Constraint #1 forbids.

  res.status(200).json({ message: EMAIL_ENVIO_RESPUESTA });

  // The copy to the company, after the response and only when an address was
  // actually replaced. The warning above goes to a mailbox that may already
  // belong to whoever is doing this; this one goes somewhere they do not
  // control, which is the only version of the warning they cannot silence.
  if (eraVerificada && direccionAnterior) {
    avisarCorreoCambiado({
      id_usuario: caller.id,
      email_anterior: direccionAnterior,
      email_nuevo: destino,
      ip: req.ip ?? null,
    }).catch((err) => emailLog.error({ err }, "fallo enviando el aviso de correo cambiado"));
  }
});

/**
 * `POST /auth/email/verify` — redeem a verification token.
 *
 * Takes **only** the token. `req.body.id_usuario` and `req.body.email` are
 * never read, whatever the caller sends — the account that gets
 * `email_verified_at` set is `redeemed.id_usuario`, and the address compared
 * is `redeemed.email_destino`, both off the row `consumirToken` just
 * matched. `req.user` (the caller `authenticate` let through) is read only
 * to gate the route at all; it plays no part in deciding whose row is
 * written. See the module comment above for why that is the design and not
 * an oversight.
 *
 * `consumirToken` runs with **no transaction** — deliberately, matching its
 * own comment on why `/email/verify` does not need one the way
 * `/password/reset` does: the failure this design expects here is the
 * partial unique index rejecting an address another account already
 * verified, and retrying the same token would not fix that, so leaving it
 * burned on that failure is correct.
 *
 * The current-account-email check just below is redundant with
 * `sendVerificationEmail`'s own token invalidation on every address change —
 * if that invalidation works, a token can never reach here with the
 * account's address already having moved on. Kept anyway, on purpose: belt
 * and suspenders, and the cost of keeping it is one extra `findByPk`.
 */
export const verifyEmail = handler("verifyEmail", async (req: Request, res: Response) => {
  const caller = req.user ?? null;
  if (!caller) return res.sendStatus(401);

  const token = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || token.length === 0) {
    return res.status(400).json({ message: TOKEN_REQUERIDO });
  }

  const redeemed = await consumirToken(token, "verify_email");
  if (!redeemed) {
    return res.status(400).json({ message: TOKEN_INVALIDO });
  }

  const cuenta = await UsuarioModel.findByPk(redeemed.id_usuario, { attributes: ["id", "email"] });
  // Either the account is gone, or it changed address again since this token
  // was minted (and `sendVerificationEmail` failed to burn this row for some
  // reason — the belt this comment's sibling above describes). Same generic
  // answer either way: the token is spent regardless, from the `consumirToken`
  // call above, and retrying it would not help.
  if (!cuenta || cuenta.dataValues.email !== redeemed.email_destino) {
    return res.status(400).json({ message: TOKEN_INVALIDO });
  }

  try {
    await UsuarioModel.update(
      { email_verified_at: new Date() },
      { where: { id: redeemed.id_usuario } },
    );
  } catch (err) {
    if (isEmailUniqueViolation(err)) {
      // Somebody else verified this exact address between the check above
      // and this write. The token stays burned — see the module comment on
      // why retrying it is not the fix.
      return res.status(400).json({ message: TOKEN_INVALIDO });
    }
    throw err;
  }

  logAction({
    id_usuario: redeemed.id_usuario,
    action: "EMAIL_VERIFIED",
    entity: "Usuario",
    entity_id: redeemed.id_usuario,
    detail: "Confirmó su dirección de correo",
    metadata: { email_destino: redeemed.email_destino },
    severity: "info",
    ip_address: req.ip ?? null,
  });

  return res.status(200).json({ message: EMAIL_VERIFICADO_MENSAJE });
});
