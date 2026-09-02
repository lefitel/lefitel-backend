// Generating/regenerating the caller's ten recovery codes, and counting how
// many are still good to spend. `docs/plans/2026-09-01-factores-mfa.md`
// Task 10, hallazgos A8 and C14.
//
// **This file is a thin wrapper, on purpose.** Every rule about bcrypt cost,
// the prefix column, the atomic invalidate-and-replace transaction, and never
// printing a code anywhere — all of that already lives in
// `auth/recoveryCodeStore.ts` (Tasks 9-11), built and verified before this
// file existed. What this file owns is the HTTP-shaped decision on top: which
// request may trigger a regeneration, what goes in the response body, and
// when a bitácora line is expected.
//
// **`POST /api/auth/recovery-codes` never accepts a recovery code as proof —
// only `requireStepUp({ exigeContrasena: true })`, mounted in
// `routes/recoveryCodes.routes.ts`.** §5 of the design spec describes this
// endpoint as "step-up, o un código de recuperación válido"; that half of the
// sentence is wrong and this plan deliberately does not build it (hallazgo
// C14, and the spec has been annotated to say so). If a code were enough on
// its own, the printed sheet in a drawer would be a master key: whoever holds
// it regenerates the ten and the real owner is left with nothing but a sheet
// of paper that no longer opens anything. Requiring the password as well —
// and `exigeContrasena` asks for it *even inside the ten-minute step-up
// window a code itself just opened* — is what keeps a lost or stolen sheet
// from being able to mint itself a fresh, unbounded ten.
//
// **Consequence of that, already applied where the state machine lives and
// not touched by this file:** `auth/sessionState.ts` keeps
// `/api/auth/recovery-codes` out of `PARCIAL` (it is in `ONBOARDING_EXTRA`),
// so a `parcial` session — one that has a factor and has not yet proved it —
// cannot reach either endpoint below at all; `authenticate` refuses it before
// either handler runs. Regenerating requires having finished getting in.
//
// **No mail is sent from here.** Regenerating invalidates ten live
// credentials at once and is worth a permanent, `critical` record — but
// `MAIL_SECURITY_TO` is not configured today and nobody has decided which
// address a notice like this should even go to. `totp.controller.ts`'s
// `confirmTotp` sets the precedent for exactly this situation: the bitácora
// line is the real constancy, written unconditionally, and no call to
// `auth/securityNotice.ts` is invented for an address that does not exist —
// that module is not part of this task's file list, and adding a
// half-decided notification path to it is a larger, separate decision than
// "wrap the store in two endpoints".
//
// 🔴 **`regenerateRecoveryCodes` refuses an account with no confirmed factor
// at all — hallazgo F1 (auditors C-2 and D-1, closure audit of 2026-09-02).**
// `factorInventory.ts:13-17` says why in its own words: recovery codes are
// the way back in when a real factor is unreachable, "handed out at the
// *end* of registering one, precisely because that assumes one already
// exists." Nothing here enforced that assumption. `requireStepUp({
// exigeContrasena: true })` only proves the caller's own current password —
// it says nothing about whether the account has anything for the ten codes
// to back up, and an account with nothing is
// exactly the account that gate's password fallback exists to let through
// (see `requireStepUp.ts`'s own docstring on the branch that answers "no
// factor, no fresh proof, but a correct password"). Composed, those two
// individually correct pieces used to open a hole the fourteen-day grace
// period was supposed to close: the password alone minted ten codes for an
// account with nothing else registered, and one of those codes promoted the
// very same session to `completa` in `mfa.controller.ts`'s `verify` — the
// mirror half of this same finding, fixed alongside this file and not in
// it — indefinitely, since a fresh ten regenerate with that same password.
// `tieneAlgunFactor(caller.id)` is checked first, before `regenerarCodigos`
// runs or writes anything, and an account with nothing registered is turned
// back with a 409 that says what to do next — see
// `MENSAJE_SIN_FACTOR_PARA_CODIGOS` — rather than only that it refused.
//
// **`GET /api/auth/recovery-codes` carries no `requireStepUp` at all.**
// Counting how many of the ten remain reveals nothing an authenticated
// caller cannot already infer by trying to spend one, and it creates no
// credential and changes no state. Gating a read like that behind a fresh
// password would be friction with nothing behind it to defend — the same
// reasoning `requireStepUp.ts`'s own `exigeContrasena` docstring draws around
// "the routes that register or remove a credential", which this is not.

