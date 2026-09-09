import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { consultarRuta } from "./ruta.controller.js";

const app = express();
app.use(express.json());
app.post("/query", consultarRuta);

const TRAMO = { waypoints: [[-68.1, -16.5], [-68.2, -16.6]] };

describe("consultarRuta", () => {
  const original = process.env.ORS_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.ORS_API_KEY;
    else process.env.ORS_API_KEY = original;
  });

  it("contesta 503 cuando no hay clave configurada", async () => {
    // La misma decisión que `/auth/totp/*`: una pieza sin configurar apaga esa
    // pieza, no el ERP. Y por eso ORS_API_KEY no está en `requiredEnv`.
    delete process.env.ORS_API_KEY;

    const res = await request(app).post("/query").send(TRAMO);

    expect(res.status).toBe(503);
  });

  it("contesta 400 sin gastar cuota cuando el trazado trae demasiados puntos", async () => {
    process.env.ORS_API_KEY = "una-clave";
    let salio = false;
    vi.stubGlobal("fetch", async () => {
      salio = true;
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
    });

    const res = await request(app)
      .post("/query")
      .send({ waypoints: Array.from({ length: 51 }, (_, i) => [-68 + i * 0.001, -16]) });

    expect(res.status).toBe(400);
    // Lo que de verdad importa: la petición no llegó a salir de la máquina.
    expect(salio).toBe(false);
    vi.unstubAllGlobals();
  });

  it("contesta 200 con el motivo cuando ORS dice que la cuota está agotada", async () => {
    process.env.ORS_API_KEY = "una-clave";
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({}),
    }));

    const res = await request(app).post("/query").send(TRAMO);

    // 200 y no un 4xx: «no hay ruta» es una respuesta correcta a «¿hay ruta?»,
    // y la pantalla dibuja la recta sin pasar por el interceptor de errores.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ coordenadas: null, motivo: "cuota-diaria" });
    vi.unstubAllGlobals();
  });

  it("devuelve la geometría en el orden que dibujan las pantallas", async () => {
    process.env.ORS_API_KEY = "una-clave";
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      // ORS habla [lng, lat]; las pantallas dibujan [lat, lng].
      json: async () => ({ features: [{ geometry: { coordinates: [[-68.1, -16.5], [-68.2, -16.6]] } }] }),
    }));

    const res = await request(app).post("/query").send(TRAMO);

    expect(res.body.coordenadas).toEqual([[-16.5, -68.1], [-16.6, -68.2]]);
    vi.unstubAllGlobals();
  });
});
