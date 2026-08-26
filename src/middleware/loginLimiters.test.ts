// How much room somebody gets to be wrong.
//
// Four budgets that do different jobs: the address bucket stops a flood, the
// account bucket stops one machine grinding one name, the lockout arithmetic
// stops a guess spread across many addresses, and the confirmation bucket stops
// a caller who is already logged in from using "prove it is you" as a password
// oracle. The arithmetic of the third is the part that goes wrong quietly — an
// escalation with no ceiling is a button for locking a colleague out — and the
// fourth is the one whose absence would be invisible, because the endpoint it
// guards charges nothing to the lockout on purpose.

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
  passwordConfirmKey,
  passwordConfirmLimiter,
  siguienteBloqueo,
} from "./loginLimiters.js";
import {
  LOCKOUT_AFTER_FAILURES,
  LOCKOUT_MAX_MINUTES,
  PASSWORD_CONFIRM_LIMIT,
} from "../config/security.js";

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

/**
 * The budget for confirming your own password, which is the only limit those two
 * routes have.
 *
 * Renaming your own account and changing your own password both compare a
 * password and neither moves `failed_attempts`: the account being asked about is
 * the one already logged in, so counting a typo there would let somebody
 * renaming themselves lock themselves out of the ERP. That decision is what
 * makes this bucket load-bearing rather than belt-and-braces — take it away and
 * an authenticated caller may compare passwords as often as the server will
 * answer, which for whoever has stolen a session is an oracle for the password
 * behind it.
 *
 * Its key is the account and not the address, so the two tests worth having are
 * that the id is really what it reads, and that it reads it from `req.user` —
 * where `authenticate` put it — rather than from anything a caller writes.
 */
describe("the key the confirmation bucket counts against", () => {
  /** As `authenticate` leaves it: `req.user` filled in, all four fields. */
  const conSesion = (id: number, body?: unknown) =>
    ({ ip: DESDE, body, user: { id, id_rol: 3, id_sesion: "s", expires_at: new Date() } }) as unknown as Request;

  it("names the account, and keeps two accounts apart", () => {
    expect(passwordConfirmKey(conSesion(7))).toBe("pc:7");
    expect(passwordConfirmKey(conSesion(7))).not.toBe(passwordConfirmKey(conSesion(8)));
  });

  it("ignores an id or a username written in the body", () => {
    // The endpoint takes neither, and the bucket must not start reading one: a
    // key a caller can choose is a fresh budget for every guess.
    const clave = passwordConfirmKey(conSesion(7, { id: 999, user: "otro", pass: "x" }));
    expect(clave).toBe("pc:7");
    expect(clave).not.toContain("999");
    expect(clave).not.toContain("otro");
  });

  it("does not put every caller in one bucket when there is no session", () => {
    // Unreachable through either mount, where `authenticate` answers 401 first.
    // What it guards is somebody mounting this limiter without authentication
    // in front of it: the fallback is address-shaped, so the endpoint degrades
    // to one budget per network instead of one budget for the whole world —
    // which is what a key generator returning a constant would give.
    const sinSesion = ({ ip: DESDE, body: {} }) as unknown as Request;
    const otraRed = ({ ip: "198.51.100.4", body: {} }) as unknown as Request;
    expect(passwordConfirmKey(sinSesion)).not.toBe(passwordConfirmKey(otraRed));
    expect(passwordConfirmKey(sinSesion)).toContain(DESDE);
    // And it folds IPv6 into its block, like the two buckets above: without
    // that, one holder of a /56 has billions of budgets.
    const v6 = (ip: string) => ({ ip, body: {} }) as unknown as Request;
    expect(passwordConfirmKey(v6("2001:db8:1:2:3:4:5:6"))).toBe(
      passwordConfirmKey(v6("2001:db8:1:2:ffff:ffff:ffff:ffff")),
    );
  });
});