import type { Request, Response } from "express";
import { regenerarCodigos, contarCodigosRestantes } from "../auth/recoveryCodeStore.js";
import { tieneAlgunFactor } from "../auth/factorInventory.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const recoveryCodesLog = log("recovery-codes");
const handler = makeHandler(recoveryCodesLog);

export const MENSAJE_CODIGOS_GENERADOS =
  "Estos son tus nuevos códigos de recuperación. Guárdalos en un lugar seguro: " +
  "no volverán a mostrarse y los anteriores han dejado de funcionar.";

/**
 * Hallazgo F1. Told plainly, not just refused: whoever reaches this
 * legitimately is doing the right thing in the wrong order, and the way out
 * is to finish the first step, not to retry this one.
 */
export const MENSAJE_SIN_FACTOR_PARA_CODIGOS =
  "Todavía no tienes ningún segundo factor configurado. Los códigos de recuperación " +
  "son la copia de repuesto de ese factor, no un sustituto suyo: configura primero tu " +
  "segundo factor (por ejemplo, un código TOTP desde tu perfil) y, una vez confirmado, " +
  "vuelve aquí para generar tus diez códigos.";

/**
 * `POST /api/auth/recovery-codes` — issue a fresh set of ten, discarding
 * whatever the account already had outstanding.
 *
 * **Step-up already ran** (see the module header): by the time this handler
 * executes, the caller has typed their current password, whether or not
 * their account already had a factor to prove first.
 *
 * The same handler serves a first issue and every later "I want new ones" —
 * `regenerarCodigos` itself does not distinguish them, and neither does this
 * endpoint. A first issue simply finds nothing outstanding to invalidate.
 *
 * The ten codes are the whole point of the response and appear **exactly
 * once**: this handler and `totp.controller.ts`'s `confirmTotp` (which, as
 * of 2026-09-02, also calls `regenerarCodigos` — but only when confirming
 * leaves the account with nothing else outstanding; see that function's own
 * comment) are the only two callers of `regenerarCodigos` in the codebase,
 * and neither writes the codes to a log, a bitácora `detail` or `metadata`
 * field, or anywhere they could be read back later.
 *
 * **Refuses an account with no confirmed factor, before anything is
 * written** — hallazgo F1. See the module header for the shape of the hole
 * this closes. No bitácora line for that refusal: nothing changed, matching
 * `totp.controller.ts`'s own precondition 409s (unverified email, factor
 * already configured), neither of which logs either.
 */
export const regenerateRecoveryCodes = handler(
  "regenerateRecoveryCodes",
  async (req: Request, res: Response) => {
    const caller = req.user;
    if (!caller) return res.sendStatus(401);

    if (!(await tieneAlgunFactor(caller.id))) {
      return res.status(409).json({ message: MENSAJE_SIN_FACTOR_PARA_CODIGOS });
    }

    const codigos = await regenerarCodigos(caller.id);

    // `critical`, unconditionally — matching `confirmTotp`'s own precedent
    // for a credential event that has no working mail path today. Whether
    // this was a first issue or a genuine regeneration, the outcome is the
    // same from a security standpoint: whatever the caller could recover
    // with before this call, they cannot any more.
    logAction({
      id_usuario: caller.id,
      action: "RECOVERY_CODES_REGENERATED",
      entity: "CodigoRecuperacion",
      entity_id: null,
      detail:
        "Generó un nuevo juego de diez códigos de recuperación; los códigos anteriores, si existían, quedaron invalidados",
      metadata: { id_sesion: caller.id_sesion },
      severity: "critical",
      ip_address: req.ip ?? null,
    });

    res.status(200).json({ message: MENSAJE_CODIGOS_GENERADOS, codigos });
  },
);

/**
 * `GET /api/auth/recovery-codes` — how many of the ten are still unspent.
 *
 * Never a code, never which ones — only the count. See the module header for
 * why this carries no `requireStepUp`.
 */
export const countRecoveryCodes = handler("countRecoveryCodes", async (req: Request, res: Response) => {
  const caller = req.user;
  if (!caller) return res.sendStatus(401);

  const restantes = await contarCodigosRestantes(caller.id);
  res.status(200).json({ restantes });
});
