// How much room somebody gets to be wrong.
//
// Three budgets that do different jobs: the address bucket stops a flood, the
// account bucket stops a guess, and the pair stops one machine grinding one
// account. The arithmetic of the third is the part that goes wrong quietly —
// an escalation with no ceiling is a button for locking a colleague out.

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";
import app from "../app.js";
import {
  accountBucketKey,
  costsNothing,
  estaBloqueada,
  ipBucketKey,
  loginAccountIpLimiter,
  loginIpLimiter,
  siguienteBloqueo,
} from "./loginLimiters.js";
import { LOCKOUT_AFTER_FAILURES, LOCKOUT_MAX_MINUTES } from "../config/security.js";

describe("estaBloqueada", () => {
  it("is false for an account that has never failed", () => {
    expect(estaBloqueada({ failed_attempts: 0, locked_until: null })).toBe(false);
  });

  it("is false once the wait has passed", () => {
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(estaBloqueada({ failed_attempts: 9, locked_until: ayer })).toBe(false);
  });

  it("is true while the wait is running", () => {
    const luego = new Date(Date.now() + 60_000);
    expect(estaBloqueada({ failed_attempts: 5, locked_until: luego })).toBe(true);
  });
});

describe("siguienteBloqueo", () => {
  it("does not lock before the threshold", () => {
    const r = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 2);
    expect(r.failed_attempts).toBe(LOCKOUT_AFTER_FAILURES - 1);
    expect(r.locked_until).toBeNull();
  });

  it("locks on reaching the threshold", () => {
    const r = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 1);
    expect(r.failed_attempts).toBe(LOCKOUT_AFTER_FAILURES);
    expect(r.locked_until).toBeInstanceOf(Date);
  });

  it("grows the wait with each further failure", () => {
    const primero = siguienteBloqueo(LOCKOUT_AFTER_FAILURES - 1).locked_until!.getTime();
    const despues = siguienteBloqueo(LOCKOUT_AFTER_FAILURES + 1).locked_until!.getTime();
    expect(despues).toBeGreaterThan(primero);
  });

  it("never waits longer than the ceiling", () => {
    // Everybody in a company of sixty knows the boss's username. Without a
    // ceiling, five wrong passwords a day keep that account shut indefinitely.
    const r = siguienteBloqueo(40);
    const minutos = (r.locked_until!.getTime() - Date.now()) / 60_000;
    expect(minutos).toBeLessThanOrEqual(LOCKOUT_MAX_MINUTES + 0.1);
  });
});

/**
 * The buckets themselves, which had no tests at all.
 *
 * Everything above this line covers the two pure functions at the bottom of
 * `loginLimiters.ts`. Nothing touched the buckets, their keys, the rule that a
 * login which works costs nothing, or the chain in `app.ts` — so taking
 * `ipKeyGenerator` out of a key, taking the username out of the per-account
 * key, or setting `skipSuccessfulRequests: false` all left 460 tests green.
 *
 * These read the counter out of each bucket directly, through `getKey`, instead
 * of sending a hundred requests and watching for a 429. Same fact, measured
 * where it lives.
 */

/** A fixed address, so the keys these tests assert on are known in advance. */
const DESDE = "203.0.113.9";
const CLAVE_IP = `ip:${DESDE}`;
const claveCuenta = (user: string) => `ipu:${DESDE}:${user}`;

function fakeReq(ip: string, body?: unknown): Request {
  return { ip, body } as unknown as Request;
}

/**
 * A one-route app around a single bucket, answering whatever the test asks for.
 *
 * `trust proxy` is one hop, the same as `app.ts`, so `req.ip` is the
 * X-Forwarded-For value these tests send. That is what lets the expected key be
 * written out in full above, instead of being whatever the loopback address
 * happens to look like on this machine.
 */
function appAround(limiter: RateLimitRequestHandler, status: number) {
  const bare = express();
  bare.set("trust proxy", 1);
  bare.use(express.json());
  bare.post("/", limiter, (_req, res) => {
    res.status(status).json({});
  });
  return bare;
}

const post = (target: express.Express, body: object) =>
  request(target).post("/").set("X-Forwarded-For", DESDE).send(body);

/**
 * express-rate-limit refunds a skipped request from the response's own `finish`
 * handler, which is asynchronous: by the time supertest has resolved, the
 * refund may still be queued. One turn of the event loop is enough, and without
 * it these assertions read the counter mid-flight and flake.
 */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const hits = async (limiter: RateLimitRequestHandler, key: string) =>
  (await limiter.getKey(key))?.totalHits;

