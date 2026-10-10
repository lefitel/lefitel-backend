// The one set of real dependencies the process uses for scheduled reports —
// shared by the scheduler's tick and by "send it now", so both go through the
// same export slot, the same day's ceiling and the same mail chain.

import { dependenciasReales } from "./store.js";
import { enlaceDeBaja } from "./unsubscribe.js";
import type { Dependencias } from "./run.js";

let dependencias: Dependencias | null = null;

/**
 * Built on first use rather than at import: importing this file must not be
 * what decides when the mail chain is configured.
 */
export function dependenciasDeInformes(): Dependencias {
  dependencias ??= dependenciasReales({ enlaceDeBaja });
  return dependencias;
}