/**
 * What the confirmation bucket spends, and the rule is `confirmCostsNothing`:
 * only a 401 costs.
 *
 * **This describe used to assert the opposite**, and the reason it changed is
 * worth keeping rather than quietly replacing. It held two tests saying every
 * answer costs the same, and the argument for them was real: `POST
 * /api/auth/confirm-password` answered a wrong password with **200** and
 * `{ correcta: false }`, on purpose, so that no client could mistake "wrong
 * password" for "server broken". With the two answers deliberately wearing the
 * same status, a refund rule that read the status would have handed back exactly
 * the attempts the bucket exists to charge for — and worse, since
 * `standardHeaders` is on, `RateLimit-Remaining` would have told a guesser which
 * attempt was the right one through the very uniformity that was hiding it.
 *
 * That endpoint is retired. The two routes left on this bucket —
 * `PUT /usuario/username/:id` and `PUT /usuario/userpass/:id` — answer a wrong
 * current password with **401 and nothing else**, and answer everything else
 * with something that is not a 401. So the status already tells the caller what
 * the header could, there is no uniformity left to leak through, and charging
 * every request stopped buying anything. What it cost instead was the case the
 * audit bet the deploy on: the *legitimate* work of changing your own password —
 * told the new one needs twelve characters, trying again a character longer —
 * spending the budget until the sixth attempt answered "Espere unos minutos" and
 * closed the rename too.
 *
 * The tests below therefore pin both halves: the 401 still costs, and nothing
 * else does. `app.auth.test.ts` holds the same rule through the real routes.
 */
describe("what the confirmation bucket spends", () => {
  const CLAVE_CUENTA = "pc:41";
  const conSesion = { id: 41, id_rol: 3, id_sesion: "s", expires_at: new Date() };

  /**
   * A one-route app that carries a `req.user` the way `authenticate` would, so
   * the limiter sees what it sees on the real mount.
   */
  function appConSesion(status: number, body: unknown) {
    const bare = express();
    bare.set("trust proxy", 1);
    bare.use(express.json());
    bare.post("/", (req, _res, next) => {
      req.user = conSesion;
      next();
    }, passwordConfirmLimiter, (_req, res) => {
      res.status(status).json(body);
    });
    return bare;
  }

  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(CLAVE_CUENTA);
  });

  it("charges a 401, which is the one answer that says the password was not theirs", async () => {
    // The half that keeps this a budget. Take it away and an authenticated
    // caller may compare passwords as often as the server will answer, which for
    // whoever has stolen a session is an oracle for the password behind it — and
    // neither route moves `failed_attempts`, so there is no second limit to fall
    // back on.
    const bare = appConSesion(401, { message: "La contraseña actual suministrada no es correcta." });
    await post(bare, {});
    await settled();

    expect(await hits(passwordConfirmLimiter, CLAVE_CUENTA)).toBe(1);
  });

  it("refunds a 200, so a rename or a password change that went through costs nothing", async () => {
    const bare = appConSesion(200, { id: 41, user: "isalas" });
    await post(bare, {});
    await settled();

    // `0` and not `undefined`: the request really was counted and really was
    // given back, which is what tells a refund apart from a limiter that was
    // never on the route.
    expect(await hits(passwordConfirmLimiter, CLAVE_CUENTA)).toBe(0);
  });

  it("refunds a 400, which is what a new password that fails the policy gets", async () => {
    // The case that made the old rule hurt, and the one the audit bet the deploy
    // on. Reaching this answer means the current password was already accepted,
    // so the request cannot be a guess at it: whoever produced it knows the
    // secret. Also the answer a frontend bundle from before this arc gets for
    // every rename it sends, since it carries no current-password field at all.
    const bare = appConSesion(400, { message: "La contraseña debe tener al menos 12 caracteres." });
    await post(bare, {});
    await settled();

    expect(await hits(passwordConfirmLimiter, CLAVE_CUENTA)).toBe(0);
  });

  it("refunds a 500, because an outage is nobody's failed attempt", async () => {
    // The same line `costsNothing` draws for the login buckets, and for the same
    // reason: a 4xx is the caller being wrong, a 5xx is this server being wrong.
    // A database that drops the row read behind these routes must not spend the
    // budget of everybody who tried to use them while it was down.
    const bare = appConSesion(500, { message: "Ocurrió un error al procesar la petición." });
    await post(bare, {});
    await settled();

    expect(await hits(passwordConfirmLimiter, CLAVE_CUENTA)).toBe(0);
  });

  it("stops answering after PASSWORD_CONFIRM_LIMIT wrong passwords", async () => {
    const bare = appConSesion(401, { message: "La contraseña actual suministrada no es correcta." });
    for (let i = 0; i < PASSWORD_CONFIRM_LIMIT; i++) {
      const res = await post(bare, {});
      await settled();
      expect(res.status, `intento ${i + 1}`).toBe(401);
    }

    const cortado = await post(bare, {});
    expect(cortado.status).toBe(429);
    // The refusal says to wait, and stops being an answer about the password —
    // which is the property that makes a budget a budget rather than a slower
    // oracle.
    expect(cortado.body.message).toMatch(/Espere/);
    expect(cortado.body.message).not.toMatch(/contraseña actual/i);
  });

  it("does not let a refunded 429 hand the caller straight back in", async () => {
    /**
     * The edge the refund rule creates, measured rather than assumed. A 429 is
     * not a 401, so it is refunded too — the counter falls back to the limit
     * instead of climbing past it. What has to stay true is that falling back to
     * the limit is not the same as falling below it: the window still has to
     * expire.
     *
     * Without this, a rule that decremented one step too far would turn the
     * budget into "one attempt every round trip, forever", which is not a limit
     * at all.
     */
    const bare = appConSesion(401, { message: "La contraseña actual suministrada no es correcta." });
    for (let i = 0; i < PASSWORD_CONFIRM_LIMIT; i++) {
      await post(bare, {});
      await settled();
    }

    for (const intento of [1, 2, 3]) {
      const res = await post(bare, {});
      await settled();
      expect(res.status, `tras el corte, intento ${intento}`).toBe(429);
    }
  });
});

