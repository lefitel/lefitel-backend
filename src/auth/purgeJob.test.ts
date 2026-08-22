// `index.ts` connects to Postgres and can call `process.exit` on import, so no
// test can import it directly — see `lifecycle.test.ts` for the same note
// about `createShutdown`. This is the wrapper that makes the purge's
// scheduling testable at all: without it, the `.catch` and the `unref()`
// could both be deleted from `index.ts` with the suite still green.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
