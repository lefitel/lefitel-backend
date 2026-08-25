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
// `handler()` and `callerOf()` below are deliberately their own small copies
// rather than imports from `auth.controller.ts`, which already has both.
// Importing either one from there would pull in that module's entire import
// graph — `sessionStore.js`, `credentials.js`, `permissions/store.js`,
// `bcryptjs` — none of which this file needs, and every one of which a test
// for *this* file would then have to mock just to load two trivial
// utilities safely (see `auth.controller.test.ts`'s own mock list for what
// that graph drags in, and Task 2's report for the `UsuarioModel.hasMany is
// not a function` failure that graph produces when the mock is incomplete).
// Two small, stable functions are cheaper to duplicate than to couple this
// file's tests to an unrelated module's imports.

import type { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import { TokenUsoUnicoModel } from "../models/tokenUsoUnico.model.js";
import { sequelize } from "../database/sequelize.js";
import { crearToken, consumirToken } from "../auth/tokenStore.js";
import { enviarCorreo } from "../auth/mailer.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { allowedOrigins, DEV_FRONTEND_ORIGIN } from "../config/security.js";

const emailLog = log("email");

const ERROR_INESPERADO = "Ocurrió un error al procesar la petición.";

/** Twin of the message in `authenticate.ts` and `auth.controller.ts`; both mean the row is gone. */
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";

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
 * header, a query does. Whoever builds the page this points at should
 * confirm the path, or change it here — this is the only place it is
 * written.
 *
 * `allowedOrigins(...)[0]` is the same "primary configured frontend origin"
 * `app.auth.test.ts` already reads off this function; the fallback to
 * `DEV_FRONTEND_ORIGIN` only matters for a misconfigured environment where
 * that list is empty, so the link is still something rather than nothing.
 */
function verificationLinkFor(token: string): string {
  const origin = allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0] ?? DEV_FRONTEND_ORIGIN;
  return `${origin}/perfil#verify_email=${encodeURIComponent(token)}`;
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
 * One place that turns an unexpected failure into a 500 — the same reason
 * `auth.controller.ts`'s own `handler()` exists: Express 4 does not catch a
 * rejected promise from an `async` handler, so without this a failure here
 * would hang the request instead of answering it.
 */
function handler(name: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  const wrapped = async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      emailLog.error({ err, ruta: req.originalUrl }, `fallo en ${name}`);
      if (!res.headersSent) {
        res.status(500).json({ message: ERROR_INESPERADO });
      }
    }
  };
  Object.defineProperty(wrapped, "name", { value: name });
  return wrapped;
}

/** Who `authenticate` says is calling, read the same way every other auth handler does. */
function callerOf(req: Request): NonNullable<Request["user"]> | null {
  return req.user ?? null;
}

/**
 * `POST /auth/email/send` — register (or replace) the address on my account
 * and ask me to confirm it.
 *
 * Always the same three things, in this order, for the account behind
 * `req.user.id`:
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
 * 2. Mint a fresh `verify_email` token and mail it.
 * 3. Answer the one uniform sentence — see `EMAIL_ENVIO_RESPUESTA` — whether
 *    the mail actually went out or not.
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
  const caller = callerOf(req);
  if (!caller) return res.sendStatus(401);

  const destino = normalizedEmailFrom((req.body as { email?: unknown } | undefined)?.email);
  if (!destino) {
    return res.status(400).json({ message: EMAIL_INVALIDO });
  }

  const found = await UsuarioModel.findByPk(caller.id, {
    attributes: ["id", "email", "email_verified_at"],
  });
  // Archived between `authenticate` and here — the same narrow race `GET
  // /api/auth/me` answers this way to. About the caller's own session, not
  // about the address, so it does not touch Global Constraint #1.
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
  // `enviarCorreo`'s own `{ ok }` is deliberately not read here — branching
  // the response on it is exactly the oracle Global Constraint #1 forbids.

  return res.status(200).json({ message: EMAIL_ENVIO_RESPUESTA });
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
  const caller = callerOf(req);
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
    metadata: { email: redeemed.email_destino },
    severity: "info",
    ip_address: req.ip ?? null,
  });

  return res.status(200).json({ message: EMAIL_VERIFICADO_MENSAJE });
});
