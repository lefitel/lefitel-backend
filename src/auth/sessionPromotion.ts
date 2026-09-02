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
 * `"passkey"` is deliberately not a member: passkeys are plan 4C's, by
 * Isaias's decision of 2026-09-01. `sesiones_mfa_source_chk` (migration
 * `20260826000002`) already allows the word `'passkey'` at the database
 * level — the CHECK's vocabulary is the four sources the schema was built
 * for, not the three this plan writes. This union is a **subset** of that
 * CHECK and must stay one: it is safe for the application's vocabulary to be
 * narrower than the column's, because Postgres still refuses anything
 * neither one allows, but it must never be wider, or a value that type-checks
 * here would fail the INSERT with a raw constraint error in the middle of a
 * login. Add `"passkey"` here the day 4C starts writing it, not before.
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
