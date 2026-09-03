// Everything a login does once the credential is good, in one place.
//
// Two doors reach this: the password login (`auth.controller.ts`'s `login`,
// behind `POST /api/auth/login` and the old `POST /api/login`) and, since plan
// 4C's phase 2, the passwordless login (`webauthnPasswordless.controller.ts`),
// where a passkey assertion is the whole credential. What they share is
// exactly the part a second copy gets wrong, because none of it is visible on
// a login that works: the state is decided by `estadoInicialDeSesion` and by
// nothing else; a session that cannot be opened is a 503 with a sentence and
// never a 500; the grace clock starts strictly after the session exists; and
// the permission matrix is published only to a session that opens `completa`.
// Each of those was a finding once, and each has its argument written below.
// The header of `credentials.ts` makes the same case for the credential check
// itself — this is the other half of a login, kept whole for the same reason.
//
// What is deliberately NOT here: the credential check (each door has its own
// and they are nothing alike), the remembered-device cookie (the password
// login's alone), the bitácora lines (each door names its method), and the
// response — this returns a body and a verdict, and the door decides the
// status, so neither can accidentally say something different about *why*.

import type { Request, Response } from "express";
import type { Transaction } from "sequelize";
import { UsuarioModel } from "../models/usuario.model.js";
import { permissionsFor } from "../permissions/store.js";
import type { RolePermissions } from "../permissions/matrix.js";
import { issueSession } from "./issueSession.js";
import { estadoInicialDeSesion } from "./factorInventory.js";
import type { UsuarioAutenticado } from "./credentials.js";
import type { EstadoSesion, FuenteEnElLogin } from "./sessionState.js";
import { log } from "../utils/logger.js";

const loginLog = log("auth");

/**
 * What somebody is told when their credential was right and the server still
 * could not let them in.
 *
 * Deliberately not beside `CREDENCIALES_INVALIDAS` and
 * `CREDENCIALES_INCOMPLETAS` in `config/security.ts`, and the line is worth
 * drawing: those two are a pair about the *credential*, kept together precisely
 * so nobody rewords one without seeing the other and leaks which usernames
 * exist. This says nothing about the account — it is about this server, right
 * now — so it belongs to the step that opens the session, whichever door led
 * to it.
 *
 * "In a few minutes" is the whole point of the wording: the two ways to get
 * here are an exhausted connection pool and a locked `sesiones` table, and both
 * pass. Retyping the password — or touching the fingerprint reader again —
 * will not help, and the person needs to be told that rather than left to
 * conclude they have forgotten something.
 *
 * It arrived on the old `POST /api/login` first and moved with the code, because
 * the alternative was losing it: `handler()` turns every rejection into a 500,
 * and a 500 tells the person nothing they can act on.
 */
export const SESION_NO_DISPONIBLE =
  "No se pudo iniciar la sesión en este momento. Inténtelo de nuevo en unos minutos.";

/** Named because the body is built in two shapes and the sentence is the same
 *  in both; two hand-typed copies of one string is how they drift. */
export const LOGIN_OK = "Login exitoso";

/** The body a finished login answers with — the same shape from either door. */
export interface CuerpoLogin {
  usuario: UsuarioAutenticado;
  /**
   * **Absent, not empty, for any state but `completa`.** The client reads the
   * field's presence as "this session is whole" (`LoginPage.tsx`), and the
   * login body never carries `estado` — see `terminarLogin` for why the matrix
   * is withheld at the door.
   */
  permisos?: RolePermissions;
  message: string;
}

/**
 * The verdict, and the door turns it into a status.
 *
 * Both failure arms name a `motivo` rather than a status code, for the reason
 * `ResultadoCredenciales` gives: a status decided here would be a status two
 * doors have to agree on, and the passwordless door answers one of these with
 * a *uniform 400* that must look exactly like a bad signature, which is not
 * the 503 the other deserves. `factor-desaparecido` is that one: it can only
 * happen on the passkey path — see the guard below.
 */
export type MotivoLoginNoTerminado = "sesion-no-disponible" | "factor-desaparecido";

