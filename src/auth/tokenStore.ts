import { Op } from "sequelize";
import { TokenUsoUnicoModel } from "../models/tokenUsoUnico.model.js";
import { hashOpaqueToken } from "./opaqueToken.js";
import type { ITokenUsoUnico } from "../interfaces/index.js";

/**
 * Redeem a token, atomically, and hand back who it belongs to.
 *
 * The four conditions below are the whole security property of this
 * mechanism, and they have to be in the same `UPDATE` rather than checked in
 * JavaScript after a separate `SELECT`: splitting it in two opens a window
 * where two simultaneous requests both read "valid" and both go on to redeem
 * the same token. `returning: true` is what makes this one statement do
 * both jobs — mark it used *and* hand back the row it just matched — instead
 * of a read-then-write pair with that same race between them.
 *
 * Zero rows affected means "not valid", and the caller cannot tell expired,
 * already-used and never-existed apart from this answer, on purpose: any of
 * the three would otherwise let a caller confirm a token existed for a given
 * purpose before proving they hold the current value of it.
 */
export async function consumirToken(
  token: string,
  proposito: ITokenUsoUnico["proposito"],
): Promise<{ id_usuario: number; email_destino: string } | null> {
  const [count, rows] = await TokenUsoUnicoModel.update(
    { used_at: new Date() },
    {
      where: {
        token_hash: hashOpaqueToken(token),
        proposito,
        // Equality against NULL, not "already redeemed" written as a
        // separate check afterwards: a second redemption of the same token
        // has to fail inside this same query, not in a follow-up read that a
        // concurrent request could race past.
        used_at: null,
        expires_at: { [Op.gt]: new Date() },
      },
      returning: true,
    },
  );
  if (count === 0) return null;
  const row = rows[0].dataValues;
  return { id_usuario: row.id_usuario, email_destino: row.email_destino };
}

/**
 * Delete rows nothing can redeem any more: used, or expired.
 *
 * Called opportunistically from the login handler rather than on a schedule
 * — see `auth.controller.ts` — because a cron job or a daily `setInterval`
 * is one more moving part that can stop running without anyone noticing,
 * where a login happens constantly and for free. `used_at` is compared with
 * `Op.ne` against `null`, which Sequelize renders as `IS NOT NULL` — the
 * same idiom this codebase already uses for `deletedAt` elsewhere (see e.g.
 * `usuario.controller.ts`'s `archived` filter).
 */
export async function purgeExpiredTokens(): Promise<number> {
  return TokenUsoUnicoModel.destroy({
    where: {
      [Op.or]: [{ used_at: { [Op.ne]: null } }, { expires_at: { [Op.lt]: new Date() } }],
    },
  });
}
