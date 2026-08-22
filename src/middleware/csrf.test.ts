// What a cookie-authenticated write has to prove, and what a bearer one does not.
//
// **`curl` cannot verify any of this, and that is why this file exists.** curl
// does not implement CORS: it sends whatever headers it is told to and reads
// whatever comes back, so it would report a clean 200 on a request no browser
// would ever complete — and would have reported one on the missing
// `credentials: true` that made the whole cookie unreachable. What a test *can*
// check is exactly what a browser checks, which is the response headers, and what
// this server decides, which is a status code. The headers are asserted in
// `app.security.test.ts`; the decisions are here.
//
// Most of this runs against a purpose-built app rather than the real one, and
// for a reason worth writing down: the origin list is the thing under test, and
// on the real app it comes from the environment. A test that read the list out of
// `process.env` and then sent that same origin would pass under *any* comparison
// at all — suffix, prefix, "contains" — because it would only ever try the string
// the code already agreed with. So the list is written out here, and so is a set
// of origins that a comparison written the easy way lets through.

import { describe, expect, it } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import { requireSameOrigin } from "./csrf.js";
import { SESSION_COOKIE_NAME } from "../auth/sessionCookie.js";
import {
  allowedOrigins,
  CSRF_CLIENT_HEADER,
  DEV_FRONTEND_ORIGIN,
  PETICION_NO_VERIFICABLE,
} from "../config/security.js";
import app from "../app.js";

const NUESTRO = "https://www.osefi.net";
const COOKIE = `${SESSION_COOKIE_NAME}=un-token-opaco-de-treinta-y-dos-bytes`;
const CLIENTE = "web";

/**
 * Origins that a comparison written the easy way lets through, and not one of
 * which is ours.
 *
 * The *data* is doing the work here, not the assertion. In the previous task a
 * deliberate sabotage went unnoticed because the test's UUIDs were all digits, so
 * deleting the lower-casing step changed nothing about the outcome: the assertion
 * was right and the input exercised nothing. So each of these exists to be let
 * through by one specific wrong comparison:
 *
 * - `https://evil-osefi.net` is a different registrable domain that happens to
 *   end in the same letters. It passes anything written as "does the host end
 *   with osefi.net", which is the mistake this file exists to catch.
 * - `https://www.osefi.net.evil.example` begins with the whole of our origin, so
 *   it passes `startsWith`.
 * - `http://www.osefi.net` differs only in scheme, so it passes anything that
 *   compares hosts and forgets that an origin is scheme, host and port.
 * - `https://www.osefi.net:8443` differs only in port, for the same reason.
 * - `https://evil.osefi.net` is a subdomain, so it is same-site and
 *   `SameSite=Lax` never stops it. This list is the only thing that does.
 */
const AJENOS = [
  "https://evil-osefi.net",
  "https://www.osefi.net.evil.example",
  "http://www.osefi.net",
  "https://www.osefi.net:8443",
  "https://evil.osefi.net",
  "null",
];

/**
 * The four verbs that write and the three that do not, written out rather than
 * imported from `csrf.ts`.
 *
 * Reading the list from the module under test would assert that the module agrees
 * with itself — the same trap `routeGuards.test.ts` names when it writes out the
 * permission pairs instead of deriving them.
 */
const ESCRITURAS = ["post", "put", "patch", "delete"] as const;
const LECTURAS = ["get", "head", "options"] as const;

/** The guard mounted the way `app.ts` mounts it, in front of one open handler. */
function guarded(allowed: string[] = [NUESTRO]) {
  const probe = express();
  probe.use(express.json());
  probe.use(cookieParser());
  probe.use(requireSameOrigin(allowed));
  probe.all("/x", (_req, res) => {
    res.status(200).json({ llego: true });
  });
  return probe;
}