/**
 * Both arms name every key, one side as `?: undefined` — the shape
 * `ResultadoCredenciales` explains: with `strictNullChecks` off, TypeScript
 * will not narrow a union by the truthiness of its discriminant unless the
 * keys exist on both arms, so `if (!r.ok) r.motivo` would not compile.
 */
export interface LoginTerminado {
  ok: true;
  estado: EstadoSesion;
  id_sesion: string;
  motivo?: undefined;
}

export interface LoginNoTerminado {
  ok: false;
  motivo: MotivoLoginNoTerminado;
  estado?: undefined;
  id_sesion?: undefined;
}

export type ResultadoLogin = LoginTerminado | LoginNoTerminado;

/**
 * Open the session this credential earned, start the clocks it starts, and
 * build the body — in that order, and the order is the load-bearing part.
 *
 * **`fuente` is what already covered the second factor during this login,
 * if anything did**: `"dispositivo"` for a remembered device beside the
 * password, `"passkey"` for the passwordless ceremony, `undefined` for a bare
 * password. It reaches `estadoInicialDeSesion`, which is the only place that
 * turns it into a state, and `createSession`, which records it on the row and
 * stamps `mfa_satisfied_at` from it — one value, both consumers, so the row
 * cannot say one thing and the state another.
 *
 * 🔴 **On the passkey path an account with no factor is a refusal, and it
 * must be.** The passwordless controller has just verified a signature
 * against a credential of this account and marked that credential used inside
 * the caller's `transaction`, so the account *has* a factor by construction
 * and `estadoInicialDeSesion`'s first branch is the only one that can honestly
 * fire. Any other branch means the credential was deleted between the read
 * and here — `deleteCredential`, or the administrator's
 * `restablecerSegundoFactor`, both of which revoke every live session
 * precisely so that a stolen key stops working. A session opened now would be
 * inserted *after* that revocation and survive it, `completa`, sealed, for up
 * to `SESSION_ABSOLUTE_DAYS`, on an account with nothing registered — and the
 * grace branch would hand it a fresh fourteen-day clock on top, restarting a
 * chase the account had already finished. The row lock the caller holds makes
 * this branch unreachable in practice; this guard is what makes it *closed*
 * rather than merely unlikely, and what keeps the property from resting on a
 * caller remembering the transaction. **It reads `conFactor`, not the state**:
 * a first version compared `estado` and `graceUntil`, and a review found the
 * no-factor branch with a deadline still ahead answering exactly what the
 * factor branch answers.
 *
 * **Everything here runs on the caller's `transaction` when there is one** —
 * the counts, the rotation, the insert — because a query issued around an
 * open transaction borrows a second pool connection, and fifteen logins doing
 * that at once would starve the pool for the whole API. The grace stamp is
 * the one write that does not join it, on purpose (below), and it cannot run
 * on the passkey path at all: the guard refuses before it. And the permission
 * matrix is not read here at all: `cuerpoDeLogin` below builds the body, and
 * the door calls it **after** its transaction has committed, because the
 * matrix loader (`permissions/store.ts`) refreshes its cache on the pool with
 * no transaction — the one query that would still have gone around it.
 *
 * **A session this cannot open is a login it cannot grant.** There is no
 * credential other than the cookie, so a 200 without one tells the browser
 * "Bienvenido", navigates the person into the ERP, gets 401 on the first
 * request for data, and puts them back on the login form with nothing on
 * screen to explain it — identically on every retry, because what is broken
 * is the database and not anything they did. Caught here rather than left to
 * the door's `handler()`, which would answer 500 and `ERROR_INESPERADO`:
 * "something is wrong with the software", when the truth is "a dependency is
 * down, come back shortly". `web`'s `Login.api.ts` reads `data.message` off
 * any non-2xx answer and hands it to the form, so the sentence reaches the
 * screen. And nothing here can lock anybody out: the per-account lockout
 * counter only moves inside `verifyCredentials` on a wrong password, and the
 * rate-limit buckets refund the whole 5xx range (`costsNothing`).
 *
 * **The grace clock starts after the session and never before it.** Written
 * first, it would start somebody's fourteen days on a request that ended in
 * the 503 above — a deadline running from a login they never got, and days
 * they had no way to spend, since there is no screen to configure anything on
 * without a session. And when that write fails, the login still succeeds:
 * failing it would send somebody back to the form holding a perfectly good
 * session, into the same failing UPDATE; the column stays null, so the *next*
 * login takes the same branch and tries again — generous, never premature,
 * never a lockout. It is logged at `error` with the consequence spelled out,
 * because a failure that keeps repeating means the ERP can never close on
 * this account. Awaited rather than fire-and-forget: it runs at most once in
 * an account's lifetime, and the ordering is what `login.session.test.ts`
 * pins. It deliberately does **not** join the caller's `transaction`: inside
 * one, a failed statement aborts the whole transaction and the commit — the
 * session included — which is the opposite of the policy above. It cannot
 * run on the passkey path anyway, by the guard.
 *
 */
