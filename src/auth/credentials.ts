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
// **And that endpoint arrived.** `verifyOwnPassword` at the bottom of this file
// answers "is this the password of the account already asking?" for the screen
// that renames your own account — a screen that until now asked by calling the
// login itself, opening a session and spending a failed attempt to answer a
// question about somebody already logged in. It shares `checkAgainstRow` with
// the login rather than comparing a hash of its own, which is this file's whole
// argument arriving on time: the second copy would have been the one without the
// filler hash, or the one that forgot to re-hash a password still stored at the
// old cost.
//
// The two doors differ in exactly two things, and both have names:
// `FailureCost` and `LockoutPolicy`. Sharing the implementation is only worth
// anything while the differences stay arguments — the moment one of them is
// answered by an `if` reading which caller this is, there are two doors again
// with one of them written by accident.
//
// Both return a result rather than writing a response, so each caller decides
// its own status codes and cannot accidentally say something different about
// *why* a check failed.

import bcryptjs from "bcryptjs";
import type { IUsuario } from "../interfaces/index.js";
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
 * What a wrong password costs the account it was aimed at.
 *
 * A closed set of two, and neither is a default: every caller of
 * `checkAgainstRow` has to name one, so "which of these did you mean" is a
 * question the compiler asks instead of one nobody thinks to ask.
 *
 * - `"lockout"` — the login. A wrong password moves `failed_attempts`, and
 *   enough of them shut the account for a while. This is the only budget that
 *   makes guessing expensive for somebody attacking from many addresses, since
 *   each address alone stays inside `LOGIN_ACCOUNT_IP_LIMIT`.
 * - `"audit-only"` — confirming your own password on an endpoint you already
 *   reached with a live session. The attempt is written to the bitácora and the
 *   account's counters are not touched. What keeps *that* from being an
 *   unlimited oracle is a rate limit on the endpoint, not this: see
 *   `PASSWORD_CONFIRM_LIMIT`.
 */
type FailureCost = "lockout" | "audit-only";

/**
 * Whether the per-account lockout is this door's business at all.
 *
 * The second named difference between the two doors, and it exists because
 * getting it wrong shut somebody out of the one screen that could rescue them.
 *
 * - `"refuse"` — the login. While `locked_until` is in the future the answer is
 *   "no" before anything is compared, filler hash included. That is the whole
 *   point of a lockout: the account rests, and while it rests no password gets
 *   it in. Answering differently — or faster — while locked would turn the
 *   lockout into an oracle naming which accounts are shut.
 * - `"ignore"` — confirming your own password on an endpoint reached with a live
 *   session. The lockout counts *login* attempts, and `authenticate` does not
 *   read it (deliberately), so somebody whose account was locked by another
 *   machine grinding their username keeps working in the session they already
 *   had. Every other authenticated endpoint answers them normally; refusing
 *   *this* one would tell them their own correct password is wrong, spend the
 *   `PASSWORD_CONFIRM_LIMIT` budget on the lie, and — since that budget is
 *   shared with the password change — close the only self-service way out of
 *   the lockout they are in. So the lockout is left to the door it belongs to.
 *
 * **The consequence of `"ignore"`, said out loud rather than discovered.** The
 * success path below clears `failed_attempts` and `locked_until`, so a caller
 * who confirms the *right* password while locked comes out unlocked. That is
 * deliberate and it costs the correct password: `updateUserPass` already lifts a
 * lockout on purpose for the same evidence, and whoever knows the password could
 * wait out the fifteen-minute ceiling regardless. What used to make this
 * uncomfortable was `POST /api/auth/confirm-password`, an endpoint that compared
 * a password with no operation behind it — a pure side entrance onto the
 * lockout. It is retired, so every door that reaches here now performs
 * something.
 */
type LockoutPolicy = "refuse" | "ignore";

