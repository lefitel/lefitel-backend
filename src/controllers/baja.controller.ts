// Unsubscribing from a scheduled report — the two things the confirmation
// page asks of the server. Public: whoever holds the link has no account.
// See `reportSchedule/unsubscribe.ts` for why both are POSTs with the token in
// the body.

import { Request, Response } from "express";
import { consultarBaja, darDeBaja } from "../reportSchedule/unsubscribe.js";
import { log } from "../utils/logger.js";

const bajaLog = log("baja");

/** One sentence for every way a link can be no good. It does not say which. */
export const ENLACE_NO_VALIDO = "Este enlace no es válido.";

const tokenDe = (req: Request): string => {
  const token = (req.body as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? token : "";
};

/** `POST /api/unsubscribe/lookup` — what this link would stop. Changes nothing. */
export async function postConsultarBaja(req: Request, res: Response) {
  try {
    const datos = await consultarBaja(tokenDe(req));
    if (!datos) return res.status(404).json({ message: ENLACE_NO_VALIDO });
    res.status(200).json(datos);
  } catch (error) {
    bajaLog.error({ err: error }, "baja: falló la consulta");
    res.status(500).json({ message: "No se pudo completar la operación. Inténtelo de nuevo." });
  }
}

/** `POST /api/unsubscribe/` — stop. Answers nothing, and the same the second time. */
export async function postDarDeBaja(req: Request, res: Response) {
  try {
    if (!(await darDeBaja(tokenDe(req)))) return res.status(404).json({ message: ENLACE_NO_VALIDO });
    res.status(204).end();
  } catch (error) {
    bajaLog.error({ err: error }, "baja: falló la confirmación");
    res.status(500).json({ message: "No se pudo completar la operación. Inténtelo de nuevo." });
  }
}
