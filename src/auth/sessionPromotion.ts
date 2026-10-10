// Writing back onto the session row what has just been proved on it:
// promoting the session that showed a factor, sealing that proof onto a row
// there was nothing left to promote, and — for an account with no factor at
// all — stamping the password confirmation that opens the ten-minute step-up
// window.
//
// Every write here is on `sesiones`. Nothing in this module touches
// `usuarios`, and the tombstone at the foot of the file says why that is now
// a rule rather than an accident.
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
import { STEP_UP_WINDOW_MINUTES } from "../config/security.js";
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
 * Mark that this session has just confirmed its password.
 *
 * 🔴 **It does not re-seal inside the window, and the `WHERE` is what makes
 * that true.** The promise this implements is "ten fixed minutes, which do not
 * renew themselves": without the age clause, every confirmation moves the date
 * forward, and a caller that re-confirmed its password would hold the window
 * open for as long as somebody kept working. Ten minutes that never end is not
 * the decision the owner of this project took. Since the gate consults the
 * window before it ever asks for a password, a request that reaches this call
 * normally finds the window already closed; the clause covers two requests
 * that confirm at the same moment, and any future caller that skips the
 * gate's own check.
 *
 * **Only the factor-less branch of `requireStepUp` calls it.** An account that
 * *has* a factor gains no window by typing its password (the only way such an
 * account reaches the password branch is `toleraFactorIlegible`, and there the
 * gate does not call this). If it did, that account could prove its factor once
 * in the life of a session and then keep the routes that register and delete
 * credentials open on the password alone — which is what the separate column
 * (§5 of the reauthentication design) exists to prevent.
 *
 * **`revoked_at: null` in the `WHERE` and not only `id`**, matching every
 * other write in this file: a revoked row must not come back holding fresh
 * proof of anything. `findLiveSession` would refuse it anyway, so this is the
 * second lock rather than the only one.
 *
 * **The window is stamped even when the operation behind the gate then fails
 * — a 404, a 409, a validation error.** That is deliberate, and it is the
 * question every reader of this function asks: what the window certifies is
 * *who you are*, not whether the thing you tried to do made sense. Somebody
 * who typed their password correctly and then hit a stale row has
 * re-authenticated exactly as much as somebody whose write succeeded, and
 * making the ten minutes conditional on the controller's answer would ask
 * them to prove it again for having been unlucky.
 *
 * Returns whether a row actually changed — `false` both for "there is no such
 * live session" and for "this session is already inside its window". The
 * caller today ignores it; it is returned for the same reason
 * `sellarPruebaDeFactor` returns one, which its own docstring gives.
 */
export async function sellarContrasena(id_sesion: string): Promise<boolean> {
  const limite = new Date(Date.now() - STEP_UP_WINDOW_MINUTES * 60_000);
  const [count] = await SesionModel.update(
    { password_confirmed_at: new Date() },
    {
      where: {
        id: id_sesion,
        revoked_at: null,
        [Op.or]: [
          { password_confirmed_at: null },
          { password_confirmed_at: { [Op.lt]: limite } },
        ],
      },
    },
  );
  return count > 0;
}

// `apagarLaMecha` vivía aquí y ponía `usuarios.mfa_grace_until` a NULL al
// registrar un factor. Borrada el 2026-09-08: era la causa del bucle que
// regalaba catorce días nuevos cada vez que alguien registraba un factor y lo
// borraba. Con la columna en NULL, `estadoInicialDeSesion` lee "el reloj no ha
// empezado nunca" y el siguiente login estampa un plazo entero; la vuelta más
// barata era una passkey, que no necesita buzón. Sin esta función la fecha
// original sobrevive, y ese mismo login la lee: vencida → `onboarding`, viva →
// `completa` sin volver a estamparla.
//
// Se descartó la alternativa —una columna `mfa_grace_started_at` que recordase
// que el plazo ya se gastó— porque rompía en silencio tres cosas: la gracia de
// rescate de 24 h (`proximaGraciaDeRescate`, en `rescueCore.ts`, devuelve NULL
// para un plazo NULL, y el administrador se queda sin ninguna palanca), el
// indulto manual documentado en el docblock de `estadoInicialDeSesion`
// (`factorInventory.ts`), y la capacidad de `estadoEfectivo` de estrechar una
// sesión viva. Además confiscaba el saldo legítimo de quien borrase su factor
// a los cuatro días. Borrar la función es menos código y conserva las tres.
//
// Dos costes conocidos, los dos reales, y el segundo es el común.
//
// **Uno: se pide el factor una vez de más.** A la cuenta que registra su
// factor **dentro** del plazo le queda una fecha futura en la columna, así que
// una sesión suya que no haya probado ningún factor —la que abre quien marcó
// «recordar este equipo», porque `esPruebaDeFactor` declara que
// `'dispositivo'` no es prueba— se estrecha a `onboarding` el día que esa
// fecha vence. La salida está abierta a `onboarding`:
// `POST /api/auth/mfa/verify` para un TOTP, un código por correo o un código
// de recuperación, y `POST /api/auth/webauthn/login/verify` para una passkey.
// Las dos promueven la sesión que pruebe algo, y hacen falta las dos:
// `/mfa/verify` **no verifica passkeys** —sus ramas son `totp`, `correo` y
// `codigo`—, así que quien solo tenga una llave saldría por ahí únicamente
// gastando uno de sus diez códigos.
//
// **Dos: reemplazar tu propio último factor cuesta cero horas de plazo, y eso
// es lo correcto.** Marta entra el 1 de marzo, se le estampa el plazo hasta el
// 15, y el 4 registra una passkey. En septiembre cambia de portátil y la
// borra: `deleteCredential` le revoca todas las sesiones, vuelve a entrar, y
// el 15 de marzo hace mucho que pasó → `onboarding`, sin margen ninguno.
// Antes, la columna vaciada el 4 de marzo le habría dado catorce días. Lo
// mismo le pasa a quien tiene el correo como único factor y cambia
// legítimamente de dirección. Es lo honesto: acaba de borrar su único factor,
// así que no tiene ninguno, y `onboarding` es ese estado — devolverle catorce
// días por borrar sería reabrir el bucle que esta lápida cierra. Y no es una
// puerta cerrada: `ONBOARDING_EXTRA` (`sessionState.ts`) abre justo las tres
// rutas que registran uno nuevo — `/api/auth/totp`,
// `/api/auth/webauthn/register` y `/api/auth/email`. (`/api/auth/recovery-codes`
// también está abierta, pero los códigos no son un factor: son la vuelta cuando
// uno de verdad no se puede alcanzar.)
//
// 🔴 **El riesgo que queda, y hay que decirlo:** de esas puertas, el TOTP
// exige antes el correo verificado (409, ver `MENSAJE_CORREO_NO_VERIFICADO`) y
// el correo exige relé de correo, así que a quien caiga aquí **sin navegador
// compatible con passkeys y sin correo entregable** no le queda ninguna, y
// hace falta consola. Ese caso ya existía; lo que cambia es que ahora llega
// más gente a `onboarding`. La palanca sigue siendo
// `UPDATE usuarios SET mfa_grace_until = NULL` — el indulto manual del
// docblock de `estadoInicialDeSesion`, y ya el único sitio que vacía la
// columna.
