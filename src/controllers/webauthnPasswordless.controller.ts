// Logging in with a passkey and nothing else — plan 4C, phase 2 (Tasks 12-14).
//
// The two endpoints here are the only ones in the API that hand a session to
// a caller holding no credential at all, and that shapes everything about
// them. Nobody is named until a signature verifies, so there is no account to
// charge, no session to key a bucket on, no allowlist to consult and no
// `authenticate` in front. What stands in for each of those is written where
// it stands: `requireVerifiedOrigin` at the mount (`app.ts`), the two address
// buckets on the routes, the paranoid account read and the single-use
// challenge below, and — for the one thing an address bucket cannot see —
// `failedAssertionBudget.ts`.
//
// 🔴 **A credential is the identity here, and that is exactly the lookup
// phase 1 forbids.** `loginVerify` scopes its credential by the session's
// account, because there the account is already known and a colleague's key
// must not finish somebody else's login. Here there is no session: the row
// `buscarCredencialPorId` returns is how the ERP learns *who* is at the door,
// and the signature is then verified against that row's own public key. A
// caller can name any credential; they cannot sign for one they do not hold.

import type { Request, Response } from "express";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import { UsuarioModel } from "../models/usuario.model.js";
import { guardarReto, consumirReto, purgarRetosCaducados } from "../auth/retoStore.js";
import {
  esContadorDeClon,
  buscarCredencialPorId,
  marcarCredencialUsada,
} from "../auth/passkeyStore.js";
import { terminarLogin, cuerpoDeLogin, SESION_NO_DISPONIBLE } from "../auth/finishLogin.js";
import type { LoginTerminado, MotivoLoginNoTerminado } from "../auth/finishLogin.js";
import { logLogin } from "../auth/credentials.js";
import type { UsuarioAutenticado } from "../auth/credentials.js";
import { purgeExpiredTokens } from "../auth/tokenStore.js";
import { clearSessionCookie } from "../auth/sessionCookie.js";
import { contabilizarFalloAnonimo } from "../auth/failedAssertionBudget.js";
import { configuracionWebauthn } from "../auth/webauthnConfig.js";
import { WEBAUTHN_ASSERTION_FAILED } from "./webauthn.controller.js";
import { sequelize } from "../database/sequelize.js";
import {
  LOGIN_WINDOW_MS,
  SESSION_EXPIRES_HEADER,
  WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT,
} from "../config/security.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const passwordlessLog = log("webauthn.passwordless");
const handler = makeHandler(passwordlessLog);

/**
 * The one sentence every refusal answers with.
 *
 * Eight ways to be refused below — a body with no assertion, a credential
 * this ERP has never seen, an archived account, a signature the library threw
 * on, one it answered unverified, a counter that went backwards, a credential
 * deleted while the ceremony was in flight, and an account found with no
 * factor left — and the caller reads the same words for all of them, with the
 * same 400. Telling them apart would turn this door into a
 * probe: "that credential exists here", "that account is archived". The
 * bitácora and the log may tell them apart; the response may not. The one
 * exception is the 503 for a session that could not be opened, which is
 * about this server and not about the caller — the same line the password
 * login draws.
 *
 * Not `CREDENCIALES_INVALIDAS`: "Usuario o contraseña incorrectos" is a lie
 * on a door where neither was asked for.
 */
export const MENSAJE_LOGIN_LLAVE = "No se pudo iniciar sesión con esa llave. Inténtalo otra vez.";

/**
 * `credencial_webauthn.credential_id` is `STRING(1364)` — base64url of the
 * 1023 bytes the WebAuthn specification allows (`credencialWebauthn.model.ts`).
 * Anything longer cannot be a credential of ours, so it is refused before it
 * reaches a `WHERE` against a unique index: `express.json()` accepts a hundred
 * kilobytes, and this is an anonymous endpoint.
 */
const CREDENTIAL_ID_MAX = 1364;

/** The verb for the summary line that replaces the per-attempt ones — see `registrarFalloAnonimo`. */
export const WEBAUTHN_ASSERTION_FLOOD = "WEBAUTHN_ASSERTION_FLOOD";

