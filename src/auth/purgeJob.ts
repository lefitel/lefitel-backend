// Starts the background purge of expired sessions: one pass now, then a daily
// interval for as long as the process runs.
//
// Extracted from `index.ts` for the same reason `lifecycle.ts` is: `index.ts`
// connects to Postgres and can call `process.exit` on import, so no test can
// import it directly, and a fix that lives only there could be deleted with
// the suite still green and nobody the wiser.

export interface PurgeJobDeps {
  /** Deletes the rows nothing can matter to any more; see `sessionStore.ts`. */
  purge: () => Promise<number>;
  /** How often to run `purge` again, once the first pass has fired. */
  intervalMs: number;
  /** Where a failed pass is reported. A purge that fails must not crash the process. */
  onError: (err: unknown) => void;
}

/**
 * Runs `purge` once immediately, then every `intervalMs` after that.
 *
 * Both the immediate call and every later one carry a `.catch` right where
 * `purge()` is invoked — same shape as `fillerHash()`'s call in `index.ts`,
 * and for the same reason: `index.ts` treats a promise rejected with nobody
 * holding it as an `unhandledRejection`, and that handler kills the process.
 * A midnight where the database happens to be unreachable must not take the
 * whole ERP down with it — the next scheduled pass, or the next boot, tries
 * again.
 *
 * The interval is `unref`'d, so a purge with nothing left to do never keeps
 * the process alive on its own account — the same reasoning `lifecycle.ts`
 * writes beside its own `setTimeout`.
 */
export function schedulePurge(deps: PurgeJobDeps): void {
  const runOnce = () => deps.purge().catch(deps.onError);

  runOnce();
  setInterval(runOnce, deps.intervalMs).unref();
}
