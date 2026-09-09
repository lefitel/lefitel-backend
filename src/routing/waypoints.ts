/**
 * What the request is allowed to ask for a route between.
 *
 * The caller supplies the points, so this is the whole of what stops a stranger
 * with a session — or a bug in a screen — from spending the routing quota on a
 * body of any size. It is a pure function so the rules can be read and tested
 * without a request.
 */

/**
 * ORS refuses more than fifty waypoints in one directions request, so anything
 * above this is a request that cannot succeed and would spend one of the day's
 * calls finding that out.
 *
 * The number is not ours to choose: it is in the provider's published
 * restrictions. `ReportRecorrido.tsx` already trims to 48 intermediates plus the
 * two ends, which is exactly this; the other three screens trim to nothing,
 * which is why their long tramos have never drawn a real route.
 */
export const ORS_MAX_WAYPOINTS = 50;

export type Waypoints = [number, number][];

export type Validacion =
  // Las claves `?: undefined` son lo que deja narrow a `if (!x.ok)` bajo el
  // `strictNullChecks: false` de este repositorio — mismo apaño, y por el
  // mismo motivo, que `ConfiguracionDeCorreo` en `config/security.ts`.
  | { ok: true; waypoints: Waypoints; mensaje?: undefined }
  | { ok: false; mensaje: string; waypoints?: undefined };

export function validarWaypoints(valor: unknown): Validacion {
  if (!Array.isArray(valor)) {
    return { ok: false, mensaje: "Se esperaba una lista de puntos." };
  }
  if (valor.length > ORS_MAX_WAYPOINTS) {
    return {
      ok: false,
      mensaje: `Un trazado admite como máximo ${ORS_MAX_WAYPOINTS} puntos; se recibieron ${valor.length}.`,
    };
  }
  if (valor.length < 2) {
    return { ok: false, mensaje: "Un trazado necesita al menos dos puntos." };
  }

  for (const [i, punto] of valor.entries()) {
    if (!Array.isArray(punto) || punto.length !== 2) {
      return { ok: false, mensaje: `El punto ${i} no es un par de coordenadas.` };
    }
    const [lng, lat] = punto as unknown[];
    // `Number.isFinite` and not `typeof === "number"`: NaN and Infinity are
    // numbers, survive `JSON.parse`, and reach ORS as a malformed request.
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return { ok: false, mensaje: `El punto ${i} no es un par de números.` };
    }
    // Order is [lng, lat] here, which is ORS's and GeoJSON's, and the opposite
    // of what the screens draw with. Checking the ranges separately is what
    // catches a pair passed the wrong way round anywhere outside the tropics.
    if ((lng as number) < -180 || (lng as number) > 180) {
      return { ok: false, mensaje: `La longitud del punto ${i} está fuera de rango.` };
    }
    if ((lat as number) < -90 || (lat as number) > 90) {
      return { ok: false, mensaje: `La latitud del punto ${i} está fuera de rango.` };
    }
  }

  return { ok: true, waypoints: valor as Waypoints };
}
