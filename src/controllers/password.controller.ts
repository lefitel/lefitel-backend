// Getting back into an account you cannot log into at all.
//
// Both routes here are public — no `authenticate` in front of either, by
// definition: the whole point is to work for somebody who is locked out.
// That makes them the two most delicate routes this plan adds, and the two
// design properties below are why.
//
// **`/password/forgot` answers before it does any work.** The naive shape —
// look the address up, and only mint a token and call Resend if a verified
// account is behind it — makes the "account exists" branch cost hundreds of
// milliseconds (an INSERT plus an HTTP call to Resend) against a few
// milliseconds for "no such account". A uniform response *body* is
// decorative on top of a timing side-channel that wide: anybody with a
// stopwatch can tell the two branches apart from outside, which is exactly
// the account enumeration Global Constraint #1 exists to close. So the
// response here is decided the moment the request's *shape* is valid, sent
// immediately, and every costly step — the lookup, minting the token,
// calling Resend — runs *afterwards*, unawaited by the client. See
// `completeForgotPassword` below, and `forgotPassword`'s own comment for
// where the response is actually sent.
//
// **`/password/reset` takes no identifier at all**, per Global Constraint
// #4: the only thing that says whose account this is is the token's own
// row, read back by `consumirToken`. `req.body.id` and `req.body.email` are
// never read for that purpose.

import bcryptjs from "bcryptjs";
import { Op } from "sequelize";
import type { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import { sequelize } from "../database/sequelize.js";
import { crearToken, consumirToken } from "../auth/tokenStore.js";
import { revokeAllSessionsOf } from "../auth/sessionStore.js";
import { enviarCorreo } from "../auth/mailer.js";
import { validarPassword } from "../utils/password.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { allowedOrigins, DEV_FRONTEND_ORIGIN, BCRYPT_COST } from "../config/security.js";

const passwordLog = log("password");
const handler = makeHandler(passwordLog);

/**
 * What `/password/forgot` answers, always, whatever actually happened.
 *
 * Global Constraint #1 — and the reason this endpoint's whole shape is built
 * around sending this line before any database work starts. See the module
 * comment above.
 */
export const PASSWORD_FORGOT_RESPUESTA =
  "Si la dirección corresponde a una cuenta con el correo verificado, se envió un enlace para restablecer la contraseña.";

/**
 * The one 400 `/password/forgot` can give, and it is about the *request*,
 * not the account: it fires identically whether or not any account would
 * ever match, so it does not enumerate anything — same reasoning as
 * global-constraints.md #13's note on the body-parser's own 400.
 */
export const EMAIL_INVALIDO = "Debe indicar una dirección de correo válida.";

/** Same reasoning as `EMAIL_INVALIDO` above, for `/password/reset`'s own shape check. */
export const DATOS_RESET_REQUERIDOS = "Debe indicar el token y la contraseña nueva.";

/**
 * One answer for every way `/password/reset` can fail to redeem a token:
 * never existed, expired, or already used. Twin of `email.controller.ts`'s
 * `TOKEN_INVALIDO` — not imported from there, for the same reason
 * `normalizedEmailFrom` below is not either; see its comment.
 */
export const TOKEN_INVALIDO = "Este enlace ya no es válido. Solicite uno nuevo.";

const PASSWORD_RESET_OK = "Contraseña actualizada. Inicia sesión con tu contraseña nueva.";

/**
 * A loose, deliberately non-RFC shape check, plus the length
 * `usuarios.email` actually allows.
 *
 * Duplicated from `email.controller.ts`'s own `normalizedEmailFrom` rather
 * than imported from there: importing one named export from that module
 * runs its entire top-level import graph (`UsuarioModel`,
 * `TokenUsoUnicoModel`, `sequelize`, `mailer`, `logAction`) just to reach a
 * ten-line pure function — the exact coupling `handler()` used to cause
 * before Task 4 moved it to `utils/handler.ts`. This one has no comparable
 * import weight of its own, so duplicating it is cheaper than the coupling;
 * if the two drift, `utils/email.ts` is the fix, not a fresh copy here.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 255;

function normalizedEmailFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) return null;
  if (!EMAIL_SHAPE.test(trimmed)) return null;
  // Same normalisation `usuario.model.ts`'s setter applies on every write —
  // computed here too so the comparison below is against the same string a
  // stored address actually looks like.
  return trimmed.toLowerCase();
}

/**
 * The link a reset email points at.
 *
 * `/nueva-contrasena#t=TOKEN` — the token in the URL *fragment*, not the
 * query, per `task-9-brief.md`'s own reasoning (repeated here because this
 * is the file that has to act on it, not that one): a fragment never
 * reaches a server log or a `Referer` header, a query does. Same
 * origin-selection as `email.controller.ts`'s `verificationLinkFor`,
 * duplicated for the same reason `normalizedEmailFrom` above is.
 */
function resetLinkFor(token: string): string {
  const origin = allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0] ?? DEV_FRONTEND_ORIGIN;
  return `${origin}/nueva-contrasena#t=${encodeURIComponent(token)}`;
}

