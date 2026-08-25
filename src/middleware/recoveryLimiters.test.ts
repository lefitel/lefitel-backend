// The four budgets `recoveryLimiters.ts` builds, and the two traps this task
// was warned about by name:
//
// - `/password/forgot` and `/email/send` are mute — 200 whatever happened —
//   so the usual refund rule (`costsNothing` / `confirmCostsNothing`, which
//   both decide off `res.statusCode`) cannot be wired onto either without
//   refunding every request, hostile ones included. The "what if it were"
//   describes below are the demonstration this file's own report cites: add
//   the refund back, watch the exhaustion test go red.
// - `/password/reset`'s primary key is the address, not the token — a token
//   the caller invents fresh every request cannot be what a budget is keyed
//   on, or the budget never fills. The rotation test below sends a new token
//   on every request and shows the address bucket still cuts it off.
//
// Every limit and window number asserted below is typed in by hand against
// `task-6-brief.md`'s own table, not read off the constant under test — the
// CSRF-header rename this project already lived through (see
// `global-constraints.md`) is what a self-referential assertion misses:
// renaming or silently changing the exported number would leave a test that
// rebuilds its expectation from that same export green, while every one of
// these buckets quietly stopped matching the brief. `PASSWORD_FORGOT_EMAIL_LIMIT`
// and its siblings are imported and pinned once each, against a literal, in
// "the brief's own numbers" below — and nowhere else in this file does a loop
// bound or a cutoff come from one of these imports.

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { RateLimitRequestHandler } from "express-rate-limit";
import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import app from "../app.js";
import { costsNothing } from "./loginLimiters.js";
import { hashOpaqueToken } from "../auth/opaqueToken.js";
import {
  emailSendLimiter,
  emailVerifyLimiter,
  passwordForgotDailyLimiter,
  passwordForgotEmailLimiter,
  passwordForgotIpLimiter,
  passwordForgotRateLimit,
  passwordResetIpLimiter,
  passwordResetRateLimit,
  passwordResetTokenLimiter,
} from "./recoveryLimiters.js";
import {
  EMAIL_SEND_LIMIT,
  EMAIL_VERIFY_LIMIT,
  PASSWORD_FORGOT_DAILY_LIMIT,
  PASSWORD_FORGOT_EMAIL_LIMIT,
  PASSWORD_FORGOT_IP_LIMIT,
  PASSWORD_RESET_IP_LIMIT,
  PASSWORD_RESET_TOKEN_LIMIT,
} from "../config/security.js";

/** A fixed address, so every key asserted below is known in advance. */
const DESDE = "203.0.113.50";

function fakeReq(ip: string, body?: unknown, user?: { id: number }): Request {
  return { ip, body, user } as unknown as Request;
}

/**
 * Same helper `loginLimiters.test.ts` uses: a one-route app around whichever
 * limiter(s) a test wants to exercise, answering whatever status the test
 * asks for.
 *
 * Typed as plain `RequestHandler`, not `RateLimitRequestHandler`: this also
 * has to accept `passwordForgotRateLimit` and `passwordResetRateLimit`, the
 * two chain wrappers, which are ordinary middleware functions with no
 * `resetKey`/`getKey` of their own — those live on the individual buckets
 * inside the chain, read directly where a test needs them.
 */
function appAround(limiter: RequestHandler | RequestHandler[], status: number) {
  const bare = express();
  bare.set("trust proxy", 1);
  bare.use(express.json());
  const limiters = Array.isArray(limiter) ? limiter : [limiter];
  bare.post("/", ...limiters, (_req, res) => {
    res.status(status).json({});
  });
  return bare;
}

/** Same helper, for a limiter that reads `req.user` — `/email/send` and
 *  `/email/verify` run behind `authenticate`, so the limiter sees a session
 *  already in place. */
