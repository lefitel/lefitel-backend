// `makeHandler` is infrastructure two controllers now share, so its own
// behaviour gets its own test file rather than being pinned only through
// whichever controller happens to exercise it — a change here that broke,
// say, the 500 fallback would otherwise only be caught by whichever of
// `auth.controller.test.ts` or `email.controller.test.ts` happens to cover
// that branch, and neither file exists to prove this module's contract.

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import {
  ValidationError,
  ValidationErrorItem,
  UniqueConstraintError,
  ForeignKeyConstraintError,
  DatabaseError,
} from "sequelize";
import { makeHandler } from "./handler.js";

function fakeLog() {
  return { error: vi.fn(), warn: vi.fn() };
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

/**
 * The failures the caller caused, which used to arrive as "Ocurrió un error".
 *
 * Built from Sequelize's own error classes rather than hand-shaped objects.
 * `handler.ts` recognises them by `err.name`, which is a string this module
 * does not own: if a Sequelize upgrade renames `SequelizeValidationError`, a
 * fake would keep passing and the product would silently go back to answering
 * 500 for a missing field. Constructing the real thing is what makes this test
 * able to notice. The four names were measured against the installed version
 * before this was written.
 */
describe("makeHandler, on a failure the caller caused", () => {
  const lanza = async (error: unknown) => {
    const log = fakeLog();
    const wrapped = makeHandler(log)("createSomething", async () => {
      throw error;
    });
    const { req, res, raw } = fakeReqRes();
    await wrapped(req, res);
    return { raw, log };
  };

  const validacion = (...items: ValidationErrorItem[]) => new ValidationError("Validation error", items);

  /**
   * One failing column, with the eight arguments the typings require.
   *
   * The cast on `type` is the one thing here that is not literal. Sequelize's
   * declaration enumerates its enum **keys** — `'notnull violation'`,
   * `'validation error'`, lowercase — while the value its own validator writes
   * at runtime is `'notNull Violation'`. Measured against the installed
   * version before this was written, and it is the runtime string
   * `handler.ts` matches on, so the runtime string is what goes here.
   */
  const item = (mensaje: string, tipo: "notNull Violation" | "Validation error", path: string, valor: string) =>
    new ValidationErrorItem(mensaje, tipo as never, path, valor, undefined as never, "", "", []);

  it("names the fields that are missing, so the person can fix the form", async () => {
    const { raw } = await lanza(
      validacion(
        item("ciudad.lat cannot be null", "notNull Violation", "lat", ""),
        item("ciudad.lng cannot be null", "notNull Violation", "lng", ""),
      ),
    );

    expect(raw.statusCode).toBe(400);
    expect(raw.body).toEqual({ message: "Faltan datos obligatorios: lat, lng." });
  });

  it("names the field whose value is out of range", async () => {
    // The measured case: `POST /api/obs` with a criticality of 12. `obs.model.ts`
    // is the only model in the repo with a `validate:` block, and before this
    // the answer was 500.
    const { raw } = await lanza(
      validacion(item("Validation max on criticality failed", "Validation error", "criticality", "12")),
    );

    expect(raw.statusCode).toBe(400);
    expect(raw.body).toEqual({ message: "Alguno de los datos no es válido: criticality." });
  });

  it("says both things when both happened, in one sentence each", async () => {
    const { raw } = await lanza(
      validacion(
        item("id_tipoObs cannot be null", "notNull Violation", "id_tipoObs", ""),
        item("Validation max on criticality failed", "Validation error", "criticality", "12"),
      ),
    );

    expect(raw.body).toEqual({
      message: "Faltan datos obligatorios: id_tipoObs. Alguno de los datos no es válido: criticality.",
    });
  });

  it("never repeats a field, however many rules it broke", async () => {
    const { raw } = await lanza(
      validacion(
        item("too short", "Validation error", "name", "a"),
        item("not a letter", "Validation error", "name", "a"),
      ),
    );

    expect(raw.body).toEqual({ message: "Alguno de los datos no es válido: name." });
  });

  it("keeps the 400 and loses only the detail when the exception names no field", async () => {
    // A `ValidationError` with nothing readable in it is still the caller's
    // fault. Falling back to 500 here would put the old defect back for a
    // shape nobody predicted, which is the shape it will come in.
    const { raw } = await lanza(new ValidationError("Validation error", []));

    expect(raw.statusCode).toBe(400);
    expect(raw.body).toEqual({ message: "Alguno de los datos enviados no es válido." });
  });

  it("never lets the value that failed validation reach the browser", async () => {
    // `logger.ts` redacts `err.errors[*].value` because a password too short to
    // pass the length rule is still the password. The same value is one
    // property away from the answer, and this is what keeps it out.
    const { raw } = await lanza(
      validacion(item("too short", "Validation error", "pass", "hunter2-de-verdad")),
    );

    expect(JSON.stringify(raw.body)).not.toContain("hunter2");
  });

  it("never repeats what Postgres said, whatever the status", async () => {
    // `errorShape.test.ts` is the guard that stops the text of an exception
    // reaching the browser, and it cannot see this code: it scans
    // `src/controllers/*.controller.ts` and judges only 500 answers, while this
    // classifier lives in `src/utils/` and answers 400 and 409. So the same
    // rule is asserted here, from the other side — behaviour rather than
    // source — for each of the three shapes that carry driver text.
    const casos = [
      validacion(item("Validation max on criticality failed", "Validation error", "criticality", "12")),
      new DatabaseError(Object.assign(
        new Error('value too long for type character varying(255)'),
        { code: "22001", sql: 'INSERT INTO "adss" ("name") VALUES ($1)' },
      )),
      new UniqueConstraintError({ fields: { user: "isaias" } }),
    ];

    for (const caso of casos) {
      const { raw } = await lanza(caso);
      const dicho = JSON.stringify(raw.body);
      expect(dicho, `${(caso as Error).name} dejó pasar el texto del driver`).not.toContain("Validation max");
      expect(dicho).not.toContain("character varying");
      expect(dicho).not.toContain("INSERT INTO");
      expect(dicho).not.toContain("isaias");
    }
  });

  it("dice que la relación no existe, sin nombrarla", async () => {
    // The shape the pg driver really produces: `dialects/postgres/query.js`
    // builds every 23503 with `fields: null` hard-coded, whatever the
    // constraint was. An earlier version of this test hand-built
    // `{ fields: ["id_tipoObs"] }` and asserted the column by name — green over
    // a branch production could never reach, and a shape the typings do not
    // even allow. The generic sentence is the whole of the contract.
    const { raw } = await lanza(new ForeignKeyConstraintError({ fields: {}, table: "eventos", index: "eventos_id_poste_fkey" }));

    expect(raw.statusCode).toBe(400);
    expect(raw.body).toEqual({ message: "Uno de los datos relacionados no existe." });
  });

  it("answers 409 for a clash and refuses to say what clashed", async () => {
    // Deliberate, and the one place the rule inverts. `UniqueConstraintError`
    // carries `fields` as `{ column: value }` — the value included — and
    // naming even the column turns any create into a way of asking whether an
    // address or a username already has an account. A controller that needs to
    // be specific says so itself, with its own sentence (`usuario.controller.ts`
    // for the username); this is only the floor under it.
    const { raw } = await lanza(new UniqueConstraintError({ fields: { user: "pepe" } }));

    expect(raw.statusCode).toBe(409);
    expect(raw.body).toEqual({ message: "Ya existe un registro con esos datos." });
    expect(JSON.stringify(raw.body)).not.toContain("pepe");
    expect(JSON.stringify(raw.body)).not.toContain("user");
  });

  it("answers 400 for a value the column cannot hold", async () => {
    const parent = Object.assign(new Error("value too long for type character varying(255)"), { code: "22001", sql: "" });
    const { raw } = await lanza(new DatabaseError(parent));

    expect(raw.statusCode).toBe(400);
    expect(raw.body).toEqual({ message: "Alguno de los valores no tiene el formato correcto." });
  });

  it("leaves every other database failure as the 500 it was", async () => {
    // SQLSTATE 40001 is a serialization failure: the server's problem, not the
    // caller's. Only class 22 crosses over, and this is the anti-vacuity side
    // of the test above — a classifier that answered 400 for everything would
    // pass every assertion before this one.
    const parent = Object.assign(new Error("could not serialize access"), { code: "40001", sql: "" });
    const { raw, log } = await lanza(new DatabaseError(parent));

    expect(raw.statusCode).toBe(500);
    expect(raw.body).toEqual({ message: "Ocurrió un error al procesar la petición." });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("leaves an ordinary exception as the 500 it was", async () => {
    const { raw, log } = await lanza(new Error("caída inesperada"));

    expect(raw.statusCode).toBe(500);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("files the caller's mistake under warn, so the error log keeps meaning something", async () => {
    const { log } = await lanza(
      validacion(item("lat cannot be null", "notNull Violation", "lat", "")),
    );

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("says nothing at all once the answer has left", async () => {
    const log = fakeLog();
    const wrapped = makeHandler(log)("createSomething", async () => {
      throw validacion(item("lat cannot be null", "notNull Violation", "lat", ""));
    });
    const { req, res, raw } = fakeReqRes({ headersSent: true });

    await wrapped(req, res);

    expect(raw.statusCode).toBe(0);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
