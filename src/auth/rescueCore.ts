// The escape hatch from §8 of `docs/specs/2026-08-21-autenticacion-mfa-design.md`
// ("La vía de escape"), as plain functions that know nothing about HTTP or a
// terminal.
//
// **Why this file exists at all, and why it is the piece that matters most in
// this plan.** Two callers need every one of these operations: `POST
// /usuario/:id/mfa/reset` (this same plan, in `usuario.controller.ts`) and
// `--reset-mfa`/`--unlock`/`--revoke-sessions`/`--set-email`/`--clear-email`/
// `--unarchive` on the console script (the next plan, `src/scripts/rescue.ts`).
// If each wrote its own copy of "delete the factor rows, revoke sessions,
// revoke devices, extend the grace, write the audit line", the two would
// diverge the first time either one changed — and the one used less often,
// almost certainly the console, is the one that would still be broken the
// night it is needed for real. So every rule the pre-audit measured
// (`.superpowers/sdd/2026-08-26-esqueleto-mfa/preaudit-via-de-escape.md`), plus
// the later fixes the 2026-09-01 four-agent audit found, lives here exactly
// once, and both doors are thin translations onto these six functions:
//
//   restablecerSegundoFactor   — H1, H2, H6, H6-bis, A4
//   desbloquearCuentaDeRescate
//   revocarSesionesDeRescate   — H6-bis
//   establecerEmailDeRescate   — H4, H8
//   limpiarEmailDeRescate
//   desarchivarCuentaDeRescate — A1: the one door Task 1 does not close,
//                                because it stops you archiving *yourself*,
//                                not somebody else archiving the last account
//                                holding `seguridad.archivar`.
//
// **No `req`, no `res`, no `process.argv`.** Every function below takes plain
// values in and returns plain values out. `ActorRescate` is how a caller
// names itself — a formatted string plus an IP that is `null` from the
// console — and it is *never* built here: this module would have to import
// Express types for one and `node:os` for the other, and either one is the
// crack a later editor pours a `req` reference into "just this once".
//
// **The shape every one of the five follows, and it is not incidental — it
// is the fix for two audit findings at once (H4's untraceable insider and the
// silent `logAction` catch):**
//
//   1. Resolve the target and refuse if it does not exist or is archived.
//   2. Send the security notice (`securityNotice.ts`'s `avisarRescate`) and
//      *wait for it* — before anything is written. Decided by Isaias: this
//      goes out whether the request is legitimate or not, because it is the
//      one trace that does not live in a table the operator's own database
//      credentials can edit.
//   3. Run the mutation inside one transaction.
//   4. Write exactly one bitácora line, *outside* that transaction, whether
//      step 3 succeeded or threw — never inside it. Inside it, a rollback
//      would erase precisely the record that was supposed to survive the
//      failure (pre-audit H6's own words). This is also why it is a
//      dedicated `BitacoraModel.create` and not `logAction`: that helper
//      ends in an empty `catch` that nothing awaits, so a failed insert
//      there reports success to a caller that already believes the rescue
//      was recorded. Here the write is awaited and its failure propagates.
//
// **Attribution.** `bitacoras.id_usuario` is `NOT NULL` with a real foreign
// key to `usuarios(id)` — there is no sentinel row and no NULL to fall back
// to. Every line below is written against the *rescued* account, with the
// real actor (console OS user, or the administrator's own account) inside
// `metadata`. `verifyEmail` (`controllers/email.controller.ts`) already does
// exactly this for the same structural reason — the caller is not always the
// subject — and it is where anybody reading this table later would look for
// the actor anyway: right beside the account something happened to.