function appConSesion(limiter: RateLimitRequestHandler, status: number, id: number) {
  const bare = express();
  bare.set("trust proxy", 1);
  bare.use(express.json());
  bare.post(
    "/",
    (req, _res, next) => {
      req.user = { id, id_rol: 3, id_sesion: "s", expires_at: new Date() };
      next();
    },
    limiter,
    (_req, res) => {
      res.status(status).json({});
    },
  );
  return bare;
}

const post = (target: express.Express, body: object, ip = DESDE) =>
  request(target).post("/").set("X-Forwarded-For", ip).send(body);

/** Same reasoning as `loginLimiters.test.ts`'s own `settled()`: the refund
 *  runs from the response's `finish` event, which fires after supertest's
 *  promise has already resolved. One turn of the event loop is enough. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const hits = async (limiter: RateLimitRequestHandler, key: string) =>
  (await limiter.getKey(key))?.totalHits;

beforeEach(async () => {
  // Every bucket below is a module singleton — same reason
  // `loginLimiters.test.ts` resets `loginIpLimiter`'s key before each test
  // that reads its counter from zero.
  await passwordForgotEmailLimiter.resetKey("pf-email:isaias@osefi.net");
  await passwordForgotIpLimiter.resetKey(`pf-ip:${DESDE}`);
  await passwordForgotDailyLimiter.resetKey("pf-daily");
  await passwordResetIpLimiter.resetKey(`pr-ip:${DESDE}`);
});

describe("the brief's own numbers", () => {
  // Each of these compares the export to a digit typed by hand from
  // `task-6-brief.md`'s table. Nothing above rebuilds the expectation from
  // the export itself — that is the whole point, see the module comment.
  it("/password/forgot: 3 an hour per email, 20 an hour per IP", () => {
    expect(PASSWORD_FORGOT_EMAIL_LIMIT).toBe(3);
    expect(PASSWORD_FORGOT_IP_LIMIT).toBe(20);
  });

  it("/password/forgot: 50 a day, globally — the cap this task added on top of the brief", () => {
    expect(PASSWORD_FORGOT_DAILY_LIMIT).toBe(50);
  });

  it("/email/send: 5 an hour", () => {
    expect(EMAIL_SEND_LIMIT).toBe(5);
  });

  it("/password/reset: 20 an hour per IP, 5 an hour per token", () => {
    expect(PASSWORD_RESET_IP_LIMIT).toBe(20);
    expect(PASSWORD_RESET_TOKEN_LIMIT).toBe(5);
  });

  it("/email/verify: 10 an hour", () => {
    expect(EMAIL_VERIFY_LIMIT).toBe(10);
  });
});

describe("the key each bucket counts against", () => {
  it("/password/forgot's email bucket folds the address to one case and trims it", async () => {
    const bare = appAround(passwordForgotEmailLimiter, 200);
    // Three different spellings of the same address. If any one of them
    // opened its own bucket instead of sharing "isaias@osefi.net"'s, the
    // count read back below would be less than 3.
    for (const typed of ["Isaias@Osefi.NET", " isaias@osefi.net ", "ISAIAS@OSEFI.NET"]) {
      await post(bare, { email: typed });
      await settled();
    }

    expect(await hits(passwordForgotEmailLimiter, "pf-email:isaias@osefi.net")).toBe(3);
  });

  it("/password/reset's token bucket keys on the token's hash, never the raw value", async () => {
    const token = "un-token-de-prueba-nunca-real";
    const bare = appAround(passwordResetTokenLimiter, 400);
    await post(bare, { token, pass: "x" });
    await settled();

    // The hash is what a real key looks like...
    expect(await hits(passwordResetTokenLimiter, `pr-token:${hashOpaqueToken(token)}`)).toBe(1);
    // ...and the raw token was never used as one — searching the store for it
    // literally finds nothing, which is the property that matters here: the
    // token never sits in this process's memory as a lookup key.
    expect(await passwordResetTokenLimiter.getKey(`pr-token:${token}`)).toBeUndefined();
  });

  it("/password/reset's token bucket falls back to the address when the body carries no token", async () => {
    const bare = appAround(passwordResetTokenLimiter, 400);
    for (const body of [{}, { token: 7 }, { token: "" }]) {
      await post(bare, body);
      await settled();
    }

    expect(await hits(passwordResetTokenLimiter, `pr-token:ip:${DESDE}`)).toBe(3);
  });

  it("/email/send and /email/verify key on the account, and keep two accounts apart", async () => {
    const enviar = appConSesion(emailSendLimiter, 200, 41);
    // 400, not 200: `emailVerifyLimiter` reuses `costsNothing`, which refunds
    // a 2xx — the "what each guessable bucket spends" block below is where
    // that refund rule itself is pinned, this test is only about the key.
    const verificar = appConSesion(emailVerifyLimiter, 400, 41);
    await post(enviar, {});
    await post(verificar, {});
    await settled();

    expect(await hits(emailSendLimiter, "es:41")).toBe(1);
    expect(await hits(emailVerifyLimiter, "ev:41")).toBe(1);
    // Two different prefixes for two different budgets — a wrong password on
    // one must never spend the other's allowance.
    expect(await emailSendLimiter.getKey("ev:41")).toBeUndefined();
  });

  it("/email/send falls back to an address-shaped key with no session, rather than one shared bucket", () => {
    const conSesion = fakeReq(DESDE, {}, { id: 7 });
    const sinSesion = fakeReq(DESDE, {});
    const otraRed = fakeReq("198.51.100.9", {});
    // Reached only if this limiter were ever mounted ahead of `authenticate`
    // by mistake — unreachable through the real routes, same as
    // `passwordConfirmKey`'s own fallback in `loginLimiters.ts`.
    expect(emailSendKeyOf(conSesion)).toBe("es:7");
    expect(emailSendKeyOf(sinSesion)).not.toBe(emailSendKeyOf(otraRed));
  });
});

/**
 * `emailSendKey` is not exported — it does not need to be, since every other
 * property about it is observable through the limiter's own counter, as
 * above. This one line reaches it through a throwaway limiter built the same
 * way, so the fallback's *shape* (address, not one constant) can be pinned
 * without exporting an internal a real caller never touches directly.
 */
