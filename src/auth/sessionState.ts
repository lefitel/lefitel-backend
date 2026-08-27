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

/**
 * The state actually in force right now, as opposed to the one the login wrote
 * into the session row however many days ago.
 *
 * **This exists because the stored one is a photograph.** `estadoInicialDeSesion`
 * (`auth/factorInventory.ts`) decides a state once, at login, and `createSession`
 * writes it down. Nothing rewrote it afterwards and nothing revoked a session
 * when its account's `mfa_grace_until` passed — so somebody who logged in on day
 * 13 of their grace period was still `completa` on day 15, and stayed `completa`
 * for as long as that session lived. And `authenticate` keeps pushing the idle
 * expiry back for as long as the session goes on being used — throttled to at
 * most once every `SESSION_TOUCH_THROTTLE_MINUTES`, which over a working day
 * still amounts to being renewed all day — so "as long as it lived" means all
 * the way to the absolute ceiling `findLiveSession` enforces:
 * `SESSION_ABSOLUTE_DAYS` from the day the session was **opened**, which for one
 * opened inside the grace period lands a fortnight to a month past the deadline.
 * On an account with no second factor, and a stolen cookie inherits every day of
 * it. The whole point of the state machine is to impose a date; without this
 * function the date was imposed on nobody who was already logged in.
 *
 * **It only ever narrows, and that is the property that makes it safe to run in
 * front of the entire API.** The only move it makes is `completa` → `onboarding`,
 * and `PERMITIDAS` above makes that strictly a narrowing: `completa` is `"todo"`
 * and `onboarding` is a list. So the worst a bug in here can do is refuse
 * somebody who should have been let through — loud, and undone by logging out and
 * back in — never let somebody through who should have been refused.
 *
 * **The other two states are returned untouched, and `parcial` especially must
 * be.** `onboarding` is `[...PARCIAL, ...ONBOARDING_EXTRA]`, i.e. a strict
 * superset of what `parcial` opens, so "recompute every state" would *widen*
 * what a `parcial` session reaches the moment a deadline it has nothing to do
 * with went by. `parcial` means the account has a factor and has not proved it,
 * which no clock changes. A stored `onboarding` is likewise left alone: it is
 * already the narrow answer, and the two ways out of it are registering a
 * factor — a write at the moment it happens, for plan 4B to make — or logging in
 * again, which is what the reprieve in `estadoInicialDeSesion` documents.
 *
 * **What it deliberately does not ask.** Whether the account has since
 * registered a factor, i.e. whether a stored `onboarding` has earned `completa`
 * back. Answering that means `tieneAlgunFactor`, which is two COUNTs against two
 * more tables, charged to **every request in the ERP**, to catch a transition
 * that happens at most once per account and that nothing in `src/` can even
 * cause yet (no code writes those tables until plan 4B). The deadline, by
 * contrast, costs nothing: `authenticate`'s `currentUser` already reads
 * `usuarios` on every request, so `mfa_grace_until` is one more name in a
 * projection that was being fetched anyway — zero extra round trips.
 *
 * **Nothing is written back.** The answer is computed from the row on each
 * request and thrown away. Storing it would make it a second photograph, which
 * is the defect being fixed, and would put an UPDATE on the read path of every
 * request in the API.
 *
 * `<=` matches `estadoInicialDeSesion`'s own comparison exactly: the stored
 * instant is when the grace is over, so the millisecond it names is already past
 * it — and a login and a request landing on that same millisecond have to agree.
 */
export function estadoEfectivo(
  guardado: EstadoSesion,
  // `undefined` as well as `null`, for the same reason `estadoInicialDeSesion`
  // spells both out: `IUsuario` declares `mfa_grace_until?: Date | null`, and
  // the projection this value arrives through can legitimately not carry it.
  mfa_grace_until: Date | null | undefined,
  ahora: Date,
): EstadoSesion {
  if (guardado !== "completa") return guardado;

  // An unreadable deadline leaves the state alone, and that is the same answer
  // `estadoInicialDeSesion` gives it — "the clock never started", which is what
  // NULL genuinely means here: every account has NULL in this column until its
  // first login after the deploy, and NULL again after the documented reprieve
  // (`UPDATE usuarios SET mfa_grace_until = NULL`). Reading NULL as "the
  // deadline passed" would 403 the whole company on deploy day and would turn
  // that reprieve into its opposite.
  //
  // The cost of being wrong in this direction is that a projection which
  // stopped naming the column would switch this rule off silently — the exact
  // failure a mutation test found for `pass_changed_at`. What catches it is
  // that `authenticate.test.ts` mocks `findByPk` **through the projection**, so
  // dropping `"mfa_grace_until"` from `attributes` and dropping the column from
  // the row are the same event there, and the test named for this rule goes
  // red. There is no answer available here that is both safe and correct for
  // NULL, so the tripwire is at the seam instead.
  const limite = mfa_grace_until == null ? NaN : new Date(mfa_grace_until).getTime();
  if (Number.isNaN(limite)) return guardado;

  return limite <= ahora.getTime() ? "onboarding" : guardado;
}

/** Shown to somebody in `onboarding` who reached for the ERP. In Spanish: they read it. */
export const MENSAJE_FACTOR_PENDIENTE =
  "Configura tu segundo factor de autenticación para continuar.";