describe("the key a bucket counts against", () => {
  it("names the address for the address bucket, and the account for the other", () => {
    // The prefixes are not what keeps the buckets apart — each has a store of
    // its own — but they say which bucket a key belongs to when it is read back
    // out, and they are what would stop the two merging behind a shared store.
    expect(ipBucketKey(fakeReq(DESDE))).toBe(CLAVE_IP);
    expect(accountBucketKey(fakeReq(DESDE, { user: "isaias" }))).toBe(claveCuenta("isaias"));
  });

  it("folds the username to one case, and trims it", () => {
    // Usernames are unique case-insensitively, so "Isaias" and "isaias" are one
    // account and must share one budget. Without this, capitalising a guess
    // buys a second, fresh bucket against the same target — and then a third.
    for (const typed of ["Isaias", "ISAIAS", " isaias ", "\tIsAiAs\n"]) {
      expect(accountBucketKey(fakeReq(DESDE, { user: typed })), typed).toBe(claveCuenta("isaias"));
    }
  });

  it("does not read a username out of a body that has none", () => {
    // These run before the controller, so they see bodies the controller would
    // refuse: no field, the wrong type, a crafted object.
    for (const body of [undefined, {}, { user: 7 }, { user: { ne: null } }, { user: ["isaias"] }]) {
      expect(accountBucketKey(fakeReq(DESDE, body)), JSON.stringify(body)).toBe(claveCuenta(""));
    }
  });

  it("folds an IPv6 address into its block rather than counting it whole", () => {
    // Without `ipKeyGenerator` one holder of a /56 walks through billions of
    // distinct keys, each with a budget of its own, and the address bucket
    // stops nothing at all.
    const dentro = ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2:ffff:ffff:ffff:ffff"];
    expect(ipBucketKey(fakeReq(dentro[0]))).toBe(ipBucketKey(fakeReq(dentro[1])));
    expect(ipBucketKey(fakeReq("2001:db8:1:100::1"))).not.toBe(
      ipBucketKey(fakeReq("2001:db8:1:200::1")),
    );
    // And it is the block, not the address it was handed.
    expect(ipBucketKey(fakeReq(dentro[0]))).not.toContain(dentro[0]);
  });
});

describe("which answers come out of somebody's budget", () => {
  const conStatus = (statusCode: number) => ({ statusCode }) as Response;

  it("charges nothing for a 2xx or 3xx, and nothing for any 5xx", () => {
    // The 5xx half is the fix. A 503 is the login unable to open a session, on
    // either of its two addresses; a 500 is anything else in the handler
    // failing. Both used to be charged, and the address bucket behind the
    // office's NAT is one key for everybody, so a database outage spent the
    // building's budget and then kept the building out for a quarter of an hour
    // after the database came back.
    for (const status of [200, 201, 204, 302, 399, 500, 502, 503, 504]) {
      expect(costsNothing(fakeReq(DESDE), conStatus(status)), String(status)).toBe(true);
    }
  });

  it("charges every 4xx, the limiter's own 429 included", () => {
    // The half that has to keep charging, and the reason the range stops at
    // 500 rather than exempting anything that is not a 2xx: a 400 is a wrong
    // password, which is the only answer this bucket exists to make expensive.
    // The 429 is the limiter answering that the budget is already spent — the
    // caller's situation, not this server failing — so it stays on the tab,
    // which is also what the library does by default.
    //
    // 399 above and 499 here are the two edges of the range, not statuses this
    // route answers. They are in the lists because an off-by-one on either
    // boundary is the way this predicate would be got wrong.
    for (const status of [400, 401, 403, 404, 422, 429, 499]) {
      expect(costsNothing(fakeReq(DESDE), conStatus(status)), String(status)).toBe(false);
    }
  });
});

