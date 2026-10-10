// The notices that make an account takeover visible to somebody who is not
// the person doing it.
//
// This plan opens a path that did not exist before: whoever controls a
// recovery mailbox can take the account it belongs to. Plan 4's second factor
// closes that path, and nothing here reaches production until it does — but
// the two mitigations that make the gap survivable in the meantime are a
// `critical` line in the bitácora (written by the controllers themselves) and
// the mail this module sends.
//
// **Why a fixed company address and not just the user's own.** Telling the
// user's mailbox that their password changed is worth something against the
// ordinary case — somebody reset the wrong account by mistake — and worth
// nothing at all against the case this exists for, because in that case the
// attacker is the one reading that mailbox. A copy to an address the attacker
// does not control is the only version of this that an attacker cannot
// silence.
//
// Everything here is fire-and-forget from the caller's point of view: these
// go out *after* the response, never before it. A password reset already has
// an answer the client is waiting on, and two mail round trips on that path
// would add hundreds of milliseconds for no benefit to the person waiting.
//
// **`avisarRescate`, below, is the deliberate exception to that paragraph.**
// It is awaited *before* a rescue operation touches anything — see its own
// docblock — because for that one family of operations the notice is not a
// courtesy on top of an answer already decided, it is the one part of §8's
// "vía de escape" that is allowed to slow the operation down.

import { UsuarioModel } from "../models/usuario.model.js";
import { enviarCorreo } from "./mailer.js";
import { correoEnTexto, vestirCorreo, type Correo } from "./mailLook.js";
import { maskEmail } from "./maskEmail.js";
import { MAIL_PLAZO_INTERACTIVO_MS } from "../config/security.js";
import { log } from "../utils/logger.js";

const noticeLog = log("securityNotice");

/**
 * Where the copy goes. Read live rather than captured at module load, the
 * same way `mailer.ts` reads its own two.
 *
 * **Deliberately not in `requiredEnv`**, and the contrast with
 * `RESEND_API_KEY`/`MAIL_FROM` is the point: without those, *every* email in
 * the system becomes a silent no-op, so the process refuses to boot. Without
 * this one only the copy is lost — the user is still told, the bitácora line
 * is still written. Refusing to boot over it would turn a missing nicety into
 * an outage.
 *
 * What is not acceptable is losing it *quietly*: a deployment that never had
 * this set would look identical to one where the notices work, right up until
 * the day somebody goes looking for the warning that was never sent. So every
 * skipped notice writes a line saying so.
 */
function securityRecipient(): string | null {
  const to = process.env.MAIL_SECURITY_TO?.trim();
  return to ? to : null;
}

/** `n***@dominio.com` — enough to recognise, not enough to hand over. */
/**
 * Why the mask is a **fixed** run of asterisks and not one per real character:
 * the length of an address is itself a hint, and this value goes to mailboxes
 * and to responses whose whole purpose is to say less than they know.
 *
 * There used to be a second copy of this in `controllers/email.controller.ts`,
 * called `enmascarada` and not exported, splitting on the *first* `@` rather
 * than the last — so a local part containing a quoted `@` masked to the wrong
 * domain. Merged here rather than left as a pair that agrees today: plan 4B's
 * `/auth/me` needed the same function, and two of them is how they drift.
 */
// Defined in `maskEmail.ts` since plan 4E and re-exported from here, so every
// caller that imported it from this module keeps working: `mailRelay.ts` and
// `mailer.ts` need it for their log lines, and this module imports `mailer.ts`
// — importing back from here would have closed an import cycle.
export { maskEmail };

/**
 * The account's login name, for a notice that a person has to act on.
 *
 * "La contraseña del usuario 14 fue restablecida" is a line somebody has to
 * go and look up before they can do anything about it, at the exact moment
 * they are trying to decide whether to worry. The extra read costs nothing:
 * this whole module runs after the response has already gone out.
 */
async function nombreDe(id_usuario: number): Promise<string> {
  try {
    const row = await UsuarioModel.findByPk(id_usuario, { attributes: ["user"] });
    return (row?.dataValues.user as string | undefined) ?? `#${id_usuario}`;
  } catch {
    return `#${id_usuario}`;
  }
}

/** Both parts of a notice, from the same blocks: what one says the other says. */
function cuerpo(correo: Correo): { html: string; texto: string } {
  return { html: vestirCorreo(correo), texto: correoEnTexto(correo) };
}

/**
 * Somebody used a recovery link to set a new password.
 *
 * Two messages, and they are not the same message: the copy names the
 * account and the address, because whoever reads it has to be able to act;
 * the one to the user says what happened to *their* account and nothing about
 * anyone else's.
 */