function resetEmailBody(enlace: string): { html: string; texto: string } {
  return {
    html: [
      "<p>Hola,</p>",
      "<p>Recibimos una solicitud para restablecer la contraseña de tu cuenta de Osefi.</p>",
      `<p><a href="${enlace}">Elegir una contraseña nueva</a></p>`,
      "<p>Este enlace caduca en 15 minutos. Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue siendo válida.</p>",
    ].join("\n"),
    texto: [
      "Hola,",
      "",
      "Recibimos una solicitud para restablecer la contraseña de tu cuenta de Osefi.",
      "",
      "Elige una contraseña nueva abriendo este enlace:",
      enlace,
      "",
      "Este enlace caduca en 15 minutos. Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue siendo válida.",
    ].join("\n"),
  };
}

/**
 * Everything `/password/forgot` does that costs real time, run *after* the
 * response already went out — see `forgotPassword` below for the call site
 * that never awaits this.
 *
 * A verified, live account gets a token minted (an INSERT) and a mail sent
 * (an HTTP call to Resend); anything else — no such address, an unverified
 * one, an archived one (`UsuarioModel` is `paranoid`, so a soft-deleted row
 * is invisible to this lookup on its own) — stops at the lookup below and
 * writes nothing. Global Constraint #8: only a verified email is operated
 * on, and the `email_verified_at` condition is what enforces that at the
 * query itself rather than in a branch somebody could get wrong later.
 *
 * `bitacoras.id_usuario` is `NOT NULL` (see `task-7-brief.md`), so a request
 * against an address with no live, verified account behind it cannot be
 * logged at all — there is no id to log it against, and inventing one would
 * be a lie in the audit trail. That silence is deliberate, not an
 * oversight: Task 7 audits the aggregate rate of calls to this endpoint,
 * not this function's decision to write nothing for an address nobody owns.
 *
 * Errors past this point are the caller's problem in exactly one sense: the
 * response already went out and nothing is waiting on this promise. They
 * are still logged, with the same care as anything else in this codebase —
 * a `/forgot` that silently stopped sending mail has to show up here before
 * a person discovers it by being unable to get back in.
 */
async function completeForgotPassword(email: string, ip: string | null): Promise<void> {
  const found = await UsuarioModel.findOne({
    where: { email, email_verified_at: { [Op.ne]: null } },
    attributes: ["id", "email"],
  });
  if (!found) return;

  const { id, email: emailDestino } = found.dataValues;
  const token = await crearToken({ id_usuario: id, email_destino: emailDestino, proposito: "reset_password" });

  logAction({
    id_usuario: id,
    action: "PASSWORD_FORGOT",
    entity: "Usuario",
    entity_id: id,
    detail: "Solicitó restablecer su contraseña",
    metadata: { email_destino: emailDestino },
    severity: "info",
    ip_address: ip,
  });

  const cuerpo = resetEmailBody(resetLinkFor(token));
  await enviarCorreo({
    para: emailDestino,
    asunto: "Restablece tu contraseña — Osefi",
    html: cuerpo.html,
    texto: cuerpo.texto,
  });
  // `enviarCorreo`'s own `{ ok }` is deliberately not read: there is no
  // response left here to branch, and there was never meant to be one.
}

/**
 * `POST /auth/password/forgot` — ask for a reset link.
 *
 * Validates the *shape* of what arrived (a 400 here says nothing about any
 * account — see `EMAIL_INVALIDO`), sends the one uniform sentence, and only
 * *then* starts the real work, deliberately not awaited. That ordering is
 * the whole point: `completeForgotPassword` is what costs hundreds of
 * milliseconds on a hit, and by the time it runs the response has already
 * left. A crash between the `res.status(200)` below and that promise
 * settling loses the email for this one request — accepted, and no worse
 * than the fire-and-forget `purgeExpiredTokens().catch(...)` already
 * mounted on `login` in `auth.controller.ts`, for the same reason: the
 * alternative is awaiting it before responding, which is the timing leak
 * this whole design exists to close.
 */
