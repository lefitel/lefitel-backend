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
//   `req.user.id` alone, and never anything the request body says. The
//   account written to is whoever `consumirToken` says the token belongs to —
//   **and the redemption is scoped to the caller**, so those have to be the
//   same account or nothing is redeemed at all.
//
//   This paragraph used to say the opposite: that `authenticate` here was a
//   floor rather than a match check, because `consumirToken`'s atomic UPDATE
//   "has no way to take an identity argument". That was false about its own
//   code — the function returns `id_usuario`, and a `WHERE` clause can take
//   one. The final review found what the false claim was covering: B sets A's
//   address on B's account (the partial index allows unverified claims on
//   purpose), the mail goes to A's inbox because that is the address on it,
//   A clicks it while logged in as A, and **B's** account came out verified.
//   A saw "Correo verificado" and had verified nothing, while A's own address
//   became permanently unusable — only one account may ever verify it, and
//   `email` is not an administrator-editable field. Silent, permanent, and
//   carried out by the victim.
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
import { vestirCorreo } from "../auth/mailLook.js";
import { hayProveedorDisponible } from "../auth/mailRelay.js";
import { avisarCorreoCambiado, maskEmail } from "../auth/securityNotice.js";
import { promoverSesion, sellarPruebaDeFactor } from "../auth/sessionPromotion.js";
import { tieneCredencialRegistrada } from "../auth/factorInventory.js";
import { revokeAllRememberedDevicesOf } from "../auth/rememberedDeviceStore.js";
import { revokeAllSessionsOf } from "../auth/sessionStore.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { allowedOrigins, DEV_FRONTEND_ORIGIN, MAIL_PLAZO_INTERACTIVO_MS } from "../config/security.js";

const emailLog = log("email");
const handler = makeHandler(emailLog);

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
// No comma or semicolon anywhere: nodemailer parses `to` as an address list
// and would split `a,b@evil.com` into two envelope recipients — N deliveries
// charged as one, and "at most two copies" gone for that address (audit of
// plan 4E, Task 7). Resend answered such a value 422; SMTP does not.
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

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
    html: vestirCorreo({
      titulo: "Verifica tu correo",
      bloques: [
        { parrafo: "Recibimos una solicitud para verificar esta dirección de correo en tu cuenta de Osefi." },
        { boton: "Verificar mi correo", href: enlace },
      ],
      pie: ["Este enlace caduca en una hora. Si no fuiste tú, puedes ignorar este mensaje."],
    }),
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
 * The security notice that goes to the *previous* address when it was
 * already verified — see the long comment on `sendVerificationEmail` for
 * why this is the real defence in the whole flow: it is the one message in
 * this file that reaches a mailbox nobody who just ran `/email/send` can
 * have redirected.
 */