export async function avisarPasswordRestablecida(input: {
  id_usuario: number;
  email_destino: string;
  ip: string | null;
}): Promise<void> {
  const cuando = new Date().toISOString();
  const usuario = await nombreDe(input.id_usuario);

  const alUsuario = cuerpo({
    titulo: "Tu contraseña ha cambiado",
    bloques: [
      { parrafo: "La contraseña de tu cuenta de Osefi acaba de cambiarse usando un enlace de recuperación." },
      { parrafo: `Fecha: ${cuando}.` },
      { parrafo: "Se han cerrado todas tus sesiones abiertas. Si has sido tú, ya puedes entrar con la contraseña nueva." },
      { parrafo: [{ fuerte: "Si no has sido tú, avisa a administración inmediatamente." }] },
    ],
  });
  await enviarCorreo({
    para: input.email_destino,
    flujo: "password/aviso-cambio",
    asunto: "Tu contraseña ha cambiado — Osefi",
    html: alUsuario.html,
    texto: alUsuario.texto,
  });

  const to = securityRecipient();
  if (!to) {
    noticeLog.warn(
      { usuario, accion: "PASSWORD_RESET" },
      "aviso de seguridad NO enviado: falta MAIL_SECURITY_TO",
    );
    return;
  }

  const copia = cuerpo({
    titulo: "Contraseña restablecida",
    bloques: [
      { parrafo: ["Se ha restablecido la contraseña de la cuenta ", { fuerte: `@${usuario}` }, " mediante un enlace de recuperación."] },
      { dato: `Dirección que recibió el enlace: ${maskEmail(input.email_destino)}` },
      { dato: `IP desde la que se completó: ${input.ip ?? "desconocida"}` },
      { dato: `Fecha: ${cuando}` },
    ],
    pie: ["Aviso de seguridad de Osefi. Si esta persona no ha pedido el cambio, su buzón de recuperación puede estar comprometido."],
  });
  await enviarCorreo({
    para: to,
    flujo: "password/aviso-restablecida",
    asunto: `[Seguridad] Contraseña restablecida: @${usuario}`,
    html: copia.html,
    texto: copia.texto,
  });
}

/**
 * Somebody replaced an already-verified recovery address.
 *
 * The user's own warning for this one does **not** live here: it goes to the
 * *previous* address and `email.controller.ts` sends it, because that is the
 * only place that still knows what the previous address was. This is the copy
 * to the company, and it is the more important half — changing the recovery
 * address is step one of taking an account, and it is the step that leaves no
 * trace the victim would notice.
 */
export async function avisarCorreoCambiado(input: {
  id_usuario: number;
  email_anterior: string;
  email_nuevo: string;
  ip: string | null;
}): Promise<void> {
  const to = securityRecipient();
  const usuario = await nombreDe(input.id_usuario);
  if (!to) {
    noticeLog.warn(
      { usuario, accion: "EMAIL_CHANGED" },
      "aviso de seguridad NO enviado: falta MAIL_SECURITY_TO",
    );
    return;
  }

  const copia = cuerpo({
    titulo: "Dirección de recuperación cambiada",
    bloques: [
      { parrafo: ["La cuenta ", { fuerte: `@${usuario}` }, " ha cambiado su dirección de recuperación."] },
      { dato: `Anterior: ${maskEmail(input.email_anterior)}` },
      { dato: `Nueva: ${maskEmail(input.email_nuevo)}` },
      { dato: `IP: ${input.ip ?? "desconocida"}` },
      { dato: `Fecha: ${new Date().toISOString()}` },
    ],
    pie: ["Aviso de seguridad de Osefi. Cambiar la dirección de recuperación es el primer paso para tomar una cuenta. Si esta persona no lo ha pedido, conviene comprobarlo con ella directamente."],
  });
  await enviarCorreo({
    para: to,
    flujo: "email/aviso-cambio",
    asunto: `[Seguridad] Dirección de recuperación cambiada: @${usuario}`,
    html: copia.html,
    texto: copia.texto,
  });
}

