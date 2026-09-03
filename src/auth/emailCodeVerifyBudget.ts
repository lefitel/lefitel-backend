// How many email-code verifications one account may attempt per quarter
// hour, in memory — plan 4E, design §3.3.
//
// **What this bounds is CPU, not the code.** The attempts against a code are
// charged in its row, atomically, by `emailCodeStore.ts`'s `cobrarIntento`;
// nothing here changes how many guesses a code survives. What a row cannot
// bound is what each guess costs the *server*: a `bcrypt.compare` at
// `BCRYPT_COST` — also on the path where no code is pending, against
// `fillerHash()`, so that timing does not say whether one exists — and a
// session that holds the password could queue hundreds of those in one tick
// before the account lockout, which is charged after the compare, catches
// up. Twenty per quarter hour is more than a person mistypes and less than
// a stall.
//
// **In memory and per process, like `failedAssertionBudget.ts` and the login
// buckets**, and for the same reason those are: a restart that forgets it
// gives away nothing the row does not still count. **Sliding, not fixed**: a
// window that resets on the quarter hour lets twice the limit through in the
// two seconds either side of the reset, and a burst is the one thing this
// exists to bound — the same reason `mailBudget.ts` gives for its shape. At
// most `EMAIL_CODE_VERIFY_LIMIT` instants live here per account; a refused
// attempt is not recorded, so refusing costs nothing and extends nothing.
//
// **Its own module, not a bucket in `loginLimiters.ts`** as the plan first
// said: those are `express-rate-limit` middleware keyed by request and run
// before the handler; this is asked from inside the handler, after the shape
// check and the lockout, with the account id. A function over a `Map` is
// the honest shape, and it drags no middleware into the tests.

import { EMAIL_CODE_VERIFY_LIMIT, LOGIN_WINDOW_MS } from "../config/security.js";

/** Admitted attempts per account, oldest first. */
const admitidos = new Map<number, number[]>();

/**
 * Count one attempt for this account and say whether it may proceed.
 * `false` means the window is full: refuse before touching the database.
 */
export function admitirIntentoDeCorreo(id_usuario: number, ahora: number = Date.now()): boolean {
  podar(ahora);
  const limite = ahora - LOGIN_WINDOW_MS;
  const vivos = (admitidos.get(id_usuario) ?? []).filter((t) => t > limite);
  if (vivos.length >= EMAIL_CODE_VERIFY_LIMIT) {
    admitidos.set(id_usuario, vivos);
    return false;
  }
  vivos.push(ahora);
  admitidos.set(id_usuario, vivos);
  return true;
}

/** For tests, and for nothing else: a window does not survive a process anyway. */
export function olvidarIntentosDeCorreo(id_usuario: number): void {
  admitidos.delete(id_usuario);
}

/** Drop the accounts whose newest attempt has left the window, so the map does not grow with every account that ever tried. */
function podar(ahora: number): void {
  const limite = ahora - LOGIN_WINDOW_MS;
  for (const [id, lista] of admitidos) {
    if (lista.length === 0 || lista[lista.length - 1] <= limite) admitidos.delete(id);
  }
}