function previousAddressNoticeBody(nuevaEnmascarada: string): { html: string; texto: string } {
  return {
    html: vestirCorreo({
      titulo: "Tu dirección de recuperación ha cambiado",
      bloques: [
        { parrafo: `La dirección de correo de recuperación de tu cuenta de Osefi se cambió a ${nuevaEnmascarada}.` },
        { parrafo: [{ fuerte: "Si no fuiste tú quien hizo este cambio, contacta con administración de inmediato." }] },
      ],
    }),
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
 * **A confirmed password is the price of reaching this handler, and the gate
 * on the route is what charges it.** This is the fix for a real
 * account-takeover chain, not a nicety. Without any confirmation at all:
 * steal a live session (an unattended office machine is enough) → set the
 * recovery address to one you control → verify it → wait for the owner to log
 * out → `/password/forgot` → reset the password, which revokes every session
 * — and the legitimate owner is now locked out, by the very feature that
 * exists to give them a way back through. The spec had this in its step-up
 * list all along ("cambiar el email propio — y se avisa a la dirección
 * anterior").
 *
 * Charged for the **first** address too, not only when replacing a verified
 * one: the attack above works identically against an account with no recovery
 * address yet, and the moment somebody is establishing their own way back in
 * is exactly the moment a confirmation is worth asking for. That is what
 * `sinVentana` on the mount buys — the password on every single request here,
 * never a ten-minute window somebody else's session can walk into.
 *
 * Does not touch Global Constraint #1. That constraint is about the
 * *destination* address — whether it is free, already claimed, or whether the
 * mail provider is up — and nothing here depends on any of those three. The
 * refusals the gate hands out arrive before this function and say nothing
 * about who has an account, because the caller is already authenticated.
 *
 * Then, always the same four things, in this order, for the account behind
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

  // 🔴 **No password check here, and its absence is the decision.** The route
  // mounts `requireStepUp({ permiteOnboarding: true, sinVentana: true })`
  // (`auth.routes.ts`), so the gate compares the caller's password on every
  // request to this route — window or no window — and asks for the account's
  // factor on top when it has one. This handler used to compare a second copy
  // of that same secret, in a field of its own called `pass`, and the two were
  // one password asked for twice: once by the gate's dialog and once by the
  // form. Removing the duplicate is what the reauthentication-window work is
  // for.
  //
  // A `pass` field still arriving from a tab opened before the change is
  // simply not read. That is the deploy window handled in the only direction
  // that can hurt: the field going away while a check for it stayed would have
  // answered 400 to every request on the one route an account uses to leave
  // `onboarding`.

  const found = await UsuarioModel.findByPk(caller.id, {
    attributes: ["id", "email", "email_verified_at"],
  });
  // Archived between `authenticate` and this lookup. Answered the way
  // `/api/auth/me` answers the same race — the session is over — and never as
  // anything about a password: this handler compares none.
  if (!found) {
    return res.status(401).json({ message: CUENTA_INACTIVA });
  }

  const direccionAnterior = found.dataValues.email;
  const eraVerificada = found.dataValues.email_verified_at !== null;

  // The daily mail budget, asked before anything is written — not merely
  // before the token is minted, but before the transaction just below even
  // opens. That transaction is what sets `email_verified_at = NULL` and
  // burns every pending token on this account: asking only ahead of
  // `crearToken`, the way this used to, meant a day with no budget left
  // still destroyed whatever verified address was on file and invalidated
  // every pending link — for a token that was then never minted and a mail
  // that was never sent — and still answered with the same "se envió un
  // enlace" sentence below. Somebody who asked to change their address lost
  // the one they had, received nothing, and was told it worked. Asking
  // first means an exhausted budget costs nothing at all: the account keeps
  // the address and the tokens it already had, the same property
  // `/password/forgot` already has for the same reason.
  //
  // `hayProveedorDisponible()` only looks — quota **and** breaker, per provider (plan 4E) — it commits nothing. The actual
  // charge happens once per real message, inside `enviarCorreo`, further
  // below — see Decision 2 in
  // `docs/plans/2026-09-01-defectos-previos-al-4b.md`. The response stays
  // the uniform one — a caller who could tell "the budget ran out" apart
  // from "sent" learns nothing useful, and Constraint #1 says the answer
  // does not move for anything.
  if (!hayProveedorDisponible("email/verificar")) {
    return res.status(200).json({ message: EMAIL_ENVIO_RESPUESTA });
  }

  // `null` until the branch below runs, so the bitácora line can say whether
  // any device or session lost its standing — the same convention
  // `deleteCredential` uses for the same numbers.
  let dispositivosRevocados: number | null = null;
  let sesionesRevocadas: number | null = null;
  await sequelize.transaction(async (transaction) => {
    await UsuarioModel.update(
      { email: destino, email_verified_at: null },
      { where: { id: caller.id }, transaction },
    );
    await TokenUsoUnicoModel.update(
      { used_at: new Date() },
      { where: { id_usuario: caller.id, used_at: null }, transaction },
    );
    // Plan 4E: a verified address is a factor, so the line above may have
    // just removed the account's last one. Then everything that was trusted
    // on the strength of a factor goes, the way `deleteTotp` and
    // `deleteCredential` do it: the remembered devices, and every other
    // session.
    //
    // **Why revoking is the only thing that reaches those sessions.**
    // `estadoEfectivo` does narrow a stored `completa` — that is its one
    // move — but not this one: a session that proved the address carries
    // `mfa_satisfied_at`, and clause 3 exempts it for ever. Nothing walks a
    // proof backwards, so a cookie on another machine would go on holding the
    // whole ERP up to `SESSION_ABSOLUTE_DAYS` on an account with nothing
    // behind it any more. The gated writes are the smaller half of that and
    // no longer the open door they were: with no factor left, every one of
    // them falls to `requireStepUp`'s password branch, so a stolen cookie on
    // its own gets at most the ten minutes of a window somebody else opened.
    // Everything the gates do not cover — which is most of the ERP — it keeps.
    //
    // Only when the old address *was* verified (otherwise nothing changed) and
    // only when no credential remains (a passkey or an app still vouches).
    //
    // **`except` this session**, because verifying the new address needs the
    // session this request runs on; the one machine that just typed the
    // password keeps its seat. Both reads and both writes on this
    // transaction so that none of them borrows a second pool connection
    // while this one holds its locks.
    if (eraVerificada && !(await tieneCredencialRegistrada(caller.id, { transaction }))) {
      dispositivosRevocados = await revokeAllRememberedDevicesOf(caller.id, { transaction });
      sesionesRevocadas = await revokeAllSessionsOf(caller.id, { except: caller.id_sesion, transaction });
    }
  });

  logAction({
    id_usuario: caller.id,
    action: "EMAIL_SEND",
    entity: "Usuario",
    entity_id: caller.id,
    detail: "Solicitó verificar una dirección de correo",
    // Plan 4E: `null` when nothing was revoked because nothing had to be —
    // the old address was unverified, or a credential still vouches. A
    // number, possibly zero, when the last factor went with the address.
    metadata: {
      email_destino: destino,
      dispositivos_revocados: dispositivosRevocados,
      sesiones_revocadas: sesionesRevocadas,
    },
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

  // This route had no daily ceiling at all until the final review did the
  // arithmetic: five calls an hour per account, up to three messages each,
  // is 360 a day from one logged-in account against a Resend quota of 100
  // for the whole company. `passwordConfirmLimiter` in front of it does not
  // help — it refunds everything that is not a wrong password, which is
  // exactly what a well-formed request is. See the budget check above, well
  // before this point, for why asking here (only ahead of the mint) was not
  // enough on its own.
  //
  // Constant #2: the token this mints is never logged, never put in the
  // bitácora, never echoed in a response — `crearToken` hands it back
  // exactly once, and the only thing done with it below is putting it in the
  // one email it is for.
  const token = await crearToken({ id_usuario: caller.id, email_destino: destino, proposito: "verify_email" });
  const cuerpo = verificationEmailBody(verificationLinkFor(token));
  // Bounded: a person is waiting on the profile screen (plan 4E, design §4.1).
  await enviarCorreo(
    {
      para: destino,
      flujo: "email/verificar",
      asunto: "Verifica tu correo — Osefi",
      html: cuerpo.html,
      texto: cuerpo.texto,
    },
    { plazo_ms: MAIL_PLAZO_INTERACTIVO_MS },
  );

  if (eraVerificada && direccionAnterior) {
    // The real defence in this whole flow — see the handler's own comment.
    // Sent to the address that is *leaving* the account, never the new one,
    // and never blocking or altering the response: same contract as the
    // verification mail above.
    const aviso = previousAddressNoticeBody(maskEmail(destino));
    await enviarCorreo(
      {
        para: direccionAnterior,
        flujo: "email/aviso-direccion-anterior",
        asunto: "Tu dirección de recuperación cambió — Osefi",
        html: aviso.html,
        texto: aviso.texto,
      },
      { plazo_ms: MAIL_PLAZO_INTERACTIVO_MS },
    );
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

  const redeemed = await consumirToken(token, "verify_email", { soloDelUsuario: caller.id });
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

  // Plan 4E: a verified address is a second factor, so confirming it is
  // registering one, and this does what `confirmTotp` and `registerVerify`
  // do at the same moment — two writes, one transaction:
  //
  // 1. the column;
  // 2. **this session promoted** (`parcial`/`onboarding` → `completa`), or,
  //    when `promoverSesion` matched nothing — a session that opened
  //    `completa` under the grace clock, hallazgo F2/B-1 — **sealed**, so the
  //    ten-minute step-up window opens now rather than refusing the very next
  //    gated write on an account that just proved a factor.
  //
  // An earlier draft promoted nothing and only cleared the fourteen-day
  // deadline. The audit traced what that left: a session stored `onboarding`
  // — everybody who logged in after their own deadline, which is the
  // population this plan exists for — stays `onboarding` for its whole life,
  // because `estadoEfectivo` only ever narrows; every route answers 403
  // `FACTOR_PENDIENTE`, and the one screen that code points to still asks for
  // an app or a key.
  //
  // 🔴 **And `usuarios.mfa_grace_until` is deliberately left where it is.**
  // Clearing it here used to be the third write, and it was the cheapest lap
  // of a loop: verify the address (deadline cleared), change the address (the
  // verification cleared, the deadline still gone), log in again, and the
  // login stamps a fresh fourteen days because a NULL deadline reads as "the
  // clock never started". See the tombstone at the foot of
  // `auth/sessionPromotion.ts`.
  //
  // `caller.id_sesion` and `redeemed.id_usuario` name the same account:
  // `consumirToken` above was scoped with `soloDelUsuario: caller.id`.
  try {
    await sequelize.transaction(async (transaction) => {
      await UsuarioModel.update(
        { email_verified_at: new Date() },
        { where: { id: redeemed.id_usuario }, transaction },
      );
      const promovida = await promoverSesion(caller.id_sesion, "correo", { transaction });
      if (!promovida) {
        await sellarPruebaDeFactor(caller.id_sesion, "correo", { transaction });
      }
    });
  } catch (err) {
    if (isEmailUniqueViolation(err)) {
      // Somebody else verified this exact address between the check above
      // and this write. The token stays burned — see the module comment on
      // why retrying it is not the fix. The transaction rolled the session
      // writes back with it: nothing was promoted for an address nobody got.
      return res.status(400).json({ message: TOKEN_INVALIDO });
    }
    throw err;
  }

  logAction({
    id_usuario: redeemed.id_usuario,
    action: "EMAIL_VERIFIED",
    entity: "Usuario",
    entity_id: redeemed.id_usuario,
    detail: "Confirmó su dirección de correo; desde ahora es su segundo factor",
    metadata: { email_destino: redeemed.email_destino, id_sesion: caller.id_sesion, fuente: "correo" },
    // `critical`, matching `TOTP_CONFIRMED` and `WEBAUTHN_REGISTERED`: since
    // plan 4E this line *is* a factor registration, and the one most accounts
    // will ever have. `EMAIL_CHANGED`, its removal, was already critical.
    severity: "critical",
    ip_address: req.ip ?? null,
  });

  return res.status(200).json({ message: EMAIL_VERIFICADO_MENSAJE });
});