export async function terminarLogin(
  req: Request,
  res: Response,
  cuenta: {
    /** The curated shape and never a row: this object goes into `res.json` verbatim. */
    usuario: UsuarioAutenticado;
    /** Read by the server only; beside `usuario`, never inside it — see `ResultadoCredenciales`. */
    mfa_grace_until: Date | null;
  },
  fuente: FuenteEnElLogin | undefined,
  opciones: { transaction?: Transaction } = {},
): Promise<ResultadoLogin> {
  const { usuario } = cuenta;
  const ahora = new Date();
  const { estado, graceUntil, conFactor } = await estadoInicialDeSesion(
    { id: usuario.id, mfa_grace_until: cuenta.mfa_grace_until },
    ahora,
    fuente,
    opciones,
  );

  if (fuente === "passkey" && !conFactor) {
    loginLog.warn(
      { id_usuario: usuario.id, estado },
      "la credencial que acaba de verificar ya no cuenta como factor: se rechaza el login",
    );
    return { ok: false, motivo: "factor-desaparecido" };
  }

  let id_sesion: string;
  try {
    ({ id: id_sesion } = await issueSession(req, res, usuario.id, estado, fuente, opciones));
  } catch (err) {
    loginLog.error(
      { err, id_usuario: usuario.id },
      "no se pudo abrir la sesión de cookie: se rechaza el login, porque la cookie es la única credencial",
    );
    return { ok: false, motivo: "sesion-no-disponible" };
  }

  if (graceUntil !== null) {
    try {
      await UsuarioModel.update({ mfa_grace_until: graceUntil }, { where: { id: usuario.id } });
    } catch (err) {
      loginLog.error(
        { err, id_usuario: usuario.id, graceUntil },
        "no se pudo iniciar el plazo de gracia de MFA: la sesión sigue abierta y el próximo login lo reintenta, pero mientras la columna siga vacía el ERP no se cerrará nunca para esta cuenta",
      );
    }
  }

  return { ok: true, estado, id_sesion };
}

/**
 * The body a finished login answers with.
 *
 * **The permission matrix, only for a session that opens `completa`.** The
 * same rule `GET /api/auth/me` applies, on the door rather than the window —
 * and the door matters more: reaching `/me` means already holding the cookie,
 * while this answers whoever just presented a credential. An account with a
 * factor opens `parcial` from the password door: the password was accepted,
 * the second factor has not been proved, and `authenticate` will refuse that
 * session everything outside the narrowest allowlist. Handing it the whole
 * map of authority in the body would give away, at the door, exactly what the
 * endpoint one route away withholds. Absent, not empty: the client reads the
 * field's presence, and `estado` is never in this body on purpose — a wrong
 * password must not be able to learn the state of an account for free.
 *
 * **Separate from `terminarLogin`, and called after the door's transaction
 * has committed.** The matrix comes from `permissionsFor`, whose cache
 * refreshes on the pool with no transaction; read inside one it would be the
 * last query on this path still borrowing a second connection while the
 * first sits waiting. Nothing about the body has to commit with the session,
 * so it is built once the session is safe. `usuario` is the curated object
 * and never a row: it goes into `res.json` verbatim.
 */
export async function cuerpoDeLogin(usuario: UsuarioAutenticado, estado: EstadoSesion): Promise<CuerpoLogin> {
  return estado === "completa"
    ? { usuario, permisos: await permissionsFor(usuario.id_rol), message: LOGIN_OK }
    : { usuario, message: LOGIN_OK };
}
