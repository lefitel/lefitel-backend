// `makeHandler` is infrastructure two controllers now share, so its own
// behaviour gets its own test file rather than being pinned only through
// whichever controller happens to exercise it — a change here that broke,
// say, the 500 fallback would otherwise only be caught by whichever of
// `auth.controller.test.ts` or `email.controller.test.ts` happens to cover
// that branch, and neither file exists to prove this module's contract.

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { makeHandler } from "./handler.js";

function fakeLog() {
  return { error: vi.fn() };
}

function fakeReqRes(overrides: { headersSent?: boolean } = {}) {
  const res = {
    headersSent: overrides.headersSent ?? false,
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return {
    req: { originalUrl: "/api/x/y" } as unknown as Request,
    res: res as unknown as Response,
    raw: res,
  };
}

describe("makeHandler", () => {
  it("runs the wrapped function and touches nothing else on success", async () => {
    const log = fakeLog();
    const handler = makeHandler(log);
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = handler("someHandler", fn);
    const { req, res } = fakeReqRes();

    await wrapped(req, res);

    expect(fn).toHaveBeenCalledWith(req, res);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("answers 500 with the generic message when the wrapped function rejects", async () => {
    const log = fakeLog();
    const handler = makeHandler(log);
    const wrapped = handler("someHandler", async () => {
      throw new Error("caída inesperada");
    });
    const { req, res, raw } = fakeReqRes();

    await wrapped(req, res);

    expect(raw.statusCode).toBe(500);
    expect((raw.body as { message: string }).message).toBe("Ocurrió un error al procesar la petición.");
    // The real failure never reaches the client — only the generic sentence
    // does, per Global Constraint #10.
    expect(JSON.stringify(raw.body)).not.toContain("caída inesperada");
  });

  it("logs the failure against the caller's own logger, with the handler's name and the request's URL", async () => {
    const log = fakeLog();
    const handler = makeHandler(log);
    const failure = new Error("boom");
    const wrapped = handler("verifyEmail", async () => {
      throw failure;
    });
    const { req, res } = fakeReqRes();

    await wrapped(req, res);

    expect(log.error).toHaveBeenCalledWith(
      { err: failure, ruta: "/api/x/y" },
      "fallo en verifyEmail",
    );
  });

  it("does not answer twice when the response has already been sent", async () => {
    // A handler that started streaming a response and then threw partway
    // through must not have this wrapper try to call `res.status` on top of
    // headers already on the wire.
    const log = fakeLog();
    const handler = makeHandler(log);
    const wrapped = handler("someHandler", async () => {
      throw new Error("después de responder");
    });
    const { req, res, raw } = fakeReqRes({ headersSent: true });

    await wrapped(req, res);

    expect(raw.statusCode).toBe(0);
    expect(raw.body).toBeUndefined();
    // The failure is still logged — headersSent only changes what is safe to
    // send back, not whether the failure is worth knowing about.
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("preserves the given name on the wrapped function, for routeGuards.test.ts", async () => {
    const handler = makeHandler(fakeLog());
    const wrapped = handler("sendVerificationEmail", async () => undefined);

    expect(wrapped.name).toBe("sendVerificationEmail");
  });

  it("gives two handlers built from the same factory independent identities", async () => {
    const handler = makeHandler(fakeLog());
    const a = handler("a", async () => undefined);
    const b = handler("b", async () => undefined);

    expect(a.name).toBe("a");
    expect(b.name).toBe("b");
    expect(a).not.toBe(b);
  });

  it("keeps two controllers' loggers separate — one file's failure never reaches the other's log", async () => {
    const authLog = fakeLog();
    const emailLog = fakeLog();
    const authHandler = makeHandler(authLog);
    const emailHandler = makeHandler(emailLog);

    const wrapped = emailHandler("verifyEmail", async () => {
      throw new Error("solo de email.controller.ts");
    });
    const { req, res } = fakeReqRes();
    await wrapped(req, res);

    expect(emailLog.error).toHaveBeenCalledOnce();
    expect(authLog.error).not.toHaveBeenCalled();
    // `authHandler` built but unused above only to prove the two factories
    // are independent closures, not a shared module-level logger.
    expect(authHandler).toBeTypeOf("function");
  });
});
