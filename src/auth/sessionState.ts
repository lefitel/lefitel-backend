// Which doors each session state opens.
//
// **This file is what stops the second factor being decorative.** Until it
// existed, `authenticate` answered one question — is this cookie a live
// session — and a session created the instant a password was accepted was
// indistinguishable from one that had proved a factor. The state has to be
// read, and read here, in one allowlist rather than in an `if` scattered
// across thirty controllers: an allowlist that lives in one constant can be
// audited by reading it, and one spread across route files can only be audited
// by reading all of them.
//
// Allowlist and not blocklist, and the difference is the next route somebody
// mounts: a blocklist forgets it, an allowlist refuses it.

// Re-exported, not redeclared: `interfaces/index.ts` declares this union
// because `interfaces/` cannot depend on `auth/` (the dependency would run
// backwards), and this module is the one place callers should get it from. A
// second, independent declaration of the same three strings is the bug this
// comment exists to prevent — two types that agree today and drift the day
// somebody adds a fourth state.
export type { EstadoSesion } from "../interfaces/index.js";
import type { EstadoSesion } from "../interfaces/index.js";

export const ESTADOS_SESION: readonly EstadoSesion[] = ["parcial", "onboarding", "completa"];

/** What a session with a password behind it and no factor may reach. */
const PARCIAL: readonly string[] = [
  "/api/auth/mfa",
  "/api/auth/webauthn/login",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/auth/me",
];

/** What `onboarding` adds: the doors that let somebody finish setting up. */
const ONBOARDING_EXTRA: readonly string[] = [
  "/api/auth/email",
  "/api/auth/totp",
  "/api/auth/webauthn/register",
  "/api/auth/webauthn/credentials",
  "/api/auth/recovery-codes",
  "/api/auth/sessions",
];

const PERMITIDAS: Record<EstadoSesion, readonly string[] | "todo"> = {
  parcial: PARCIAL,
  onboarding: [...PARCIAL, ...ONBOARDING_EXTRA],
  completa: "todo",
};

/**
 * Segment-aware prefix match. `/api/auth/me` opens `/api/auth/me` and
 * `/api/auth/me/anything`, and does **not** open `/api/auth/mefoo` — which a
 * bare `startsWith` would, handing a partial session any route somebody later
 * mounts under a name that shares an allowed prefix.
 */
function coincide(ruta: string, permitida: string): boolean {
  return ruta === permitida || ruta.startsWith(`${permitida}/`);
}

export function puedeAlcanzar(estado: EstadoSesion, ruta: string): boolean {
  const permitidas = PERMITIDAS[estado];
  if (permitidas === "todo") return true;
  const limpia = ruta.split("?")[0];
  return permitidas.some((p) => coincide(limpia, p));
}

/** Shown to somebody in `onboarding` who reached for the ERP. In Spanish: they read it. */
export const MENSAJE_FACTOR_PENDIENTE =
  "Configura tu segundo factor de autenticación para continuar.";
