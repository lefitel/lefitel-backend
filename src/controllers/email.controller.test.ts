// Registering and confirming your own email address.
//
// Two things this file exists to pin harder than the rest, per
// `task-4-brief.md`'s acceptance criteria:
//
// - `/email/verify` writes to whoever the *token* names, never to
//   `req.user.id` and never to anything the request body says. Both
//   properties get a red demonstration below (see "the two red
//   demonstrations"), not just a green assertion — a green test here would
//   pass just as easily against a version that used `caller.id` if the two
//   ids happened to coincide in the setup, and the brief specifically asks
//   for the break to be shown.
// - `/email/send` answers the exact same body whether the mail actually
//   went out or not — compared as whole objects, not just a status code,
//   per the brief's own warning that a status-only test passes while the
//   body gives away which path was taken.
//
// A third thing joined these two in Ronda de arreglo 2, and it is the more
// serious of the three: `/email/send` used to require nothing but a live
// session, which chains into a real account takeover — steal a session, set
// the recovery address to one you control, verify it, wait, then
// `/password/forgot` and reset the legitimate owner out entirely. The
// previous-address notice below is this file's half of closing that.
//
// 🔴 **The other half is no longer in this file, and looking for it here is
// the mistake to avoid.** The password that stops that chain is compared by
// the gate on the route — `requireStepUp({ permiteOnboarding: true,
// sinVentana: true })` in `auth.routes.ts` — before this handler runs, against
// a field of the gate's own. This handler used to compare a second copy of the
// same secret under the name `pass`, and asking twice for one password is what
// the reauthentication-window work exists to stop. So there is nothing to
// assert here about a password: what these tests hold instead is that the
// handler adds **no** lock of its own behind the gate's, which is what
// "no longer asks for a password of its own" below is for. The gate's end is
// driven through the real stack in `app.auth.test.ts`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const findByPk = vi.fn();
const update = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: {
    findByPk: (...a: unknown[]) => findByPk(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

// Mocked wholesale for two reasons: `sendVerificationEmail` really does call
// it, and the real `tokenUsoUnico.model.ts` calls `UsuarioModel.hasMany` at
// import time, which the plain mock above has no method for — exactly the
// trap `global-constraints.md` #11 and Task 2's report both describe.
const tokenUpdate = vi.fn();
vi.mock("../models/tokenUsoUnico.model.js", () => ({
  TokenUsoUnicoModel: { update: (...a: unknown[]) => tokenUpdate(...a) },
}));

const TRANSACCION = { id: "una-transaccion" };
const transaction = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: { transaction: (...a: unknown[]) => transaction(...a) },
}));

const crearToken = vi.fn();
const consumirToken = vi.fn();
vi.mock("../auth/tokenStore.js", () => ({
  crearToken: (...a: unknown[]) => crearToken(...a),
  consumirToken: (...a: unknown[]) => consumirToken(...a),
}));

const enviarCorreo = vi.fn();
vi.mock("../auth/mailer.js", () => ({
  enviarCorreo: (...a: unknown[]) => enviarCorreo(...a),
}));

// `hayPresupuestoDeCorreo` only, matching what `email.controller.ts` now
// imports since Task 4 — the controller no longer calls
// `consumirPresupuestoDeCorreo` at all, so this file has no business
// mocking it. Defaults to `true` in `beforeEach`; the one test in "the mail
// budget" below is what overrides it.
const hayPresupuestoDeCorreo = vi.fn();
vi.mock("../auth/mailRelay.js", () => ({
  hayProveedorDisponible: (...a: unknown[]) => hayPresupuestoDeCorreo(...a),
}));

// Kept as a mock even though this controller no longer calls it, and that is
// the point: the assertion it exists for is `not.toHaveBeenCalled()`. A spy
// that can register a call is the only thing that can say "no password was
// compared here" out loud — without it, re-adding a comparison would be
// invisible to this file.
//
// Mocked wholesale rather than letting the real `credentials.js` load, as it
// always was: that module pulls in `bcryptjs`, `config/security.js`'s
// `fillerHash`/`bcryptCostOf` and `middleware/loginLimiters.js`'s
// `estaBloqueada`, none of which this file has any business exercising. Its own
// suite is `auth/verifyOwnPassword.test.ts`.
const verifyOwnPassword = vi.fn();
vi.mock("../auth/credentials.js", () => ({
  verifyOwnPassword: (...a: unknown[]) => verifyOwnPassword(...a),
}));

