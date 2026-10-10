// The two public handlers behind the unsubscribe page.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../utils/logger.js", () => ({ log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

const consultarBaja = vi.fn();
const darDeBaja = vi.fn();
vi.mock("../reportSchedule/unsubscribe.js", () => ({
  consultarBaja: (...a: unknown[]) => consultarBaja(...a),
  darDeBaja: (...a: unknown[]) => darDeBaja(...a),
}));

const { ENLACE_NO_VALIDO, postConsultarBaja, postDarDeBaja } = await import("./baja.controller.js");

const peticion = (body: unknown) => ({ body }) as unknown as Request;
function respuesta() {
  const res = { statusCode: 0, body: undefined as unknown, terminada: false } as {
    statusCode: number;
    body: unknown;
    terminada: boolean;
    status(c: number): typeof res;
    json(b: unknown): typeof res;
    end(): typeof res;
  };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.end = () => ((res.terminada = true), res);
  return res;
}
const como = (res: ReturnType<typeof respuesta>) => res as unknown as Response;

beforeEach(() => vi.clearAllMocks());

describe("POST /api/unsubscribe/lookup", () => {
  it("answers what the link would stop, taking the token from the body", async () => {
    consultarBaja.mockResolvedValue({ informe: "Informe semanal", programadoPor: "Ana Pérez", deBaja: false });
    const res = respuesta();
    await postConsultarBaja(peticion({ token: "abc" }), como(res));
    expect([res.statusCode, res.body]).toEqual([200, { informe: "Informe semanal", programadoPor: "Ana Pérez", deBaja: false }]);
    expect(consultarBaja).toHaveBeenCalledWith("abc");
  });

  it("answers 404 with one sentence for every link that is no good", async () => {
    consultarBaja.mockResolvedValue(null);
    for (const body of [{ token: "x" }, {}, undefined, { token: 7 }, { token: ["a"] }]) {
      const res = respuesta();
      await postConsultarBaja(peticion(body), como(res));
      expect([res.statusCode, res.body], JSON.stringify(body)).toEqual([404, { message: ENLACE_NO_VALIDO }]);
    }
    // Whatever is not a string reaches the lookup as an empty one.
    expect(consultarBaja.mock.calls.map((c) => c[0])).toEqual(["x", "", "", "", ""]);
  });
});

describe("POST /api/unsubscribe/", () => {
  it("answers 204 and nothing else", async () => {
    darDeBaja.mockResolvedValue(true);
    const res = respuesta();
    await postDarDeBaja(peticion({ token: "abc" }), como(res));
    expect([res.statusCode, res.terminada, res.body]).toEqual([204, true, undefined]);
    expect(darDeBaja).toHaveBeenCalledWith("abc");
  });

  it("answers 404 for a token nobody holds", async () => {
    darDeBaja.mockResolvedValue(false);
    const res = respuesta();
    await postDarDeBaja(peticion({ token: "x" }), como(res));
    expect([res.statusCode, res.body]).toEqual([404, { message: ENLACE_NO_VALIDO }]);
  });
});

describe("when the database fails", () => {
  it("answers 500 in both, without its words", async () => {
    consultarBaja.mockRejectedValue(new Error('column "baja_token" does not exist'));
    darDeBaja.mockRejectedValue(new Error('column "baja_token" does not exist'));
    for (const handler of [postConsultarBaja, postDarDeBaja]) {
      const res = respuesta();
      await handler(peticion({ token: "abc" }), como(res));
      expect(res.statusCode).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/column|baja_token/);
    }
  });
});