/**
 * Hand the browser a fresh challenge for a passwordless ceremony — and
 * nothing that depends on who is asking, because nobody is.
 *
 * 🔴 **This endpoint reads nothing from the request, and that is the whole
 * design.** The tempting shape — take a username, look up its passkeys, fill
 * `allowCredentials` — is an oracle: a list for somebody who has a key, an
 * empty one for somebody who does not, which is precisely who still logs in
 * with a password alone and precisely who to phish. `residentKey: "required"`
 * at registration exists for this moment: the authenticator can offer its
 * discoverable credentials without being told which account to look for, so
 * `allowCredentials` is empty and no question is asked. The row is written
 * unconditionally, so the timing does not depend on anything either.
 *
 * The challenge is written down with **no owner and no session** — both
 * `null`, typed rather than optional so the call site has to say so — and
 * under the purpose `"login"`, which is inside the `WHERE` that spends it:
 * a challenge minted here cannot finish a phase-1 ceremony and a phase-1
 * challenge cannot finish this one. `retoStore.ts` has measured that a null
 * `id_sesion` reaches SQL as `IS NULL` and not as `= NULL`, which is the one
 * refactor that would make every passwordless login fail silently.
 *
 * `userVerification: "required"` for the same reason as at registration:
 * this assertion is the *whole* login, and the session it opens is born with
 * `mfa_satisfied_at` stamped. An assertion that meant only "this laptop was
 * unlocked" would open ten minutes of the permission matrix on that.
 */
export const passwordlessOptions = handler("passwordlessOptions", async (_req: Request, res: Response) => {
  const { rpID } = configuracionWebauthn();
  const opciones = await generateAuthenticationOptions({
    rpID,
    allowCredentials: [],
    userVerification: "required",
  });

  await guardarReto(opciones.challenge, "login", { id_usuario: null, id_sesion: null });

  // Fire-and-forget, as in phase 1: tidying up must never fail a ceremony.
  // These rows have no session to cascade from — both columns are null — so
  // this sweep is the only thing that ever removes them.
  void purgarRetosCaducados().catch((err: unknown) => {
    passwordlessLog.error({ err }, "no se pudieron purgar los retos caducados");
  });

  return res.json(opciones);
});

/**
 * Thrown inside the transaction to roll it back; caught right outside it.
 * Each names the one outcome it stands for, so the catch reads as a table.
 */
class CredencialDesaparecida extends Error {}
class LoginRechazado extends Error {
  constructor(readonly motivo: MotivoLoginNoTerminado) {
    super(motivo);
  }
}

/**
 * Check the assertion, and turn it into a session.
 *
 * **The order is the argument.** Each step below is placed where it is for a
 * reason that is written next to it, and moving one of them up or down is
 * how the guarantees get lost:
 *
 * 1. The body is refused before any read. Nothing was attempted, so nothing
 *    is written down — the cheapest request an attacker can send is the one
 *    that must not become a row.
 * 2. The credential resolves the account (see the header). Unknown → refused
 *    with a *log* line and no bitácora line: there is nobody to file it
 *    under, and `logAction` rightly refuses a null owner. The log line is
 *    what makes a sweep of random ids countable at all.
 * 3. The challenge is spent **inside** the verification, before the expensive
 *    cryptography, and the callback **awaits** it. Written as a bare
 *    `consumirReto(...) !== null` it compiles — the library accepts a promise
 *    or a boolean — and a promise is never null, so every replayed assertion
 *    would pass. For a synced passkey this single-use redemption is the only
 *    replay defence there is; `esContadorDeClon` cannot see a clone of one.
 * 4. **The account is read paranoid, after the signature and before anything
 *    is opened.** This is the plan's 🔴: `deleteUsuario` archives an account
 *    and revokes its sessions and remembered devices, and leaves
 *    `credencial_webauthn` alone on purpose so that un-archiving gives the
 *    person their factors back. An archived ex-employee therefore keeps a
 *    passkey that *verifies* — and without this read it would log in.
 *    `findByPk` on a paranoid model never finds an archived row. **After the
 *    signature, not before**, so that an archived account and a live one
 *    with a bad signature do the same work — spend the challenge, verify —
 *    and answer in the same time: read first, the archived case answered
 *    faster and, worse, left the challenge unspent, so a caller holding a
 *    captured credential id could learn from a second redemption whether its
 *    owner still works here. What is deliberately **not** read is
 *    `locked_until`: the lockout defends a guessable secret, and phase 1
 *    already decided that a passkey is neither blocked by it nor clears it —
 *    blocking would hand anybody a way to shut a colleague's key with five
 *    wrong passwords from anywhere. Phase 2 inherits that as its own
 *    decision, written in the plan: a locked account may still enter by key.
 * 5. Only then is anything opened, and the opening is one transaction with
 *    the mark on the credential — see the block below for the race. The
 *    body — the permission matrix — is built after that transaction commits.
 *
 * **Timing is not levelled between "unknown credential" and everything
 * after it, and that is decided, not overlooked.** The fast refusal answers
 * a question — "does this id exist here" — that only somebody already
 * holding the id can ask, and a credential id sits nowhere but in the
 * authenticator that owns it and in the ceremonies its owner's own browser
 * ran. Past that point every refusal does the same work.
 */