/**
 * The one thing `requireStepUp` needed from this bucket that neither route
 * above had a use for: a way to charge a wrong password that does not answer
 * 401.
 *
 * `requireStepUp` (`middleware/requireStepUp.ts`) shares this exact limiter —
 * same store, same `pc:<id>` key — for its own password fallback, but every
 * refusal it makes is uniformly `403 { code: CODIGO_STEP_UP }`, on purpose, so
 * the frontend reacts to a stale window, a missing factor and a wrong password
 * the same way. `confirmCostsNothing`'s original rule ("only a 401 costs")
 * would have refunded every one of those wrong guesses, leaving the gate with
 * no real budget behind it — see the comment on `res.locals.stepUpPasswordWrong`
 * in `confirmCostsNothing` itself for the fix. These two tests are what pin
 * that fix in place, through the real limiter, the way the rest of this
 * describe block pins the 401 rule.
 */
describe("the flag a caller sets when its own answer cannot be a 401", () => {
  const CLAVE_CUENTA = "pc:42";
  const conSesion = { id: 42, id_rol: 3, id_sesion: "s", expires_at: new Date() };

  /** Same shape as `appConSesion` above, except the route answers 403 and
   *  optionally marks that 403 as a wrong password before sending it — which
   *  is exactly what `requireStepUp` does right before calling `denegar`. */
  function appConBandera(marca: boolean) {
    const bare = express();
    bare.set("trust proxy", 1);
    bare.use(express.json());
    bare.post(
      "/",
      (req, _res, next) => {
        req.user = conSesion;
        next();
      },
      passwordConfirmLimiter,
      (_req, res) => {
        if (marca) res.locals.stepUpPasswordWrong = true;
        res.status(403).json({ message: "Esta operación necesita que confirmes tu identidad.", code: "STEP_UP_REQUIRED" });
      },
    );
    return bare;
  }

  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(CLAVE_CUENTA);
  });

  it("charges a 403 marked as a wrong password, exactly like it would charge a 401", async () => {
    const bare = appConBandera(true);
    await post(bare, {});
    await settled();

    expect(await hits(passwordConfirmLimiter, CLAVE_CUENTA)).toBe(1);
  });

  it("still refunds an ordinary 403 that carries no such flag", async () => {
    // The regression this guards against: the original rule — only a 401
    // costs — has to keep holding for every caller that never sets the flag,
    // which is both routes this bucket guarded before requireStepUp existed.
    const bare = appConBandera(false);
    await post(bare, {});
    await settled();

    expect(await hits(passwordConfirmLimiter, CLAVE_CUENTA)).toBe(0);
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
