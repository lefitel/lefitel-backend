// Promoting the session that just proved a factor, and turning off the
// fourteen-day clock the first time an account registers one.
//
// **Why this file has to exist.** `estadoEfectivo` (`sessionState.ts`) opens
// with `if (guardado !== "completa") return guardado` — it only ever
// narrows. A session stored as `parcial` or `onboarding` stays exactly that
// for the rest of its life unless something writes `completa` back into the
// row. Nothing did, anywhere in `src/`, until this module: hallazgo D2 is
// the technician on day 15 who scans the QR, types the code, and is told
// "configure your second factor" right back, forever, because confirming a
// factor and promoting the session that confirmed it were never the same
// write. This module is that write.

import { Op } from "sequelize";
import type { Transaction } from "sequelize";
import { SesionModel } from "../models/sesion.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import type { EstadoSesion } from "./sessionState.js";

/**
 * The ways a session can end up having proved a factor.
 *
 * `"passkey"` **is** a member as of 2026-09-02, and it was withheld until
 * that day on purpose. `sesiones_mfa_source_chk` (migration
 * `20260826000002`) has allowed the word at the database level since the
 * schema was built, so the union could have carried it from the start; it did
 * not, so that any code writing `'passkey'` before there was an endpoint able
 * to verify one would be a **compile error** instead of a session promoted on
 * a factor nobody had proved. Plan 4C is what makes it verifiable, and it
 * arrives with the endpoint, not ahead of it.
 *
 * The rule that outlives that guard, unchanged: this union may be **narrower**
 * than the CHECK but never wider. Narrower is safe — Postgres still refuses
 * anything neither allows. Wider means a value that type-checks here fails the
 * INSERT with a raw constraint error in the middle of a login.
 */
// Declared in `sessionState.ts`, which owns the session vocabulary and is the
// module that *reads* this column. Re-exported so existing importers of this
// file keep working.
export type { FuenteMfa } from "./sessionState.js";
import type { FuenteMfa } from "./sessionState.js";

/**
 * States that a live proof of a factor lifts. Both are named because
 * `estadoInicialDeSesion` can open a session in either one — this is not
 * only about the technician who never registered anything (`parcial`); it is
 * just as much about the one who did, watched the fourteen days run out, and
 * is still owed a way out the moment they finish. Hallazgo C15's own table
 * names only `'parcial'` for this row — that was written before Decision 8
 * settled the point; this plan supersedes it on purpose (see the plan's
 * Task 5 and Decision 8).
 */
const ESTADOS_PROMOVIBLES: readonly EstadoSesion[] = ["parcial", "onboarding"];

/**
 * Ascend the caller's own session to `completa` once it has proved a factor.
 *
 * `id_sesion` **must** be `req.user.id_sesion` — the id `authenticate`
 * already put there after validating the session cookie — and never
 * anything read from a request body. There is deliberately no `id_usuario`
 * parameter here to cross-check that against: unlike `revokeSessionOf`,
 * which takes a session id out of a URL segment that any caller could type,
 * this function's only input is a session id that has no legitimate source
 * other than the caller's own authenticated cookie. A route that read it
 * from `req.body` instead would let anybody hand in a stranger's session id
 * and promote it out from under them — the WHERE below offers no other
 * protection than trusting that `id_sesion` names exactly the row it claims
 * to, which is the caller's job to guarantee, not this function's to verify.
 *
 * `estado IN ('parcial', 'onboarding')` in the same `WHERE` does two jobs:
 *
 * - it is the reason this function exists at all — Decision 8's actual path
 *   out of both states a session can be stuck in, not only the one hallazgo
 *   C15's table happened to name; and
 * - it makes a repeat call harmless. A session already `completa` matches
 *   nothing, so confirming a factor twice — a legitimate retry after a
 *   dropped response, say — never re-stamps `mfa_satisfied_at` over a
 *   session that was already satisfied.
 *
 * Returns whether a row actually changed, which is exactly what
 * `revokeSessionOf` returns and for the same reason: the caller can tell
 * "there was nothing left to promote" apart from "this worked".
 */
/**
 * Both operations take an optional `transaction`, and the reason is a
 * composition neither of them can see from here.
 *
 * Spending a recovery code and sealing the session it just proved have to
 * commit or fail **together**: if the code is consumed and the seal is not, the
 * person burned one of ten and has no trace of why. `recoveryCodeStore.ts`'s
 * `gastarCodigo` already accepts one for exactly this, and without the same
 * parameter here the pair cannot be closed — which is what the agent who built
 * that store stopped to say rather than reaching into this file.
 *
 * Optional rather than required, because the TOTP path has nothing to compose
 * with: it verifies and promotes, and one statement needs no transaction.
 */
export async function promoverSesion(
  id_sesion: string,
  fuente: FuenteMfa,
  opciones: { transaction?: Transaction } = {},
): Promise<boolean> {
  const [count] = await SesionModel.update(
    { estado: "completa", mfa_satisfied_at: new Date(), mfa_source: fuente },
    {
      where: { id: id_sesion, estado: { [Op.in]: [...ESTADOS_PROMOVIBLES] } },
      transaction: opciones.transaction,
    },
  );
  return count > 0;
}