export const passwordlessVerify = handler("passwordlessVerify", async (req: Request, res: Response) => {
  const cuerpo = req.body as Record<string, unknown> | undefined;
  const respuesta = cuerpo?.respuesta as { id?: unknown } | undefined;
  if (
    !respuesta ||
    typeof respuesta.id !== "string" ||
    respuesta.id.length === 0 ||
    respuesta.id.length > CREDENTIAL_ID_MAX
  ) {
    return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
  }

  const credencial = await buscarCredencialPorId(respuesta.id);
  if (!credencial) {
    // No bitácora line — nobody to attribute it to — but not silence either:
    // the address is the one thing a sweep of credential ids has in common.
    passwordlessLog.warn(
      { ip: req.ip ?? null },
      "aserción anónima con una credencial que no existe aquí",
    );
    return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
  }

  const { rpID, origenes } = configuracionWebauthn();
  const guardado = credencial.counter;

  let verificacion: VerifiedAuthenticationResponse;
  try {
    verificacion = await verifyAuthenticationResponse({
      response: respuesta as never,
      expectedChallenge: async (challenge: string) => {
        const fila = await consumirReto(challenge, "login", { id_sesion: null });
        return fila !== null;
      },
      expectedOrigin: origenes,
      expectedRPID: rpID,
      credential: {
        id: credencial.credential_id,
        publicKey: new Uint8Array(credencial.public_key),
        // The one place the BIGINT-as-string meets the library's number —
        // see `ICredencialWebauthn.counter` and `loginVerify`.
        counter: Number(guardado),
        transports: undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    await registrarFalloAnonimo(req, credencial.id_usuario, "verificacion-rechazada", credencial.id);
    return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
  }

  if (!verificacion.verified) {
    await registrarFalloAnonimo(req, credencial.id_usuario, "firma-invalida", credencial.id);
    return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
  }

  const recibido = verificacion.authenticationInfo.newCounter;
  // Detection, not refusal — the library already refused by a stricter rule.
  // Kept for the one signal it can name: a counter going backwards means a
  // credential was copied, and that is `critical`, not a 400 like the rest.
  if (esContadorDeClon(guardado, recibido)) {
    await logAction({
      id_usuario: credencial.id_usuario,
      action: "WEBAUTHN_COUNTER_REGRESSION",
      entity: "credencial_webauthn",
      entity_id: credencial.id,
      detail: `El contador de firmas retrocedió: guardado ${guardado}, recibido ${recibido}.`,
      metadata: { ceremonia: "login" },
      severity: "critical",
      ip_address: req.ip ?? null,
    });
    return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
  }

  const cuenta = await UsuarioModel.findByPk(credencial.id_usuario, {
    // Exactly what `UsuarioAutenticado` publishes, plus the one column the
    // server reads and the body must never carry. Named so that the row can
    // never be spread into the response — `terminarLogin` gets a curated
    // object, built below from these and nothing else.
    attributes: ["id", "id_rol", "user", "name", "lastname", "image", "mfa_grace_until"],
  });
  if (!cuenta) {
    // A valid signature from a key whose owner no longer works here — the
    // line worth reading, and the reason this refusal comes after the
    // cryptography rather than before it (see the docblock).
    await registrarFalloAnonimo(req, credencial.id_usuario, "cuenta-archivada", credencial.id);
    return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
  }

  // Six named fields and never the row: this object is the response body.
  const usuario: UsuarioAutenticado = {
    id: cuenta.dataValues.id,
    id_rol: cuenta.dataValues.id_rol,
    user: cuenta.dataValues.user,
    name: cuenta.dataValues.name,
    lastname: cuenta.dataValues.lastname,
    image: cuenta.dataValues.image,
  };
  const mfa_grace_until = cuenta.dataValues.mfa_grace_until ?? null;

  /**
   * 🔴 **The mark on the credential and the session row commit together, and
   * the mark has to have found its row.** This is the race the design audit
   * found, and it is the one thing on this door that phase 1 is immune to and
   * this is not. `deleteCredential` — and the administrator's
   * `restablecerSegundoFactor`, the tool for "somebody stole Ana's key" —
   * delete the credential and then revoke every live session, precisely so
   * that a stolen key stops working. A login in flight sits between those two
   * writes: it read the credential before the delete, and would insert its
   * session *after* the revocation, `completa`, sealed, alive for up to
   * `SESSION_ABSOLUTE_DAYS` on an account with nothing registered. Phase 1
   * only ever *promotes* a row that already exists, which the revocation
   * already took; this creates a new one afterwards.
   *
   * The `UPDATE` in `marcarCredencialUsada` takes the row lock, and Postgres
   * makes a `DELETE` of that row wait until this transaction ends. So the
   * deletion either happened first — the mark matches nothing, and this
   * refuses — or it waits, and its revocation then runs *after* the session
   * below is committed and takes that one too. Either way the stolen key
   * opens nothing that survives. `terminarLogin` adds a backstop, not a
   * second observation: `estadoInicialDeSesion` counts the account's
   * factors on this same transaction's connection, and at READ COMMITTED it
   * can never disagree with the mark — a deletion that committed first
   * already made the mark match nothing, and one that is waiting on the
   * lock is invisible to the count. It is defence in depth for the day one
   * of the two is refactored; it is not what closes the race.
   *
   * Everything thrown inside is thrown to roll the mark back; the catch turns
   * each into its answer. And a failure *of the commit itself* — the one way
   * a cookie could already be on the response for a row that was never kept
   * — clears that cookie before the wrapper answers 500.
   */
  let resultado: LoginTerminado;
  try {
    resultado = await sequelize.transaction(async (transaction) => {
      const marcada = await marcarCredencialUsada(credencial.id, recibido, { transaction });
      if (!marcada) throw new CredencialDesaparecida();
      const r = await terminarLogin(req, res, { usuario, mfa_grace_until }, "passkey", { transaction });
      if (!r.ok) throw new LoginRechazado(r.motivo);
      return r;
    });
  } catch (err) {
    if (err instanceof CredencialDesaparecida) {
      await registrarFalloAnonimo(req, credencial.id_usuario, "credencial-borrada-durante-la-ceremonia", credencial.id);
      return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
    }
    if (err instanceof LoginRechazado) {
      if (err.motivo === "factor-desaparecido") {
        await registrarFalloAnonimo(req, credencial.id_usuario, "factor-desaparecido", credencial.id);
        return res.status(400).json({ message: MENSAJE_LOGIN_LLAVE });
      }
      return res.status(503).json({ message: SESION_NO_DISPONIBLE });
    }
    // The cookie and the expiry header both went onto the response inside
    // `issueSession`; neither may describe a row that was rolled back.
    clearSessionCookie(res);
    res.removeHeader(SESSION_EXPIRES_HEADER);
    throw err;
  }

  // The body after the commit, not inside it: the matrix loader refreshes its
  // cache on the pool with no transaction, and inside one that read would
  // have borrowed a second connection — see `cuerpoDeLogin`.
  const respuestaDeLogin = await cuerpoDeLogin(usuario, resultado.estado);

  // Both lines after the session exists, like every other door: a line for a
  // login that answered 500 is worse than no line. `LOGIN` so that whatever
  // counts logins keeps counting; `MFA_VERIFIED` so that whatever counts
  // proved factors sees this one — a password-plus-TOTP arrival already
  // writes the same two, from two requests, so this is consistent and not a
  // double count. The device type and whether the key is synced ride along
  // because the table has nowhere to keep them yet, and a login by a synced
  // key is the one that may have come from a device nobody in the office has
  // seen.
  logLogin(usuario, req.ip ?? null, { metodo: "passkey", id_sesion: resultado.id_sesion });
  await logAction({
    id_usuario: usuario.id,
    action: "MFA_VERIFIED",
    entity: "Usuario",
    entity_id: usuario.id,
    detail: "Segundo factor verificado (passkey, inicio de sesión sin contraseña)",
    metadata: {
      id_sesion: resultado.id_sesion,
      fuente: "passkey",
      id_credencial: credencial.id,
      ceremonia: "login",
      tipo: verificacion.authenticationInfo.credentialDeviceType,
      respaldada: verificacion.authenticationInfo.credentialBackedUp,
    },
    severity: "info",
    ip_address: req.ip ?? null,
  });

  // The same opportunistic sweep the password login runs — see `tokenStore.ts`.
  purgeExpiredTokens().catch((err: unknown) =>
    passwordlessLog.error({ err }, "no se pudo purgar token_uso_unico tras el login"),
  );
  return res.status(200).json(respuestaDeLogin);
});

/**
 * The line a refused anonymous assertion leaves behind — the other half of
 * decision D7 here as in phase 1, with one difference the address buckets
 * cannot absorb.
 *
 * In phase 1 the caller of this line held a stolen cookie, and the bucket
 * keyed on that cookie bounded how many they could write. Here the caller
 * holds a `credential_id` — plain text in every ceremony the victim's own
 * browser ever ran — and the only bucket is by address, so from many
 * addresses the same account can be buried under thousands of `warning`
 * lines an hour, in a table nothing prunes. `contabilizarFalloAnonimo` is the
 * budget that follows the *account*: past
 * `WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT` in a window, one `critical`
 * line says the ceiling was reached, and the rest of the window writes nothing
 * — **except the first refusal of each kind**, which is always written: an
 * attacker who can spend the ceiling on ten garbage assertions must not be
 * able to silence the one `cuenta-archivada` line that says an ex-employee's
 * key was just used, or the `credencial-borrada-durante-la-ceremonia` that
 * says a deletion raced a login. The refusal itself is never budgeted —
 * bounding it would hand the attacker a way to shut the victim's key with a
 * loop.
 *
 * Same verb as phase 1 (`WEBAUTHN_ASSERTION_FAILED`), `id_sesion: null`
 * because there is none, and `ceremonia: "login"` so that whoever reads the
 * bitácora can tell an anonymous attempt from an authenticated one without
 * guessing. `warning`, as there: a thing to count, not to wake up for.
 */
async function registrarFalloAnonimo(
  req: Request,
  id_usuario: number,
  motivo: string,
  id_credencial: number,
): Promise<void> {
  const veredicto = contabilizarFalloAnonimo(id_usuario, motivo);
  if (veredicto === "callar") return;

  if (veredicto === "resumir") {
    await logAction({
      id_usuario,
      action: WEBAUTHN_ASSERTION_FLOOD,
      entity: "Usuario",
      entity_id: id_usuario,
      detail:
        `Más de ${WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT} intentos anónimos de entrar con una ` +
        `passkey rechazados contra esta cuenta en ${LOGIN_WINDOW_MS / 60_000} minutos: ` +
        "se deja de registrar cada uno hasta que pase la ventana",
      // No count: by construction this line is written on refusal number
      // `WEBAUTHN_FAILED_ASSERTION_LINES_PER_ACCOUNT + 1`, so a count here
      // would always say the same number and nothing about what follows.
      metadata: { ceremonia: "login", motivo_ultimo: motivo, id_credencial },
      severity: "critical",
      ip_address: req.ip ?? null,
    });
    return;
  }

  await logAction({
    id_usuario,
    action: WEBAUTHN_ASSERTION_FAILED,
    entity: "credencial_webauthn",
    entity_id: id_credencial,
    detail: `Intento de entrar con una passkey rechazado: ${motivo}`,
    metadata: { id_sesion: null, ceremonia: "login", motivo },
    severity: "warning",
    ip_address: req.ip ?? null,
  });
}
