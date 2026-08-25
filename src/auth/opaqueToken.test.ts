// The opaque-token primitive.
//
// Same two properties `sessionToken.test.ts` pins for the delegating wrapper,
// asserted here directly against the module that actually implements them.
// `sessionToken.ts` only proves this indirectly through delegation; a caller
// that reaches this module straight — `tokenStore.ts` does — deserves its own
// coverage that does not depend on that delegation staying in place.

import { describe, it, expect } from "vitest";
import { newOpaqueToken, hashOpaqueToken } from "./opaqueToken.js";

describe("newOpaqueToken", () => {
  it("produces a 43-character token, which is 32 bytes in base64url", () => {
    // base64url of 32 bytes is 43 characters with no padding. Fewer characters
    // than that means fewer bytes than that.
    expect(newOpaqueToken()).toHaveLength(43);
  });

  it("is url-safe, so it never needs escaping in a cookie or a query string", () => {
    for (let i = 0; i < 50; i++) {
      expect(newOpaqueToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newOpaqueToken());
    expect(seen.size).toBe(1000);
  });
});

describe("hashOpaqueToken", () => {
  it("returns 64 hex characters", () => {
    expect(hashOpaqueToken("cualquier-cosa")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same answer every time, so a lookup can find the row", () => {
    const t = newOpaqueToken();
    expect(hashOpaqueToken(t)).toBe(hashOpaqueToken(t));
  });

  it("gives different answers to different tokens", () => {
    expect(hashOpaqueToken("a")).not.toBe(hashOpaqueToken("b"));
  });

  it("does not contain the token", () => {
    // The whole point of hashing before it is stored: a dump of the table
    // hands over nothing that can be replayed.
    const t = newOpaqueToken();
    expect(hashOpaqueToken(t)).not.toContain(t);
  });
});
