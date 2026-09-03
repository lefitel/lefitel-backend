// The login code by email — plan 4E. Minting, charging an attempt, spending,
// purging. The only module that touches `codigo_correo`; the controllers
// built on top of it never see bcrypt, the caps or the SQL.
//
// **The one rule everything here serves: an attempt is charged before it is
// compared, by the statement that reads the hash.** The first draft of the
// design read the row, compared, and then incremented `intentos`. An audit
// traced what N requests in the same tick do to that: all N read `intentos =
// 0`, all N compare, all N land, and "five attempts per code" is five times
// N. `cobrarIntento` below is one `UPDATE … RETURNING`: the increment, the
// burn at the cap and the read of the hash are a single row-locked statement,
// so N concurrent requests see N distinct values of `intentos` and from the
// fifth on none of them obtains the hash. It is the shape
// `recoveryCodeStore.ts` describes as "the write that marks a code used is
// the same statement that checks it is still unused", applied to the attempt
// counter instead of to `used_at`.
//
// **Why bcrypt for six digits.** SHA-256 over a million values is reversed
// from a dump in milliseconds; bcrypt at `BCRYPT_COST` makes a dump taken
// inside the ten-minute window worth nothing. The cost per compare (~250 ms)
// is bounded by the cap above and by `EMAIL_CODE_VERIFY_LIMIT` in the
// controller.
//
// **Why the caps live in the database.** Cooldown, hourly and daily limits are
// computed from this account's own `created_at` rows, spent or not: a process
// restart forgets nothing, and a second process would see the same numbers.
// The sweep (`purgarCodigosCaducados`) keeps everything younger than a day
// for the same reason — an audit of the first draft found it deleting each
// spent row on the next mint, which reset every cap to "one code a minute,
// for ever". The per-process bucket of `emailCodeVerifyBudget.ts` is the
// deliberate exception, for the verification attempts, and its header says
// why.
//
// **One clock.** `created_at` and `expires_at` are written from this
// process's clock, and every comparison against them — the caps here, the
// liveness clause in `cobrarIntento`, the sweep — uses the same clock. A
// database whose clock drifted ten minutes from the app's would otherwise
// kill every code on arrival with no diagnostic.
//
// **Two codes can never be valid at once, and the schema says so.**
// `emitirCodigo` burns the pending code before inserting the new one, and the
// partial unique index `codigo_correo_pendiente_idx` makes two concurrent
// mints — a double click, two tabs — fail on the second insert instead of
// leaving two rows for the spend to charge. That failure is read here as
// "somebody else just minted one" and answered as a cooldown.

