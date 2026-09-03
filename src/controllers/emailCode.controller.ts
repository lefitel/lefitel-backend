// `POST /auth/mfa/email-code` — send the caller a six-digit login code by
// email. Plan 4E, Task 5; design §3.4.
//
// **The order of the checks is the design, not a convenience**, and the
// comment on each step says what it protects. The one that matters most is
// the third: the mail chain is asked whether it can send *before* anything is
// minted or burned. An earlier draft minted first, and on a day with no mail
// left that killed the code the person already had and sent nothing — the
// exact defect `mailBudget.test.ts` pins for the verification link ("en un
// día agotado eso invalida el enlace pendiente y no le manda ninguno nuevo").
//
// **Who may call it.** A session that already passed the password: `parcial`
// (the second step of a login), `onboarding` (the same, past its deadline) or
// `completa` (the step-up window). The route lives under `/api/auth/mfa`,
// which `auth/sessionState.ts`'s `PARCIAL` list opens by prefix, so no list
// changes. It carries no `requireStepUp` — it is a means of satisfying one —
// and no bucket of its own: its limits are the cooldown and the caps in
// `auth/emailCodeStore.ts`, per account and in the database.
//
// **A code that could not be sent is not invalidated.** The relay may have
// delivered a copy the server could not confirm (the ambiguous case the
// design's §1.2.3 accepts), and a code that arrives and does not work costs
// the person five `failed_attempts` for typing it in good faith. The TTL and
// the next mint retire it. The **previous** code, though, is already gone:
// minting retires it before the send, by design (one live code at a time),
// so a walk that fails outright — every provider refusing — leaves the person
// with no code and a sixty-second cooldown. Step 3 above makes that the rare
// case: when nothing can send, nothing is minted.
//
// **No link in the message.** A login-code email with a link in it is the
// template every phishing mail copies; the code is the whole content.

