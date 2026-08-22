// The session token.
//
// Two properties and nothing else: it is unguessable, and what the database
// keeps cannot be turned back into it. Both are the kind of thing that looks
// fine when it is wrong, so they are pinned here.

import { describe, it, expect } from "vitest";
import { newSessionToken, hashSessionToken } from "./sessionToken.js";

describe("newSessionToken", () => {
  it("produces a 43-character token, which is 32 bytes in base64url", () => {
    // base64url of 32 bytes is 43 characters with no padding. Fewer characters
    // than that means fewer bytes than that.
    // Note: the guarantee that the source is cryptographic lives in the use of
    // randomBytes() from node:crypto, not in this test. This assert catches
    // encoding changes or byte-count errors; randomBytes guarantees quality.
    expect(newSessionToken()).toHaveLength(43);
  });

  it("is url-safe, so a cookie never needs escaping", () => {
    for (let i = 0; i < 50; i++) {
      expect(newSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newSessionToken());
    expect(seen.size).toBe(1000);
  });
});

describe("hashSessionToken", () => {
  it("returns 64 hex characters", () => {
    expect(hashSessionToken("cualquier-cosa")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same answer every time, so a lookup can find the row", () => {
    const t = newSessionToken();
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
  });

  it("gives different answers to different tokens", () => {
    expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
  });

  it("does not contain the token", () => {
    // Obvious, and the point of the whole module: a dump of the table hands
    // over nothing that can be replayed.
    const t = newSessionToken();
    expect(hashSessionToken(t)).not.toContain(t);
  });
});