describe("what each bucket spends", () => {
  beforeEach(async () => {
    // The buckets are module singletons shared with the real app, so the
    // address key has to start each test empty. The account keys do not: every
    // test below uses a username of its own.
    await loginIpLimiter.resetKey(CLAVE_IP);
  });

  it("charges the address bucket for a login that fails", async () => {
    const bare = appAround(loginIpLimiter, 400);
    await post(bare, { user: "quienquiera" });
    await settled();

    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(1);
  });

  it("charges the address bucket nothing for a login that works", async () => {
    // `skipSuccessfulRequests`. Without it the budget is spent by people
    // getting in, and behind one NAT the whole office shares it — which is how
    // the limiter this replaced put everybody out on day one.
    const bare = appAround(loginIpLimiter, 200);
    await post(bare, { user: "quienquiera" });
    await settled();

    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(0);
  });

  it("charges the address bucket nothing when the server is what failed", async () => {
    // The cascade this closes, measured where it happened. Without the refund
    // this reads 1, and a hundred of them from one office — fifteen people
    // taking the "inténtelo de nuevo en unos minutos" at its word — leave
    // nobody in the building able to log in until the window rolls over, with
    // the ERP already healthy again.
    const bare = appAround(loginIpLimiter, 503);
    await post(bare, { user: "quienquiera" });
    await settled();

    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(0);
  });

  it("charges the account bucket nothing for the same failure", async () => {
    // Both buckets, because the per-account one is the smaller half of the same
    // cascade and the only one the previous round declared: ten of these would
    // keep one person out for a quarter of an hour over an outage they had
    // nothing to do with. 500 here and 503 above so each bucket is measured
    // against a status one of the two doors really answers.
    const bare = appAround(loginAccountIpLimiter, 500);
    await post(bare, { user: "olegario" });
    await settled();

    expect(await hits(loginAccountIpLimiter, claveCuenta("olegario"))).toBe(0);
  });

  it("charges the account bucket under the username, however it was capitalised", async () => {
    // The assertion this bucket exists for. Drop the username from the key and
    // this record does not exist at all; keep it but stop folding case and the
    // two requests land in two separate buckets and this reads 1.
    const bare = appAround(loginAccountIpLimiter, 400);
    await post(bare, { user: "Rebeca" });
    await post(bare, { user: " REBECA " });
    await settled();

    expect(await hits(loginAccountIpLimiter, claveCuenta("rebeca"))).toBe(2);
  });

  it("keeps two accounts from the same address apart", async () => {
    // The other half: were the key the address alone, one person failing to log
    // in would be spending a colleague's budget from the same office.
    const bare = appAround(loginAccountIpLimiter, 400);
    await post(bare, { user: "camila" });
    await post(bare, { user: "teodoro" });
    await settled();

    expect(await hits(loginAccountIpLimiter, claveCuenta("camila"))).toBe(1);
    expect(await hits(loginAccountIpLimiter, claveCuenta("teodoro"))).toBe(1);
  });

  it("charges the account bucket nothing for a login that works", async () => {
    const bare = appAround(loginAccountIpLimiter, 200);
    await post(bare, { user: "marisol" });
    await settled();

    expect(await hits(loginAccountIpLimiter, claveCuenta("marisol"))).toBe(0);
  });
});

describe("the chain the real login endpoint is mounted behind", () => {
  beforeEach(async () => {
    await loginIpLimiter.resetKey(CLAVE_IP);
  });

  it("puts a POST through both buckets", async () => {
    // Both of them, in one request, on the app as `app.ts` assembled it. This
    // was an anonymous arrow written at the mount: dropping either bucket from
    // it changed nothing any test could see.
    //
    // An empty password is refused by `verifyCredentials` before it looks
    // anything up, so this needs no database — and a 400 is a failure, which is
    // what these buckets count.
    await request(app)
      .post("/api/login")
      .set("X-Forwarded-For", DESDE)
      .send({ user: "Nicolasa", pass: "" });
    await settled();

    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(1);
    expect(await hits(loginAccountIpLimiter, claveCuenta("nicolasa"))).toBe(1);
  });

  it("spends nothing on a GET, which is a 404 on this mount and used to be a read", async () => {
    // Written when `GET /api/login` was the JWT verifier the client asked on
    // every page load, and kept now that the address answers 404, because the
    // reason got stronger: an office behind one NAT address shares this budget,
    // and if 404s counted, anyone could empty it with GETs to a URL that does
    // not exist and nobody in the building could log in until the window closed.
    // The status is not asserted — `app.auth.test.ts` owns the 404 — only that
    // whatever this answers costs nothing.
    await request(app).get("/api/login").set("X-Forwarded-For", DESDE);
    await settled();

    expect(await loginIpLimiter.getKey(CLAVE_IP)).toBeUndefined();
  });
});
