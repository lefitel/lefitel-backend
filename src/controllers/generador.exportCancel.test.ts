// Cancelling an export has to reach the builder.
//
// The handler listened for `close` on the *request*. Since Node 16 that event
// fires once the body has been read — about a millisecond in — and the listener
// here is attached later, after `authenticate`, the permission gate and
// `viewerOf`. So it never fired: the browser dropped the request, the server
// went on building a file for nobody, and the single export slot of the whole
// process stayed taken. Measured on Node 24: aborting the client fires `close`
// on the response and nothing on the request.
//
// The request and response below are real emitters for that reason: a fake
// `on` that calls back whatever it is handed would pass with either object.

import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

vi.mock("../models/reporteVista.model.js", () => ({ ReporteVistaModel: {} }));
vi.mock("../models/usuario.model.js", () => ({ UsuarioModel: {}, USUARIO_AS_AUTHOR: ["id", "name", "lastname"] }));
vi.mock("../utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("../reportBuilder/execute.js", () => ({ runReport: vi.fn(), countReport: vi.fn() }));
vi.mock("../reportBuilder/fieldOptions.js", () => ({ loadOptionLists: vi.fn() }));
vi.mock("../permissions/store.js", () => ({ can: async () => true }));

/** The signal the builder was handed, and the promise it is still waiting on. */
let signal: AbortSignal | undefined;
let finish: (output: unknown) => void = () => {};
vi.mock("../reportBuilder/export/index.js", async (original) => ({
  ...(await original<typeof import("../reportBuilder/export/index.js")>()),
  buildExport: (options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  },
}));

const { postExportar } = await import("./generador.controller.js");

function exchange() {
  const req = Object.assign(new EventEmitter(), {
    user: { id: 7, id_rol: 1 },
    body: { config: { root: "evento", columns: [{ path: "id" }] }, format: "excel" },
  });
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  });
  return { req: req as unknown as Request, res: res as unknown as Response & EventEmitter };
}

const OUTPUT = { buffer: Buffer.from("x"), contentType: "application/x", filename: "r.xlsx", rows: 1, photos: 0 };

describe("postExportar — cancelling", () => {
  it("aborts the build when the connection closes before the answer was written", async () => {
    const { req, res } = exchange();
    const pending = postExportar(req, res);
    await vi.waitFor(() => expect(signal).toBeDefined());

    res.emit("close");

    const aborted = signal?.aborted;
    finish(OUTPUT);
    await pending;
    expect(aborted).toBe(true);
  });

  it("aborts when the connection was already gone before anything listened", async () => {
    // `close` fires once. A client that hung up while the viewer was still
    // being resolved has had theirs, and a listener attached afterwards waits
    // for an event that is not coming.
    signal = undefined;
    const { req, res } = exchange();
    (res as unknown as { destroyed: boolean }).destroyed = true;
    const pending = postExportar(req, res);
    await vi.waitFor(() => expect(signal).toBeDefined());

    // Read, then let the build finish, then judge: a failed expectation ahead
    // of `finish` leaves the one export slot taken and fails the next test too.
    const aborted = signal?.aborted;
    finish(OUTPUT);
    await pending;
    expect(aborted).toBe(true);
  });

  it("does not abort on the close that follows a finished answer", async () => {
    signal = undefined;
    const { req, res } = exchange();
    const pending = postExportar(req, res);
    await vi.waitFor(() => expect(signal).toBeDefined());

    finish(OUTPUT);
    await pending;
    (res as unknown as { writableFinished: boolean }).writableFinished = true;
    res.emit("close");

    expect(signal?.aborted).toBe(false);
  });
});
