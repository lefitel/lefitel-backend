/**
 * The road-route client. One call out of this process, to OpenRouteService.
 *
 * The retry loop is the whole reason this is a module and not three lines in a
 * controller: ORS refuses the entire request when a single waypoint is not near
 * a routable road (error 2010), naming the offending index in prose. Dropping
 * that point and asking again is what turns "no route" into "the route without
 * that pole", which is the answer the screens actually want.
 */
const ORS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

/**
 * How long the whole walk may take, retries included — not how long one attempt
 * may take.
 *
 * The distinction is the mail chain's (`MAIL_PLAZO_INTERACTIVO_MS` against
 * `MAIL_PLAZO_POR_INTENTO_MS`) and it is here for the same reason: a per-attempt
 * deadline bounds nothing when the loop can attempt again. A tramo with six
 * poles off the road is six sequential requests, and eight seconds each would
 * hold the browser for the best part of a minute while somebody waits on a map.
 *
 * Twelve seconds because a person is watching. There is no deferred caller for
 * this; every one of the four screens draws as soon as it answers.
 */
export const ORS_PLAZO_TOTAL_MS = 12_000;

export interface DependenciasRuta {
  /** Injected so the tests drive the loop without a network. */
  fetch: typeof fetch;
  clave: string;
  /** Injected so the deadline can be tested without waiting for it. */
  ahora?: () => number;
  plazoTotalMs?: number;
}

/**
 * Why there is no route, when there is none.
 *
 * The point of naming these is the log. In the browser every failure collapsed
 * into the same straight line: an exhausted quota, a revoked key and a tramo
 * with no roads were indistinguishable, and none of them was written down
 * anywhere. Here each one has a name that reaches `req.log`.
 */
export type MotivoSinRuta =
  /** 403 — the day's requests are spent, or the key is not valid any more. */
  | "cuota-diaria"
  /** 429 — too many in the last sixty seconds. */
  | "ritmo"
  /** ORS answered, and there is no route: no road near an end, or no geometry. */
  | "sin-ruta"
  /** The walk ran out of time before ORS answered. */
  | "plazo"
  /** ORS could not be reached at all: DNS, a refused connection, a cut one. */
  | "red"
  /** ORS refused for a reason of its own. */
  | "rechazo";

export type ResultadoRuta =
  // Las claves `?: undefined` son lo que deja narrow a `if (!x.ok)` bajo el
  // `strictNullChecks: false` de este repositorio — mismo apaño, y por el
  // mismo motivo, que `ConfiguracionDeCorreo` en `config/security.ts`.
  | { ok: true; coordenadas: [number, number][]; motivo?: undefined }
  | { ok: false; motivo: MotivoSinRuta; coordenadas?: undefined };

/** The index ORS names in the prose of a 2010, or null when it names none. */
function puntoRechazado(mensaje: unknown): number | null {
  if (typeof mensaje !== "string") return null;
  const match = mensaje.match(/coordinate\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

export async function pedirRuta(
  waypoints: number[][],
  deps: DependenciasRuta,
): Promise<ResultadoRuta> {
  let wps = [...waypoints];
  const ahora = deps.ahora ?? Date.now;
  const plazo = deps.plazoTotalMs ?? ORS_PLAZO_TOTAL_MS;
  const arranque = ahora();

  while (wps.length >= 2) {
    // Checked before starting an attempt rather than after finishing one: an
    // attempt begun with no budget left is a request whose answer nobody can
    // wait for.
    const restante = plazo - (ahora() - arranque);
    if (restante <= 0) return { ok: false, motivo: "plazo" };

    // The check above only stops an attempt from *starting*. One already under
    // way had nothing to end it: an ORS that accepts the connection and never
    // answers held the request for `fetch`'s own default, which is minutes. The
    // signal carries what is left of the budget, and covers reading the body.
    const corte = AbortSignal.timeout(restante);
    let res: Response;
    let geojson: { features?: { geometry?: { coordinates?: number[][] } }[] } | undefined;
    try {
      res = await deps.fetch(ORS_URL, {
        method: "POST",
        headers: { Authorization: deps.clave, "Content-Type": "application/json" },
        // `-1` is ORS's "no limit" search radius: snap each point to the nearest
        // road however far it is. Without it a pole a few metres off the road is
        // a 2010 on its own.
        body: JSON.stringify({ coordinates: wps, radiuses: wps.map(() => -1) }),
        signal: corte,
      });
      if (res.ok) geojson = (await res.json()) as typeof geojson;
    } catch {
      // Named rather than thrown: the caller logs the reason, and a thrown
      // error reached the browser as a 500 with no reason written anywhere.
      return { ok: false, motivo: corte.aborted ? "plazo" : "red" };
    }

    if (res.ok) {
      const coordenadas = geojson.features?.[0]?.geometry?.coordinates;
      if (!coordenadas) return { ok: false, motivo: "sin-ruta" };
      // ORS speaks [lng, lat]; every caller of this API draws in [lat, lng].
      return { ok: true, coordenadas: coordenadas.map(([lng, lat]) => [lat, lng]) };
    }

    const cuerpo = (await res.json().catch(() => null)) as { error?: { code?: number; message?: unknown } } | null;

    if (cuerpo?.error?.code === 2010) {
      const indice = puntoRechazado(cuerpo.error.message);
      // The ends are the tramo: dropping one would answer a different question
      // from the one that was asked.
      if (indice !== null && indice > 0 && indice < wps.length - 1) {
        wps = wps.filter((_, i) => i !== indice);
        continue;
      }
      // A 2010 naming an end, or naming nothing: there is no point left to drop
      // that would still answer the question that was asked.
      return { ok: false, motivo: "sin-ruta" };
    }

    if (res.status === 403) return { ok: false, motivo: "cuota-diaria" };
    if (res.status === 429) return { ok: false, motivo: "ritmo" };
    return { ok: false, motivo: "rechazo" };
  }

  // Fewer than two points left to join.
  return { ok: false, motivo: "sin-ruta" };
}
