// The MFA keyring: which encryption keys exist, which one is `active` (the
// one `auth/mfaCrypto.ts`'s `cifrar` always uses), and which one opens a
// particular already-encrypted row (`llavePorVersion`, driven by that row's
// own `key_version` — see Decision 3 of
// `docs/plans/2026-09-01-factores-mfa.md`).
//
// **Loaded lazily, on first use, and nowhere near module import.** Every
// function below reads `process.env` itself, only when called — nothing here
// runs at import time. This is not a style preference: `src/scripts/rescue.ts`
// (through `auth/rescueCore.ts`) imports `config/security.ts`, and rescue is
// the one tool that has to keep working when a key is missing or malformed —
// it deletes the `factor_totp` row outright, it never decrypts it. If reading
// a key threw the moment this module (or anything that imports it) was
// merely imported, a bad `MFA_ENCRYPTION_KEY_ACTIVE` would take down the only
// remedy for a bad `MFA_ENCRYPTION_KEY_ACTIVE` along with everything else.
// This is finding A6, and Task 2's `mfaKeyCheck.ts` is the piece that
// actually calls into this file at boot — from `src/index.ts` and nowhere
// that `rescue.ts` can reach; its own test walks that import graph so this
// stays true after this file is forgotten about.
//
// **Nothing here is cached.** Every call re-reads and re-validates from
// `process.env`, the same choice `auth/securityNotice.ts` makes for
// `MAIL_SECURITY_TO`. Keys do not change while a process is running, so a
// cache would buy nothing real, and it would cost something concrete: one
// more piece of state a test has to reset between runs, on top of what
// `vi.stubEnv` / `vi.unstubAllEnvs()` already reset for `process.env` itself.
//
// **B2, measured: validating a key by decoded length alone is not enough.**
// `Buffer.from(x, 'hex')` decodes hex two characters at a time and simply
// stops at the point it cannot pair one up, so a 65-character string — one
// keystroke too long — still decodes to exactly 32 bytes, silently dropping
// the last character. A wrong key that round-trips as if it were 32 bytes is
// worse than one that visibly fails, so every key is checked *two* ways: the
// exact shape first (`/^[0-9a-fA-F]{64}$/`, which the 65-character case
// already fails on length alone), then the decoded buffer's own length. The
// second check is redundant once the first has passed — 64 valid hex
// characters always decode to exactly 32 bytes — and it stays anyway, as the
// one invariant this module actually promises regardless of how the first
// check is ever rewritten later.
//
// **Never a key, or a fragment of one, in a thrown error.** Every error
// message below names the *environment variable*, never the value read out
// of it — so a misconfigured key can be diagnosed from a log line without
// that log line becoming the thing an attacker needed.

import { MFA_ENCRYPTION_KEY_BYTES } from "../config/security.js";

/** One usable key: which rotation it is, and the raw bytes. */
export interface Llave {
  version: number;
  clave: Buffer;
}

const NOMBRE_ACTIVA = "MFA_ENCRYPTION_KEY_ACTIVE";

/** Exactly `MFA_ENCRYPTION_KEY_BYTES` bytes of hex, no more, no less. */
const PATRON_HEX = new RegExp(`^[0-9a-fA-F]{${MFA_ENCRYPTION_KEY_BYTES * 2}}$`);

/** Matches `MFA_ENCRYPTION_KEY_<n>`, never `MFA_ENCRYPTION_KEY_ACTIVE` — the
 *  literal `ACTIVE` suffix is not `\d+`. */
const PATRON_VERSION = /^MFA_ENCRYPTION_KEY_(\d+)$/;

function nombreDeVersion(version: number): string {
  return `MFA_ENCRYPTION_KEY_${version}`;
}

/**
 * Validate and decode one key's raw hex value. See the module comment for
 * why both checks exist, and why neither ever repeats `valor` in a message.
 */
