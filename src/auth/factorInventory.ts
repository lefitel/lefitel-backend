// What an account already has to prove a second factor with — and what does
// not count, on purpose.
//
// Two rules live here because a shortcut through either one turns onboarding,
// and later `requireStepUp`, into theatre:
//
// - An unconfirmed TOTP secret is not a factor. Generating one only proves a
//   QR code was drawn, not that anybody scanned it — the screen could have
//   been photographed wrong, or abandoned halfway. Counting it would let a
//   session pass a gate it cannot actually satisfy: nobody can type a code
//   back for a secret they never captured.
// - Recovery codes are the way back in when a real factor is unreachable, not
//   a factor of their own. They are handed out at the *end* of registering
//   one, precisely because that assumes one already exists. Counting them
//   here would let onboarding — and later, `requireStepUp` — finish with
//   nothing but a sheet of paper, which is the exact hole the second factor
//   was built to close.
//
// The three tables this file queries are empty until a later plan starts
// writing to them: registering a passkey, confirming a TOTP secret, issuing
// recovery codes. So today this returns zero for everybody — that is not a
// stub, it is the correct answer for an account that has genuinely
// registered nothing, and the two rules above are exercised by the tests
// beside this file rather than left for the day rows finally appear.

import { Op } from "sequelize";
import { CredencialWebauthnModel } from "../models/credencialWebauthn.model.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { CodigoRecuperacionModel } from "../models/codigoRecuperacion.model.js";

/** The raw inventory: how many of each thing this account has registered. */
export interface InventarioFactores {
  passkeys: number;
  totp: number;
  codigos: number;
}

/**
 * The raw inventory: how many of each thing this account has registered.
 *
 * `totp` already excludes an unconfirmed secret — the query asks for
 * `confirmed_at IS NOT NULL` directly, so the exclusion lives in the one
 * place nobody reading this later could skip by accident. `codigos` counts
 * *unredeemed* codes only (`used_at IS NULL`), which is the number worth
 * showing somebody deciding whether to generate a fresh batch. `passkeys` is
 * a plain count: every row here already went through a WebAuthn ceremony
 * that proved possession, so there is no confirmation step left to ask for.
 */
export async function factoresDe(id_usuario: number): Promise<InventarioFactores> {
  const [passkeys, totp, codigos] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario } }),
    FactorTotpModel.count({ where: { id_usuario, confirmed_at: { [Op.ne]: null } } }),
    CodigoRecuperacionModel.count({ where: { id_usuario, used_at: null } }),
  ]);
  return { passkeys, totp, codigos };
}

/**
 * Whether this account has anything `requireStepUp` may accept in place of
 * the current password.
 *
 * Deliberately `passkeys > 0 || totp > 0` and nothing else — the second rule
 * this file exists to enforce is that recovery codes never join that `||`.
 *
 * Queries the two relevant tables directly rather than calling `factoresDe`
 * and discarding its `codigos` count: this runs on the hot path of every
 * gated write `requireStepUp` guards, and a third COUNT this function has no
 * use for is a third round trip charged to every one of them. `factoresDe`
 * keeps all three, for callers that actually want the full inventory (a
 * settings screen showing "2 passkeys, no TOTP, 5 recovery codes left").
 * Both share the same confirmed-only TOTP rule, each in its own query, since
 * there is no third function here for one copy of it to live in without one
 * of these two calling the other and paying for a table it does not need.
 */
export async function tieneAlgunFactor(id_usuario: number): Promise<boolean> {
  const [passkeys, totp] = await Promise.all([
    CredencialWebauthnModel.count({ where: { id_usuario } }),
    FactorTotpModel.count({ where: { id_usuario, confirmed_at: { [Op.ne]: null } } }),
  ]);
  return passkeys > 0 || totp > 0;
}
