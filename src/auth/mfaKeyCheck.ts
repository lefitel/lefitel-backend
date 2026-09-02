// The boot-time check that a broken `MFA_ENCRYPTION_KEY_ACTIVE` is caught the
// morning it goes wrong, not three days later when the first person says
// their code stopped working and nobody connects the two. Decisions 1 and 2
// of `docs/plans/2026-09-01-factores-mfa.md`, findings A6, B8, B9.
//
// **Decision 1 — decrypt a real row, never a fingerprint.** The design spec
// (§9) wanted `HMAC(clave, constante)` stored "next to the data". There is no
// table to put it in — the audit's inventory walked all 24 tables and found
// no config table, no singleton — and even with one, a fingerprint proves
// "the key changed", not "the key opens these rows". The false-OK that
// matters: restoring an old dump of `factor_totp` over the live table leaves
// the fingerprint matching and every secret unreadable — exactly what the
// fingerprint exists to catch. Decrypting an actual row has none of that
// problem and needs no table.
//
// **Decision 2 — a bad key cuts TOTP, not the ERP.** Refusing to boot over a
// typo'd env var would lock out all nine people who use this ERP, including
// everyone who has never touched MFA. It also has a second-order failure:
// whoever is firefighting this at 8am is staring at a server that will not
// start and a check that is stopping it — the reflex is to delete the check,
// and once it is gone it does not come back. So a failure here never exits
// the process: it logs one `fatal` line and flips `totpEstaDisponible()` to
// `false`. It is on `/auth/totp/*`'s routes (Task 6) to read that switch and
// answer 503 — everything else (login, recovery codes, the grace period, all
// 25 other screens) keeps working.
//
// **Where this must never live, under any refactor — finding A6.** Verified
// import chain: `src/scripts/rescue.ts` imports `config/security.ts`
// directly, and (through `auth/rescueCore.ts`) again indirectly.
// `config/security.ts` is the obvious place anybody would reach for to wire
// up "load and check the key" — and rescue is the one tool that has to keep
// working when the key is broken: it *deletes* a `factor_totp` row outright,
// it never decrypts one. If this check, or anything it calls, sat in a module
// `rescue.ts` reaches by import, a bad key would take down the only remedy
// for a bad key along with the TOTP routes. That is why `comprobarLlaveAlArrancar`
// is called from `src/index.ts` and nowhere else, and why
// `mfaKeyCheck.test.ts` walks `rescue.ts`'s own import graph on the real
// files on disk and asserts this file never appears in it — not a rule
// written down for someone to remember, a test that goes red the day it is
// broken.
//
// **Two checks, in this exact order, both required (Step 4 of Task 2).**
//   1. `llaveActiva()` has to resolve, whether or not there is a single row
//      yet. `requiredEnv` (`config/security.ts`) only proves
//      `MFA_ENCRYPTION_KEY_ACTIVE` was *set*; it is this function's job to
//      prove it *works*. Skipping this whenever the table is empty would let
//      a deploy with no key at all, or with the pointer aimed at a version
//      nobody configured, boot cleanly — and nobody would notice until the
//      first person tries to register a factor.
//   2. Only if at least one confirmed row exists, decrypt a representative of
//      every `key_version` those rows actually carry (see "Which rows"
//      below — finding A1). Zero confirmed rows is the correct, unremarkable
//      state of a first deploy: there is nothing to protect yet, so there is
//      nothing to fail.
//
// **Which rows (Step 5) — finding A1, not the original single-row design.**
// The first draft decrypted only the lowest `id` with `confirmed_at IS NOT
// NULL`, reasoning that an unconfirmed row can be a half-finished `setup`
// nobody is going to use while a confirmed one is a secret somebody actually
// relies on. True, but incomplete: `src/scripts/rotateMfaKey.ts` also sorts
// `id ASC`, so a rotation that dies half way always converts the *lowest*
// ids first — which means "the lowest confirmed id" is exactly the one row
// in the whole table guaranteed to already sit on the new key. It decrypts
// fine, this check says `ok: true`, and the higher-id rows still waiting on
// the key the operator is about to delete are never looked at. Once that key
// is gone, those rows are unreadable forever, behind a check that stayed
// green the whole time.
//
// The fix keeps "a confirmed row, never an unconfirmed one" and drops "only
// one": every distinct `key_version` present among the confirmed rows gets
// its own lowest-id representative decrypted, so a key that stopped working
// — including one removed before every row had actually moved off it — is
// caught no matter which version happens to sort first. `factor_totp` holds
// at most one confirmed row per person, so reading all of them once at boot
// is not a cost worth engineering around.
//
// **The AAD convention, because `auth/totpStore.ts` (Task 4) has to produce
// the exact same string or every decryption here fails, always.** It is
// `factor:<factor_totp.id>` — already the format `mfaCrypto.test.ts` writes
// its own fixtures against (`"factor:1"`, `"factor:7"`, …). Decision 6 ties
// the AAD to the row's own `id`, never to `id_usuario`: `factor_totp`'s FK to
// `usuarios` is `ON UPDATE CASCADE`, so an `id_usuario` merge would silently
// move the AAD out from under a row that never re-encrypted. `factor_totp.id`
// does not cascade.

