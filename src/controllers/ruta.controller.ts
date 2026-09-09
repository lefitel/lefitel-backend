import { Request, Response } from "express";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { pedirRuta } from "../routing/orsClient.js";
import { validarWaypoints } from "../routing/waypoints.js";

const rutaLog = log("ruta");
const handler = makeHandler(rutaLog);

/**
 * The road route between a tramo's points, asked of OpenRouteService from here
 * rather than from the browser.
 *
 * **Why the API and not the page.** The provider's key was read in the frontend
 * as `import.meta.env.VITE_ORS_API_KEY`, and Vite writes those literally into
 * the bundle: the key shipped, readable, in the JavaScript `www.osefi.net`
 * serves. There is no way to make it secret there — OpenRouteService has no
 * referrer or domain restriction to fall back on, unlike the map keys that are
 * public by design. Moving the call is the only thing that makes it a secret.
 *
 * **And the log.** Every failure used to end as a straight line drawn in
 * somebody's browser and written down nowhere: an exhausted quota, a revoked
 * key and a tramo with no roads were the same picture. `pedirRuta` names them,
 * and the name lands here.
 */
export const consultarRuta = handler("consultarRuta", async (req: Request, res: Response) => {
  const clave = process.env.ORS_API_KEY;
  if (!clave) {
    // Deliberately not in `requiredEnv`: a routing key nobody set must not stop
    // the ERP booting, the same call `/auth/totp/*` makes about its own key.
    rutaLog.warn({}, "ORS_API_KEY no está configurada: el trazado por carretera está apagado");
    return res.status(503).json({
      message: "El trazado por carretera no está disponible en este momento.",
    });
  }

  const validacion = validarWaypoints((req.body as { waypoints?: unknown }).waypoints);
  if (!validacion.ok) {
    return res.status(400).json({ message: validacion.mensaje });
  }

  const resultado = await pedirRuta(validacion.waypoints, { fetch, clave });

  if (!resultado.ok) {
    // 200 and not an error status, on purpose. "There is no route" is a
    // successful answer to "is there a route": the four screens draw the
    // straight line and carry on, and turning it into a 4xx would put it
    // through the frontend's global error interceptor for nothing. The reason
    // rides in the body for whoever is debugging, and in the log for whoever is
    // not watching.
    rutaLog.info({ motivo: resultado.motivo, puntos: validacion.waypoints.length }, "sin trazado por carretera");
    return res.json({ coordenadas: null, motivo: resultado.motivo });
  }

  return res.json({ coordenadas: resultado.coordenadas, motivo: null });
});