/**
 * Whether the caller re-typed their own password correctly.
 *
 * Not `ResultadoCredenciales`: that type carries a `usuario` and a sentence to
 * show, and this answers a yes/no question about somebody the caller already
 * is. Its own type so the third case cannot be flattened into the second —
 * "the account is gone" is a session that has ended, not a password that is
 * wrong, and the two must not reach the client as the same answer.
 *
 * Both arms name both fields for the reason `ResultadoCredenciales` explains
 * above: with `strictNullChecks` off, TypeScript will not narrow a union by the
 * truthiness of its discriminant unless every key exists on both arms.
 */
export type ResultadoConfirmacion =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: "wrong-password" | "no-account" };

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

  // Everything past the lookup is what both doors do identically, so it lives
  // in one place — see `checkAgainstRow`, and `verifyOwnPassword` for the
  // second caller.
  return checkAgainstRow({
    row: TempUsuario.dataValues,
    pass,
    ip,
    typedAs: user,
    failure: "lockout",
    lockout: "refuse",
  });
}

/**
 * The half of a credential check that starts once the row is in hand.
 *
 * Two doors share it: the login, which found the row by the username somebody
 * typed, and `verifyOwnPassword`, which found it by the id of the session
 * already asking. What is identical between them is everything here — the
 * comparison, the filler hash that levels the timings, clearing the slate on
 * success and re-hashing at the current cost. What differs is two things, and
 * both are named rather than implied: `failure` and `lockout`.
 *
 * Written as one function taking named policies rather than two functions with
 * a copy each, for the reason at the top of this file: the part a second copy
 * loses is the part with no visible effect on a successful check. And the two
 * policies are arguments rather than one boolean called `isLogin`, because that
 * name would answer "which caller is this" instead of "what should happen" —
 * the next door would have to decide whether it counts as a login, which is a
 * question about nothing.
 */