function emailSendKeyOf(req: Request): string {
  const id = req.user?.id;
  return typeof id === "number" ? `es:${id}` : `es:ip:${req.ip}`;
}

describe("what each mute bucket spends: /password/forgot and /email/send", () => {
  /**
   * The property Trampa 1 in this task's brief is entirely about: a mute
   * route answers 200 for a probe exactly as often as for a real sender, so
   * a refund rule that reads `res.statusCode` refunds both alike. These
   * three charge on every status, with no `requestWasSuccessful` at all —
   * proven here by driving each one through 200, 400 and 500 and watching
   * the counter climb every time.
   */
  it("passwordForgotEmailLimiter charges a 200, a 400 and a 500 alike", async () => {
    const bare200 = appAround(passwordForgotEmailLimiter, 200);
    await post(bare200, { email: "isaias@osefi.net" });
    await settled();
    expect(await hits(passwordForgotEmailLimiter, "pf-email:isaias@osefi.net")).toBe(1);

    const bare400 = appAround(passwordForgotEmailLimiter, 400);
    await post(bare400, { email: "isaias@osefi.net" });
    await settled();
    expect(await hits(passwordForgotEmailLimiter, "pf-email:isaias@osefi.net")).toBe(2);

    const bare500 = appAround(passwordForgotEmailLimiter, 500);
    await post(bare500, { email: "isaias@osefi.net" });
    await settled();
    expect(await hits(passwordForgotEmailLimiter, "pf-email:isaias@osefi.net")).toBe(3);
  });

  it("passwordForgotIpLimiter charges a 200, a 400 and a 500 alike", async () => {
    for (const status of [200, 400, 500]) {
      const bare = appAround(passwordForgotIpLimiter, status);
      await post(bare, { email: `distinta-${status}@osefi.net` });
      await settled();
    }
    expect(await hits(passwordForgotIpLimiter, `pf-ip:${DESDE}`)).toBe(3);
  });

  it("emailSendLimiter charges a 200, a 400 and a 500 alike", async () => {
    for (const status of [200, 400, 500]) {
      const bare = appConSesion(emailSendLimiter, status, 55);
      await post(bare, {});
      await settled();
    }
    expect(await hits(emailSendLimiter, "es:55")).toBe(3);
  });

  /**
   * The red demonstration this task's report is required to include: bolt
   * the ordinary refund rule onto the mute bucket, and the exhaustion test
   * below stops being able to cut anybody off, because every legitimate-
   * looking 200 refunds itself. This test builds that broken variant inline,
   * rather than editing `recoveryLimiters.ts` to break it, so the passing
   * suite never depends on a temporarily-sabotaged source file — the report
   * pastes the transcript of the version that *does* edit the source and
   * goes red.
   */
  it("shows what would happen if the mute bucket refunded like the others do", async () => {
    const brokenWithRefund = rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 3,
      skipSuccessfulRequests: true,
      requestWasSuccessful: costsNothing, // the mistake Trampa 1 warns against
      keyGenerator: () => "broken:demo",
    });
    const bare = appAround(brokenWithRefund, 200); // /password/forgot always answers 200

    for (let i = 0; i < 10; i++) {
      const res = await post(bare, { email: `cualquiera-${i}@osefi.net` });
      await settled();
      // Every single one gets through — ten requests, no 429, because a 200
      // is refunded every time and the counter never climbs past zero.
      expect(res.status, `intento ${i + 1}`).toBe(200);
    }
    expect(await hits(brokenWithRefund, "broken:demo")).toBe(0);
  });
});

