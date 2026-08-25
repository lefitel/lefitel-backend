import { Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { TokenUsoUnicoModel } from "../models/tokenUsoUnico.model.js";
import { newOpaqueToken, hashOpaqueToken } from "./opaqueToken.js";
import { EMAIL_VERIFY_TOKEN_TTL_MS, PASSWORD_RESET_TOKEN_TTL_MS } from "../config/security.js";
import type { ITokenUsoUnico } from "../interfaces/index.js";

/**
 * How long a freshly minted token stays redeemable, keyed by `proposito` so
 * the duration is this module's decision and not the caller's — see
 * `crearToken` below.
 */
const TTL_MS: Record<ITokenUsoUnico["proposito"], number> = {
  verify_email: EMAIL_VERIFY_TOKEN_TTL_MS,
  reset_password: PASSWORD_RESET_TOKEN_TTL_MS,
};

/**
 * Mint a token for one purpose, and hand back the only copy of it that will
 * ever exist outside this table.
 *
 * The return value is the plain token — not stored anywhere, not logged, not
 * readable back out of the database once this call returns. Whoever calls
 * this is responsible for it from here: an email body, and nowhere else.
 *
 * **Minting invalidates whatever of the same purpose was already pending for
 * this account**, in the same transaction as the insert. Without this, a
 * second "forgot my password" click issues a second live credential instead
 * of replacing the first: two links in two emails, both good for fifteen
 * minutes from when *they* were sent — and the first one does not stop being
 * good just because somebody asked for another, so its effective lifetime is
 * however long that inbox takes to be read. The cost lands on the person, not
 * on security: if the first email arrives late and they click the old link,
 * it answers exactly like an expired or already-used one — "this link no
 * longer works, ask for another" — which is the same screen those two cases
 * already show.
 *
 * `expires_at` is computed from `new Date()` — the process clock, not
 * Postgres's `now()`. Deliberate: the API and the database run on the same
 * host, so the drift between the two clocks is milliseconds against a fifteen-
 * minute margin. If Postgres ever moves to its own machine, this assumption
 * is what needs revisiting.
 */
export async function crearToken(input: {
  id_usuario: number;
  email_destino: string;
  proposito: ITokenUsoUnico["proposito"];
}): Promise<string> {
  const token = newOpaqueToken();
  const expiresAt = new Date(Date.now() + TTL_MS[input.proposito]);

  await sequelize.transaction(async (transaction) => {
    // Only the still-pending ones: an already-used or already-expired row
    // has nothing left to invalidate, and leaving its `used_at` alone keeps
    // it as a true record of when it was actually redeemed.
    await TokenUsoUnicoModel.update(
      { used_at: new Date() },
      {
        where: { id_usuario: input.id_usuario, proposito: input.proposito, used_at: null },
        transaction,
      },
    );

    await TokenUsoUnicoModel.create(
      {
        id_usuario: input.id_usuario,
        email_destino: input.email_destino,
        token_hash: hashOpaqueToken(token),
        proposito: input.proposito,
        expires_at: expiresAt,
        used_at: null,
      },
      { transaction },
    );
  });

  return token;
}

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
