// Whether this username and this password are good, and nothing else.
//
// This is the whole of the old `POST /api/login` handler's body except the
// HTTP: the uniform
// message, the filler hash that levels the timings, the per-account lockout
// with its atomic counter, the cost re-hash, and the case-folded lookup. Seven
// tasks of an earlier plan went into those, and every one of them is a decision
// that looks removable from the outside — which is exactly why there must be
// one copy of it.
//
// It was extracted when there were two front doors: the old `POST /api/login`,
// which handed out a JWT, and `POST /api/auth/login`, which hands out a session
// cookie. Copying this into the second one would have worked on the first day
// and drifted by the third — the likeliest thing to be left behind is the
// lockout, because it is the only part with no visible effect on a successful
// login. The two doors have since been merged onto one handler, so this has one
// caller again; the reasoning is what keeps it a separate function rather than
// being folded back into it, because the next endpoint that needs to check a
// password is the second copy this exists to prevent.
//
// It returns a result rather than writing a response, so its caller decides its
// own status codes and cannot accidentally say something different about *why* a
// login failed. There is only one "why" here on purpose.

import bcryptjs from "bcryptjs";
import { UsuarioModel } from "../models/usuario.model.js";
import { logAction } from "../utils/logAction.js";
import {
  BCRYPT_COST,
  CREDENCIALES_INCOMPLETAS,
  CREDENCIALES_INVALIDAS,
  bcryptCostOf,
  fillerHash,
} from "../config/security.js";
import { estaBloqueada, siguienteBloqueo } from "../middleware/loginLimiters.js";
import { whereUsernameIs } from "../utils/username.js";

/**
 * Everything a caller may learn about the account it just let in.
 *
 * Curated rather than `dataValues`: the row also carries the password hash,
 * `failed_attempts` and `locked_until`, and both callers put this object
 * straight into a `res.json`. An explicit shape is what stops the next column
 * added to `usuarios` from being published by accident.
 */
export interface UsuarioAutenticado {
  id: number;
  id_rol: number;
  user: string;
  name: string;
  lastname: string;
  image: string | null;
}

/**
 * Either the person, or the one sentence they get told.
 *
 * The failure carries its message instead of a code the callers would each map
 * to text of their own — two doors that word the same refusal differently is
 * how the uniform message stops being uniform.
 *
 * Both arms name both fields, one of them as `?: undefined`. That is not
 * decoration: `tsconfig.json` has `strictNullChecks` off, and without it
 * TypeScript will not narrow a union by the truthiness of its discriminant, so
 * `if (!check.ok) { check.message }` does not compile against a union whose
 * arms have different keys. Declared this way, both keys exist on the union and
 * the exclusivity is still written down for whoever reads it.
 */
export type ResultadoCredenciales =
  | { ok: true; usuario: UsuarioAutenticado; message?: undefined }
  | { ok: false; usuario?: undefined; message: string };

/**
 * Is this the right password for this account?
 *
 * Takes plain values rather than a `Request` so it can be reasoned about and
 * tested without an HTTP shape around it. `ip` is only used for the bitácora
 * lines: the whole point of reading those is telling one machine grinding one
 * account apart from a person mistyping their own.
 *
 * Throws nothing of its own. A database failure propagates, and the caller
 * turns it into a 500 — the same as before this was extracted.
 */