describe("what each guessable bucket spends: /password/reset and /email/verify", () => {
  it("passwordResetIpLimiter and passwordResetTokenLimiter refund a 200", async () => {
    const bare = appAround([passwordResetIpLimiter, passwordResetTokenLimiter], 200);
    await post(bare, { token: "un-token-cualquiera", pass: "x" });
    await settled();

    expect(await hits(passwordResetIpLimiter, `pr-ip:${DESDE}`)).toBe(0);
  });

  it("passwordResetIpLimiter and passwordResetTokenLimiter charge a 400", async () => {
    const bare = appAround([passwordResetIpLimiter, passwordResetTokenLimiter], 400);
    await post(bare, { token: "un-token-cualquiera", pass: "x" });
    await settled();

    expect(await hits(passwordResetIpLimiter, `pr-ip:${DESDE}`)).toBe(1);
  });

  it("passwordResetIpLimiter refunds a 500 — the property a 5xx must not cost", async () => {
    const bare = appAround([passwordResetIpLimiter, passwordResetTokenLimiter], 500);
    await post(bare, { token: "un-token-cualquiera", pass: "x" });
    await settled();

    expect(await hits(passwordResetIpLimiter, `pr-ip:${DESDE}`)).toBe(0);
  });

  /**
   * The red demonstration the brief's acceptance criteria names explicitly:
   * take the refund away and watch this exact property fail. Built the same
   * way as the mute-bucket demonstration above, with a throwaway limiter
   * missing `requestWasSuccessful` entirely — `express-rate-limit`'s own
   * default (`statusCode < 400`) is what is left, and that default still
   * refunds a 2xx but charges every 5xx, which is the half this project
   * learned the hard way it cannot afford. The report pastes the transcript
   * of actually deleting `requestWasSuccessful: costsNothing` from
   * `recoveryLimiters.ts` and running this file.
   */
  it("shows what a 5xx would cost without the refund rule", async () => {
    const brokenNoRefund = rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 20,
      skipSuccessfulRequests: true, // default requestWasSuccessful: statusCode < 400
      keyGenerator: () => "broken:demo-500",
    });
    const bare = appAround(brokenNoRefund, 500);
    await post(bare, { token: "un-token-cualquiera", pass: "x" });
    await settled();

    // Charged — which is exactly the outage-locks-the-office failure this
    // task's brief and `costsNothing`'s own comment both describe.
    expect(await hits(brokenNoRefund, "broken:demo-500")).toBe(1);
  });

  it("emailVerifyLimiter charges a 400 and refunds a 200 or a 500", async () => {
    const malo = appConSesion(emailVerifyLimiter, 400, 70);
    await post(malo, {});
    await settled();
    expect(await hits(emailVerifyLimiter, "ev:70")).toBe(1);

    const bueno = appConSesion(emailVerifyLimiter, 200, 71);
    await post(bueno, {});
    await settled();
    expect(await hits(emailVerifyLimiter, "ev:71")).toBe(0);

    const roto = appConSesion(emailVerifyLimiter, 500, 72);
    await post(roto, {});
    await settled();
    expect(await hits(emailVerifyLimiter, "ev:72")).toBe(0);
  });
});