// Plan 4E: verifying the address registers a factor, so `verifyEmail` does
// what `confirmTotp` does — promote and seal — and changing the address may
// remove the last factor, so `sendVerificationEmail` asks whether a credential
// remains and revokes the remembered devices if not.
const promoverSesion = vi.fn();
const sellarPruebaDeFactor = vi.fn();
vi.mock("../auth/sessionPromotion.js", () => ({
  promoverSesion: (...a: unknown[]) => promoverSesion(...a),
  sellarPruebaDeFactor: (...a: unknown[]) => sellarPruebaDeFactor(...a),
}));
const tieneCredencialRegistrada = vi.fn();
vi.mock("../auth/factorInventory.js", () => ({
  tieneCredencialRegistrada: (...a: unknown[]) => tieneCredencialRegistrada(...a),
}));
const revokeAllRememberedDevicesOf = vi.fn();
vi.mock("../auth/rememberedDeviceStore.js", () => ({
  revokeAllRememberedDevicesOf: (...a: unknown[]) => revokeAllRememberedDevicesOf(...a),
}));
const revokeAllSessionsOf = vi.fn();
vi.mock("../auth/sessionStore.js", () => ({
  revokeAllSessionsOf: (...a: unknown[]) => revokeAllSessionsOf(...a),
}));

const logAction = vi.fn();
vi.mock("../utils/logAction.js", () => ({ logAction: (...a: unknown[]) => logAction(...a) }));