describe("a write authenticated by cookie", () => {
  it("goes through when it names our origin and carries our header", async () => {
    for (const verbo of ESCRITURAS) {
      const res = await request(guarded())[verbo]("/x")
        .set("Cookie", COOKIE)
        .set("Origin", NUESTRO)
        .set(CSRF_CLIENT_HEADER, CLIENTE);

      expect(res.status, verbo).toBe(200);
    }
  });

  it("is refused when our header is missing, on every verb that writes", async () => {
    // The barrier that stops the request nothing else stops: an HTML form post
    // needs no preflight, so CORS never gets to refuse it, and it cannot carry a
    // header that is not CORS-safelisted.
    for (const verbo of ESCRITURAS) {
      const res = await request(guarded())[verbo]("/x")
        .set("Cookie", COOKIE)
        .set("Origin", NUESTRO);

      expect(res.status, verbo).toBe(403);
      expect(res.body.message, verbo).toBe(PETICION_NO_VERIFICABLE);
    }
  });

  it("clears the session cookie on a header refusal, so a retry is not refused again", async () => {
    // A proxy that eats the custom header locks a returning user out of every
    // write, login included — and the frontend's logout never calls the server,
    // so nothing else would ever discard this cookie. Taking it back here means
    // the very next request, whichever route it hits, arrives with none and
    // reaches the route instead of being refused a second time.
    const res = await request(guarded())
      .post("/x")
      .set("Cookie", COOKIE)
      .set("Origin", NUESTRO);

    expect(res.status).toBe(403);
    const setCookie = (res.headers["set-cookie"] ?? []) as string[];
    expect(setCookie.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=;`))).toBe(true);
  });

  it("is refused when the header is there but empty", async () => {
    // A proxy that rewrites unknown headers to nothing is likelier than one that
    // deletes them, and "present" has to mean present.
    for (const valor of ["", "   "]) {
      const res = await request(guarded())
        .post("/x")
        .set("Cookie", COOKIE)
        .set("Origin", NUESTRO)
        .set(CSRF_CLIENT_HEADER, valor);

      expect(res.status, JSON.stringify(valor)).toBe(403);
    }
  });

  it("does not care what the header says, only that it is there", async () => {
    // Deliberate: any value we chose would ship inside a readable bundle, so it
    // cannot be a secret, and pinning one would mean a "rotation" that refuses
    // every browser still holding the previous build. What protects the request
    // is that a browser will not send this header cross-site without permission.
    for (const valor of [CLIENTE, "movil", "cualquier-cosa", "0"]) {
      const res = await request(guarded())
        .post("/x")
        .set("Cookie", COOKIE)
        .set("Origin", NUESTRO)
        .set(CSRF_CLIENT_HEADER, valor);

      expect(res.status, valor).toBe(200);
    }
  });

  it("is refused from any origin that is not exactly ours, header and all", async () => {
    for (const ajeno of AJENOS) {
      const res = await request(guarded())
        .post("/x")
        .set("Cookie", COOKIE)
        .set("Origin", ajeno)
        .set(CSRF_CLIENT_HEADER, CLIENTE);

      expect(res.status, ajeno).toBe(403);
    }
  });

  it("leaves the cookie alone on an origin refusal, unlike a header refusal", async () => {
    // `evil.osefi.net` is same-site, so `SameSite=Lax` does not stop it from
    // carrying this cookie — it is exactly the kind of request that could try to
    // force a logout if this refusal cleared the cookie too. It cannot: a script
    // cannot forge `Origin`, so this path is never the "our own stale bundle, or
    // a proxy ate our header" case the clearing on a header refusal exists for.
    const res = await request(guarded())
      .post("/x")
      .set("Cookie", COOKIE)
      .set("Origin", "https://evil.osefi.net")
      .set(CSRF_CLIENT_HEADER, CLIENTE);

    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("is refused when it names no origin at all", async () => {
    // Absent is refused, not waved through, and that is the difference between a
    // check and a suggestion: if missing meant allowed, deleting the header would
    // be the whole bypass. Nothing legitimate is lost — the only client that
    // authenticates by cookie is a browser on another host, and a browser always
    // names its origin on a request that carries a body.
    const res = await request(guarded())
      .post("/x")
      .set("Cookie", COOKIE)
      .set(CSRF_CLIENT_HEADER, CLIENTE);

    expect(res.status).toBe(403);
  });
});

describe("everything else is left alone", () => {
  it("does not touch a read, whatever it carries", async () => {
    // The guard is about writes. A GET with a cookie and no origin is every page
    // load of the application, and 403ing those would be the whole product.
    for (const verbo of LECTURAS) {
      const res = await request(guarded())[verbo]("/x").set("Cookie", COOKIE);
      expect(res.status, verbo).toBe(200);
    }
  });

  it("does not touch a write that carries no cookie", async () => {
    // The first login of a browser, and every call the current frontend makes
    // before it has a session row. There is no credential a browser attaches by
    // itself here, so there is nothing another site could trigger.
    for (const verbo of ESCRITURAS) {
      const res = await request(guarded())[verbo]("/x");
      expect(res.status, verbo).toBe(200);
    }
  });

  it("does not touch a write authenticated by the old bearer token", async () => {
    // The assertion that pins the coexistence, and the one that fails the moment
    // somebody decides the header should be required of everybody. Requiring it
    // there would refuse every write the current frontend makes — it sends a
    // bearer token and no header of its own — and being able to deploy the two
    // repositories on different days is the entire reason both credentials work.
    //
    // Safe because nothing makes a browser send `Authorization` on its own: a
    // page on another site cannot produce this request at all, which is why the
    // hostile origin below is not a hole either.
    for (const ajeno of AJENOS) {
      const res = await request(guarded())
        .post("/x")
        .set("Authorization", "Bearer un-jwt-cualquiera")
        .set("Origin", ajeno);

      expect(res.status, ajeno).toBe(200);
    }
  });

  it("skips a cookie cookie-parser turned into something that is not a string", async () => {
    // `Cookie: osefi_session=j:1` reaches the guard as the number 1, because
    // cookie-parser runs `JSONCookies` on everything. `readSessionCookie` is what
    // keeps that honest, and using it here rather than reading `req.cookies`
    // directly is what makes this guard agree with `authenticate` about what
    // counts as a cookie-authenticated request. It is not one: nothing downstream
    // will authenticate by it either.
    const res = await request(guarded())
      .post("/x")
      .set("Cookie", `${SESSION_COOKIE_NAME}=j:1`);

    expect(res.status).toBe(200);
  });
});

describe("the origin list", () => {
  it("forgives a trailing slash in the configuration and not in the header", async () => {
    // `CORS_ORIGIN=https://www.osefi.net/` is one keystroke and a total outage:
    // an `Origin` header never carries a path, so the untrimmed form matches
    // nothing, every browser request is blocked, and the server logs clean 200s.
    // `nodeEnv` is "production" here on purpose: a configured value must work
    // regardless of environment, which is what tells this branch apart from the
    // fallback below.
    const res = await request(guarded(allowedOrigins(`${NUESTRO}/`, "production")))
      .post("/x")
      .set("Cookie", COOKIE)
      .set("Origin", NUESTRO)
      .set(CSRF_CLIENT_HEADER, CLIENTE);

    expect(res.status).toBe(200);
  });

  it("takes several origins from one variable", () => {
    expect(allowedOrigins(` ${NUESTRO} , https://preview.osefi.net/ `, "production")).toEqual([
      NUESTRO,
      "https://preview.osefi.net",
    ]);
  });

  it("treats a blank variable as unset in development, exactly as requiredEnv's own carve-out for development", () => {
    expect(allowedOrigins(undefined, "development")).toEqual([DEV_FRONTEND_ORIGIN]);
    expect(allowedOrigins("", "development")).toEqual([DEV_FRONTEND_ORIGIN]);
    expect(allowedOrigins("   ", "development")).toEqual([DEV_FRONTEND_ORIGIN]);
  });

  it("refuses everything instead of guessing development, for any nodeEnv that is not provably development", () => {
    // This is the fix for the finding that a deployment path which never sets
    // NODE_ENV at all — a platform's own buildpack instead of this repo's
    // Dockerfile, an overridden start command, `node dist/index.js` run by
    // hand — used to sail past both guards at once: `requiredEnv` only demands
    // CORS_ORIGIN when nodeEnv is exactly "production", and this function used
    // to hand out `DEV_FRONTEND_ORIGIN` — with credentials, once `app.ts` wires
    // it into `cors()` — for every nodeEnv that merely wasn't that one exact
    // string. Asking "is this NOT production?" and asking "is this KNOWN to be
    // development?" agree on `"production"` itself but disagree on everything
    // that is neither: this data set is exactly the cases where the two
    // questions used to give different answers, which is the point being
    // tested, not just the empty-list outcome.
    expect(allowedOrigins(undefined, "production")).toEqual([]);
    expect(allowedOrigins(undefined, undefined)).toEqual([]);
    expect(allowedOrigins(undefined, "staging")).toEqual([]);
    expect(allowedOrigins("", "production")).toEqual([]);

    const res = allowedOrigins(undefined, undefined);
    expect(res).not.toEqual([DEV_FRONTEND_ORIGIN]);
  });

  it("drops a wildcard instead of honouring it", async () => {
    // A wildcard cannot coexist with credentials — browsers refuse
    // `Access-Control-Allow-Origin: *` next to
    // `Access-Control-Allow-Credentials: true` — so a deployment that writes one
    // is asking for something no browser accepts. An empty list refuses
    // everything loudly, which is the failure you can find.
    expect(allowedOrigins("*", "production")).toEqual([]);
    expect(allowedOrigins(`*,${NUESTRO}`, "production")).toEqual([NUESTRO]);

    const res = await request(guarded(allowedOrigins("*", "production")))
      .post("/x")
      .set("Cookie", COOKIE)
      .set("Origin", "*")
      .set(CSRF_CLIENT_HEADER, CLIENTE);

    expect(res.status).toBe(403);
  });
});

describe("mounted on the assembled app", () => {
  // The probe above proves the middleware decides correctly. It says nothing
  // about whether `app.ts` mounts it, or mounts it in front of everything —
  // which is exactly the gap `routeGuards.test.ts` was written for on the
  // permission gates. `/api/ciudad` is picked because it is an ordinary router
  // with nothing to do with sessions: the guard has to cover the whole API, not
  // the endpoints somebody remembered.
  const ORIGEN = allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0];

  it("answers 403 before authenticate ever runs", async () => {
    const res = await request(app).post("/api/ciudad").set("Cookie", COOKIE);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(PETICION_NO_VERIFICABLE);
  });

  it("hands a real cookie write on to the route once it looks like the frontend's", async () => {
    // `POST /api/login` rather than `/api/ciudad`, for one practical reason: a
    // cookie the guard accepts is a cookie `authenticate` then looks up in
    // Postgres, and there is no Postgres here. This route answers before it
    // queries anything — an empty password is refused by `verifyCredentials` on
    // the shape of the request — so the status says which middleware answered and
    // nothing else.
    //
    // 400 and not 403 is the whole assertion: the guard let a genuine
    // cookie-carrying write reach the controller. Paired with the 403 above it
    // separates "refused by the origin check" from every other refusal.
    const conCabecera = await request(app)
      .post("/api/login")
      .set("Cookie", COOKIE)
      .set("Origin", ORIGEN)
      .set(CSRF_CLIENT_HEADER, CLIENTE)
      .send({ user: "nadie", pass: "" });

    expect(conCabecera.status).toBe(400);

    const sinCabecera = await request(app)
      .post("/api/login")
      .set("Cookie", COOKIE)
      .set("Origin", ORIGEN)
      .send({ user: "nadie", pass: "" });

    expect(sinCabecera.status).toBe(403);
    // The lockout this guards against: without this, a browser stuck with a
    // header a proxy keeps stripping could never log back in either, because
    // the frontend's logout never calls the server and nothing else would ever
    // take this cookie back.
    const setCookie = (sinCabecera.headers["set-cookie"] ?? []) as string[];
    expect(setCookie.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=;`))).toBe(true);
  });

  it("leaves the bearer path alone on a real route", async () => {
    const res = await request(app)
      .post("/api/ciudad")
      .set("Authorization", "Bearer un-jwt-cualquiera");

    expect(res.status).toBe(401);
  });

  it("refuses an origin that exists only in a wider list, not in the one cors() was given", async () => {
    // Guards the single-source-of-truth design itself: `app.ts` is supposed to
    // read ORIGINS once and hand the identical array to `cors()` and to
    // `requireSameOrigin`. A change such as
    // `requireSameOrigin([...ORIGINS, "https://staging.osefi.net"])` — done to
    // make a new preview deployment work without touching CORS_ORIGIN — would
    // widen the guard's copy alone, and nothing above this test would notice:
    // the probe-based tests build their own list by hand, and
    // `app.security.test.ts` only exercises `cors()`. This runs the real app, so
    // it fails the moment the two copies disagree.
    const res = await request(app)
      .post("/api/ciudad")
      .set("Cookie", COOKIE)
      .set("Origin", "https://staging.osefi.net")
      .set(CSRF_CLIENT_HEADER, CLIENTE);

    expect(res.status).toBe(403);
  });
});
