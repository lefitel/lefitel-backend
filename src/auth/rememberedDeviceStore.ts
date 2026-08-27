// The `dispositivo_recordado` table: browsers that have already proved a
// factor and asked not to be asked again on this machine.
//
// Only two of its operations exist in the 4A skeleton, because there is not yet
// any factor to prove: the sweep that stops the table growing for ever, and the
// revocation that has to run when an account is archived. Issuing and accepting
// a device cookie belong to the plans that build the factors.
//
// Its own module rather than a corner of `purgeJob.ts`, for the same reason
// `purgeExpiredSessions` lives in `sessionStore.ts` and `purgeExpiredTokens` in
// `tokenStore.ts`: the query that deletes from a table belongs beside the rest
// of that table's queries, and it is where the next person to touch this table
// will look. `purgeJob.ts` holds the scheduling and imports no model at all,
// which is precisely what lets it be tested without a database.

import { Op, type Transaction } from "sequelize";
import { DispositivoRecordadoModel } from "../models/dispositivoRecordado.model.js";
import { REMEMBERED_DEVICE_REVOKED_MAX_AGE_DAYS } from "../config/security.js";

const DAY_MS = 86_400_000;

/**
 * Delete the rows that can no longer let anybody past a second factor.
 *
 * Nothing else deletes from this table, so without this it only grows — and it
 * does not grow with harmless bookkeeping: every row holds an IP address and a
 * user agent, which is personal data kept for as long as the row is.
 *
 * Two ways in, and they are deliberately not symmetric:
 *
 * - **Expired.** `expires_at` already in the past. The acceptance condition
 *   refuses the row from that instant, so there is nothing left to keep it for.
 * - **Revoked longer ago than the cap.** This branch only ever makes a row go
 *   *sooner*. A device cut off while still valid would otherwise sit here until
 *   its own `expires_at`, and a device cookie is long-lived on purpose, so
 *   without this branch a laptop revoked in January keeps its IP address and its
 *   user agent on disk until March. See `REMEMBERED_DEVICE_REVOKED_MAX_AGE_DAYS`.
 *
 * Neither branch carries a grace margin, so **nothing here promises a revoked
 * row will survive any particular length of time**: a device revoked yesterday
 * that also expires today goes today. What a revoked row actually gets is
 * `min(its own expiry, revocation + thirty days)`. That is deliberate — an
 * expired row is dead weight holding personal data whether or not anybody
 * revoked it first — and it is why this table is the wrong place to look for a
 * durable record of a revocation. That record is the bitácora line
 * `deleteUsuario` writes.
 *
 * `revoked_at: { [Op.lt]: cutoff }` carries the "and is not null" for free —
 * SQL compares NULL with nothing, so a device that was never revoked never
 * matches that branch. Spelling it out as an explicit `IS NOT NULL AND <` would
 * be the same query with one more thing to get wrong. Same shape, same reason,
 * as `purgeExpiredSessions`.
 */
export async function purgeExpiredRememberedDevices(): Promise<number> {
  const cutoff = new Date(Date.now() - REMEMBERED_DEVICE_REVOKED_MAX_AGE_DAYS * DAY_MS);
  return DispositivoRecordadoModel.destroy({
    where: {
      [Op.or]: [{ expires_at: { [Op.lt]: new Date() } }, { revoked_at: { [Op.lt]: cutoff } }],
    },
  });
}

/**
 * Cut off every browser this account had told to stop asking.
 *
 * Called when an account is archived, and it has to be called explicitly: that
 * delete is *logical*, so the `ON DELETE RESTRICT` on `id_usuario` never fires
 * and no cascade ever will. The rows survive the archive — and so, without this,
 * does every device cookie on them, ready to skip the second factor the moment
 * `desarchivarUsuario` brings the account back. See `deleteUsuario` for why that
 * undo, and not the archived stretch itself, is where the hole would be.
 *
 * Revoked, not deleted: the row stays until the sweep takes it, so the sessions
 * screen can still show that the device existed and when it was cut off. How
 * long that is — and why it is a ceiling rather than a guarantee — is written on
 * `purgeExpiredRememberedDevices` above.
 *
 * `revoked_at: null` in the WHERE leaves an already-revoked device's stamp
 * exactly where it was. Overwriting it would move the record of when the device
 * was really cut off to whenever the last unrelated revocation happened to run,
 * and would restart that row's retention clock every time. Same clause, same
 * reason, as `revokeAllSessionsOf`.
 */
export async function revokeAllRememberedDevicesOf(
  id_usuario: number,
  options: { transaction?: Transaction } = {},
): Promise<number> {
  const [count] = await DispositivoRecordadoModel.update(
    { revoked_at: new Date() },
    { where: { id_usuario, revoked_at: null }, transaction: options.transaction },
  );
  return count;
}