import type { Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { CredencialWebauthnModel } from "../models/credencialWebauthn.model.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { CodigoRecuperacionModel } from "../models/codigoRecuperacion.model.js";
import { TokenUsoUnicoModel } from "../models/tokenUsoUnico.model.js";
import { BitacoraModel } from "../models/bitacora.model.js";
import { revokeAllSessionsOf } from "./sessionStore.js";
import { revokeAllRememberedDevicesOf } from "./rememberedDeviceStore.js";
import { whereUsernameIs } from "../utils/username.js";
import { avisarRescate } from "./securityNotice.js";
import { RESCUE_GRACE_HOURS } from "../config/security.js";

const HORA_MS = 60 * 60 * 1000;

/**
 * Who is running a rescue operation, and from where — supplied by the
 * caller, never derived here.
 *
 * `descripcion` is free text meant for a human reading the notice email or
 * the bitácora `metadata`, not a machine-parsed field: the console formats
 * something like `"consola: isaias@VPS-osefi (pid 41213)"`, and the endpoint
 * formats `"endpoint: @admin_isaias (id 1)"`.
 */
export interface ActorRescate {
  descripcion: string;
  /** `null` for the console — there is no HTTP request to read one off. */
  ip: string | null;
}

/** The account a rescue operation actually ran against. */
export interface CuentaRescatada {
  id: number;
  user: string;
}

/**
 * The three ways naming a target account, by id, can fail — shared by the
 * four operations that do not touch `usuarios.email`.
 *
 * Not a fourth case for "the database is unreachable" or similar: those
 * propagate as a thrown error, same convention as `auth/credentials.ts`
 * (`verifyCredentials`'s own docblock: "Throws nothing of its own. A database
 * failure propagates, and the caller turns it into a 500"). `ok: false` here
 * is reserved for an answer this module actually knows how to give, not for
 * everything that could possibly go wrong underneath it.
 *
 * **Every arm names every key, the ones it does not use as `?: undefined`.**
 * Same reasoning `auth/credentials.ts`'s `ResultadoCredenciales` already
 * documents: `tsconfig.json` has `strictNullChecks` off, and without it
 * TypeScript will not narrow `if (!resultado.ok)` against a union whose arms
 * have genuinely different keys — every arm here needs the same key set for
 * that narrowing to work at every call site, this file's own included.
 */
export type ResultadoRescate<T> =
  | {
      ok: true;
      cuenta: CuentaRescatada;
      avisoEnviado: boolean;
      datos: T;
      motivo?: undefined;
      user?: undefined;
    }
  | {
      ok: false;
      motivo: "no-encontrada";
      cuenta?: undefined;
      avisoEnviado?: undefined;
      datos?: undefined;
      user?: undefined;
    }
  | {
      ok: false;
      motivo: "archivada";
      user: string;
      cuenta?: undefined;
      avisoEnviado?: undefined;
      datos?: undefined;
    };

/**
 * `establecerEmailDeRescate` alone can also fail on the partial unique index
 * — see H8 — which is a fourth, equally expected outcome and not a database
 * failure. Kept off `ResultadoRescate` itself so the other four functions'
 * callers are not made to handle a branch that can never fire for them.
 */
export type ResultadoRescateEmail<T> =
  | ResultadoRescate<T>
  | {
      ok: false;
      motivo: "email-en-uso";
      cuenta?: undefined;
      avisoEnviado?: undefined;
      datos?: undefined;
      user?: undefined;
    };

/**
 * `desarchivarCuentaDeRescate`'s own result shape — deliberately not built on
 * `ResultadoRescate<T>`. That type's "archivada" arm is a refusal for the
 * other five operations; here archived is the success case, and the refusal
 * that replaces it is "no-archivada", for a target that exists but was never
 * archived in the first place. Same "every arm names every key" treatment as
 * `ResultadoRescate`, for the identical `strictNullChecks: false` reason.
 */
export type ResultadoDesarchivo<T> =
  | {
      ok: true;
      cuenta: CuentaRescatada;
      avisoEnviado: boolean;
      datos: T;
      motivo?: undefined;
      user?: undefined;
    }
  | {
      ok: false;
      motivo: "no-encontrada";
      cuenta?: undefined;
      avisoEnviado?: undefined;
      datos?: undefined;
      user?: undefined;
    }
  | {
      ok: false;
      motivo: "no-archivada";
      user: string;
      cuenta?: undefined;
      avisoEnviado?: undefined;
      datos?: undefined;
    };

/**
 * H1, made a pure function with its own name so it can be tested on its own
 * — the pre-audit's own instruction ("Escríbelo como test con nombre").
 *
 * **Never a reduction.** A plain assignment of `ahora + RESCUE_GRACE_HOURS`
 * reads as generosity ("grant a fresh 24 hours") and is the opposite of it
 * for the common case: on deploy day 0 of 15 accounts have
 * `mfa_grace_until` set, the login stamps `MFA_GRACE_DAYS` (14 days) on each
 * one's first login, and a technician with twelve of those fourteen days
 * left who loses their phone on day 2 would have a rescue meant to help them
 * cut that down to one day instead. `Math.max` is the whole fix: whichever
 * deadline is later survives.
 *
 * **`actual: null` does not mean "no deadline, so start one" — A4.** It
 * means the clock has never started at all: every account has NULL here
 * until its first login after the 4A deploy, the same fact
 * `sessionState.ts`'s own `estadoEfectivo` already reasons about on this
 * exact column ("every account has NULL in this column until its first
 * login after the deploy"). A rescue is not a login, so it must not be what
 * starts that clock — stamping a 24-hour deadline on an account that had
 * never logged in would *shorten* the fourteen days that account's actual
 * first login is supposed to hand it, which is the one thing this whole
 * function exists to prevent. `null` in, `null` out: the caller is told to
 * leave `usuarios.mfa_grace_until` exactly where it found it — the same
 * "a date means write it, `null` means leave the column alone" convention
 * `factorInventory.ts`'s own `graceUntil` already documents.
 */
export function proximaGraciaDeRescate(actual: Date | null, ahora: Date): Date | null {
  if (actual === null) return null;
  const candidata = new Date(ahora.getTime() + RESCUE_GRACE_HOURS * HORA_MS);
  return actual.getTime() > candidata.getTime() ? actual : candidata;
}

/**
 * How a name typed at `--user` resolves to an account — the three traps
 * pre-audit finding H7 measured, closed once so the console does not have to
 * reopen any of them.
 *
 * - **Case.** `usuarios_user_uniq` is `UNIQUE (lower("user"))`, so this looks
 *   up the same way, through `whereUsernameIs` — the same helper the login
 *   uses, for the same reason: bytes say `Omar Mita` and `omar mita` are two
 *   different people, and the index does not.
 * - **Archived.** `UsuarioModel` is `paranoid`, so a plain lookup would
 *   silently miss an archived row and answer "no existe" about an account
 *   that is very much on file, just soft-deleted. Queried with
 *   `paranoid: false` and refused with its own reason instead — carrying the
 *   row's `id` too, even though a refusal, because `--unarchive` is the one
 *   caller (`rescue.ts`'s own `main()`) that needs to act on the account
 *   despite this exact refusal rather than stop at it.
 * - **Ambiguity.** The unique index is *partial* — `WHERE "deletedAt" IS
 *   NULL` — so with `paranoid: false` in play, one name can legitimately
 *   match more than one row: a live account and an archived one that once
 *   held the same name. `findAll`, not `findOne`, is what lets this tell
 *   that case apart from a single clean match instead of silently acting on
 *   whichever row Postgres happened to return first.
 */
export type ResolucionDeCuenta =
  | { ok: true; id: number; user: string; motivo?: undefined; ids?: undefined }
  | { ok: false; motivo: "no-encontrada"; id?: undefined; user?: undefined; ids?: undefined }
  | { ok: false; motivo: "archivada"; user: string; id: number; ids?: undefined }
  | { ok: false; motivo: "ambigua"; ids: number[]; id?: undefined; user?: undefined };

export async function resolverCuentaDeRescate(nombreUsuario: string): Promise<ResolucionDeCuenta> {
  const filas = await UsuarioModel.findAll({
    where: whereUsernameIs(nombreUsuario),
    paranoid: false,
    attributes: ["id", "user", "deletedAt"],
  });
  if (filas.length === 0) return { ok: false, motivo: "no-encontrada" };
  if (filas.length > 1) {
    return { ok: false, motivo: "ambigua", ids: filas.map((f) => f.dataValues.id) };
  }
  const fila = filas[0].dataValues;
  if (fila.deletedAt) return { ok: false, motivo: "archivada", user: fila.user, id: fila.id };
  return { ok: true, id: fila.id, user: fila.user };
}

/**
 * Shared first step of every operation below except `desarchivarCuentaDeRescate`:
 * does this id name a live account? Same "every arm names every key"
 * treatment as `ResultadoRescate` above, and for the same reason:
 * `ejecutarRescate` and `establecerEmailDeRescate` both narrow this result
 * with `if (!cuenta.ok)`.
 *
 * `desarchivarCuentaDeRescate` cannot use this one: for that operation an
 * archived account is exactly the case being looked for, the opposite of
 * what this function refuses. It uses `cuentaArchivadaOrNull` below instead
 * — same shape, same `paranoid: false` query, the one `if` flipped.
 */
async function cuentaActivaOrNull(id_usuario: number): Promise<
  | { ok: true; cuenta: CuentaRescatada; motivo?: undefined; user?: undefined }
  | { ok: false; motivo: "no-encontrada"; cuenta?: undefined; user?: undefined }
  | { ok: false; motivo: "archivada"; user: string; cuenta?: undefined }
> {
  const fila = await UsuarioModel.findOne({
    where: { id: id_usuario },
    paranoid: false,
    attributes: ["id", "user", "deletedAt"],
  });
  if (!fila) return { ok: false, motivo: "no-encontrada" };
  const v = fila.dataValues;
  if (v.deletedAt) return { ok: false, motivo: "archivada", user: v.user };
  return { ok: true, cuenta: { id: v.id, user: v.user } };
}

/**
 * `cuentaActivaOrNull`'s mirror image, for the one operation that needs the
 * opposite verdict — see that function's own comment for why copying it
 * outright and only touching the `if` is the trap here: the four operations
 * that go through `ejecutarRescate` inherit its "archived is a refusal" rule
 * from `cuentaActivaOrNull` itself, so reusing that helper (or a copy of one
 * of those four operations) for `desarchivarCuentaDeRescate` would make the
 * one case it exists for permanently unreachable.
 */
async function cuentaArchivadaOrNull(id_usuario: number): Promise<
  | { ok: true; cuenta: CuentaRescatada; motivo?: undefined; user?: undefined }
  | { ok: false; motivo: "no-encontrada"; cuenta?: undefined; user?: undefined }
  | { ok: false; motivo: "no-archivada"; user: string; cuenta?: undefined }
> {
  const fila = await UsuarioModel.findOne({
    where: { id: id_usuario },
    paranoid: false,
    attributes: ["id", "user", "deletedAt"],
  });
  if (!fila) return { ok: false, motivo: "no-encontrada" };
  const v = fila.dataValues;
  if (!v.deletedAt) return { ok: false, motivo: "no-archivada", user: v.user };
  return { ok: true, cuenta: { id: v.id, user: v.user } };
}

/**
 * The one and only bitácora write this module makes, always confirmed
 * *outside* the caller's mutation transaction — see the module header for
 * why that placement is load-bearing and not a style choice.
 *
 * No `try`/`catch`: unlike `utils/logAction.ts`, whose empty `catch` is
 * pre-audit finding H-the-headline (nothing in `src/` awaits it, so a failed
 * insert reports success to code that believes it was recorded), this is
 * awaited by every caller and a failure here is meant to propagate. A
 * rescue whose own audit line cannot be written has not finished, whatever
 * the transaction above it did.
 */
async function registrarRescateEnBitacora(input: {
  id_usuario: number;
  action: string;
  detail: string;
  actor: string;
  ip: string | null;
  resultado: "ok" | "error" | "conflicto";
  avisoEnviado: boolean;
  extra?: Record<string, unknown>;
}): Promise<void> {
  await BitacoraModel.create({
    id_usuario: input.id_usuario,
    action: input.action,
    detail: input.detail,
    entity: "Usuario",
    entity_id: input.id_usuario,
    severity: "critical",
    ip_address: input.ip,
    metadata: {
      actor: input.actor,
      resultado: input.resultado,
      aviso_enviado: input.avisoEnviado,
      ...input.extra,
    },
  });
}

/**
 * The shared spine of the three operations that both need a live (not
 * archived) target and cannot produce a database conflict. The other two
 * write their own, for two unrelated reasons: `establecerEmailDeRescate`
 * still needs a live target but can hit H8's unique-index conflict, a branch
 * this shape has no room for; `desarchivarCuentaDeRescate` needs the opposite
 * target validation entirely — archived is its success case — so it cannot
 * resolve through `cuentaActivaOrNull` (this function's first step) at all.
 *
 * Resolve → notify → mutate-in-a-transaction → log-outside-it, in that
 * order and no other: see the module header for why each step is where it
 * is.
 */
async function ejecutarRescate<T>(input: {
  id_usuario: number;
  actor: ActorRescate;
  /** Shared between the bitácora `action` column and the notice's `operacion`. */
  accion: string;
  /** One sentence: what this operation does. Shared between the notice body
   *  and the bitácora `detail` — both are meant to be read by a person, and
   *  a single sentence that is honest in both places is better than two that
   *  can drift apart. Kept well under `bitacoras.detail`'s 500-character cap
   *  by every call site below, none of which interpolates anything long. */
  detalle: string;
  mutar: (transaction: Transaction) => Promise<T>;
  /**
   * What of the outcome belongs in the bitácora row's metadata — the facts
   * `detalle` cannot know before the mutation ran. Optional: most rescues
   * have nothing to add. `restablecerSegundoFactor` passes whether the
   * account came out of it with a factor (its verified address) or without.
   */
  metadatosDe?: (datos: T) => Record<string, unknown>;
}): Promise<ResultadoRescate<T>> {
  const resolucion = await cuentaActivaOrNull(input.id_usuario);
  // `resolucion.ok === true` first, not `if (!resolucion.ok)`: with
  // `strictNullChecks` off (`tsconfig.json`), TypeScript does not narrow a
  // union on the *negated* truthiness of a boolean discriminant, only on an
  // explicit equality check — the same limitation `auth/credentials.ts`
  // documents on `ResultadoCredenciales`. Measured directly: `if
  // (!resolucion.ok) return resolucion;` here left `resolucion` unnarrowed at
  // the `return`, and `npm run typecheck` failed on it two branches down.
  if (resolucion.ok === true) {
    const { cuenta } = resolucion;
    const { enviado } = await avisarRescate({
      id_usuario: input.id_usuario,
      operacion: input.accion,
      detalle: input.detalle,
      actor: input.actor.descripcion,
      ip: input.actor.ip,
    });

    try {
      const datos = await sequelize.transaction((t) => input.mutar(t));
      await registrarRescateEnBitacora({
        id_usuario: input.id_usuario,
        action: input.accion,
        detail: input.detalle,
        actor: input.actor.descripcion,
        ip: input.actor.ip,
        resultado: "ok",
        avisoEnviado: enviado,
        ...(input.metadatosDe ? { extra: input.metadatosDe(datos) } : {}),
      });
      return { ok: true, cuenta, avisoEnviado: enviado, datos };
    } catch (err) {
      await registrarRescateEnBitacora({
        id_usuario: input.id_usuario,
        action: input.accion,
        detail: input.detalle,
        actor: input.actor.descripcion,
        ip: input.actor.ip,
        resultado: "error",
        avisoEnviado: enviado,
        extra: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  if (resolucion.motivo === "archivada") {
    return { ok: false, motivo: "archivada", user: resolucion.user };
  }
  return { ok: false, motivo: "no-encontrada" };
}

/** What `restablecerSegundoFactor` actually changed, for the caller to report. */
export interface DatosResetMfa {
  factoresBorrados: { passkeys: number; totp: number; codigos: number };
  sesionesRevocadas: number;
  dispositivosRevocados: number;
  /**
   * Whether the account keeps a verified address — which, since plan 4E, is
   * a second factor the reset deliberately does **not** remove. A caller
   * telling a human "ya puede entrar solo con su contraseña" has to check
   * this first: for a verified account the next login asks for a code by
   * email, and if the *mailbox* is what was lost, the remedy is
   * `establecerEmailDeRescate` / `limpiarEmailDeRescate`, not this reset.
   */
  correoVerificado: boolean;
  /**
   * `null` when the account's grace clock had never started —
   * `proximaGraciaDeRescate` said so, and `usuarios.mfa_grace_until` was
   * left untouched. A caller reporting this to a human must not call
   * `.toISOString()` on it unconditionally.
   */
  graceUntil: Date | null;
}

/**
 * The big one: clear every second factor an account has, and leave it in a
 * state that can actually be logged back into — not merely "empty".
 *
 * Four things, one transaction, matching the pattern `deleteUsuario`
 * (`controllers/usuario.controller.ts`) already uses for the same reason:
 * half of this is worse than none. Factors gone with sessions still alive is
 * the best outcome available to whoever caused the incident; factors gone
 * with the grace deadline unwritten is H1 in its most extreme form — the
 * account has nothing left to prove and no time to register anything either.
 *
 * 1. **Delete every row in the three factor tables** — `credencial_webauthn`,
 *    `factor_totp`, `codigo_recuperacion`. Their `id_usuario` FKs are
 *    `ON DELETE RESTRICT` on the *user's* deletion, not on deleting these
 *    rows themselves, so a plain `destroy` has nothing in its way.
 * 2. **Revoke every session, and every remembered device — H6-bis.**
 *    `revokeAllSessionsOf` alone is not the fix: a remembered-device cookie
 *    skips a login's second factor entirely and survives a session
 *    revocation on its own, so leaving it standing would let whoever caused
 *    this incident straight back in on the next login, second factor and
 *    all, without ever touching a password. Every one of the four call
 *    sites already in this codebase revokes both together; this is the
 *    fifth, and it does not get to be the one that forgets.
 * 3. **Lift the account lockout — H2.** Losing a factor is exactly the kind
 *    of afternoon that ends in five wrong password guesses first. The
 *    login's lockout (`checkAgainstRow` in `auth/credentials.ts`) refuses a
 *    locked account *before comparing anything*, with the same message a
 *    wrong password gets — so without this line the rescue finishes, the
 *    person tries to log in, and is told their correct password is wrong,
 *    with nothing on the screen explaining that a lockout, not the reset,
 *    is what is standing in the way now.
 * 4. **Extend the grace deadline, never reduce it, and never start a clock
 *    that had not already started — H1, A4.** See `proximaGraciaDeRescate`.
 *
 * All four inside one transaction: any one of them failing must not leave a
 * partial result on the table, and retrying the whole call after a 500 must
 * be safe — which it is, since every step here is idempotent. Deleting rows
 * already gone deletes nothing more, revoking already-revoked rows touches
 * nothing, and `proximaGraciaDeRescate` only ever moves the deadline later or
 * leaves it alone: run this whole operation twice on the same account and
 * the second call cannot make its grace worse than the first one left it,
 * whatever `ahora` reads on the retry — never a shorter deadline, and never
 * one invented on a clock that still had not started.
 */
export async function restablecerSegundoFactor(
  id_usuario: number,
  actor: ActorRescate,
): Promise<ResultadoRescate<DatosResetMfa>> {
  return ejecutarRescate({
    id_usuario,
    actor,
    accion: "RESCUE_MFA_RESET",
    detalle:
      "Se borraron sus llaves, su aplicación y sus códigos de recuperación, se revocaron sus sesiones y " +
      "dispositivos recordados, se levantó cualquier bloqueo por intentos fallidos y se concedió una gracia " +
      `de ${RESCUE_GRACE_HOURS} horas (nunca menor que la que ya tuviera). Su correo verificado, si lo ` +
      "tiene, no se toca: sigue siendo su segundo factor.",
    // The one fact the row is most often read for: did the account come out of
    // this with a factor (its verified address) or with nothing.
    metadatosDe: (datos) => ({ correo_es_factor: datos.correoVerificado }),
    mutar: async (transaction) => {
      const [passkeys, totp, codigos] = await Promise.all([
        CredencialWebauthnModel.destroy({ where: { id_usuario }, transaction }),
        FactorTotpModel.destroy({ where: { id_usuario }, transaction }),
        CodigoRecuperacionModel.destroy({ where: { id_usuario }, transaction }),
      ]);

      const sesionesRevocadas = await revokeAllSessionsOf(id_usuario, { transaction });
      const dispositivosRevocados = await revokeAllRememberedDevicesOf(id_usuario, { transaction });

      // `email_verified_at` read alongside the deadline: plan 4E made the
      // verified address a factor, and this reset leaves it in place — the
      // address is the account's recovery channel, not a lost device. The
      // caller has to report that honestly (see `DatosResetMfa`), and for a
      // verified account the grace computed below is moot: its next login
      // opens `parcial` and asks for a code by email, deadline or no deadline.
      const filaActual = await UsuarioModel.findOne({
        where: { id: id_usuario },
        attributes: ["mfa_grace_until", "email_verified_at"],
        transaction,
      });
      const correoVerificado = filaActual?.dataValues.email_verified_at != null;
      const graceUntil = proximaGraciaDeRescate(filaActual?.dataValues.mfa_grace_until ?? null, new Date());

      // `graceUntil === null` means "leave the column alone", not "write
      // NULL into it" — those give the same result on a row that already had
      // NULL, but not on one that carried a real deadline, which is exactly
      // what would happen if this always named `mfa_grace_until` in the
      // object below. So the key is only added when there is a value worth
      // writing.
      const cambios: Record<string, unknown> = { failed_attempts: 0, locked_until: null };
      if (graceUntil !== null) cambios.mfa_grace_until = graceUntil;

      await UsuarioModel.update(cambios, { where: { id: id_usuario }, transaction });

      return {
        factoresBorrados: { passkeys, totp, codigos },
        sesionesRevocadas,
        dispositivosRevocados,
        graceUntil,
        correoVerificado,
      };
    },
  });
}

/** What `desbloquearCuentaDeRescate` actually changed. */
export interface DatosDesbloqueo {
  desbloqueada: boolean;
}

/**
 * Lift an account lockout on its own, with none of `restablecerSegundoFactor`'s
 * other four effects — for `--unlock`/a caller that only needs the lockout
 * gone, not the factors.
 *
 * **Deliberately not a call into `desbloquearUsuario`
 * (`controllers/usuario.controller.ts`).** The pre-audit measured that
 * handler and found "nada importable: dos columnas escritas dentro del
 * controlador con `req`/`res` alrededor" — its two writes live inside a
 * function whose signature is `(req, res)`, so there is nothing here to
 * import without either wrapping a request around a console invocation or
 * duplicating two `UPDATE` columns. This is that duplication, done once,
 * tested once, and shared by both doors that need it.
 */
export async function desbloquearCuentaDeRescate(
  id_usuario: number,
  actor: ActorRescate,
): Promise<ResultadoRescate<DatosDesbloqueo>> {
  return ejecutarRescate({
    id_usuario,
    actor,
    accion: "RESCUE_ACCOUNT_UNLOCK",
    detalle: "Se levantó el bloqueo por intentos fallidos de inicio de sesión.",
    mutar: async (transaction) => {
      const [afectadas] = await UsuarioModel.update(
        { failed_attempts: 0, locked_until: null },
        { where: { id: id_usuario }, transaction },
      );
      return { desbloqueada: afectadas > 0 };
    },
  });
}

/** What `revocarSesionesDeRescate` actually changed. */
export interface DatosRevocacion {
  sesionesRevocadas: number;
  dispositivosRevocados: number;
}

/**
 * Close every live session of an account, and cut off every remembered
 * device with them — never one without the other.
 *
 * **H6-bis, made impossible to get wrong by not offering the choice.** There
 * is no `revocarSolamenteSesiones` export: a remembered-device cookie is a
 * second, independent way past a login's second factor, and it survives a
 * session revocation on its own — exactly the gap a rescue for "I think my
 * session was stolen" must not reopen through its own tool. Every one of the
 * four call sites this codebase already has (`deleteUsuario`, `logoutAll`,
 * `resetPassword`, `updateUserPass`) revokes both together; this is the
 * fifth, structurally.
 */
export async function revocarSesionesDeRescate(
  id_usuario: number,
  actor: ActorRescate,
): Promise<ResultadoRescate<DatosRevocacion>> {
  return ejecutarRescate({
    id_usuario,
    actor,
    accion: "RESCUE_SESSIONS_REVOKED",
    detalle: "Se cerraron todas sus sesiones activas y se revocaron sus dispositivos recordados.",
    mutar: async (transaction) => {
      const sesionesRevocadas = await revokeAllSessionsOf(id_usuario, { transaction });
      const dispositivosRevocados = await revokeAllRememberedDevicesOf(id_usuario, { transaction });
      return { sesionesRevocadas, dispositivosRevocados };
    },
  });
}

/** `n***@dominio.com` — the same shape `securityNotice.ts`'s own `maskEmail`
 *  uses, duplicated rather than imported so this module never has to import
 *  a function from the file it already calls for the notice itself; both
 *  copies exist to be read by a human, not compared byte for byte. */
function enmascarar(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * True for a Postgres unique-violation on `usuarios_email_verificado_uniq`
 * specifically — the same check `controllers/email.controller.ts`'s
 * `isEmailUniqueViolation` makes, and a private copy of it for the same
 * reason `desbloquearCuentaDeRescate`'s comment gives for not importing from
 * that file: it is not exported, and importing the module that holds it
 * would pull an HTTP controller's whole graph into a caller that has no
 * `req` to give it.
 */
function esConflictoDeEmailUnico(error: unknown): boolean {
  const err = error as { name?: string; parent?: { constraint?: string }; message?: string } | null;
  if (!err || err.name !== "SequelizeUniqueConstraintError") return false;
  return (
    err.parent?.constraint === "usuarios_email_verificado_uniq" ||
    /usuarios_email_verificado_uniq/i.test(err.message ?? "")
  );
}

/**
 * Precarga y preverifica a recovery address — `--set-email` in §8's table —
 * skipping the token-and-click flow entirely because the account cannot
 * complete it (that is the whole reason a rescue is happening).
 *
 * **This function is one half of a complete account takeover, and it knows
 * it — H4.** With today's code, `--set-email attacker@x --user <admin>`
 * followed by `POST /auth/password/forgot` on that same address is a full
 * credential replacement with no password and no factor: `forgot` accepts
 * any address with `email_verified_at != null`, which is exactly what this
 * function just set, unconditionally, with no proof the target account's
 * owner asked for it. **What closes that is not inside this function**:
 * `avisarRescate` firing before the write is half of it, and the other half
 * — refusing `--set-email` and `--reset-mfa` in the *same console
 * invocation* without a second, explicit confirmation — is a decision about
 * a *pair of command-line flags*, which this module cannot see one of, let
 * alone two. That refusal belongs to the console script (the next plan) and
 * has to be enforced there, in front of both calls, not delegated here on
 * the hope that the two calls happen to run one after the other.
 *
 * **Plan 4E made this one flag a complete takeover on its own, and that is
 * accepted with its eyes open (design §1.2.2).** A verified address is now a
 * second factor, so the chain above no longer stops at the victim's TOTP or
 * passkey: `--set-email` → `/password/forgot` → reset → login `parcial` → a
 * code to the attacker's mailbox → `completa`. Two invocations used to be
 * needed; now one. What has not changed is where the control actually sits:
 * whoever runs this has the container, and the container has the database,
 * so the barrier was never the flag pair — it was the trace. `avisarRescate`
 * still fires **before** the write and `RESCUE_EMAIL_SET` still lands in the
 * bitácora, and the console now says out loud that the address it just set
 * is a login factor. Isaias chose that over the alternatives (leaving the
 * address unverified, which would break `/password/forgot` for the very
 * person being rescued; or a 24-hour quarantine on `'correo'` after a
 * rescue), 2026-09-03.
 *
 * **H8: the address may already belong, verified, to somebody else.** The
 * partial unique index `usuarios_email_verificado_uniq` catches that at
 * write time with a raw Postgres constraint violation; caught here and
 * turned into `{ ok: false, motivo: "email-en-uso" }` rather than left to
 * propagate as an opaque 500, the same shape `verifyEmail`
 * (`email.controller.ts`) already gives its own callers for the identical
 * race.
 *
 * Also invalidates every pending `token_uso_unico` row for this account, in
 * the same transaction as the address write — the same pairing
 * `sendVerificationEmail` uses for an ordinary email change, and for the
 * same reason: a reset-password link minted against the *old* state of this
 * account must not still be redeemable once the address underneath it has
 * moved.
 *
 * The notice still goes out even on the `"email-en-uso"` outcome: by the
 * time the conflict is discovered, inside the transaction, the mail has
 * already been sent — see the module header for why the notice always
 * precedes the mutation rather than following whatever the mutation decides.
 */
export async function establecerEmailDeRescate(
  id_usuario: number,
  email: string,
  actor: ActorRescate,
): Promise<ResultadoRescateEmail<Record<string, never>>> {
  const resolucion = await cuentaActivaOrNull(id_usuario);
  // `=== true` first — see the identical comment in `ejecutarRescate` for why
  // `if (!resolucion.ok)` does not narrow under this project's
  // `strictNullChecks: false`.
  if (resolucion.ok !== true) {
    if (resolucion.motivo === "archivada") {
      return { ok: false, motivo: "archivada", user: resolucion.user };
    }
    return { ok: false, motivo: "no-encontrada" };
  }
  const { cuenta } = resolucion;

  // Same normalisation `usuario.model.ts`'s own setter applies on every
  // write — computed here too so the masked address in the notice, and the
  // value compared against the unique index, are the exact string that ends
  // up in the column.
  const destino = email.trim().toLowerCase();
  const accion = "RESCUE_EMAIL_SET";
  const detalle = `Se precargó y marcó como verificada la dirección ${enmascarar(destino)}.`;

  const { enviado } = await avisarRescate({
    id_usuario,
    operacion: accion,
    detalle,
    actor: actor.descripcion,
    ip: actor.ip,
  });

  try {
    await sequelize.transaction(async (transaction) => {
      await UsuarioModel.update(
        { email: destino, email_verified_at: new Date() },
        { where: { id: id_usuario }, transaction },
      );
      await TokenUsoUnicoModel.update(
        { used_at: new Date() },
        { where: { id_usuario, used_at: null }, transaction },
      );
    });
  } catch (err) {
    if (esConflictoDeEmailUnico(err)) {
      await registrarRescateEnBitacora({
        id_usuario,
        action: accion,
        detail: detalle,
        actor: actor.descripcion,
        ip: actor.ip,
        resultado: "conflicto",
        avisoEnviado: enviado,
        extra: { email_destino: destino, motivo: "la dirección ya está verificada en otra cuenta" },
      });
      return { ok: false, motivo: "email-en-uso" };
    }
    await registrarRescateEnBitacora({
      id_usuario,
      action: accion,
      detail: detalle,
      actor: actor.descripcion,
      ip: actor.ip,
      resultado: "error",
      avisoEnviado: enviado,
      extra: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  await registrarRescateEnBitacora({
    id_usuario,
    action: accion,
    detail: detalle,
    actor: actor.descripcion,
    ip: actor.ip,
    resultado: "ok",
    avisoEnviado: enviado,
    extra: { email_destino: destino },
  });
  return { ok: true, cuenta, avisoEnviado: enviado, datos: {} };
}

/**
 * Remove a recovery address entirely — `--clear-email` in §8's table, for the
 * address that never arrives or was typed wrong and needs to be taken back
 * out rather than replaced.
 *
 * `email_verified_at` is cleared alongside `email` even though setting the
 * address to `NULL` alone would already take the row out of
 * `usuarios_email_verificado_uniq`'s partial scope (`WHERE email_verified_at
 * IS NOT NULL`) — leaving a stale timestamp next to a NULL address is a row
 * that claims a verification of nothing.
 *
 * Same token invalidation as `establecerEmailDeRescate`, and the same
 * reason: a `token_uso_unico` row minted for the address just removed must
 * not still be redeemable once that address is no longer this account's.
 */
export async function limpiarEmailDeRescate(
  id_usuario: number,
  actor: ActorRescate,
): Promise<ResultadoRescate<Record<string, never>>> {
  return ejecutarRescate({
    id_usuario,
    actor,
    accion: "RESCUE_EMAIL_CLEARED",
    detalle: "Se borró su dirección de correo de recuperación y se invalidaron los enlaces pendientes.",
    mutar: async (transaction) => {
      await UsuarioModel.update(
        { email: null, email_verified_at: null },
        { where: { id: id_usuario }, transaction },
      );
      await TokenUsoUnicoModel.update(
        { used_at: new Date() },
        { where: { id_usuario, used_at: null }, transaction },
      );
      return {};
    },
  });
}

/** What `desarchivarCuentaDeRescate` actually changed. */
export interface DatosDesarchivo {
  desarchivada: boolean;
}

/**
 * A1, second half: Task 1 (`usuario.controller.ts`) closes the self-archive
 * door, but not the one that stays open when somebody *else* archives the
 * last account holding `seguridad.archivar`. Until this function existed,
 * the only way back was `UPDATE usuarios SET "deletedAt" = NULL` run by hand
 * against production.
 *
 * **The one operation in this file where "archivada" is the goal, not the
 * refusal — read `cuentaArchivadaOrNull`'s own comment before touching
 * this.** Every one of this module's other five operations resolves its
 * target through `cuentaActivaOrNull` (directly or via `ejecutarRescate`)
 * and refuses an archived account outright. Copying any of them here would
 * copy that refusal too, and this operation would never run: the one
 * account it exists to reach is always the one `cuentaActivaOrNull` turns
 * away.
 *
 * Same four-step order as every other operation regardless — resolve,
 * notify, mutate inside a transaction, log outside it — hand-rolled rather
 * than routed through `ejecutarRescate` for the same reason
 * `establecerEmailDeRescate` is: that spine's first step is
 * `cuentaActivaOrNull`, which this operation cannot use at all.
 *
 * `UsuarioModel.restore`, not a plain `update({ deletedAt: null })`: the
 * same idiom `desarchivarUsuario` (`controllers/usuario.controller.ts`)
 * already uses to clear a paranoid model's soft-delete column, so a paranoid
 * model is always un-archived the one way Sequelize itself provides for it.
 *
 * **What this deliberately does not do.** `desarchivarUsuario` also checks
 * the restored name against every live account's `usuarios_user_uniq`
 * before restoring, because the archived name might since have been handed
 * to somebody new. That check belongs to a screen with a `:id` from a URL
 * and a human choosing what to do about a 409; a rescue is invoked with
 * nothing but a username or an id, no UI to send a conflict message to, and
 * adding that check here was not asked for by the finding this closes (A1)
 * or by the encargo that implements it. A restore that collides is not
 * silently swallowed either way: it throws the same raw unique-constraint
 * error every other unexpected failure in this module already propagates,
 * recorded in the bitácora as `resultado: "error"` before it does.
 */
export async function desarchivarCuentaDeRescate(
  id_usuario: number,
  actor: ActorRescate,
): Promise<ResultadoDesarchivo<DatosDesarchivo>> {
  const resolucion = await cuentaArchivadaOrNull(id_usuario);
  // `=== true` first — see the identical comment on `ejecutarRescate` for why
  // `if (!resolucion.ok)` does not narrow under this project's
  // `strictNullChecks: false`.
  if (resolucion.ok !== true) {
    if (resolucion.motivo === "no-archivada") {
      return { ok: false, motivo: "no-archivada", user: resolucion.user };
    }
    return { ok: false, motivo: "no-encontrada" };
  }
  const { cuenta } = resolucion;

  const accion = "RESCUE_ACCOUNT_UNARCHIVED";
  const detalle = "Se desarchivó la cuenta, que había quedado archivada.";

  const { enviado } = await avisarRescate({
    id_usuario,
    operacion: accion,
    detalle,
    actor: actor.descripcion,
    ip: actor.ip,
  });

  try {
    await sequelize.transaction((t) => UsuarioModel.restore({ where: { id: id_usuario }, transaction: t }));
    await registrarRescateEnBitacora({
      id_usuario,
      action: accion,
      detail: detalle,
      actor: actor.descripcion,
      ip: actor.ip,
      resultado: "ok",
      avisoEnviado: enviado,
    });
    return { ok: true, cuenta, avisoEnviado: enviado, datos: { desarchivada: true } };
  } catch (err) {
    await registrarRescateEnBitacora({
      id_usuario,
      action: accion,
      detail: detalle,
      actor: actor.descripcion,
      ip: actor.ip,
      resultado: "error",
      avisoEnviado: enviado,
      extra: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