/**
 * The notice §8 ("la vía de escape") requires of *every* rescue operation,
 * whichever of the two doors ran it — `auth/rescueCore.ts`'s functions call
 * this once each, so the console and the endpoint cannot drift into sending
 * it differently or forgetting it on a new operation.
 *
 * **Decided by Isaias, not reopened: this goes out before anything is
 * touched, whether the request turns out to be legitimate or not.** The
 * reasoning is specific to this family of operations and does not apply to
 * `avisarPasswordRestablecida` or `avisarCorreoCambiado` above: whoever runs
 * a rescue — from the console — holds the database credentials in their own
 * environment and can delete the bitácora row after the fact. A mail already
 * sent by the server is the one trace that is not theirs to erase, which is
 * why it has to be sent *before* the row exists, not queued alongside it.
 *
 * **Company-only, on purpose — there is no "to the user" half here.** The
 * other two functions above email the account holder and a copy to the
 * company, because the account holder can still read their own mailbox. A
 * rescue runs precisely when that assumption has failed — the phone is lost,
 * or the recovery address is what is being replaced — so there is no
 * reachable inbox to tell, and this sends exactly one message, to
 * `MAIL_SECURITY_TO`.
 *
 * **This message spends the mail budget like every other, and the paragraph
 * that stood here said the opposite.** It claimed the three notices were
 * "deliberately outside `mailBudget.ts`'s daily ceiling"; that stopped being
 * true in plan 4B, when the charge moved inside `enviarCorreo`, and an audit
 * of plan 4E caught the comment still saying it. What *is* true, and matters
 * more since 4E: `rescate/aviso` is one of the **reserved** flows
 * (`FLUJOS_RESERVADOS`), so a flood of verification or recovery mail cannot be
 * the reason this trace was not sent — each provider keeps a quarter of its
 * ceiling for exactly this. The other half of the old worry stands: a console
 * invocation is its own OS process with its own copies of the counters, so it
 * cannot see what the running server spent today. Reconciling that needs a
 * database-backed counter, which is more machinery than five-or-so rescues a
 * year justifies; the reserve makes the gap harmless in the direction that
 * counts.
 *
 * **A failed send does not stop the rescue, and that is a considered
 * trade-off, not the easy default.** `enviarCorreo` never throws — see its
 * own contract — so the only way this can fail is `{ ok: false }` or a
 * missing `MAIL_SECURITY_TO`. Aborting the whole operation on either would
 * turn §8's *last resort* into a second way to get stuck: the day Resend is
 * down, or nobody ever set the variable, is exactly the kind of day this
 * escape hatch has to keep working on. So the caller is told via the
 * returned `enviado` flag and this always logs at `error` — louder than the
 * `warn` the other two notices use above, because for this family it is the
 * one surviving trace, not a courtesy copy — and `auth/rescueCore.ts` writes
 * `enviado` into the bitácora line it confirms afterwards, so the gap is on
 * the record even where it cannot be prevented.
 */
export async function avisarRescate(input: {
  id_usuario: number;
  /** Machine label, shared with the bitácora `action` column — e.g. `"RESCUE_MFA_RESET"`. */
  operacion: string;
  /** One sentence of what this operation did or is about to do. Free text — never
   *  echoes anything long enough to threaten `bitacoras.detail`'s own 500-character
   *  cap, because the same string is reused there. */
  detalle: string;
  /** Who ran this and from where, already formatted by the caller — the console
   *  names an OS user and host, the endpoint names the administrator's account.
   *  Never built here: this module has no access to `process.argv` or `req`. */
  actor: string;
  ip: string | null;
}): Promise<{ enviado: boolean }> {
  const usuario = await nombreDe(input.id_usuario);
  const to = securityRecipient();
  if (!to) {
    noticeLog.error(
      { usuario, operacion: input.operacion },
      "aviso de RESCATE no enviado: falta MAIL_SECURITY_TO — la operación sigue adelante sin la única traza fuera del alcance de quien la ejecuta",
    );
    return { enviado: false };
  }

  const cuando = new Date().toISOString();
  const copia = cuerpo({
    titulo: "Operación de rescate",
    bloques: [
      { parrafo: ["Operación: ", { fuerte: input.operacion }, " sobre la cuenta ", { fuerte: `@${usuario}` }, "."] },
      { parrafo: input.detalle },
      { dato: `Pedida por: ${input.actor}` },
      { dato: `IP: ${input.ip ?? "consola del contenedor, sin IP"}` },
      { dato: `Fecha: ${cuando}` },
    ],
    pie: ["Aviso de seguridad de Osefi — operación de rescate (vía de escape, §8). Esta operación actúa sobre la cuenta indicada aunque no la haya pedido su dueño — es exactamente lo que hace un rescate legítimo. Si no reconoces esta acción, contacta a esa persona directamente y revisa la bitácora."],
  });
  const { ok } = await enviarCorreo(
    {
    para: to,
    flujo: "rescate/aviso",
    asunto: `[Seguridad] Rescate ejecutado — ${input.operacion}: @${usuario}`,
      html: copia.html,
      texto: copia.texto,
    },
    // Before the rescue touches anything, with a person at the console: bounded.
    { plazo_ms: MAIL_PLAZO_INTERACTIVO_MS },
  );
  if (!ok) {
    noticeLog.error(
      { usuario, operacion: input.operacion },
      "aviso de RESCATE: enviarCorreo devolvió ok:false — ningún proveedor lo entregó",
    );
  }
  return { enviado: ok };
}
