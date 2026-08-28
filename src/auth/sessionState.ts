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
 * Every state there is — **derived from `PERMITIDAS`, not written out again.**
 *
 * This used to be a hand-written literal typed `readonly EstadoSesion[]`, and
 * that type accepts being *incomplete*: adding a fourth member to
 * `EstadoSesion` compiles perfectly well without anybody touching the list, and
 * then everything iterating it skips the new state in silence. The victim is
 * the containment test in `sessionState.test.ts`, whose entire job is to go red
 * when a new state breaks the narrowing invariant — it would have kept passing
 * while the property it names was already false, which is the exact failure
 * that test was rewritten to stop having.
 *
 * `PERMITIDAS` is a `Record<EstadoSesion, …>`, so a fourth state is a
 * compile error *there*, at the one place that must be updated anyway. Taking
 * the keys from it means the list cannot go stale on its own.
 *
 * The `as EstadoSesion[]` is on `Object.keys`, which TypeScript types as
 * `string[]` for sound reasons that do not apply to an object literal declared
 * two lines up. It buys a compile-time guarantee rather than hiding one: the
 * alternative is the literal that was here before, which had no cast and no
 * guarantee either.
 */
export const ESTADOS_SESION: readonly EstadoSesion[] = Object.keys(PERMITIDAS) as EstadoSesion[];

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
 * ---
 *
 * **`mfa_grace_until` in the past does not mean "this account has no factor".**
 * It means "the configuration deadline went by", and **nothing in `src/` ever
 * clears or moves that column again**: its only writer (`auth.controller.ts`)
 * fires solely when `estadoInicialDeSesion` hands back a date, and the two
 * branches that matter — an account that has a factor, and a deadline already
 * decided — both hand back `null`, which means "leave the column alone". Once
 * the stamp is in the past it is in the past for ever, on every account,
 * including the ones that did exactly what was asked of them.
 *
 * A first version of this function narrowed on that stamp alone, and the
 * consequence was a permanent lockout waiting for plan 4B to arm it: register a
 * factor on day 20, prove it, have the session promoted to `completa` — and the
 * next request reads a deadline still sitting on day 14 and answers 403 to the
 * whole ERP, on an account that has complied in full. Logging out and back in
 * returns to the same place. There is no way out from inside the API.
 *
 * **So the question is not "has the deadline passed" but "is this session one
 * the deadline is even about".** The deadline chases accounts that have
 * registered nothing; for an account that has a factor there is nothing left to
 * onboard, and `onboarding` is not a narrower truth about it, it is a false one.
 * Three things on the session row itself answer that, and every one of them is
 * already in `findLiveSession`'s projection, so the answer still costs **zero
 * queries**:
 *
 * 1. **The stored state is not `completa`.** Not this rule's business — see
 *    below for why `parcial` in particular must never be moved.
 * 2. **The session was opened after the deadline had already gone by.** Then its
 *    own login cannot have concluded "no factor, still in grace": with the
 *    deadline past, `estadoInicialDeSesion` answers `onboarding` for an account
 *    with nothing registered and `parcial` for one with a factor — never
 *    `completa`. A `completa` row created after its own deadline can therefore
 *    only have been promoted there by something that verified a factor. **This
 *    clause needs nothing at all from 4B**, which is the point of it: it holds
 *    even if the endpoint that promotes the session writes nothing but `estado`.
 *
 *    **It is not hermetic, and the gap is written down rather than coded
 *    around.** `estadoInicialDeSesion` is judged against an `ahora` read in the
 *    controller, while `created_at` is a *second* reading of the clock, taken
 *    inside `createSession` when the row is inserted. A login that begins a
 *    hair before the deadline instant and inserts a hair after it comes out
 *    `completa` with `created_at >= limite`, and this clause then exempts that
 *    session for the rest of its life. The window is the microseconds between
 *    those two reads, and aiming at it would mean knowing the account's
 *    deadline to the millisecond, which nothing exposes — `/auth/me` publishes
 *    `estado` and deliberately not `mfa_grace_until`. Closing it would mean
 *    threading a single clock through the login for a gap nobody can aim at;
 *    the honest trade is to leave it and say so, so that nobody later reads
 *    this clause as a proof.
 * 3. **The row carries evidence that a factor was involved.**
 *    `mfa_satisfied_at` is stamped only by a live proof of a factor, and
 *    `mfa_source` names which kind — including `dispositivo`, a remembered
 *    device, which can only exist for an account that proved a factor once to
 *    have the device remembered. Either one present means the account has a
 *    factor, and an account with a factor has nothing to onboard.
 *
 * **No time window on `mfa_satisfied_at`, and that is deliberate.**
 * `requireStepUp` measures the same column against `STEP_UP_WINDOW_MINUTES`,
 * and copying that here would be a disaster: ten minutes after proving their
 * factor, a legitimately authenticated person would be dropped into
 * `onboarding` and told to go configure the thing they had just configured. The
 * two questions are different. Step-up asks "was a factor proved *recently
 * enough* to authorise this write"; this asks "does this account have a factor
 * at all", and the answer to that does not expire.
 *
 * **What this still leaves to 4B, said plainly.** Clause 3 depends on the
 * endpoint that verifies a factor stamping `mfa_satisfied_at`, which is the
 * column's entire declared purpose and which it cannot skip without breaking
 * step-up loudly on the very next gated write. Clause 2 depends on nothing. And
 * if both were somehow missed, the result is no longer the inescapable lockout
 * described above: `onboarding` opens everything `parcial` opens **plus six**,
 * `/api/auth/mfa` and `/api/auth/webauthn/login` among them, so the endpoint
 * that verifies a factor is still reachable and a second attempt still gets out.
 * Degraded, not sealed shut.
 *
 * **And a request to 4B that is not load-bearing:** when an account registers
 * its first factor, clear `usuarios.mfa_grace_until`. `estadoInicialDeSesion`'s
 * own first branch already says a date in that column "reads as: this account is
 * still being chased", and after registration it is not. That is data hygiene
 * and a third line of defence; the two clauses above do not wait for it.
 *
 * ---
 *
 * **It only ever narrows, and that is the property that makes it safe to run in
 * front of the entire API.** The only move it makes is `completa` → `onboarding`,
 * and `PERMITIDAS` above makes that strictly a narrowing: `completa` is `"todo"`
 * and `onboarding` is a list. So the worst a bug in here can do is refuse
 * somebody who should have been let through, never let somebody through who
 * should have been refused.
 *
 * **The other two states are returned untouched, and `parcial` especially must
 * be.** `onboarding` is `[...PARCIAL, ...ONBOARDING_EXTRA]`, i.e. a strict
 * superset of what `parcial` opens, so "recompute every state" would *widen*
 * what a `parcial` session reaches the moment a deadline it has nothing to do
 * with went by. `parcial` means the account has a factor and has not proved it,
 * which no clock changes. A stored `onboarding` is likewise left alone: it is
 * already the narrow answer, and the way out of it is registering a factor and
 * having the endpoint that did it promote the row — which clause 3 above then
 * respects on every later request.
 *
 * **What it deliberately does not ask.** Whether the *account* has a factor,
 * as opposed to whether this session shows signs of one. Answering that means
 * `tieneAlgunFactor`, which is two COUNTs against two more tables, charged to
 * **every request in the ERP**, to catch a transition that happens at most once
 * per account. The deadline and the three clauses above cost nothing:
 * `authenticate`'s `currentUser` already reads `usuarios`, and `findLiveSession`
 * already reads every session column used here.
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
  // The session row as `findLiveSession` returns it, not four loose arguments:
  // every field here is a fact about *this session*, and taking them together
  // keeps a caller from supplying three of them and forgetting the fourth.
  sesion: {
    estado: EstadoSesion;
    created_at: Date;
    mfa_satisfied_at: Date | null;
    mfa_source: string | null;
  },
  // `undefined` as well as `null`, for the same reason `estadoInicialDeSesion`
  // spells both out: `IUsuario` declares `mfa_grace_until?: Date | null`, and
  // the projection this value arrives through can legitimately not carry it.
  mfa_grace_until: Date | null | undefined,
  ahora: Date,
): EstadoSesion {
  const guardado = sesion.estado;
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
  if (limite > ahora.getTime()) return guardado;

  // Clause 3: any sign that a factor was involved in this session at all. No
  // window on either — see the docstring for why borrowing `requireStepUp`'s
  // ten minutes here would throw people out of the session they had just
  // authenticated.
  //
  // `!= null` and **not** `!== null`, the same loose comparison its two
  // siblings above and below use, and for the same reason pointing the same
  // way: a column that is *missing* rather than NULL must read as "no
  // evidence" and let the row narrow. Written strictly, an absent column reads
  // as evidence and switches this whole rule off — failing open, on the one
  // check here whose job is to decide whether the rule applies at all.
  // `strictNullChecks` is off in this project, so nothing stops such a row
  // being built, and the shared fixture in `app.auth.test.ts` already omits
  // `mfa_source`.
  if (sesion.mfa_satisfied_at != null || sesion.mfa_source != null) return guardado;

  // Clause 2: opened after the deadline had already gone by, so its `completa`
  // cannot have come from a login that found grace left.
  //
  // **Written as the exemption and not as the refusal, and that is the whole
  // safety of it.** An unreadable `created_at` gives `NaN`, and every
  // comparison against `NaN` is `false` — so asking "is this session exempt"
  // answers no and the row narrows, while the mirror-image spelling
  // (`creadaEn < limite` → narrow) would answer no to *that* and let a row this
  // function cannot read walk past the rule entirely. Same operands, opposite
  // failure, and it is the direction rather than any guard that decides which:
  // an explicit `Number.isFinite` in front of this changes nothing and was
  // removed after a mutation proved it dead. `authenticate` refuses an
  // unparseable `created_at` long before this runs, so the case is unreachable
  // from there; this function is exported and does not get to assume that.
  const creadaEn = sesion.created_at == null ? NaN : new Date(sesion.created_at).getTime();
  if (creadaEn >= limite) return guardado;

  return "onboarding";
}

/** Shown to somebody in `onboarding` who reached for the ERP. In Spanish: they read it. */
export const MENSAJE_FACTOR_PENDIENTE =
  "Configura tu segundo factor de autenticación para continuar.";
