import { Request, Response } from "express";
import { UsuarioModel } from "../models/usuario.model.js";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import { logAction } from "../utils/logAction.js";
import { permissionsFor } from "../permissions/store.js";
import { BCRYPT_COST, CREDENCIALES_INVALIDAS, bcryptCostOf, fillerHash } from "../config/security.js";
import { estaBloqueada, siguienteBloqueo } from "../middleware/loginLimiters.js";
import { whereUsernameIs } from "../utils/username.js";

const secretKey = process.env.JWT_SECRET;

export async function loginUsuario(req: Request, res: Response) {
  /**
   * The username loses the spaces at its ends; the password loses nothing.
   *
   * Those are different decisions on purpose. A username is a name for a row:
   * "isaias" and "isaias " are meant to be the same person, and somebody who
   * pastes their name with a trailing space and is told "usuario inexistente"
   * has no way of seeing why. Spaces *inside* stay — `Omar Mita` is a real
   * account and trimming is not the same as stripping.
   *
   * A password is not a name, it is a secret, and every character in it counts.
   * Trimming one would silently accept a different secret than the one chosen,
   * shrink what an attacker has to guess, and lock out anybody whose password
   * legitimately starts or ends with a space.
   */
  const rawUser = req.body?.user;
  const pass = req.body?.pass;

  // Not a string is not a username. Sequelize takes an object in `where` as a
  // set of conditions, so refusing anything else here keeps a crafted body from
  // being read as a query instead of a value.
  if (typeof rawUser !== "string" || typeof pass !== "string") {
    return res.status(400).json({ message: "Usuario y contraseña son obligatorios." });
  }
  const user = rawUser.trim();
  if (user === "" || pass === "") {
    return res.status(400).json({ message: "Usuario y contraseña son obligatorios." });
  }

  try {
    // Case-insensitively, the same way `usuarios_user_uniq` and the per-account
    // rate-limit bucket already were — see `whereUsernameIs`. This lookup was
    // the one place of the four that still compared bytes, and the people it
    // shut out were the ones whose stored name carries a capital: they typed it
    // in lower case, fell into the unknown-user branch, and got the same
    // "Usuario o contraseña incorrectos" a wrong password gets. Nothing told
    // them why, and there was no way around it.
    const TempUsuario = await UsuarioModel.findOne({ where: whereUsernameIs(user) });

    // The account not existing and the password being wrong must be
    // indistinguishable: same message, same status, same time. Comparing
    // against the filler hash costs the same as a real comparison and is what
    // makes the third of those true.
    if (!TempUsuario) {
      await bcryptjs.compare(pass, await fillerHash());
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }

    const data = TempUsuario.dataValues;

    // A locked account answers exactly like a wrong password, filler hash
    // included. Answering differently — or faster — turns the lockout into the
    // oracle the uniform message was meant to close.
    if (estaBloqueada(data)) {
      await bcryptjs.compare(pass, await fillerHash());
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }

    const confirmPass = await bcryptjs.compare(pass, data.pass);
    if (!confirmPass) {
      /**
       * A second compare that throws its result away, and it has to stay.
       *
       * The comparison above costs whatever the *stored* hash costs, and every
       * account in this database predates the rise from 8 to 12 until its owner
       * logs in successfully once. So a wrong password against a real account
       * answers in about 19 ms, while the two branches above — unknown name and
       * locked account — each pay one compare at BCRYPT_COST against the filler
       * and answer in about 228 ms. Twelve times slower. That is the same
       * enumeration oracle the filler hash was added to close, with the polarity
       * reversed: fast now means "this account exists". Two attempts per
       * candidate name and the median tells you, and two is below
       * LOCKOUT_AFTER_FAILURES, so the whole payroll can be enumerated without
       * locking a single account.
       *
       * Paying one BCRYPT_COST compare here brings the difference down from
       * 209 ms to the ~19 ms of the cost-8 compare itself, which is inside the
       * jitter of any real network.
       *
       * It narrows on its own as people log in and get re-hashed below, and it
       * never closes: an account that never logs in stays cheap forever, and
       * former staff not yet archived, service accounts and the spare
       * administrator account are exactly the ones worth finding.
       *
       * `?? 0` covers a stored value that is not a bcrypt hash at all — a
       * corrupt row, something written by hand — where `compare` returns false
       * in microseconds. Same hole, wider.
       *
       * `login.controller.test.ts` fails if this is deleted.
       */
      if ((bcryptCostOf(data.pass) ?? 0) < BCRYPT_COST) {
        await bcryptjs.compare(pass, await fillerHash());
      }

      // The count is incremented in the database, not read into Node,
      // added to, and written back. That three-step version loses updates
      // under concurrency: ten wrong guesses arriving together all read
      // failed_attempts=0 before any of them writes, and all ten write
      // back 1 — the counter is pinned at 1 forever and the account never
      // locks. This per-account bucket is the only defense credential
      // stuffing spread across many addresses runs into (each address
      // alone stays under LOGIN_ACCOUNT_IP_LIMIT), so losing it here loses
      // the one place that catches that attack.
      //
      // `UsuarioModel.increment` compiles to a single
      // `SET failed_attempts = failed_attempts + 1` — the database does
      // the read-and-add, so no concurrent increment can be lost. Its own
      // resolved value is not used: traced through this project's
      // Sequelize version (6.36.0) — `Model.increment` ->
      // `queryInterface.increment` -> the Postgres dialect's
      // `Query.formatResults`, which for an UPDATE with no
      // `options.instance` set resolves to `[rows, rowCount]` — the static
      // call then wraps that again, so what actually comes back is not
      // the `M[]` the type declaration promises. Rather than rely on it,
      // the fresh count is read back explicitly below.
      //
      // Known and accepted timing asymmetry: this branch awaits a database
      // round trip (this increment, and sometimes the update below) before
      // answering, while the locked-account and unknown-user branches above
      // answer as soon as their filler-hash compare resolves, with no write
      // at all. A round trip here is on the order of a millisecond against
      // bcrypt's ~250ms — under half a percent — and measuring that over a
      // real network, with tens of milliseconds of jitter, is not
      // realistic. Not awaiting the write would trade the counter's
      // atomicity (the whole point of this change) for a gain nobody could
      // observe, so this is left as is on purpose rather than closed.
      await UsuarioModel.increment("failed_attempts", { where: { id: data.id } });
      const actualizado = await UsuarioModel.findOne({
        where: { id: data.id },
        attributes: ["failed_attempts"],
      });
      if (actualizado) {
        const fallos = actualizado.dataValues.failed_attempts ?? 0;
        // siguienteBloqueo expects the count *before* this failure and adds
        // one itself; the database already added it, so passing the fresh
        // count minus one gets the same arithmetic without adding it twice.
        const { locked_until } = siguienteBloqueo(fallos - 1);
        // Only locked_until is written here — failed_attempts is left alone
        // because it is already correct in the database. Writing it again
        // from a value read a moment ago would reopen the exact race this
        // comment starts with, just narrowed to the gap between the read
        // above and this write.
        if (locked_until) {
          await UsuarioModel.update({ locked_until }, { where: { id: data.id } });
          // The moment of locking, which nothing recorded until now. The
          // bitácora showed a run of LOGIN_FAILED and then one every so often,
          // and nowhere the single fact anyone reading it would want: that this
          // account has been shut since Tuesday. `critical` and not `warning`
          // because a LOGIN_FAILED is somebody mistyping and this is somebody
          // unable to work — whether they did it to themselves or whether
          // someone who knows their username did it to them. Its own action
          // name so a panel can pull just these out of the failure noise.
          logAction({ id_usuario: data.id, action: "ACCOUNT_LOCKED", entity: "Usuario", entity_id: data.id, detail: `Cuenta @${data.user} bloqueada tras ${fallos} intentos fallidos`, metadata: { user: data.user, failed_attempts: fallos, locked_until }, severity: 'critical', ip_address: req.ip ?? null });
        }
      }
      logAction({ id_usuario: data.id, action: "LOGIN_FAILED", entity: "Usuario", entity_id: data.id, detail: `Login fallido para @${user}`, metadata: { user }, severity: 'warning', ip_address: req.ip ?? null });
      return res.status(400).json({ message: CREDENCIALES_INVALIDAS });
    }

    // A good password clears the slate. Otherwise yesterday's four failures and
    // today's one lock an account whose owner never got anything wrong twice
    // in a row.
    if ((data.failed_attempts ?? 0) > 0 || data.locked_until) {
      await UsuarioModel.update({ failed_attempts: 0, locked_until: null }, { where: { id: data.id } });
    }

    // The stored hash carries its own cost in the prefix. Reading it back out
    // with `bcryptCostOf` and comparing to `BCRYPT_COST` — rather than testing
    // the hash string against one literal old value — is what keeps this
    // correct the next time the constant moves. Re-hashing here is the only
    // moment the plaintext is in hand.
    const costoGuardado = bcryptCostOf(data.pass);
    if (costoGuardado !== null && costoGuardado < BCRYPT_COST) {
      const nuevo = await bcryptjs.hash(pass, BCRYPT_COST);
      await UsuarioModel.update({ pass: nuevo }, { where: { id: data.id } });
    }

    const usuario = {
      id: data.id,
      id_rol: data.id_rol,
      user: data.user,
      name: data.name,
      lastname: data.lastname,
      image: data.image,
    };
    const token = jwt.sign(usuario, secretKey, { expiresIn: "7d" });
    // The interface draws itself from these. Sent here so the first screen after
    // logging in is already right, rather than flashing everything and then
    // hiding what this role cannot reach.
    const permisos = await permissionsFor(data.id_rol);
    logAction({ id_usuario: data.id, action: "LOGIN", entity: "Usuario", entity_id: data.id, detail: "Inició sesión", metadata: { user: data.user }, severity: 'info', ip_address: req.ip ?? null });
    res.status(200).json({ usuario: { ...usuario, token }, permisos, message: "Login exitoso" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido";
    return res.status(500).json({ usuario: {}, message: msg });
  }
}

// Endpoint para verificar el token
/**
 * Who the bearer of this token is, right now.
 *
 * It used to answer with the token's own payload, which is a photograph taken
 * the day the person logged in. Tokens last a week: someone moved from
 * Coordinador to Cliente kept a browser that believed it was still a
 * Coordinador for the rest of it — and since the interface decided what to draw
 * from that belief, they kept seeing buttons they were no longer meant to have.
 *
 * So the role and the permissions come from the database, not from the token.
 */
export function comprobarToken(req: Request, res: Response) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, secretKey, async (err, decoded) => {
    if (err) return res.sendStatus(403);
    try {
      const claims = decoded as { id?: number };
      const stored = await UsuarioModel.findOne({
        where: { id: claims?.id },
        attributes: { exclude: ["pass"] },
      });
      // Archived or deleted since the token was issued: paranoid findOne returns
      // nothing, and the session ends rather than continuing on old claims.
      if (!stored) return res.sendStatus(403);

      const usuario = stored.dataValues;
      res.status(200).json({
        id: usuario.id,
        id_rol: usuario.id_rol,
        user: usuario.user,
        name: usuario.name,
        lastname: usuario.lastname,
        image: usuario.image,
        permisos: await permissionsFor(usuario.id_rol),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Error desconocido";
      return res.status(500).json({ message: msg });
    }
  });
}
