// Admission control for exports.
//
// ExcelJS assembles the whole workbook in memory, and the server shares four
// gigabytes with Postgres. Two large exports at once take the API down for
// everyone, so only one runs at a time.

/** Thrown when an export is already running. The caller answers 429. */
export class ExportBusyError extends Error {
  constructor() {
    super("Ya hay una exportación en curso. Espere a que termine e intente de nuevo.");
    this.name = "ExportBusyError";
  }
}

/**
 * Refuses rather than queues.
 *
 * A silent wait behind a two-minute export looks exactly like a system that has
 * frozen, and the user's only feedback would be a spinner that never moves. A
 * refusal with a sentence they can read is worth more than a place in a line
 * they cannot see.
 */
export class SingleSlot {
  private busy = false;

  get isBusy(): boolean {
    return this.busy;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ExportBusyError();
    this.busy = true;
    try {
      return await task();
    } finally {
      this.busy = false;
    }
  }
}

/** One slot for the whole process. */
export const exportSlot = new SingleSlot();