vi.mock("../utils/logger.js", () => ({
  log: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const {
  sendVerificationEmail,
  verifyEmail,
  EMAIL_INVALIDO,
  EMAIL_ENVIO_RESPUESTA,
  TOKEN_REQUERIDO,
  TOKEN_INVALIDO,
} = await import("./email.controller.js");

const A = 7;
const B = 9;
const TOKEN_CRUDO = "un-token-opaco-que-nunca-debe-salir-en-un-log";

function usuarioRow(overrides: Record<string, unknown> = {}) {
  return {
    dataValues: {
      id: A,
      email: null as string | null,
      email_verified_at: null as Date | null,
      ...overrides,
    },
  };
}

function call(
  user: NonNullable<Request["user"]> | undefined,
  body: unknown = {},
) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return {
    req: { user, body, ip: "203.0.113.9", originalUrl: "/api/auth/email/x" } as unknown as Request,
    res: res as unknown as Response,
    get status() {
      return res.statusCode;
    },
    get payload() {
      return res.body as Record<string, unknown> | undefined;
    },
    get message() {
      return (res.body as { message?: string } | undefined)?.message ?? "";
    },
  };
}

/**
 * The caller `authenticate` hands these handlers, with every field it declares
 * required — the session ones included, even though nothing in
 * `email.controller.ts` reads them. A fixture short of any of them is a caller
 * the middleware cannot produce, and this file has no business being the place
 * that finds out what a handler does with one.
 *
 * `"completa"` and the two nulls are what a session opened on a password alone
 * carries, which is every session there is today.
 */
const YO_CON_SESION = {
  id: A,
  id_rol: 2,
  id_sesion: "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa",
  expires_at: new Date(),
  estado: "completa" as const,
  mfa_satisfied_at: null,
  // Required on `req.user`, and null until somebody types their password
  // into `requireStepUp`: the ten-minute window of a factor-less account.
  password_confirmed_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  findByPk.mockResolvedValue(usuarioRow());
  update.mockResolvedValue([1]);
  tokenUpdate.mockResolvedValue([0]);
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
  crearToken.mockResolvedValue(TOKEN_CRUDO);
  consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
  enviarCorreo.mockResolvedValue({ ok: true });
  verifyOwnPassword.mockResolvedValue({ ok: true });
  hayPresupuestoDeCorreo.mockReturnValue(true);
  promoverSesion.mockResolvedValue(true);
  sellarPruebaDeFactor.mockResolvedValue(true);
  tieneCredencialRegistrada.mockResolvedValue(false);
  revokeAllRememberedDevicesOf.mockResolvedValue(0);
  revokeAllSessionsOf.mockResolvedValue(0);
});

describe("POST /auth/email/send", () => {
  it("refuses without a caller, and touches nothing", async () => {
    const c = call(undefined, { email: "a@osefi.net" });
    await sendVerificationEmail(c.req, c.res);

    expect(c.status).toBe(401);
    expect(findByPk).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a body with no email, before looking anything up", async () => {
    const c = call(YO_CON_SESION, {});
    await sendVerificationEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(EMAIL_INVALIDO);
    expect(findByPk).not.toHaveBeenCalled();
  });

  it("refuses a string that is not shaped like an email", async () => {
    const c = call(YO_CON_SESION, { email: "no-es-un-correo" });
    await sendVerificationEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(EMAIL_INVALIDO);
    expect(findByPk).not.toHaveBeenCalled();
  });

  // Audit of plan 4E, Task 7: nodemailer parses `to` as an address list and
  // would split this into two envelope recipients — N deliveries charged as
  // one, and "at most two copies" gone for that address. Resend answered such
  // a value 422; SMTP does not.
  it("refuses an address with a comma or a semicolon in it — nodemailer would read two recipients", async () => {
    for (const email of ["a,b@evil.com", "isaias@osefi.net,otro@evil.com", "isaias@osefi.net;otro@evil.com"]) {
      const c = call(YO_CON_SESION, { email });
      await sendVerificationEmail(c.req, c.res);
      expect(c.status, email).toBe(400);
      expect(c.message, email).toBe(EMAIL_INVALIDO);
    }
    expect(findByPk).not.toHaveBeenCalled();
  });

  it("refuses a non-string email without crashing", async () => {
    const c = call(YO_CON_SESION, { email: 123 });
    await sendVerificationEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(EMAIL_INVALIDO);
  });

  /**
   * The account-takeover fix, and where it lives now.
   *
   * The chain it closes is unchanged and still real: steal a live session, set
   * the recovery address to one you control, verify it, wait for the owner to
   * log out, and reset their password out from under them. What moved is
   * **who asks**. This handler used to compare a password of its own, in a
   * field called `pass`, and said in a comment beside the check that it was
   * the only thing asking. Since the route mounts
   * `requireStepUp({ permiteOnboarding: true, sinVentana: true })`
   * (`auth.routes.ts`) the gate compares the caller's password on **every**
   * request to this route, window or no window, and adds the account's factor
   * on top when it has one — which the handler's own check never could.
   *
   * Two secrets asked for twice was the whole complaint this arc started
   * from, so the handler's copy goes and the gate keeps it. These tests are
   * what makes putting it back visible: the first one goes red the moment
   * anything in this handler reads a password again.
   */
  describe("no longer asks for a password of its own — the gate does", () => {
    it("accepts a body with no password at all, and goes on to do the work", async () => {
      // The break-it test of this half. Restore the `pass` check in
      // `sendVerificationEmail` and this answers 400 instead of doing the job.
      //
      // 200 **and** the transaction, not merely "not a 400": the point is that
      // the request reaches the work, and a 400 from some other branch would
      // satisfy a status-only assertion just as well.
      const c = call(YO_CON_SESION, { email: "a@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(transaction).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalled();
      // Nothing here compares a password any more. The gate did that before
      // this function ran, against `stepup_password`.
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("ignores a `pass` field a stale bundle still sends, rather than comparing it", async () => {
      // The deploy window, from the other side. A tab opened before this
      // change still puts `pass` on the body; the field is simply not read,
      // so an old client keeps working and nothing compares a second secret.
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: "lo-que-sea" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
    });

    it("still answers 401 when the account was archived mid-request, and says the session is over", async () => {
      // The race survives the move: archived between `authenticate` and this
      // handler's own lookup. It used to be caught twice — once by
      // `verifyOwnPassword`'s `no-account`, once by the `findByPk` here — and
      // only the second catcher is left, so this is now the route's only 401.
      //
      // Matched on the reason and not the number: 401 is what `authenticate`
      // answers too, and the sentence is what says this branch ran. Loosely,
      // because the wording lives in three files by design (see
      // `CUENTA_INACTIVA`'s own comment) and a byte-for-byte copy here would
      // be a fourth.
      findByPk.mockResolvedValue(null);
      const c = call(YO_CON_SESION, { email: "a@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(401);
      expect(c.message).toMatch(/ya no está activa/i);
      expect(update).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  it("trims and lowercases the address before writing, minting and mailing", async () => {
    const c = call(YO_CON_SESION, { email: "  Isaias@Osefi.NET  " });
    await sendVerificationEmail(c.req, c.res);

    expect(c.status).toBe(200);
    const [values] = update.mock.calls[0] as [Record<string, unknown>];
    expect(values.email).toBe("isaias@osefi.net");
    expect(crearToken).toHaveBeenCalledWith(
      expect.objectContaining({ email_destino: "isaias@osefi.net" }),
    );
    expect(enviarCorreo.mock.calls[0][0]).toMatchObject({ para: "isaias@osefi.net" });
  });

  it("sets email_verified_at to NULL on every write, even the first one", async () => {
    const c = call(YO_CON_SESION, { email: "a@osefi.net" });
    await sendVerificationEmail(c.req, c.res);

    const [values] = update.mock.calls[0] as [Record<string, unknown>];
    expect(values.email_verified_at).toBeNull();
  });

  it("invalidates every pending token of the account, any purpose, in the same transaction as the email write", async () => {
    const c = call(YO_CON_SESION, { email: "a@osefi.net" });
    await sendVerificationEmail(c.req, c.res);

    const [, usuarioOptions] = update.mock.calls[0] as [unknown, { transaction: unknown }];
    const [tokenValues, tokenOptions] = tokenUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown>; transaction: unknown },
    ];
    expect(tokenValues.used_at).toBeInstanceOf(Date);
    // No `proposito` in the where — a pending reset_password row must die
    // too, not only a pending verify_email one.
    expect(tokenOptions.where).toEqual({ id_usuario: A, used_at: null });
    expect(tokenOptions.transaction).toBe(usuarioOptions.transaction);
    expect(tokenOptions.transaction).toBe(TRANSACCION);
  });

  it("answers the exact same body whether the mail actually sent or not", async () => {
    enviarCorreo.mockResolvedValue({ ok: true });
    const enviado = call(YO_CON_SESION, { email: "a@osefi.net" });
    await sendVerificationEmail(enviado.req, enviado.res);

    vi.clearAllMocks();
    findByPk.mockResolvedValue(usuarioRow());
    update.mockResolvedValue([1]);
    tokenUpdate.mockResolvedValue([0]);
    transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
    crearToken.mockResolvedValue(TOKEN_CRUDO);
    verifyOwnPassword.mockResolvedValue({ ok: true });
    enviarCorreo.mockResolvedValue({ ok: false });
    const caido = call(YO_CON_SESION, { email: "a@osefi.net" });
    await sendVerificationEmail(caido.req, caido.res);

    expect(enviado.status).toBe(caido.status);
    expect(enviado.payload).toEqual(caido.payload);
    expect(enviado.payload).toEqual({ message: EMAIL_ENVIO_RESPUESTA });
  });

  it("logs EMAIL_SEND on every call, with the destination address and no token", async () => {
    const c = call(YO_CON_SESION, { email: "a@osefi.net" });
    await sendVerificationEmail(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: A,
        action: "EMAIL_SEND",
        severity: "info",
        metadata: expect.objectContaining({ email_destino: "a@osefi.net" }),
      }),
    );
    expect(JSON.stringify(logAction.mock.calls)).not.toContain(TOKEN_CRUDO);
  });

  it("logs EMAIL_CHANGED, as critical, only when a verified address is being replaced", async () => {
    findByPk.mockResolvedValue(usuarioRow({ email: "vieja@osefi.net", email_verified_at: new Date() }));
    const c = call(YO_CON_SESION, { email: "nueva@osefi.net" });
    await sendVerificationEmail(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EMAIL_CHANGED",
        severity: "critical",
        metadata: { email_anterior: "vieja@osefi.net", email_destino: "nueva@osefi.net" },
      }),
    );
  });

  it("does not log EMAIL_CHANGED for a first-time or still-unverified address", async () => {
    findByPk.mockResolvedValue(usuarioRow({ email: null, email_verified_at: null }));
    const c = call(YO_CON_SESION, { email: "a@osefi.net" });
    await sendVerificationEmail(c.req, c.res);

    expect(logAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "EMAIL_CHANGED" }),
    );
  });

  it("never puts the plain token in the response, whatever it is", async () => {
    const c = call(YO_CON_SESION, { email: "a@osefi.net" });
    await sendVerificationEmail(c.req, c.res);

    expect(JSON.stringify(c.payload)).not.toContain(TOKEN_CRUDO);
  });

  /**
   * Arreglo 2's other half — the notice to the address that is *leaving*
   * the account, and arguably the more important of the two fixes: it is
   * the only message in this whole flow that reaches a mailbox the attacker
   * does not hold.
   */
  describe("notifying the previous address", () => {
    it("mails the new address and the previous one, masked, when replacing a verified address", async () => {
      findByPk.mockResolvedValue(usuarioRow({ email: "vieja@osefi.net", email_verified_at: new Date() }));
      const c = call(YO_CON_SESION, { email: "nueva@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(enviarCorreo).toHaveBeenCalledTimes(2);
      const [primero, segundo] = enviarCorreo.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(primero.para).toBe("nueva@osefi.net");
      expect(segundo.para).toBe("vieja@osefi.net");
      // The new address is masked in the notice — recognisable, not spelled
      // out, to whoever now reads the old mailbox.
      expect(segundo.html).toContain("n***@osefi.net");
      expect(segundo.texto).toContain("n***@osefi.net");
      expect(segundo.html).not.toContain("nueva@osefi.net");
      expect(segundo.texto).not.toContain("nueva@osefi.net");
    });

    it("mails only the new address when there is no previous address at all", async () => {
      findByPk.mockResolvedValue(usuarioRow({ email: null, email_verified_at: null }));
      const c = call(YO_CON_SESION, { email: "a@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(enviarCorreo).toHaveBeenCalledTimes(1);
      expect(enviarCorreo.mock.calls[0][0]).toMatchObject({ para: "a@osefi.net" });
    });

    it("mails only the new address when the address it replaces was never verified", async () => {
      // There is a previous address, but it was never confirmed — nobody
      // relies on it as a recovery channel yet, so there is nobody to warn.
      findByPk.mockResolvedValue(usuarioRow({ email: "sin-verificar@osefi.net", email_verified_at: null }));
      const c = call(YO_CON_SESION, { email: "a@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(enviarCorreo).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Hallazgo A2 / Task 3. The bug this pins: the handler used to wipe
   * `email_verified_at` and burn every pending token *before* asking the
   * mail budget, so an exhausted budget destroyed the address already on
   * file for a token that was then never minted and a mail that was never
   * sent — while still answering the same "se envió un enlace" sentence. A
   * test that only reads the response cannot see that at all: per
   * Constraint #1 the response is identical in both cases on purpose (see
   * "answers the exact same body whether the mail actually sent or not"
   * above). What has to be pinned is the write that must NOT happen.
   */
  describe("the mail budget", () => {
    it("leaves the verified address intact when there is no mail budget left", async () => {
      hayPresupuestoDeCorreo.mockReturnValue(false);
      findByPk.mockResolvedValue(usuarioRow({ email: "vieja@osefi.net", email_verified_at: new Date() }));
      const c = call(YO_CON_SESION, { email: "nueva@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      // The uniform response, unmoved — Constraint #1 still holds even here.
      expect(c.status).toBe(200);
      expect(c.payload).toEqual({ message: EMAIL_ENVIO_RESPUESTA });
      // What actually matters: the destructive transaction never ran, so the
      // account keeps the verified address and the pending tokens it had.
      expect(update).not.toHaveBeenCalled();
      expect(tokenUpdate).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      // And nothing downstream of the wipe ran either — no token minted for
      // an address that was never touched, no mail sent for a link that was
      // never minted.
      expect(crearToken).not.toHaveBeenCalled();
      expect(enviarCorreo).not.toHaveBeenCalled();
    });

    it("still runs the transaction and sends when the budget has room", async () => {
      hayPresupuestoDeCorreo.mockReturnValue(true);
      const c = call(YO_CON_SESION, { email: "a@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(transaction).toHaveBeenCalledOnce();
      expect(enviarCorreo).toHaveBeenCalled();
    });
  });
});

describe("POST /auth/email/verify", () => {
  it("refuses without a caller, and touches nothing", async () => {
    const c = call(undefined, { token: "x" });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(401);
    expect(consumirToken).not.toHaveBeenCalled();
  });

  it("requires a token in the body, before looking anything up", async () => {
    const c = call(YO_CON_SESION, {});
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(TOKEN_REQUERIDO);
    expect(consumirToken).not.toHaveBeenCalled();
  });

  it("refuses a non-string token without crashing", async () => {
    const c = call(YO_CON_SESION, { token: 12345 });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(consumirToken).not.toHaveBeenCalled();
  });

  it("answers the generic message when the token does not redeem", async () => {
    consumirToken.mockResolvedValue(null);
    const c = call(YO_CON_SESION, { token: "caducado-o-usado-o-inventado" });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(TOKEN_INVALIDO);
    expect(update).not.toHaveBeenCalled();
  });

  it("redeems the token only for the account holding the session, and in no transaction", async () => {
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);

    // `soloDelUsuario` is what closes the attack the final review found: B
    // could put A's address on B's own account, the mail went to A's inbox,
    // and A clicking the link verified **B's** account — permanently taking
    // A's address, since only one account may ever verify it. The id comes
    // from the session `authenticate` established, never from the body.
    expect(consumirToken).toHaveBeenCalledWith("un-token", "verify_email", { soloDelUsuario: A });
    // And no transaction, deliberately: burning the token on the unique-index
    // collision is the correct outcome here — retrying would not help, the
    // address genuinely belongs to somebody else.
    expect(consumirToken.mock.calls[0][2]).not.toHaveProperty("transaction");
  });

  it("refuses when the account's current email no longer matches the token's own address", async () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "vieja@osefi.net" });
    findByPk.mockResolvedValue(usuarioRow({ email: "nueva@osefi.net" }));
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(TOKEN_INVALIDO);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses when the account behind the token is gone", async () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    findByPk.mockResolvedValue(null);
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(TOKEN_INVALIDO);
  });

  it("answers the generic message, and leaves the token burned, on a unique-constraint collision", async () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    findByPk.mockResolvedValue(usuarioRow({ email: "a@osefi.net" }));
    update.mockRejectedValue({
      name: "SequelizeUniqueConstraintError",
      parent: { constraint: "usuarios_email_verificado_uniq" },
      message: "duplicate key",
    });
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(TOKEN_INVALIDO);
    // The token is not retried — consumirToken ran once, at the top.
    expect(consumirToken).toHaveBeenCalledOnce();
  });

  it("answers 500, not the generic token message, for an unrelated database failure", async () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    findByPk.mockResolvedValue(usuarioRow({ email: "a@osefi.net" }));
    update.mockRejectedValue(new Error("pool agotado"));
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(500);
    expect(c.message).not.toContain("pool agotado");
  });

  it("sets email_verified_at and logs EMAIL_VERIFIED with the token's own address", async () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    findByPk.mockResolvedValue(usuarioRow({ email: "a@osefi.net" }));
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);

    expect(c.status).toBe(200);
    const [values, options] = update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(values.email_verified_at).toBeInstanceOf(Date);
    expect(options.where).toEqual({ id: A });
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: A,
        action: "EMAIL_VERIFIED",
        severity: "critical",
        metadata: expect.objectContaining({ email_destino: "a@osefi.net", fuente: "correo" }),
      }),
    );
  });

  it("never puts the plain token in the response or in a bitácora line", async () => {
    const crudo = "el-token-en-claro-de-esta-peticion";
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    findByPk.mockResolvedValue(usuarioRow({ email: "a@osefi.net" }));
    const c = call(YO_CON_SESION, { token: crudo });
    await verifyEmail(c.req, c.res);

    expect(JSON.stringify(c.payload)).not.toContain(crudo);
    expect(JSON.stringify(logAction.mock.calls)).not.toContain(crudo);
  });

  /**
   * The two red demonstrations `task-4-brief.md` asks for by name. Both are
   * expressed as one behaviour test (green today) plus a note of exactly
   * which line was edited to watch it fail — the pasted transcript is in
   * `task-4-report.md`, not duplicated here as a skipped test, so this file
   * stays something `npx vitest run` actually exercises.
   */
  describe("the account written is the token's own, never the caller's and never the body's", () => {
    it("verifies A's account from A's token while B is the one logged in", async () => {
      // Demonstrated by breaking it: in `email.controller.ts`'s `verifyEmail`,
      // change `redeemed.id_usuario` to `caller.id` in the `findByPk` call and
      // in the `where` of the `UsuarioModel.update` call, then run
      // `npx vitest run src/controllers/email.controller.test.ts` — this test
      // goes red because the update lands on B (9) instead of A (7). See
      // task-4-report.md for the pasted failure.
      consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
      findByPk.mockResolvedValue(usuarioRow({ id: A, email: "a@osefi.net" }));
      // The same kind of caller as `YO_CON_SESION`, differing only in who it
      // is: another account, on another session row.
      const callerEsB = {
        ...YO_CON_SESION,
        id: B,
        id_sesion: "bbbbbbbb-22de-4222-8222-bbbbbbbbbbbb",
      };
      const c = call(callerEsB, { token: "el-token-de-A" });
      await verifyEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(findByPk).toHaveBeenCalledWith(A, expect.anything());
      const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
      expect(options.where).toEqual({ id: A });
    });

    it("ignores an id_usuario and email in the body that point at another account", async () => {
      // Demonstrated by breaking it: make `verifyEmail` prefer
      // `req.body.id_usuario`/`req.body.email` over `redeemed.id_usuario`/
      // `redeemed.email_destino` when they are present, then run the suite —
      // this test goes red because the write targets account 999 (which
      // `findByPk` has not been told to answer for) instead of A. See
      // task-4-report.md for the pasted failure.
      consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
      findByPk.mockResolvedValue(usuarioRow({ id: A, email: "a@osefi.net" }));
      const c = call(YO_CON_SESION, {
        token: "un-token-valido",
        id_usuario: 999,
        email: "attacker@evil.com",
      });
      await verifyEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(findByPk).toHaveBeenCalledWith(A, expect.anything());
      const [, options] = update.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
      expect(options.where).toEqual({ id: A });
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ id_usuario: A, metadata: expect.objectContaining({ email_destino: "a@osefi.net" }) }),
      );
    });
  });
});

// Plan 4E: a verified address is a second factor.
describe("POST /auth/email/verify — verifying registers a factor (plan 4E)", () => {
  const tokenBueno = () => {
    consumirToken.mockResolvedValue({ id_usuario: A, email_destino: "a@osefi.net" });
    findByPk.mockResolvedValue(usuarioRow({ email: "a@osefi.net" }));
  };

  it("promotes the caller's session as `correo`, in the same transaction as the column", async () => {
    tokenBueno();
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);
    expect(c.status).toBe(200);
    expect(update.mock.calls[0][1]).toMatchObject({ where: { id: A }, transaction: TRANSACCION });
    expect(promoverSesion).toHaveBeenCalledWith(YO_CON_SESION.id_sesion, "correo", { transaction: TRANSACCION });
    expect(sellarPruebaDeFactor).not.toHaveBeenCalled();
  });

  it("seals the session instead when there was nothing to promote — a completa session under the grace clock", async () => {
    tokenBueno();
    promoverSesion.mockResolvedValue(false);
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);
    expect(sellarPruebaDeFactor).toHaveBeenCalledWith(YO_CON_SESION.id_sesion, "correo", { transaction: TRANSACCION });
  });

  it("no toca el plazo de gracia: verificar el correo no compra catorce dias nuevos", async () => {
    // La vuelta mas barata del bucle que se cerro el 2026-09-08, y la unica
    // que necesita buzon: verificar la direccion borraba el plazo, cambiarla
    // borraba la verificacion, y el siguiente login leia NULL —"el reloj no ha
    // empezado nunca"— y estampaba catorce dias enteros. La unica escritura
    // que este handler puede hacer sobre `usuarios` es la de la columna del
    // correo.
    tokenBueno();
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);
    for (const [values] of update.mock.calls as [Record<string, unknown>][]) {
      expect(values).not.toHaveProperty("mfa_grace_until");
    }
  });

  it("promotes nothing when the column write collides with another verified account", async () => {
    tokenBueno();
    update.mockRejectedValue({
      name: "SequelizeUniqueConstraintError",
      parent: { constraint: "usuarios_email_verificado_uniq" },
      message: "duplicate key",
    });
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);
    expect(c.status).toBe(400);
    expect(promoverSesion).not.toHaveBeenCalled();
    expect(sellarPruebaDeFactor).not.toHaveBeenCalled();
  });

  it("names the session and the source in the bitácora line", async () => {
    tokenBueno();
    const c = call(YO_CON_SESION, { token: "un-token" });
    await verifyEmail(c.req, c.res);
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EMAIL_VERIFIED",
        metadata: expect.objectContaining({ id_sesion: YO_CON_SESION.id_sesion, fuente: "correo" }),
      }),
    );
  });
});