export async function verifyCredentials(input: {
  user: unknown;
  pass: unknown;
  ip: string | null;
}): Promise<ResultadoCredenciales> {
  /**
   * The username loses the spaces at its ends; the password loses nothing.
   *
   * Those are different decisions on purpose. A username is a name for a row:
   * "isaias" and "isaias " are meant to be the same person, and somebody who
   * pastes their name with a trailing space and is told "usuario inexistente"
   * has no way of seeing why. Spaces *inside* stay — `Omar Mita` is a real
   * account and trimming is not the same as stripping.
   *
   * A password is not a name, it is a secret, and every character in it counts.
   * Trimming one would silently accept a different secret than the one chosen,
   * shrink what an attacker has to guess, and lock out anybody whose password
   * legitimately starts or ends with a space.
   */
  const rawUser = input.user;
  const pass = input.pass;

  // Not a string is not a username. Sequelize takes an object in `where` as a
  // set of conditions, so refusing anything else here keeps a crafted body from
  // being read as a query instead of a value.
  if (typeof rawUser !== "string" || typeof pass !== "string") {
    return { ok: false, message: CREDENCIALES_INCOMPLETAS };
  }
  const user = rawUser.trim();
  if (user === "" || pass === "") {
    return { ok: false, message: CREDENCIALES_INCOMPLETAS };
  }
  const ip = input.ip;

  // Case-insensitively, the same way `usuarios_user_uniq` and the per-account
  // rate-limit bucket already were — see `whereUsernameIs`. This lookup was
  // the one place of the four that still compared bytes, and the people it
  // shut out were the ones whose stored name carries a capital: they typed it
  // in lower case, fell into the unknown-user branch, and got the same
  // "Usuario o contraseña incorrectos" a wrong password gets. Nothing told
  // them why, and there was no way around it.
  const TempUsuario = await UsuarioModel.findOne({ where: whereUsernameIs(user) });

  // The account not existing and the password being wrong must be
  // indistinguishable: same message, same status, same time. Comparing
  // against the filler hash costs the same as a real comparison and is what
  // makes the third of those true.
  if (!TempUsuario) {
    await bcryptjs.compare(pass, await fillerHash());
    return { ok: false, message: CREDENCIALES_INVALIDAS };
  }

  const data = TempUsuario.dataValues;

  // A locked account answers exactly like a wrong password, filler hash
  // included. Answering differently — or faster — turns the lockout into the
  // oracle the uniform message was meant to close.
  if (estaBloqueada(data)) {
    await bcryptjs.compare(pass, await fillerHash());
    return { ok: false, message: CREDENCIALES_INVALIDAS };
  }

  const confirmPass = await bcryptjs.compare(pass, data.pass);
  if (!confirmPass) {
    /**
     * A second compare that throws its result away, and it has to stay.
     *
     * The comparison above costs whatever the *stored* hash costs, and every
     * account in this database predates the rise from 8 to 12 until its owner
     * logs in successfully once. So a wrong password against a real account
     * answers in about 19 ms, while the two branches above — unknown name and
     * locked account — each pay one compare at BCRYPT_COST against the filler
     * and answer in about 228 ms. Twelve times slower. That is the same
     * enumeration oracle the filler hash was added to close, with the polarity
     * reversed: fast now means "this account exists". Two attempts per
     * candidate name and the median tells you, and two is below
     * LOCKOUT_AFTER_FAILURES, so the whole payroll can be enumerated without
     * locking a single account.
     *
     * Paying one BCRYPT_COST compare here brings the difference down from
     * 209 ms to the ~19 ms of the cost-8 compare itself, which is inside the
     * jitter of any real network.
     *
     * It narrows on its own as people log in and get re-hashed below, and it
     * never closes: an account that never logs in stays cheap forever, and
     * former staff not yet archived, service accounts and the spare
     * administrator account are exactly the ones worth finding.
     *
     * `?? 0` covers a stored value that is not a bcrypt hash at all — a
     * corrupt row, something written by hand — where `compare` returns false
     * in microseconds. Same hole, wider.
     *
     * `credentials.test.ts`, beside this file, fails if this is deleted.
     */
    if ((bcryptCostOf(data.pass) ?? 0) < BCRYPT_COST) {
      await bcryptjs.compare(pass, await fillerHash());
    }

    // The count is incremented in the database, not read into Node,
    // added to, and written back. That three-step version loses updates
    // under concurrency: ten wrong guesses arriving together all read
    // failed_attempts=0 before any of them writes, and all ten write
    // back 1 — the counter is pinned at 1 forever and the account never
    // locks. This per-account bucket is the only defense credential
    // stuffing spread across many addresses runs into (each address
    // alone stays under LOGIN_ACCOUNT_IP_LIMIT), so losing it here loses
    // the one place that catches that attack.
    //
    // `UsuarioModel.increment` compiles to a single
    // `SET failed_attempts = failed_attempts + 1` — the database does
    // the read-and-add, so no concurrent increment can be lost. Its own
    // resolved value is not used: traced through this project's
    // Sequelize version (6.36.0) — `Model.increment` ->
    // `queryInterface.increment` -> the Postgres dialect's
    // `Query.formatResults`, which for an UPDATE with no
    // `options.instance` set resolves to `[rows, rowCount]` — the static
    // call then wraps that again, so what actually comes back is not
    // the `M[]` the type declaration promises. Rather than rely on it,
    // the fresh count is read back explicitly below.
    //
    // Known and accepted timing asymmetry: this branch awaits a database
    // round trip (this increment, and sometimes the update below) before
    // answering, while the locked-account and unknown-user branches above
    // answer as soon as their filler-hash compare resolves, with no write
    // at all. A round trip here is on the order of a millisecond against
    // bcrypt's ~250ms — under half a percent — and measuring that over a
    // real network, with tens of milliseconds of jitter, is not
    // realistic. Not awaiting the write would trade the counter's
    // atomicity (the whole point of this change) for a gain nobody could
    // observe, so this is left as is on purpose rather than closed.
    await UsuarioModel.increment("failed_attempts", { where: { id: data.id } });
    const actualizado = await UsuarioModel.findOne({
      where: { id: data.id },
      attributes: ["failed_attempts"],
    });
    if (actualizado) {
      const fallos = actualizado.dataValues.failed_attempts ?? 0;
      // siguienteBloqueo expects the count *before* this failure and adds
      // one itself; the database already added it, so passing the fresh
      // count minus one gets the same arithmetic without adding it twice.
      const { locked_until } = siguienteBloqueo(fallos - 1);
      // Only locked_until is written here — failed_attempts is left alone
      // because it is already correct in the database. Writing it again
      // from a value read a moment ago would reopen the exact race this
      // comment starts with, just narrowed to the gap between the read
      // above and this write.
      if (locked_until) {
        await UsuarioModel.update({ locked_until }, { where: { id: data.id } });
        // The moment of locking, which nothing recorded until now. The
        // bitácora showed a run of LOGIN_FAILED and then one every so often,
        // and nowhere the single fact anyone reading it would want: that this
        // account has been shut since Tuesday. `critical` and not `warning`
        // because a LOGIN_FAILED is somebody mistyping and this is somebody
        // unable to work — whether they did it to themselves or whether
        // someone who knows their username did it to them. Its own action
        // name so a panel can pull just these out of the failure noise.
        logAction({ id_usuario: data.id, action: "ACCOUNT_LOCKED", entity: "Usuario", entity_id: data.id, detail: `Cuenta @${data.user} bloqueada tras ${fallos} intentos fallidos`, metadata: { user: data.user, failed_attempts: fallos, locked_until }, severity: 'critical', ip_address: ip });
      }
    }
    logAction({ id_usuario: data.id, action: "LOGIN_FAILED", entity: "Usuario", entity_id: data.id, detail: `Login fallido para @${user}`, metadata: { user }, severity: 'warning', ip_address: ip });
    return { ok: false, message: CREDENCIALES_INVALIDAS };
  }

  // A good password clears the slate. Otherwise yesterday's four failures and
  // today's one lock an account whose owner never got anything wrong twice
  // in a row.
  if ((data.failed_attempts ?? 0) > 0 || data.locked_until) {
    await UsuarioModel.update({ failed_attempts: 0, locked_until: null }, { where: { id: data.id } });
  }

  // The stored hash carries its own cost in the prefix. Reading it back out
  // with `bcryptCostOf` and comparing to `BCRYPT_COST` — rather than testing
  // the hash string against one literal old value — is what keeps this
  // correct the next time the constant moves. Re-hashing here is the only
  // moment the plaintext is in hand.
  const costoGuardado = bcryptCostOf(data.pass);
  if (costoGuardado !== null && costoGuardado < BCRYPT_COST) {
    const nuevo = await bcryptjs.hash(pass, BCRYPT_COST);
    await UsuarioModel.update({ pass: nuevo }, { where: { id: data.id } });
  }

  const usuario: UsuarioAutenticado = {
    id: data.id,
    id_rol: data.id_rol,
    user: data.user,
    name: data.name,
    lastname: data.lastname,
    image: data.image,
  };

  return { ok: true, usuario };
}

/**
 * Write the LOGIN line, once the person is actually in.
 *
 * The wording, the action name and the severity live here, beside the three
 * failure lines, so the two doors cannot describe the same event differently or
 * forget it on the newer one. *When* it is written is each door's business, and
 * that is the part this got wrong at first: called from inside
 * `verifyCredentials`, the line was written before the session row existed, so
 * a failure to open one — or to read the permission matrix — answered 500 while
 * the bitácora said that person had logged in. The bitácora is read to find out
 * what happened; a line for a login that did not happen is worse than no line.
 */
export function logLogin(usuario: UsuarioAutenticado, ip: string | null): void {
  logAction({ id_usuario: usuario.id, action: "LOGIN", entity: "Usuario", entity_id: usuario.id, detail: "Inició sesión", metadata: { user: usuario.user }, severity: 'info', ip_address: ip });
}