import { randomInt } from "node:crypto";
import bcryptjs from "bcryptjs";
import { Op, QueryTypes, type Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { CodigoCorreoModel } from "../models/codigoCorreo.model.js";
import {
  BCRYPT_COST,
  EMAIL_CODE_TTL_MS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_RESEND_SECONDS,
  EMAIL_CODE_HOURLY_LIMIT,
  EMAIL_CODE_DAILY_LIMIT,
} from "../config/security.js";

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/** Why a code was not minted, and how long to wait — what the 429 carries. */
export interface EmisionRechazada {
  rechazado: "cooldown" | "tope-hora" | "tope-dia";
  reintento_en_s: number;
}

export type ResultadoEmision = { codigo: string } | EmisionRechazada;

/**
 * Six digits, zero-padded. `randomInt` and not `randomBytes % 1e6`: the
 * modulo of a byte string is biased, `randomInt` is not.
 */
export function generarCodigo(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Seconds until `instante`, never below one — a 429 that says "retry in 0 s" is a lie. */
function segundosHasta(instante: number, ahora: number): number {
  return Math.max(1, Math.ceil((instante - ahora) / 1000));
}

const INDICE_PENDIENTE_UNICO = "codigo_correo_pendiente_idx";

/**
 * `true` for the one error the unique index produces when two mints race.
 * Matched by class **and** by index name: inside the mint's transaction only
 * `codigo_correo` is touched, but a primary-key collision — a sequence left
 * behind by a restore — is the same class, and answering it as a sixty-second
 * cooldown would hide a 500 one minute at a time.
 */
function esViolacionDePendienteUnico(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; parent?: { constraint?: unknown }; original?: { constraint?: unknown } };
  if (e.name !== "SequelizeUniqueConstraintError") return false;
  return (e.parent?.constraint ?? e.original?.constraint) === INDICE_PENDIENTE_UNICO;
}

/**
 * Mint a code for this account and hand back the only copy of it there will
 * ever be — the caller mails it; the row holds bcrypt.
 *
 * Refuses, with how long to wait, when the account minted one less than
 * `EMAIL_CODE_RESEND_SECONDS` ago, or `EMAIL_CODE_HOURLY_LIMIT` in the last
 * hour, or `EMAIL_CODE_DAILY_LIMIT` in the last day. The three are read from
 * this account's own rows in one query, newest first, so the cooldown is the
 * first row and the two caps are counts over the same list.
 *
 * `ahora` is a parameter so the caps can be tested against a fixed clock; it
 * is also what the row's `created_at` and `expires_at` are written from, so
 * the row and the count agree on what "now" was.
 *
 * The hash is computed **before** the transaction opens: bcrypt is CPU, and a
 * transaction held open across it is a pool connection held for nothing.
 */
export async function emitirCodigo(
  id_usuario: number,
  email_destino: string,
  ahora: Date = new Date(),
): Promise<ResultadoEmision> {
  const t = ahora.getTime();
  const recientes = await CodigoCorreoModel.findAll({
    where: { id_usuario, created_at: { [Op.gt]: new Date(t - DIA_MS) } },
    attributes: ["created_at"],
    order: [["created_at", "DESC"]],
  });
  const creados = recientes.map((fila) => new Date(fila.dataValues.created_at).getTime());

  if (creados.length > 0 && t - creados[0] < EMAIL_CODE_RESEND_SECONDS * 1000) {
    return { rechazado: "cooldown", reintento_en_s: segundosHasta(creados[0] + EMAIL_CODE_RESEND_SECONDS * 1000, t) };
  }
  const enLaHora = creados.filter((c) => c > t - HORA_MS);
  if (enLaHora.length >= EMAIL_CODE_HOURLY_LIMIT) {
    // The oldest of the hour is the one that leaves the window first.
    return { rechazado: "tope-hora", reintento_en_s: segundosHasta(enLaHora[enLaHora.length - 1] + HORA_MS, t) };
  }
  if (creados.length >= EMAIL_CODE_DAILY_LIMIT) {
    return { rechazado: "tope-dia", reintento_en_s: segundosHasta(creados[creados.length - 1] + DIA_MS, t) };
  }

  const codigo = generarCodigo();
  const codigo_hash = await bcryptjs.hash(codigo, BCRYPT_COST);
  try {
    await sequelize.transaction(async (transaction) => {
      await CodigoCorreoModel.update(
        { used_at: ahora },
        { where: { id_usuario, used_at: null }, transaction },
      );
      await CodigoCorreoModel.create(
        {
          id_usuario,
          email_destino,
          codigo_hash,
          expires_at: new Date(t + EMAIL_CODE_TTL_MS),
          used_at: null,
          created_at: ahora,
        },
        { transaction },
      );
    });
  } catch (err) {
    if (esViolacionDePendienteUnico(err)) {
      // Two mints raced and the other one won: its code is in the mail. The
      // honest answer is the same the cooldown gives — wait for that one.
      return { rechazado: "cooldown", reintento_en_s: EMAIL_CODE_RESEND_SECONDS };
    }
    throw err;
  }
  return { codigo };
}

/** What `cobrarIntento` hands back when a live code exists: enough to compare, nothing more. */
export interface IntentoCobrado {
  id: number;
  codigo_hash: string;
  /**
   * `true` when this charge was the one that reached the cap and burned the
   * row — in the same statement that read the hash. The caller must then
   * not try to spend the row again: `liquidarCodigo` only spends an unspent
   * row, and a correct last-allowed code would otherwise find its own burn,
   * be answered as wrong, and lock the account on it (audit of the first
   * draft, plan 4E).
   */
  agotado: boolean;
}

/**
 * Charge one attempt against the account's pending code and return its hash
 * — or `null` when there is no live code to charge: none was minted, it
 * expired, it was spent, it was burned by the cap, the address it went to is
 * no longer the account's verified address, or the account is archived.
 *
 * **One statement, by construction.** The increment, the burn at
 * `EMAIL_CODE_MAX_ATTEMPTS` and the read of the hash happen in the same
 * row-locked `UPDATE`, so concurrent requests are serialised by Postgres and
 * the cap holds for N of them at once. Runs outside any transaction, on
 * purpose: the compare that follows is bcrypt, and nothing should hold a
 * connection while it runs. The header says why.
 *
 * `email_destino` is compared with the account's **verified** address inside
 * the same `WHERE`: a code minted for an address the account has since
 * changed — or merely re-sent to, which clears `email_verified_at` — is not
 * charged and not returned. The `"deletedAt" IS NULL` clause is the model's
 * `paranoid` rule, spelled out because raw SQL does not inherit it.
 * `expires_at` is compared with `:ahora`, this process's clock, because that
 * is the clock that wrote it — the header says why the two must agree.
 * `used_at` takes the database's `now()`: it is a marker, compared by nobody.
 *
 * The caller does not learn *why* it got `null`, and that is the point: the
 * design's uniformity rule says "expired" must not be distinguishable from
 * "wrong", in the answer or in the time it takes — the controller compares
 * against `fillerHash()` on this path for the second half.
 */
export async function cobrarIntento(id_usuario: number, ahora: Date = new Date()): Promise<IntentoCobrado | null> {
  const [filas] = (await sequelize.query(
    "UPDATE codigo_correo " +
      "SET intentos = intentos + 1, " +
      "used_at = CASE WHEN intentos + 1 >= :max THEN now() ELSE used_at END " +
      "WHERE id_usuario = :id AND used_at IS NULL AND expires_at > :ahora " +
      "AND email_destino = (" +
      'SELECT email FROM usuarios WHERE id = :id AND email_verified_at IS NOT NULL AND "deletedAt" IS NULL' +
      ") " +
      // `RETURNING` sees the row as updated: `used_at` is set exactly when
      // this charge burned it, because the `WHERE` required it null before.
      "RETURNING id, codigo_hash, (used_at IS NOT NULL) AS agotado",
    { replacements: { id: id_usuario, max: EMAIL_CODE_MAX_ATTEMPTS, ahora }, type: QueryTypes.UPDATE },
  )) as unknown as [IntentoCobrado[], unknown];
  return filas[0] ?? null;
}

/**
 * Spend the code whose hash just matched. `true` when this call is the one
 * that spent it; `false` when it was already spent — a concurrent request
 * with the same correct code got there first, and only one of the two may
 * promote a session. Runs on the caller's transaction, beside the promotion,
 * so that a promotion that finds nothing to promote rolls the spend back too.
 */
export async function liquidarCodigo(
  id: number,
  opciones: { transaction?: Transaction } = {},
): Promise<boolean> {
  const [count] = await CodigoCorreoModel.update(
    { used_at: new Date() },
    { where: { id, used_at: null }, transaction: opciones.transaction },
  );
  return count > 0;
}

/**
 * Sweep the rows older than a day. **Not "spent or expired"**: the cooldown
 * and the two caps in `emitirCodigo` are counted from this account's rows of
 * the last twenty-four hours, spent or not, and a sweep that removed each
 * spent row on the next mint reset every cap — an audit of the first draft
 * traced it to one code a minute, for ever, with nothing but a stolen
 * password. A row older than a day is expired many times over and outside
 * every window, so nothing is lost by keeping the young ones.
 *
 * Called opportunistically from the route that mints one, the way
 * `purgeExpiredTokens` rides the login — there is no scheduler for these
 * rows to join. Returns how many rows went.
 */
export async function purgarCodigosCaducados(ahora: Date = new Date()): Promise<number> {
  return CodigoCorreoModel.destroy({
    where: { created_at: { [Op.lt]: new Date(ahora.getTime() - DIA_MS) } },
  });
}