function analizarClave(nombreVar: string, valor: string): Buffer {
  if (!PATRON_HEX.test(valor)) {
    throw new Error(
      `${nombreVar} debe ser exactamente ${MFA_ENCRYPTION_KEY_BYTES * 2} caracteres hexadecimales`,
    );
  }
  const clave = Buffer.from(valor, "hex");
  // Redundant given the regex above for any input that reaches this line —
  // kept as the actual invariant this function promises its caller, not as
  // a rewrite of the check above.
  if (clave.length !== MFA_ENCRYPTION_KEY_BYTES) {
    throw new Error(`${nombreVar} no decodifica a ${MFA_ENCRYPTION_KEY_BYTES} bytes`);
  }
  return clave;
}

/**
 * Every key version configured in the environment right now, sorted
 * ascending, gaps included.
 *
 * Deliberately **not** "scan from 1 until the first missing number". The
 * rotation procedure this plan documents (Task 3, Step 5 of
 * `docs/plans/2026-09-01-factores-mfa.md`) ends by *removing*
 * `MFA_ENCRYPTION_KEY_1` once every row has moved to the new version — a
 * from-1 scan would stop at that very first missing number and never see
 * `_2` at all, right after a rotation that was supposed to leave the system
 * working. Reading the real variable names out of `process.env` instead has
 * no such assumption: gaps are just gaps.
 *
 * Values here are not validated — a caller that needs a specific version's
 * key validates it through `llavePorVersion`, which is the only place that
 * matters.
 */
export function versionesDisponibles(): number[] {
  return Object.keys(process.env)
    .map((nombre) => PATRON_VERSION.exec(nombre))
    .filter((coincide): coincide is RegExpExecArray => coincide !== null)
    .map((coincide) => Number(coincide[1]))
    .sort((a, b) => a - b);
}

/**
 * The key that opens one specific `key_version` — what `mfaCrypto.ts`'s
 * `descifrar` calls, with the version stamped on the row being read, never
 * with whichever key happens to be active right now.
 *
 * Throws by variable name if that version was never configured. There is no
 * fallback to any other version: decrypting a row with the wrong key
 * produces either an authentication failure (the tag will not match) or,
 * worse, nothing that fails at all if the wrong key still happens to
 * validate against different bytes — Decision 6 and finding B3 exist
 * precisely because a silent substitution here is how a secret gets
 * destroyed without anyone noticing.
 */
export function llavePorVersion(version: number): Llave {
  const nombreVar = nombreDeVersion(version);
  const valor = process.env[nombreVar];
  if (valor === undefined) {
    throw new Error(`${nombreVar} no está configurada`);
  }
  return { version, clave: analizarClave(nombreVar, valor) };
}

/**
 * The key that `mfaCrypto.ts`'s `cifrar` always uses to encrypt something
 * new. Reads `MFA_ENCRYPTION_KEY_ACTIVE`, requires it to be a plain positive
 * integer, and looks up that version's key exactly the way `llavePorVersion`
 * would for any other caller.
 *
 * **No fallback to version 1 "just in case".** If `_ACTIVE` names a version
 * that was never configured, that is a configuration mistake, and it is
 * reported with the name of the variable that is actually missing. Falling
 * back silently would mean a typo in `_ACTIVE` quietly starts encrypting new
 * secrets under a key nobody meant to keep using — or one that does not
 * exist at all, which is a different failure than this function's contract
 * ("the active key exists and is valid") is supposed to rule out.
 *
 * **With a single key configured — `_1` and `_ACTIVE=1` — this behaves
 * exactly as if there were no keyring at all.** That is deliberate and it is
 * the normal case: there is no special branch here for "only one key",
 * because none is needed. The general path already collapses to it.
 */
export function llaveActiva(): Llave {
  const bruta = process.env[NOMBRE_ACTIVA];
  if (bruta === undefined || bruta.trim() === "") {
    throw new Error(`${NOMBRE_ACTIVA} no está configurada`);
  }
  const texto = bruta.trim();
  if (!/^[1-9]\d*$/.test(texto)) {
    throw new Error(`${NOMBRE_ACTIVA} debe ser un número entero positivo`);
  }
  return llavePorVersion(Number(texto));
}
