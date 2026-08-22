// How the process stops.
//
// Extracted from `index.ts` so it can be tested. `index.ts` is the one module
// the suite cannot import — it connects, migrates and binds a port on import —
// so it is excluded from coverage, and three fixes that live in it could be
// deleted without a single test noticing: stopping the listener before the pool,
// setting an exit code instead of calling `process.exit`, and having a last net
// for unhandled rejections at all.
//
// The dependencies arrive as arguments for the same reason. A test needs to see
// the *order* of two calls, which is the whole point of the fix.

export interface ShutdownDeps {
  /** Stops accepting new connections. Null before the server is listening. */
  closeListener: () => void;
  /** Releases the connection pool. */
  closeDatabase: () => Promise<unknown>;
  /** Last resort if something refuses to let go. */
  forceExit: (code: number) => void;
  /** How long to wait for a clean stop before forcing it. */
  graceMs?: number;
}

/**
 * Stop, having said why, without jumping the queue.
 *
 * `process.exit()` cuts the process off where it stands, and anything still in
 * the output stream can land out of order or not at all — the boot failure
 * printed *above* the "connected to PostgreSQL" line that came before it, which
 * reads as though the failure happened first. Setting the exit code and letting
 * the loop drain fixes the order.
 *
 * The order of the two closes is not cosmetic. Closing the pool while the
 * listener was still up left a two-second window where every arriving request
 * was accepted and then answered 500, because the connection manager had
 * already been replaced by a thrower — and requests already in flight had their
 * transaction pulled out from under them. Stop accepting, then let go.
 */
export function createShutdown(deps: ShutdownDeps): () => void {
  const graceMs = deps.graceMs ?? 2000;
  let stopping = false;

  return function die(): void {
    // A rejected promise can arrive while the first shutdown is still draining;
    // closing twice is noise at best and a second timer at worst.
    if (stopping) return;
    stopping = true;

    process.exitCode = 1;
    deps.closeListener();
    void Promise.resolve(deps.closeDatabase()).catch(() => undefined);
    // Unref'd: this must never be the reason the process stays alive.
    setTimeout(() => deps.forceExit(1), graceMs).unref();
  };
}