export const forgotPassword = handler("forgotPassword", async (req: Request, res: Response) => {
  const email = normalizedEmailFrom((req.body as { email?: unknown } | undefined)?.email);
  if (!email) {
    return res.status(400).json({ message: EMAIL_INVALIDO });
  }

  res.status(200).json({ message: PASSWORD_FORGOT_RESPUESTA });

  completeForgotPassword(email, req.ip ?? null).catch((err) =>
    passwordLog.error({ err }, "fallo procesando /password/forgot tras responder"),
  );
});

/**
 * `POST /auth/password/reset` — redeem a token and set a new password.
 *
 * Takes **only** the token and the new password. Global Constraint #4: no
 * `id` or `email` in the body is ever read to decide *whose* account this
 * is — that comes solely from `consumirToken`'s own row. Reading either
 * from the body would be exactly the hole the constraint exists to close:
 * ask for a reset of your own account, then redeem it against somebody
 * else's id sent alongside the same token.
 *
 * Order of checks, and why it is this order:
 *
 * 1. Shape of the body — both fields present and typed right. Free, and
 *    it is what makes global-constraints.md #13's "POST with no body → 400"
 *    test pass for this route too.
 * 2. `validarPassword` — the server's password rule, checked before
 *    anything that costs CPU or a database round trip. A three-character
 *    password never reaches bcrypt, which is the CPU-exhaustion defense the
 *    brief asks for.
 * 3. `bcryptjs.hash` at `BCRYPT_COST` — **before** the transaction opens,
 *    and unconditionally once the password passes its own rule, whether or
 *    not the token turns out to be any good. `tokenStore.ts`'s own comment
 *    on `consumirToken` is why: the atomicity this endpoint needs means
 *    `consumirToken` has to run *inside* the transaction (so a later
 *    failure rolls the redemption back too, and the token stays usable),
 *    and the only way to keep bcrypt's ~250ms of CPU outside that
 *    transaction is to pay it *before* knowing whether the token is any
 *    good. What that costs against a guessed token is real CPU spent for
 *    nothing — exactly the load this plan's rate limiter (Task 6, not this
 *    file) is sized to bound; see `progress.md`'s own finding about this
 *    route's per-token bucket being trivially dodgeable and the per-IP one
 *    being the actual defense.
 * 4. The transaction: redeem, then the three writes the brief lists —
 *    password, lockout cleared, every session revoked. `consumirToken`
 *    returning `null` here is not an error to throw; the transaction simply
 *    commits having written nothing.
 */
export const resetPassword = handler("resetPassword", async (req: Request, res: Response) => {
  const token = (req.body as { token?: unknown } | undefined)?.token;
  const passRaw = (req.body as { pass?: unknown } | undefined)?.pass;
  if (typeof token !== "string" || token.length === 0 || typeof passRaw !== "string") {
    return res.status(400).json({ message: DATOS_RESET_REQUERIDOS });
  }

  const passwordError = validarPassword(passRaw);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  const hashed = await bcryptjs.hash(passRaw, BCRYPT_COST);

  const redeemed = await sequelize.transaction(async (transaction) => {
    const result = await consumirToken(token, "reset_password", transaction);
    if (!result) return null;

    await UsuarioModel.update(
      // `failed_attempts: 0, locked_until: null` is deliberate, not a
      // leftover from copying the credential-check's own "clear the slate
      // on success" — see the module comment on `/password/reset` in
      // `task-5-brief.md`: a locked account has to be able to leave the
      // lockout through this door, or the lockout and "I forgot my
      // password" combine into a trap nobody can open.
      { pass: hashed, failed_attempts: 0, locked_until: null },
      { where: { id: result.id_usuario }, transaction },
    );
    // No `except`: whoever asks for a reset is not inside any of these
    // sessions to begin with — see `sessionStore.ts`'s own comment on why
    // `except: undefined` is what "spare nothing" means, not a gap to fill.
    await revokeAllSessionsOf(result.id_usuario, { transaction });

    return result;
  });

  if (!redeemed) {
    return res.status(400).json({ message: TOKEN_INVALIDO });
  }

  logAction({
    id_usuario: redeemed.id_usuario,
    action: "PASSWORD_RESET",
    entity: "Usuario",
    entity_id: redeemed.id_usuario,
    detail: "Restableció su contraseña con un enlace de recuperación",
    metadata: { email_destino: redeemed.email_destino },
    severity: "critical",
    ip_address: req.ip ?? null,
  });

  // No session opened, and no cookie touched. Global Constraint #9: this
  // returns to the login screen on purpose — see the module comment.
  return res.status(200).json({ message: PASSWORD_RESET_OK });
});
