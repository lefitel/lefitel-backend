// The cookie.
//
// Four attributes, y cada uno cierra un ataque distinto. This file exists so
// nobody "simplifies" one of them away, because three of the four fail silently
// — the application keeps working and the protection is gone.

import { describe, it, expect } from "vitest";
import { setSessionCookie, clearSessionCookie, readSessionCookie, SESSION_COOKIE_NAME } from "./sessionCookie.js";
import type { Request, Response } from "express";

function fakeRes() {
  const calls: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      calls.push({ name, value, options });
      return res;
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      calls.push({ name, value: "", options });
      return res;
    },
  };
  return { res: res as unknown as Response, calls };
}

const optionsOf = (calls: { options: Record<string, unknown> }[]) => calls[0].options;

describe("setSessionCookie", () => {
  it("is not readable from JavaScript", () => {
    // Without this, one injected script takes the session.
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls).httpOnly).toBe(true);
  });

  it("never leaves the host that set it", () => {
    // No `domain`. A cookie scoped to the parent domain can be shadowed by any
    // subdomain — httpOnly stops it being read, not being overwritten — and it
    // would travel to the frontend's host on every image and script.
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls)).not.toHaveProperty("domain");
  });

  it("covers the whole host, so nothing can shadow it with a longer path", () => {
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls).path).toBe("/");
  });

  it("is not sent on a request another site started", () => {
    const { res, calls } = fakeRes();
    setSessionCookie(res, "t", new Date(Date.now() + 1000));
    expect(optionsOf(calls).sameSite).toBe("lax");
  });

  it("expires when the session does", () => {
    const { res, calls } = fakeRes();
    const expiresAt = new Date(Date.now() + 60_000);
    setSessionCookie(res, "t", expiresAt);
    expect(optionsOf(calls).expires).toEqual(expiresAt);
  });

  it("carries the token as its value", () => {
    const { res, calls } = fakeRes();
    setSessionCookie(res, "el-token", new Date(Date.now() + 1000));
    expect(calls[0].value).toBe("el-token");
    expect(calls[0].name).toBe(SESSION_COOKIE_NAME);
  });
});

describe("clearSessionCookie", () => {
  it("clears it with the same attributes it was set with", () => {
    // A browser only drops a cookie when path and the rest match. Clearing it
    // with different attributes leaves the old one in place.
    const { res, calls } = fakeRes();
    clearSessionCookie(res);
    expect(calls[0].name).toBe(SESSION_COOKIE_NAME);
    expect(calls[0].options.path).toBe("/");
    expect(calls[0].options.httpOnly).toBe(true);
  });
});

describe("readSessionCookie", () => {
  it("finds the token when the cookie is there", () => {
    const req = { cookies: { [SESSION_COOKIE_NAME]: "abc" } } as unknown as Request;
    expect(readSessionCookie(req)).toBe("abc");
  });

  it("is undefined when there are no cookies at all", () => {
    // cookie-parser not mounted, or a client that sends none. Must not throw.
    expect(readSessionCookie({} as Request)).toBeUndefined();
  });

  it("ignores a value cookie-parser has already parsed as JSON", () => {
    // `Cookie: osefi_session=j:1` makes cookie-parser's own JSONCookies step
    // hand this a number, not a string. Returning it anyway would send a
    // number into `hashSessionToken`, which throws on anything that is not a
    // string or Buffer — turning an unauthenticated request into a 500.
    const req = { cookies: { [SESSION_COOKIE_NAME]: 1 } } as unknown as Request;
    expect(readSessionCookie(req)).toBeUndefined();
  });
});
