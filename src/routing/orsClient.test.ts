import { describe, expect, it } from "vitest";
import { pedirRuta } from "./orsClient.js";

/** ORS answers a rejected waypoint with a body of this shape. */
const rechazo2010 = (indice: number) => ({
  ok: false,
  status: 400,
  headers: new Headers(),
  json: async () => ({
    error: {
      code: 2010,
      message: `Could not find routable point within a radius of 350.0 meters of specified coordinate ${indice}.`,
    },
  }),
});

const rutaDevuelta = (coordenadas: number[][]) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ features: [{ geometry: { coordinates: coordenadas } }] }),
});

describe("pedirRuta", () => {
  it("quita el punto que ORS rechaza y reintenta sin él", async () => {
    const enviados: number[][][] = [];
    const fetchFalso = (async (_url: string, init: { body: string }) => {
      enviados.push(JSON.parse(init.body).coordinates);
      return enviados.length === 1 ? rechazo2010(1) : rutaDevuelta([[0, 0], [2, 2]]);
    }) as unknown as typeof fetch;

    const res = await pedirRuta(
      [[0, 0], [1, 1], [2, 2]],
      { fetch: fetchFalso, clave: "una-clave" },
    );

    // Lo que importa no es cuántas veces se llamó, sino qué se mandó la
    // segunda vez: el punto 1 tiene que haber desaparecido y los extremos
    // seguir en su sitio.
    expect(enviados[1]).toEqual([[0, 0], [2, 2]]);
    expect(res.ok).toBe(true);
  });

  it("deja de reintentar cuando se agota el plazo total", async () => {
    // Ocho puntos: seis intermedios que ORS podría rechazar uno a uno. Si el
    // plazo no se respetara, el bucle haría las seis peticiones y se quedaría
    // sin puntos, no sin tiempo — que es la confusión que este test descarta.
    const waypoints = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]];
    let reloj = 0;
    let peticiones = 0;
    const fetchFalso = (async () => {
      peticiones += 1;
      reloj += 5_000;
      return rechazo2010(1);
    }) as unknown as typeof fetch;

    const res = await pedirRuta(waypoints, {
      fetch: fetchFalso,
      clave: "una-clave",
      ahora: () => reloj,
      plazoTotalMs: 12_000,
    });

    // Tres intentos entran en el presupuesto (0, 5.000 y 10.000 transcurridos);
    // el cuarto arrancaría en 15.000, pasado el plazo.
    expect(peticiones).toBe(3);
    expect(res.ok).toBe(false);
  });

  it("corta una petición que no contesta, en vez de esperarla sin límite", async () => {
    // El plazo total sólo se miraba entre un intento y el siguiente: un ORS que
    // acepta la conexión y no responde dejaba la petición colgada hasta el
    // plazo por defecto de `fetch`, que son minutos. La señal es lo único que
    // puede cortar un intento ya empezado.
    const fetchFalso = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;

    const res = await pedirRuta([[0, 0], [1, 1]], {
      fetch: fetchFalso,
      clave: "una-clave",
      plazoTotalMs: 20,
    });

    expect(res).toEqual({ ok: false, motivo: "plazo" });
  });

  it("nombra el fallo de red en vez de dejarlo salir como excepción", async () => {
    const fetchFalso = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const res = await pedirRuta([[0, 0], [1, 1]], { fetch: fetchFalso, clave: "una-clave" });

    expect(res).toEqual({ ok: false, motivo: "red" });
  });

  it("distingue la cuota diaria agotada de un tramo sin carreteras", async () => {
    // 403 es la respuesta de ORS al pasarse de las peticiones del día. Sin este
    // motivo, agotar la cuota y no encontrar carretera se ven igual desde el
    // log — que es exactamente lo que pasa hoy en el navegador.
    const fetchFalso = (async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const res = await pedirRuta([[0, 0], [1, 1]], { fetch: fetchFalso, clave: "una-clave" });

    expect(res).toEqual({ ok: false, motivo: "cuota-diaria" });
  });
});