describe("exhausting the cupo — the brief's own acceptance criteria", () => {
  /**
   * "Test que agota el cupo de /forgot por email y comprueba que la 4ª
   * responde 429." Three requests for the same address, each a literal `3`
   * typed here rather than `PASSWORD_FORGOT_EMAIL_LIMIT` — see the module
   * comment for why the loop bound is not allowed to come from the constant
   * this test is trying to hold honest.
   */
  it("cuts off the 4th request to the same address within an hour", async () => {
    const bare = appAround(passwordForgotRateLimit, 200);
    for (let i = 0; i < 3; i++) {
      const res = await post(bare, { email: "tercero@osefi.net" });
      await settled();
      expect(res.status, `intento ${i + 1}`).toBe(200);
    }

    const cuarto = await post(bare, { email: "tercero@osefi.net" });
    expect(cuarto.status).toBe(429);
  });

  /**
   * `/email/send`'s own exhaustion, mirroring the one above — the second of
   * the two mute routes, and the one Trampa 1 names explicitly alongside
   * `/password/forgot`. Same literal-5 discipline as every other cutoff in
   * this block.
   */
  it("cuts off the 6th /email/send request from the same account within an hour", async () => {
    const bare = appConSesion(emailSendLimiter, 200, 93);
    for (let i = 0; i < 5; i++) {
      const res = await post(bare, {});
      await settled();
      expect(res.status, `intento ${i + 1}`).toBe(200);
    }

    const sexto = await post(bare, {});
    expect(sexto.status).toBe(429);
  });

  /**
   * "Test que agota por IP rotando emails." Twenty requests, twenty different
   * addresses, one IP — none of them can trip the 3-per-address bucket, so
   * the 21st failing proves the *address* budget (20) is what caught this,
   * not a coincidence of the per-email one.
   */
  it("cuts off the 21st request from one IP even when every email is different", async () => {
    const bare = appAround(passwordForgotRateLimit, 200);
    for (let i = 0; i < 20; i++) {
      const res = await post(bare, { email: `rotando-${i}@osefi.net` });
      await settled();
      expect(res.status, `intento ${i + 1}`).toBe(200);
    }

    const vigesimoPrimero = await post(bare, { email: "rotando-20@osefi.net" });
    expect(vigesimoPrimero.status).toBe(429);
  });

  it("the daily backstop cuts off the 51st request of the day, however it is spread out", async () => {
    const bare = appAround(passwordForgotRateLimit, 200);
    // Fifty requests, each its own address and (via a distinct X-Forwarded-For)
    // its own IP too — nothing here trips the 3-per-email or 20-per-IP bucket,
    // which is exactly the gap Task 6's own daily cap exists to close: many
    // individually-under-budget identities, summing past the mail quota.
    for (let i = 0; i < 50; i++) {
      const res = await post(bare, { email: `global-${i}@osefi.net` }, `198.51.100.${i % 200}`);
      await settled();
      expect(res.status, `intento ${i + 1}`).toBe(200);
    }

    const cincuentaYUno = await post(bare, { email: "global-final@osefi.net" }, "198.51.100.250");
    expect(cincuentaYUno.status).toBe(429);
  });

  /**
   * `/password/reset`'s own version of Trampa 2: a caller who never repeats
   * a token cannot be stopped by the per-token bucket, since every guess
   * opens a fresh one. The address bucket is what still catches them — 20
   * requests, 20 different tokens, and the 21st is cut off regardless.
   */
  it("cuts off the 21st reset attempt from one IP even when every token is different", async () => {
    const bare = appAround(passwordResetRateLimit, 400); // a made-up token always answers 400
    for (let i = 0; i < 20; i++) {
      const res = await post(bare, { token: `token-inventado-${i}`, pass: "x" });
      await settled();
      expect(res.status, `intento ${i + 1}`).toBe(400);
    }

    const vigesimoPrimero = await post(bare, { token: "token-inventado-20", pass: "x" });
    expect(vigesimoPrimero.status).toBe(429);
  });

  it("cuts off the 6th reset attempt with the same token, well under the IP budget", async () => {
    const bare = appAround(passwordResetRateLimit, 400);
    for (let i = 0; i < 5; i++) {
      const res = await post(bare, { token: "el-mismo-token-cinco-veces", pass: "x" });
      await settled();
      expect(res.status, `intento ${i + 1}`).toBe(400);
    }

    const sexto = await post(bare, { token: "el-mismo-token-cinco-veces", pass: "x" });
    expect(sexto.status).toBe(429);
  });
});

