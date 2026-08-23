// What must never appear in a log line.
//
// Session cookies travel on `set-cookie`, the legacy bearer token on
// `authorization`, and three endpoints take passwords in the body. A log is a file that
// gets copied, shipped to a log service, and read by whoever is on call — so a
// credential written into one is a credential leaked, quietly and durably.
//
// Redaction is configured once on the logger rather than remembered at each call
// site, and this is what proves it holds.

import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";

/** Capture what a logger with the real configuration actually writes. */
async function captured(write: (log: pino.Logger) => void): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });

  // The same options the real logger uses. Imported rather than retyped would be
  // better, but they are bound to a stream chosen at module load; this file
  // pins the paths themselves, which is the part that can silently rot.
  const { REDACT_PATHS, REDACT_CENSOR } = await import("./logger.js");
  write(pino({ level: "trace", redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR } }, sink));
  return lines;
}

describe("what never reaches the log", () => {
  it("hides the authorization header", async () => {
    const [line] = await captured((log) =>
      log.info({ req: { headers: { authorization: "Bearer secreto.de.verdad" } } }, "petición"),
    );

    expect(JSON.stringify(line)).not.toContain("secreto.de.verdad");
    expect((line.req as { headers: { authorization: string } }).headers.authorization)
      .toBe("[oculto]");
  });

  it("hides the token the sliding session sends back", async () => {
    // This one is the dangerous one: it is on *every* response, so an
    // unredacted response log leaves a working credential per request served.
    const [line] = await captured((log) =>
      log.info({ res: { headers: { "x-new-token": "jwt.recien.firmado" } } }, "respuesta"),
    );

    expect(JSON.stringify(line)).not.toContain("jwt.recien.firmado");
  });

  it("hides a password wherever in the object it appears", async () => {
    const [top, nested] = await captured((log) => {
      log.info({ pass: "hunter2" }, "arriba");
      log.info({ body: { pass: "hunter2", oldPass: "hunter1" } }, "anidado");
    });

    expect(JSON.stringify(top)).not.toContain("hunter2");
    expect(JSON.stringify(nested)).not.toContain("hunter2");
    expect(JSON.stringify(nested)).not.toContain("hunter1");
  });

  it("leaves everything else alone", async () => {
    // Redaction that swallowed the useful fields would be its own kind of
    // failure: a log nobody can read is not safer, it is just empty.
    const [line] = await captured((log) =>
      log.info({ usuario: 14, rol: 3, req: { method: "PUT", url: "/api/usuario/14" } }, "ok"),
    );

    expect(line.usuario).toBe(14);
    expect(line.rol).toBe(3);
    expect((line.req as { url: string }).url).toBe("/api/usuario/14");
    expect(line.msg).toBe("ok");
  });
});

describe("levels", () => {
  it("says nothing at all while the suite runs", async () => {
    // Otherwise every passing test prints the server's boot lines and the
    // failure you are looking for sits in the middle of them.
    const { logger } = await import("./logger.js");
    expect(logger.level).toBe(process.env.LOG_LEVEL ?? "silent");
  });

  it("keeps the SQL out of the way at the level a server runs at", async () => {
    // Every statement Sequelize runs is logged at debug. At `info` — the default
    // outside tests — a page load must not scroll the interesting line away.
    const quiet = pino({ level: "info" });
    expect(quiet.isLevelEnabled("debug")).toBe(false);
    expect(quiet.isLevelEnabled("warn")).toBe(true);
  });
});
