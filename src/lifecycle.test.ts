// The order in which a dying process lets go of things.
//
// `index.ts` cannot be imported by a test — it connects, migrates and binds a
// port on import — so it is excluded from coverage, and until this file existed
// the three fixes that live there could be deleted with the suite still green.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createShutdown } from "./lifecycle.js";

beforeEach(() => {
  vi.useFakeTimers();
  process.exitCode = 0;
});

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = 0;
});

describe("createShutdown", () => {
  it("stops accepting requests before it releases the database", () => {
    // Not cosmetic. Closing the pool with the listener still up left a
    // two-second window where every arriving request was accepted and then
    // answered 500 — the connection manager had already been replaced by a
    // thrower — and requests already in flight had their transaction pulled
    // out from under them.
    const order: string[] = [];
    const die = createShutdown({
      closeListener: () => order.push("listener"),
      closeDatabase: async () => order.push("database"),
      forceExit: () => order.push("exit"),
    });

    die();

    expect(order).toEqual(["listener", "database"]);
  });

  it("sets the exit code instead of cutting the process off mid-sentence", () => {
    // `process.exit()` discards whatever is still in the output stream, which
    // is how a boot failure came to be printed *above* the line that preceded
    // it — reading as though the failure happened first.
    const forceExit = vi.fn();
    const die = createShutdown({
      closeListener: () => {},
      closeDatabase: async () => {},
      forceExit,
    });

    die();

    expect(process.exitCode).toBe(1);
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("forces the exit only when something refuses to let go", () => {
    const forceExit = vi.fn();
    const die = createShutdown({
      closeListener: () => {},
      closeDatabase: async () => {},
      forceExit,
      graceMs: 2000,
    });

    die();
    vi.advanceTimersByTime(1999);
    expect(forceExit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it("never keeps the process alive on the timer's account", () => {
    // Unref'd, or a server that has finished shutting down cleanly still sits
    // there for two seconds because of the backstop meant to protect it.
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setTimeout").mockReturnValue({ unref } as never);
    try {
      createShutdown({
        closeListener: () => {},
        closeDatabase: async () => {},
        forceExit: () => {},
      })();
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("stops once, however many failures arrive", async () => {
    // An unhandled rejection can arrive while the first shutdown is draining.
    // Closing twice is noise at best and a second forced-exit timer at worst.
    const closeDatabase = vi.fn(async () => {});
    const die = createShutdown({
      closeListener: () => {},
      closeDatabase,
      forceExit: () => {},
    });

    die();
    die();
    die();

    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("survives a database that refuses to close", async () => {
    // The rejection has to be swallowed here: an unhandled rejection *inside*
    // the handler for unhandled rejections is how a readable last line becomes
    // a stack trace.
    const die = createShutdown({
      closeListener: () => {},
      closeDatabase: () => Promise.reject(new Error("pool ya cerrado")),
      forceExit: () => {},
    });

    expect(() => die()).not.toThrow();
    await Promise.resolve();
  });
});