import type { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import { emitirCodigo, purgarCodigosCaducados } from "../auth/emailCodeStore.js";
import { enviarCorreo } from "../auth/mailer.js";
import { hayProveedorDisponible } from "../auth/mailRelay.js";
import { maskEmail } from "../auth/securityNotice.js";
import { estaBloqueada } from "../middleware/loginLimiters.js";
import { CODIGO_MFA_INVALIDO } from "./mfa.controller.js";
import { EMAIL_CODE_RESEND_SECONDS, EMAIL_CODE_TTL_MS, MAIL_PLAZO_INTERACTIVO_MS } from "../config/security.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const codeLog = log("email-code");
const handler = makeHandler(codeLog);

/** Twin of the message in `mfa.controller.ts` and its siblings: the row behind this session is gone. */
const CUENTA_INACTIVA = "Su cuenta ya no está activa.";

export const CORREO_NO_VERIFICADO = "Tu cuenta no tiene un correo verificado.";
export const ESPERA_ANTES_DE_REENVIAR = "Espera un momento antes de pedir otro código.";
export const CODIGO_NO_ENVIADO =
  "No se pudo enviar el código. Prueba otro método o inténtalo más tarde.";
export const CODIGO_ENVIADO = "Te hemos enviado un código a tu correo.";

/** The message. The code is the whole content; nothing to click. */
export function codeEmailBody(codigo: string): { asunto: string; html: string; texto: string } {
  const minutos = Math.round(EMAIL_CODE_TTL_MS / 60_000);
  return {
    asunto: "Tu código de acceso — Osefi",
    html: [
      "<p>Hola,</p>",
      `<p>Tu código de acceso a Osefi es: <strong style="font-size:1.4em;letter-spacing:0.2em">${codigo}</strong></p>`,
      `<p>Caduca en ${minutos} minutos y solo vale una vez.</p>`,
      "<p>Si no has intentado entrar, alguien conoce tu contraseña: cámbiala cuanto antes.</p>",
    ].join("\n"),
    texto: [
      "Hola,",
      "",
      `Tu código de acceso a Osefi es: ${codigo}`,
      "",
      `Caduca en ${minutos} minutos y solo vale una vez.`,
      "Si no has intentado entrar, alguien conoce tu contraseña: cámbiala cuanto antes.",
    ].join("\n"),
  };
}

export const sendEmailCode = handler("sendEmailCode", async (req: Request, res: Response) => {
  const caller = req.user ?? null;
  if (!caller) return res.sendStatus(401);

  // 1. The account, paranoid: an archived row reads as gone. Lockout first,
  //    as `verify` and `stepup` do — a locked account spends no mail.
  const cuenta = await UsuarioModel.findByPk(caller.id, {
    attributes: ["id", "email", "email_verified_at", "failed_attempts", "locked_until"],
  });
  if (!cuenta) return res.status(401).json({ message: CUENTA_INACTIVA });
  const datos = cuenta.dataValues;
  if (estaBloqueada(datos)) {
    return res.status(400).json({ message: CODIGO_MFA_INVALIDO, intentosRestantes: 0 });
  }

  // 2. Nothing to send to. Plain, because the caller is the account itself.
  if (!datos.email || datos.email_verified_at == null) {
    return res.status(400).json({ message: CORREO_NO_VERIFICADO });
  }
  const destino = datos.email;
  const ip = req.ip ?? null;

  // 3. Can the chain send right now? Asked before touching anything: with the
  //    answer no, the code the person already has stays valid.
  if (!hayProveedorDisponible("mfa/codigo")) {
    logAction({
      id_usuario: caller.id,
      action: "MFA_EMAIL_CODE_FAILED",
      entity: "Usuario",
      entity_id: caller.id,
      detail: "No se pudo enviar un código por correo: ningún proveedor disponible",
      metadata: { id_sesion: caller.id_sesion, motivo: "sin-proveedor" },
      severity: "warning",
      ip_address: ip,
    });
    return res.status(503).json({ message: CODIGO_NO_ENVIADO });
  }

  // 4. Cooldown and caps, from the account's own rows.
  const emision = await emitirCodigo(caller.id, destino);
  if ("rechazado" in emision) {
    return res
      .status(429)
      .json({ message: ESPERA_ANTES_DE_REENVIAR, reintento_en_s: emision.reintento_en_s });
  }

  // 5. Send. The plaintext exists only here and in the message.
  const cuerpo = codeEmailBody(emision.codigo);
  const envio = await enviarCorreo({
    para: destino,
    asunto: cuerpo.asunto,
    flujo: "mfa/codigo",
    html: cuerpo.html,
    texto: cuerpo.texto,
  }, { plazo_ms: MAIL_PLAZO_INTERACTIVO_MS });

  // The sweep rides here, unawaited, the way `purgeExpiredTokens` rides the
  // login: there is no scheduler for these rows to join. A failed sweep is a
  // log line, never a failed request.
  void purgarCodigosCaducados().catch((err: unknown) => {
    codeLog.warn({ err }, "no se pudieron purgar los códigos por correo caducados");
  });

  // 6. Not sent — and, on purpose, not invalidated. See the header.
  if (!envio.ok) {
    logAction({
      id_usuario: caller.id,
      action: "MFA_EMAIL_CODE_FAILED",
      entity: "Usuario",
      entity_id: caller.id,
      detail: "No se pudo enviar un código por correo: el envío falló",
      metadata: {
        id_sesion: caller.id_sesion,
        motivo: envio.motivo ?? "envio",
        proveedor: envio.proveedor ?? null,
        enviado_a: maskEmail(destino),
      },
      severity: "warning",
      ip_address: ip,
    });
    return res.status(503).json({ message: CODIGO_NO_ENVIADO });
  }

  // 7. Sent. The masked address is what the screen shows and what the
  //    bitácora keeps — never the code, never the full address. The provider
  //    and its message id are what answer "no me llegó" (design §3.4).
  const enviado_a = maskEmail(destino);
  logAction({
    id_usuario: caller.id,
    action: "MFA_EMAIL_CODE_SENT",
    entity: "Usuario",
    entity_id: caller.id,
    detail: "Se envió un código de acceso por correo",
    metadata: { id_sesion: caller.id_sesion, enviado_a, proveedor: envio.proveedor ?? null, id_correo: envio.id ?? null },
    severity: "info",
    ip_address: ip,
  });
  return res.status(200).json({
    message: CODIGO_ENVIADO,
    enviado_a,
    reintento_en_s: EMAIL_CODE_RESEND_SECONDS,
  });
});