async function checkAgainstRow(input: {
  /** The account row, as read from the database. */
  row: IUsuario;
  /** The plaintext, exactly as it arrived. */
  pass: string;
  /** For the bitácora lines only, so one machine can be told from one typo. */
  ip: string | null;
  /**
   * The name to write in those lines. The login writes what was *typed* rather
   * than what is stored, because that is the string whose case or spacing may
   * be why the attempt failed.
   */
  typedAs: string;
  /** What a wrong password costs this account — see `FailureCost`. */
  failure: FailureCost;
  /** Whether a resting account is refused here — see `LockoutPolicy`. */
  lockout: LockoutPolicy;
}): Promise<ResultadoCredenciales> {
  const { row: data, pass, ip, typedAs: user, failure, lockout } = input;

  // On the login, a locked account answers exactly like a wrong password,
  // filler hash included. Answering differently — or faster — turns the lockout
  // into the oracle the uniform message was meant to close.
  //
  // On the confirmation door it is skipped entirely, and that is not a
  // relaxation of this check: it is refusing to apply a *login* limit to a
  // caller who is already inside. See `LockoutPolicy` for the case it broke.
  if (lockout === "refuse" && estaBloqueada(data)) {
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

    /**
     * The confirmation door stops here: it records the attempt and charges the
     * account nothing.
     *
     * Everything below this block is the login's bookkeeping — the atomic
     * counter, the escalating wait, the ACCOUNT_LOCKED line — and the reason it
     * must not run for a caller confirming their own password is in
     * `verifyOwnPassword`. In one sentence: the account being confirmed is the
     * account already logged in, so counting a typo there means somebody
     * renaming themselves can shut themselves out of the ERP, behind a message
     * that says nothing about it.
     *
     * The line is still written, with an action of its own. A run of these on
     * one account is somebody holding a session and guessing at the password
     * behind it, which is precisely the event worth being able to find in the
     * bitácora — and giving it its own name keeps it out of the LOGIN_FAILED
     * noise the login panel already reads, instead of forging entries that
     * claim a login attempt nobody made.
     */
    if (failure === "audit-only") {
      logAction({ id_usuario: data.id, action: "PASSWORD_CONFIRM_FAILED", entity: "Usuario", entity_id: data.id, detail: `Contraseña incorrecta al confirmar una acción de @${user}`, metadata: { user }, severity: 'warning', ip_address: ip });
      return { ok: false, message: CREDENCIALES_INVALIDAS };
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
 * Is this the password of the account already asking? Nothing else.
 *
 * The second door onto `checkAgainstRow`, and it exists because the screen that
 * renames your own account asked this question **by calling the login**. That
 * cost four things, all of them in production: a second session was opened, so
 * the rotation on the way in revoked the one the browser was using; a line
 * saying "Inició sesión" went into the bitácora for a login nobody performed; a
 * typo counted as a failed login attempt, so mistyping your password a few
 * times while renaming yourself locked you out of the ERP; and the client read
 * the answer off a status code that only worked by accident.
 *
 * So this emits **nothing**: no cookie, no session row, no LOGIN line. It reads
 * one row and compares one hash.
 *
 * **Who it is about is not in the request.** The id comes from `req.user`,
 * which is to say from the session cookie `authenticate` already checked, and
 * there is no username in the body to look up. That is what makes the enumeration
 * question this file spends so much care on moot here rather than merely
 * handled: there is no name to probe with, and the only account this can be
 * asked about is the caller's own.
 *
 * **A locked account is answered normally, and that is a fix.** This asked
 * `checkAgainstRow` for the login's lockout policy until now, so while
 * `locked_until` was in the future it returned `wrong-password` **for the right
 * password**, before comparing anything. The reason given was that the success
 * path clears `failed_attempts` and `locked_until`, so letting a locked account
 * through would be a side entrance onto the lockout.
 *
 * That reasoning was answered on the other door and not here. `updateUserPass`
 * compares its own hash precisely so that a locked account can change its
 * password — `authenticate` does not read `locked_until`, so the session survives
 * the lockout and changing the password is the way out — and `updateUserName`,
 * the only caller left here, was wired to this door a commit earlier. So somebody
 * whose account had been locked by another machine grinding their username was
 * told their own correct password was wrong, five times, and the sixth answer was
 * a 429 out of a budget shared with the password change: the rescue closed too.
 *
 * `lockout: "ignore"` is the whole fix, and `LockoutPolicy` carries the argument
 * — including what it means that a correct confirmation now lifts the lockout.
 *
 * Throws nothing of its own; a database failure propagates, and the endpoint
 * turns it into a 500.
 */
export async function verifyOwnPassword(input: {
  /** The caller's own id, from `req.user` and never from the request body. */
  id: number;
  pass: unknown;
  ip: string | null;
}): Promise<ResultadoConfirmacion> {
  const pass = input.pass;
  // Not a string is not a password, and an empty one is not a confirmation.
  // Refused before any read: there is nothing here worth a database round trip
  // and nothing to level the timing of, since the answer does not depend on
  // which account is asking.
  if (typeof pass !== "string" || pass === "") {
    return { ok: false, reason: "wrong-password" };
  }

  const found = await UsuarioModel.findByPk(input.id);
  // Archived between `authenticate` and here — the same narrow race
  // `GET /api/auth/me` answers 401 to. Its own reason so the endpoint can say
  // "your session is over" instead of "your password is wrong", which would
  // send somebody looking for a typo that does not exist.
  if (!found) {
    return { ok: false, reason: "no-account" };
  }

  const check = await checkAgainstRow({
    row: found.dataValues,
    pass,
    ip: input.ip,
    // The stored name, because there is no typed one: the caller never sent a
    // username. It is what the bitácora line is addressed to.
    typedAs: found.dataValues.user,
    failure: "audit-only",
    lockout: "ignore",
  });

  // The `usuario` and the sentence `checkAgainstRow` returns are deliberately
  // dropped. This endpoint answers a yes/no question, and handing back a
  // profile — or a message worded for the login screen — is how a "confirm
  // your password" endpoint turns into a second way of reading account data.
  return check.ok ? { ok: true } : { ok: false, reason: "wrong-password" };
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
