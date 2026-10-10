// The way out for an outside address: the link in every scheduled report it
// receives, and what happens when it is used. Design §3.6.
//
// **Opening the link unsubscribes nobody.** It leads to a page of the web
// application with a button, and only pressing that button does. Mail
// scanners open every link in a message to look at it — many companies'
// filters do, and so do some clients' previews — and a link that acted on a
// GET would unsubscribe those recipients the moment the message arrived. So
// the address in the email is a page (`/baja-informe#t=…`) and both things
// the server does with the token are POSTs with it in the body.
//
// **The token rides in the fragment**, like the password-reset link's: a
// browser never sends the part after `#` to any server, so it reaches neither
// the web host's access log nor a `Referer`. The page reads it and takes it
// out of the address bar.
//
// **The token is in the body, never in a path.** `httpLogger` writes the path
// of every request; a token in it would be a working unsubscribe link in the
// log of anybody who can read logs.
//
// **The same link in every message.** It is created the first time a
// recipient is written to and never changes, so the link in last month's
// email still works. That is why the table holds the token itself — see the
// migration for why that is acceptable.
//
// **Only an outside address has one.** An account stops receiving by being
// taken off the schedule, or by asking whoever set it up; it has a login and
// a person to ask. The outside address has neither.

import { randomBytes } from "node:crypto";
import { allowedOrigins } from "../config/security.js";
import {
  ReporteProgramacionDestinatarioModel,
  ReporteProgramacionModel,
} from "../models/reporteProgramacion.model.js";
import { ReporteVistaModel } from "../models/reporteVista.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { log } from "../utils/logger.js";
import { maskEmail } from "../auth/maskEmail.js";

const bajaLog = log("reportSchedule");

/** Thirty-two random bytes in base64url: forty-three characters, no padding. */
export const FORMA_DEL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const nuevoToken = (): string => randomBytes(32).toString("base64url");

/** Where the page that confirms an unsubscribe lives, under the web application. */
export const RUTA_DE_BAJA = "/baja-informe";

/**
 * The web application's own address — the first origin this server accepts
 * requests from. `null` when none is configured, in which case no link is
 * written: a link to nowhere is worse than none.
 */
export function origenDeLaWeb(env: NodeJS.ProcessEnv = process.env): string | null {
  return allowedOrigins(env.CORS_ORIGIN, env.NODE_ENV)[0] ?? null;
}

export const enlaceCon = (origen: string, token: string): string =>
  `${origen}${RUTA_DE_BAJA}#t=${encodeURIComponent(token)}`;

/**
 * The unsubscribe link for one recipient, creating its token on first use.
 * `null` for an account, and when the web's address is not known.
 */
export async function enlaceDeBaja(id_destinatario: number): Promise<string | null> {
  const origen = origenDeLaWeb();
  if (!origen) return null;

  const fila = await ReporteProgramacionDestinatarioModel.unscoped().findByPk(id_destinatario, {
    attributes: ["id", "email", "baja_token"],
  });
  if (!fila?.dataValues.email) return null;

  let token = fila.dataValues.baja_token ?? null;
  if (!token) {
    token = nuevoToken();
    // Only where there is still none: two runs that reach the same recipient
    // at once must end up mailing the same link, not two of which one is dead.
    const [escritas] = await ReporteProgramacionDestinatarioModel.update(
      { baja_token: token },
      { where: { id: id_destinatario, baja_token: null } },
    );
    if (escritas === 0) {
      const otra = await ReporteProgramacionDestinatarioModel.unscoped().findByPk(id_destinatario, {
        attributes: ["baja_token"],
      });
      token = otra?.dataValues.baja_token ?? token;
    }
  }
  return enlaceCon(origen, token);
}

export interface DatosDeBaja {
  /** The report's name, so the person knows what they are stopping. */
  informe: string | null;
  /** Who set the schedule up. */
  programadoPor: string | null;
  /** Already unsubscribed: the page says so instead of offering the button. */
  deBaja: boolean;
}

async function buscar(token: string) {
  if (typeof token !== "string" || !FORMA_DEL_TOKEN.test(token)) return null;
  return ReporteProgramacionDestinatarioModel.unscoped().findOne({
    where: { baja_token: token },
    attributes: ["id", "id_programacion", "email", "baja_at"],
  });
}

/** What the confirmation page shows. `null` for a token nobody holds. */
export async function consultarBaja(token: string): Promise<DatosDeBaja | null> {
  const fila = await buscar(token);
  if (!fila) return null;

  // `paranoid: false` throughout: the schedule may have been removed and the
  // report archived since the message was sent, and the person holding the
  // link should still be told what it was rather than "not found".
  const programacion = await ReporteProgramacionModel.findByPk(fila.dataValues.id_programacion, {
    attributes: ["id_reporte", "id_usuario"],
    paranoid: false,
  });
  const [informe, dueno] = programacion
    ? await Promise.all([
        ReporteVistaModel.findByPk(programacion.dataValues.id_reporte, { attributes: ["name"], paranoid: false }),
        UsuarioModel.findByPk(programacion.dataValues.id_usuario, { attributes: ["name", "lastname"], paranoid: false }),
      ])
    : [null, null];

  return {
    informe: informe?.dataValues.name ?? null,
    programadoPor: dueno ? `${dueno.dataValues.name} ${dueno.dataValues.lastname}`.trim() : null,
    deBaja: Boolean(fila.dataValues.baja_at),
  };
}

/**
 * Unsubscribe. `false` for a token nobody holds; `true` otherwise, including
 * when it had already been done — pressing the button twice is not an error.
 */
export async function darDeBaja(token: string): Promise<boolean> {
  const fila = await buscar(token);
  if (!fila) return false;
  if (!fila.dataValues.baja_at) {
    await ReporteProgramacionDestinatarioModel.update(
      { baja_at: new Date() },
      { where: { id: fila.dataValues.id, baja_at: null } },
    );
    bajaLog.info(
      { id_destinatario: fila.dataValues.id, id_programacion: fila.dataValues.id_programacion, para: maskEmail(fila.dataValues.email ?? "") },
      "una dirección externa se dio de baja de un informe programado",
    );
  }
  return true;
}