/**
 * Seal this exact session as having just proved a factor, whatever `estado`
 * the row is stored as. **Not a replacement for `promoverSesion` and never
 * called in its place** — see `confirmTotp` in `totp.controller.ts` for the
 * one gap this fills, and why a parameter on `promoverSesion` was rejected
 * for it.
 *
 * `promoverSesion`'s `WHERE estado IN (...)` is not an oversight to route
 * around: it is what its own docstring says makes a retry of that function
 * harmless — a session already `completa` matches nothing, so confirming a
 * factor twice never re-stamps `mfa_satisfied_at` over one already
 * satisfied. Widening that WHERE, or adding a flag that bypasses it, would
 * hand every future caller of `promoverSesion` — today the recovery-code
 * path, tomorrow whatever proves a factor next — the option of also
 * re-stamping an already-satisfied session, which is exactly the footgun
 * that WHERE exists to rule out. Composing two functions with narrow,
 * separate contracts keeps that guarantee intact for everyone who calls
 * `promoverSesion` and gives `confirmTotp` a tool whose only job is
 * "whatever this row's `estado` is, it must come away holding fresh proof".
 *
 * **What forces this to exist at all — hallazgo F2/B-1.**
 * `estadoInicialDeSesion` (`factorInventory.ts`) can open a brand-new
 * session as `completa` for an account that has no factor yet but is still
 * inside its fourteen-day grace period. When that account then registers
 * its first factor, `promoverSesion`'s WHERE matches nothing — the row was
 * never `parcial` or `onboarding` — so it returns `false` and writes
 * nothing. Without this function, `mfa_satisfied_at` would never be sealed
 * on that session, and `requireStepUp` would refuse it step-up for the rest
 * of its life: the very account that registered its factor *on time* ends
 * up locked out of the screen it just used, while somebody who registers
 * late (session opened `onboarding`) goes through `promoverSesion` normally
 * and is fine. This function is the other half of that same write, for the
 * one case `promoverSesion` was never meant to cover.
 *
 * 🔴 **And deliberately not narrowed to `{ id, id_usuario, estado }`.** Plan
 * 4C proposed exactly that, to match the ownership triple `mfa.controller.ts`
 * uses when it seals a step-up. The triple buys nothing here — `id_sesion`
 * arrives from `req.user`, which `authenticate` read off the same row as the
 * user id, so there is no request-controlled input on the path — and it costs
 * something real: this function returns `void`, so a `WHERE` that stops
 * matching becomes an unobservable no-op. The caller would answer "Identidad
 * confirmada", stamp nothing, and send somebody back into the same 403 for
 * ever. Narrow it only together with a boolean return that **both** callers
 * read, the way `mfa.controller.ts` checks `count > 0` before it believes its
 * own write. Note too that a revoked session still reads `estado = 'completa'`
 * — revocation writes `revoked_at` — so the clause would not even mean what it
 * looks like it means.
 *
 * **Returns whether the row was there**, which most callers may ignore and one
 * may not: the recovery-code path in `mfa.controller.ts` spends one of ten
 * printed codes in the same transaction, and has to roll that back if there
 * turned out to be no session to seal. A `void` here made that impossible to
 * express, which is also why narrowing this `WHERE` was refused above.
 *
 * **Deliberately does not touch `estado`.** Both callers — `confirmTotp` and,
 * since plan 4C, `loginVerify` — invoke this only after `promoverSesion` has
 * already returned `false`, which — given the three session states — means
 * this row is already `completa` (or the session is gone). There is no state
 * left to promote here, only proof left to record.
 */
export async function sellarPruebaDeFactor(
  id_sesion: string,
  fuente: FuenteMfa,
  opciones: { transaction?: Transaction } = {},
): Promise<boolean> {
  const [count] = await SesionModel.update(
    { mfa_satisfied_at: new Date(), mfa_source: fuente },
    { where: { id: id_sesion }, transaction: opciones.transaction },
  );
  return count > 0;
}

/**
 * Turn off the fourteen-day clock: clear `usuarios.mfa_grace_until`.
 *
 * This is the write `factorInventory.ts`'s own docblock asks 4B for by
 * name, and it is the line this task is easiest to skip, because nothing
 * breaks the moment it is missing — `estadoEfectivo`'s clause 3 already
 * keeps a freshly-promoted session `completa` regardless of the deadline.
 * What breaks is later and quieter: `mfa_grace_until` is stamped once, at an
 * account's first login after deploy, and until this function existed
 * **nothing in `src/` ever cleared it again**. So somebody who registers
 * their factor on day 3 still carries a deadline that reads "overdue" from
 * day 15 onward — dead as a lockout only because clause 3 also checks
 * `mfa_satisfied_at`, but a landmine for the next piece of code that reads
 * `mfa_grace_until` on its own and treats a past date as "no factor, still
 * chasing this account".
 *
 * Called once, when an account's *first* factor is confirmed — see the
 * caller in the TOTP confirm controller. Unconditional `SET ... = NULL`
 * rather than a read-then-write: an account with no deadline stored has
 * nothing to clear, and overwriting NULL with NULL costs nothing and needs
 * no prior read to decide whether to run.
 */
export async function apagarLaMecha(
  id_usuario: number,
  opciones: { transaction?: Transaction } = {},
): Promise<void> {
  await UsuarioModel.update(
    { mfa_grace_until: null },
    { where: { id: id_usuario }, transaction: opciones.transaction },
  );
}