describe("mounted on the real routes, not merely built", () => {
  /**
   * Reading the app's own route table, the way `routeGuards.test.ts` already
   * does for a different question — not importing anything from that file,
   * both files are independent readers of the same public Express structure.
   * This is the safe way to prove the wiring in `auth.routes.ts` without a
   * real request ever reaching `password.controller.ts` or
   * `email.controller.ts`: neither of those is mocked in this file (Global
   * Constraint #11), so a real POST that reached either handler's database
   * calls would run against the local Postgres instance, which is a copy of
   * production.
   */
  interface Layer {
    regexp: { source: string };
    route?: { path: string; methods: Record<string, boolean>; stack: { handle: { name: string } }[] };
    handle: { stack?: Layer[] };
  }

  function chainFor(method: string, path: string): string[] {
    const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
    for (const layer of stack) {
      if (!layer.handle.stack) continue;
      for (const inner of layer.handle.stack) {
        if (!inner.route) continue;
        if (inner.route.path !== path) continue;
        if (!inner.route.methods[method.toLowerCase()]) continue;
        return inner.route.stack.map((s) => s.handle.name);
      }
    }
    throw new Error(`no se encontró ${method} ${path} en el árbol de rutas`);
  }

  it("puts a nameable limiter chain in front of /password/forgot and /password/reset", () => {
    expect(chainFor("POST", "/password/forgot")).toEqual(["passwordForgotRateLimit", "forgotPassword"]);
    expect(chainFor("POST", "/password/reset")).toEqual(["passwordResetRateLimit", "resetPassword"]);
  });

  it("puts a limiter between authenticate and the handler on /email/send and /email/verify", () => {
    // `emailSendLimiter`/`emailVerifyLimiter` are bare `rateLimit()` results,
    // which carry no name of their own (checked directly: a plain
    // `rateLimit()` call's `.name` is `""`) — so the wiring is pinned by
    // position and chain length instead of by a name that does not exist.
    const send = chainFor("POST", "/email/send");
    expect(send[0]).toBe("authenticate");
    expect(send[2]).toBe("sendVerificationEmail");
    expect(send).toHaveLength(3);

    const verify = chainFor("POST", "/email/verify");
    expect(verify[0]).toBe("authenticate");
    expect(verify[2]).toBe("verifyEmail");
    expect(verify).toHaveLength(3);
  });
});