describe("POST /auth/email/send — changing the address may remove the last factor (plan 4E)", () => {
  it("revokes the remembered devices and every other session, on the transaction, when the old address was verified and no credential remains", async () => {
    findByPk.mockResolvedValue(usuarioRow({ email: "vieja@osefi.net", email_verified_at: new Date() }));
    tieneCredencialRegistrada.mockResolvedValue(false);
    revokeAllRememberedDevicesOf.mockResolvedValue(2);
    revokeAllSessionsOf.mockResolvedValue(3);
    const c = call(YO_CON_SESION, { email: "nueva@osefi.net" });
    await sendVerificationEmail(c.req, c.res);
    expect(c.status).toBe(200);
    expect(tieneCredencialRegistrada).toHaveBeenCalledWith(A, { transaction: TRANSACCION });
    expect(revokeAllRememberedDevicesOf).toHaveBeenCalledWith(A, { transaction: TRANSACCION });
    // `except` this session: verifying the new address needs it.
    expect(revokeAllSessionsOf).toHaveBeenCalledWith(A, { except: YO_CON_SESION.id_sesion, transaction: TRANSACCION });
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EMAIL_SEND",
        metadata: expect.objectContaining({ dispositivos_revocados: 2, sesiones_revocadas: 3 }),
      }),
    );
  });

  it("leaves devices and sessions alone when a passkey or an app still vouches for them", async () => {
    findByPk.mockResolvedValue(usuarioRow({ email: "vieja@osefi.net", email_verified_at: new Date() }));
    tieneCredencialRegistrada.mockResolvedValue(true);
    const c = call(YO_CON_SESION, { email: "nueva@osefi.net" });
    await sendVerificationEmail(c.req, c.res);
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EMAIL_SEND",
        metadata: expect.objectContaining({ dispositivos_revocados: null, sesiones_revocadas: null }),
      }),
    );
  });

  it("asks nothing when the old address was never verified: no factor was removed", async () => {
    findByPk.mockResolvedValue(usuarioRow({ email: "sin-verificar@osefi.net", email_verified_at: null }));
    const c = call(YO_CON_SESION, { email: "nueva@osefi.net" });
    await sendVerificationEmail(c.req, c.res);
    expect(tieneCredencialRegistrada).not.toHaveBeenCalled();
    expect(revokeAllRememberedDevicesOf).not.toHaveBeenCalled();
    expect(revokeAllSessionsOf).not.toHaveBeenCalled();
  });

  it("serves an account with no factor and no address, which is every account on deploy day", async () => {
    /**
     * The sealed-room case, measured from the handler's side.
     *
     * This route is the only way out of `onboarding`: a verified address is
     * the prerequisite for `/auth/totp/setup` (409 without one) and a factor
     * is the only way out of that state. So an account with nothing — no
     * factor, no address, which is what every account looks like the day this
     * ships — has to get through here. It used to be refused by this
     * handler's own `pass` check whenever the client did not send that field,
     * and the client stopped sending it in this same change.
     *
     * What still asks is the gate, on the route, with `permiteOnboarding`
     * and `sinVentana` — a password on every request, plus a factor for
     * whoever has one. `app.auth.test.ts` drives that end of it; this pins
     * that the handler adds no second lock behind it.
     */
    findByPk.mockResolvedValue(usuarioRow({ email: null, email_verified_at: null }));
    const c = call(YO_CON_SESION, { email: "nueva@osefi.net" });
    await sendVerificationEmail(c.req, c.res);
    expect(c.status).toBe(200);
    expect(transaction).toHaveBeenCalledOnce();
  });
});
