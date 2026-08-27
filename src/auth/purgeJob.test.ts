// `index.ts` connects to Postgres and can call `process.exit` on import, so no
// test can import it directly — see `lifecycle.test.ts` for the same note
// about `createShutdown`. This is the wrapper that makes the purge's
// scheduling testable at all: without it, the `.catch` and the `unref()`
// could both be deleted from `index.ts` with the suite still green.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { schedulePurge } from "./purgeJob.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("schedulePurge", () => {
  it("runs the purge once immediately, without waiting for the first interval", () => {
    const purge = vi.fn().mockResolvedValue(0);

    schedulePurge({ purge, intervalMs: 1000, onError: () => {} });

    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("keeps running the purge on the interval, for as long as the process does", async () => {
    const purge = vi.fn().mockResolvedValue(0);

    schedulePurge({ purge, intervalMs: 1000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // One immediate pass plus three interval ticks.
    expect(purge).toHaveBeenCalledTimes(4);
  });

  it("reports a failed pass instead of leaving a rejection nobody holds", async () => {
    // Without the `.catch` right where `purge()` is called, this rejection is
    // exactly what `index.ts`'s `unhandledRejection` handler is watching for,
    // and that handler calls `die()` — a purge that fails on one midnight
    // must not take the whole ERP down with it.
    const err = new Error("la base no responde");
    const purge = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();

    schedulePurge({ purge, intervalMs: 1000, onError });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(err);
  });

  it("keeps trying on the next interval after a failed pass, rather than giving up", async () => {
    const purge = vi
      .fn()
      .mockRejectedValueOnce(new Error("la base no responde"))
      .mockResolvedValue(0);
    const onError = vi.fn();

    schedulePurge({ purge, intervalMs: 1000, onError });
    await vi.advanceTimersByTimeAsync(1000);

    expect(purge).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("never keeps the process alive on the interval's own account", () => {
    // Unref'd, or a process with nothing left to do but wait out an idle
    // purge interval never gets to exit on its own.
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as never);
    try {
      schedulePurge({
        purge: vi.fn().mockResolvedValue(0),
        intervalMs: 1000,
        onError: () => {},
      });
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The half `schedulePurge`'s own tests cannot reach: whether both sweeps are
 * actually wired to it.
 *
 * Extracting the mechanism into `purgeJob.ts` made the `.catch` and the
 * `unref()` testable, and left the *wiring* exactly as exposed as it was.
 * Delete either `schedulePurge({ … })` call from `index.ts` and every test in
 * this repository stays green while the table it swept grows for ever — which
 * for `dispositivo_recordado` means an IP address and a user agent per row,
 * kept indefinitely.
 *
 * `index.ts` connects to Postgres and can call `process.exit` on import, so no
 * test can import it and assert on the calls. So this reads the source, the way
 * `cookieSecureDefault.test.ts` and `securityNotice.test.ts` do — the pattern
 * this repo already uses for the defect whose shape is *a line that is
 * missing*, not a line that is wrong. Cheaper than a `scheduleAllPurges()`
 * wrapper, and it keeps `purgeJob.ts` importing no model at all, which is what
 * lets everything above run without a database.
 */
describe("every purge there is, is actually scheduled at boot", () => {
  const INDEX = "src/index.ts";

  /** The function named by the `purge:` of each `schedulePurge({ … })` in `index.ts`. */
  const scheduled = () =>
    [...readFileSync(INDEX, "utf8").matchAll(/schedulePurge\(\s*\{[\s\S]*?\}\s*\)/g)].map(
      (call) => /purge:\s*([A-Za-z0-9_]+)/.exec(call[0])?.[1] ?? SIN_PURGE,
    );
  const SIN_PURGE = "«la llamada no nombra ninguna purga»";

  it("schedules the session sweep and the remembered-device sweep, both of them", () => {
    expect(scheduled()).toEqual(
      expect.arrayContaining(["purgeExpiredSessions", "purgeExpiredRememberedDevices"]),
    );
  });

  it("finds every schedulePurge call there is, so a rewrite cannot make the check vacuous", () => {
    // Without this, renaming `schedulePurge` or reformatting either call turns
    // the pattern above into zero matches and the assertion into a green
    // nothing — the failure mode of every scan-the-source test.
    const llamadas = (readFileSync(INDEX, "utf8").match(/schedulePurge\(/g) ?? []).length;
    expect(llamadas).toBeGreaterThan(0);
    expect(scheduled()).toHaveLength(llamadas);
    expect(scheduled()).not.toContain(SIN_PURGE);
  });
});