import { Op } from "sequelize";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { llaveActiva } from "./mfaKeyring.js";
import { descifrar } from "./mfaCrypto.js";
// The AAD format has exactly one home, and it is `totpStore.ts` — the module
// that writes these rows. A second copy here would agree today and would be
// free to drift, and the drift is silent: a decrypt with the wrong AAD is
// indistinguishable from a wrong key, which is the very thing this file
// reports. Safe in the other direction too: finding A6 forbids `rescue.ts`
// reaching *this* module, and this import points the other way.
import { aadDeFactorTotp } from "./totpStore.js";

/** What `comprobarLlaveAlArrancar` found. */
export interface ResultadoComprobacion {
  ok: boolean;
  /**
   * Present only when `ok` is `false`. Names the row and the key version
   * that failed — **never** a key, a fragment of one, or any plaintext
   * (finding B12: a wrong code, a corrupt row and a wrong key must not be
   * distinguishable from what gets written down or answered any more than
   * from what a caller gets back).
   */
  detalle?: string;
}

/**
 * The switch `/auth/totp/*` (Task 6) reads to decide whether to answer 503.
 * A module-level value, deliberately not a per-request query: the check runs
 * exactly once, at boot, from `src/index.ts`. There is no exported setter —
 * the only way this changes is by calling `comprobarLlaveAlArrancar`.
 */
let disponible = true;

/** Whether `/auth/totp/*` may serve requests right now. */
export function totpEstaDisponible(): boolean {
  return disponible;
}

/**
 * Run both checks described in the module header and update the switch
 * accordingly. Safe to call more than once (nothing here is one-shot state
 * beyond the switch itself), but `src/index.ts` only ever calls it the once,
 * at boot.
 */
export async function comprobarLlaveAlArrancar(): Promise<ResultadoComprobacion> {
  try {
    llaveActiva();
  } catch (err) {
    disponible = false;
    return {
      ok: false,
      detalle: `MFA_ENCRYPTION_KEY_ACTIVE no resuelve una clave utilizable: ${(err as Error).message}`,
    };
  }

  // `unscoped()` is required, not a stylistic choice: `FactorTotpModel`'s own
  // `defaultScope` (finding B10) excludes exactly the three columns this
  // check has to read — `secreto_cifrado`, `iv`, `auth_tag` — so a plain
  // `findAll` here would always see them as `undefined` and always "fail" to
  // decrypt, on a perfectly healthy key.
  const filas = await FactorTotpModel.unscoped().findAll({
    where: { confirmed_at: { [Op.ne]: null } },
    order: [["id", "ASC"]],
  });

  if (filas.length === 0) {
    // No confirmed row anywhere: the first deploy, or every account still
    // mid-registration. Nothing to protect yet, so there is nothing to fail.
    disponible = true;
    return { ok: true };
  }

  interface FilaCifrada {
    id: number;
    secreto_cifrado: Buffer;
    iv: Buffer;
    auth_tag: Buffer;
    key_version: number;
  }

  // One representative per `key_version` actually present, lowest id first
  // within each — see "Which rows" in the module header. `filas` is already
  // sorted `id ASC`, so the first row seen for a given version is always its
  // lowest id, exactly what the pre-A1 single-row check picked when only one
  // version existed.
  const representantePorVersion = new Map<number, FilaCifrada>();
  for (const filaModel of filas) {
    const datos = filaModel.get() as FilaCifrada;
    if (!representantePorVersion.has(datos.key_version)) {
      representantePorVersion.set(datos.key_version, datos);
    }
  }

  for (const datos of representantePorVersion.values()) {
    try {
      descifrar(
        {
          ciphertext: datos.secreto_cifrado,
          iv: datos.iv,
          auth_tag: datos.auth_tag,
          key_version: datos.key_version,
        },
        aadDeFactorTotp(datos.id),
      );
    } catch {
      // Never the caught error's own `.message` here — see finding B12 in the
      // module header. The row id and the key version it tried are the only
      // detail worth keeping; both name where to look without naming why.
      disponible = false;
      return {
        ok: false,
        detalle: `factor_totp.id=${datos.id} no se pudo descifrar con la clave de la versión ${datos.key_version}`,
      };
    }
  }

  disponible = true;
  return { ok: true };
}
