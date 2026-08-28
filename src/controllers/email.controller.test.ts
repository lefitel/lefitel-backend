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
// `/password/forgot` and reset the legitimate owner out entirely. The tests
// below for `verifyOwnPassword` and the previous-address notice are what
// close that, and the red demonstration for this round removes the
// `verifyOwnPassword` call itself rather than a single condition inside it —
// see "the account-takeover fix" below.

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

// Mocked wholesale rather than let the real `credentials.js` load: that
// module imports `UsuarioModel` (fine, already mocked above) but also
// `bcryptjs`, `config/security.js`'s `fillerHash`/`bcryptCostOf` and
// `middleware/loginLimiters.js`'s `estaBloqueada` — none of which this file
// has any business exercising to prove what `sendVerificationEmail` does
// with `verifyOwnPassword`'s answer. What is under test here is the
// controller's own branching on `{ ok, reason }`, not `verifyOwnPassword`
// itself — that function's own suite is `auth/verifyOwnPassword.test.ts`.
const verifyOwnPassword = vi.fn();
vi.mock("../auth/credentials.js", () => ({
  verifyOwnPassword: (...a: unknown[]) => verifyOwnPassword(...a),
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
  CURRENT_PASSWORD_REQUIRED_MESSAGE,
  CURRENT_PASSWORD_WRONG_MESSAGE,
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
 * required — the last two included, even though nothing in `email.controller.ts`
 * reads either. A fixture short of them is a caller the middleware cannot
 * produce, and this file has no business being the place that finds out what a
 * handler does with one.
 *
 * `"completa"` and `null` are what a session opened on a password alone carries,
 * which is every session there is today.
 */
const YO_CON_SESION = {
  id: A,
  id_rol: 2,
  id_sesion: "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa",
  expires_at: new Date(),
  estado: "completa" as const,
  mfa_satisfied_at: null,
};

/** The current password, standing in for whatever the caller actually typed. */
const PASS = "una-clave-de-prueba";

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

  it("refuses a non-string email without crashing", async () => {
    const c = call(YO_CON_SESION, { email: 123 });
    await sendVerificationEmail(c.req, c.res);

    expect(c.status).toBe(400);
    expect(c.message).toBe(EMAIL_INVALIDO);
  });

  /**
   * The account-takeover fix (Ronda de arreglo 2). Without a password
   * confirmation, a stolen session is enough to redirect the account's
   * recovery address to one the attacker controls, verify it, wait for the
   * owner to log out, and reset the password out from under them — which
   * revokes every session, including the legitimate owner's. `verifyOwnPassword`
   * is the exact piece `usuario.controller.ts`'s `updateUserName` already
   * uses for the same question, reused rather than a fresh `bcryptjs.compare`.
   */
  describe("requires the caller's current password", () => {
    it("refuses a body with no password, and never touches the row — comparing the row, not just the status", async () => {
      const c = call(YO_CON_SESION, { email: "a@osefi.net" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(400);
      expect(c.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
      expect(verifyOwnPassword).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("refuses a non-string password without crashing, and never touches the row", async () => {
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: 12345 });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(400);
      expect(c.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
      expect(update).not.toHaveBeenCalled();
    });

    it("refuses the wrong current password, and never touches the row", async () => {
      verifyOwnPassword.mockResolvedValue({ ok: false, reason: "wrong-password" });
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: "no-es-la-mia" });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(401);
      expect(c.message).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      expect(verifyOwnPassword).toHaveBeenCalledWith({ id: A, pass: "no-es-la-mia", ip: "203.0.113.9" });
      expect(update).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(findByPk).not.toHaveBeenCalled();
    });

    it("answers 401 without a wrong-password sentence when the account is gone by the time the password is checked", async () => {
      // `no-account`: archived between `authenticate` and `verifyOwnPassword`'s
      // own lookup. Answered the same way `/api/auth/me` answers the same
      // race, and pointedly not as a wrong password — telling somebody to
      // look for a typo in a password nothing ever compared is worse than
      // telling them their session is over.
      verifyOwnPassword.mockResolvedValue({ ok: false, reason: "no-account" });
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(401);
      expect(c.message).not.toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      expect(findByPk).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it("answers 401 for the narrower race between verifyOwnPassword's own lookup and this handler's second one", async () => {
      findByPk.mockResolvedValue(null);
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(401);
      expect(update).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it("proceeds once the password is confirmed", async () => {
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
      await sendVerificationEmail(c.req, c.res);

      expect(verifyOwnPassword).toHaveBeenCalledWith({ id: A, pass: PASS, ip: "203.0.113.9" });
      expect(c.status).toBe(200);
      expect(transaction).toHaveBeenCalledOnce();
    });
  });

  it("trims and lowercases the address before writing, minting and mailing", async () => {
    const c = call(YO_CON_SESION, { email: "  Isaias@Osefi.NET  ", pass: PASS });
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
    const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
    await sendVerificationEmail(c.req, c.res);

    const [values] = update.mock.calls[0] as [Record<string, unknown>];
    expect(values.email_verified_at).toBeNull();
  });

  it("invalidates every pending token of the account, any purpose, in the same transaction as the email write", async () => {
    const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
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
    const enviado = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
    await sendVerificationEmail(enviado.req, enviado.res);

    vi.clearAllMocks();
    findByPk.mockResolvedValue(usuarioRow());
    update.mockResolvedValue([1]);
    tokenUpdate.mockResolvedValue([0]);
    transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(TRANSACCION));
    crearToken.mockResolvedValue(TOKEN_CRUDO);
    verifyOwnPassword.mockResolvedValue({ ok: true });
    enviarCorreo.mockResolvedValue({ ok: false });
    const caido = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
    await sendVerificationEmail(caido.req, caido.res);

    expect(enviado.status).toBe(caido.status);
    expect(enviado.payload).toEqual(caido.payload);
    expect(enviado.payload).toEqual({ message: EMAIL_ENVIO_RESPUESTA });
  });

  it("logs EMAIL_SEND on every call, with the destination address and no token", async () => {
    const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
    await sendVerificationEmail(c.req, c.res);

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id_usuario: A,
        action: "EMAIL_SEND",
        severity: "info",
        metadata: { email_destino: "a@osefi.net" },
      }),
    );
    expect(JSON.stringify(logAction.mock.calls)).not.toContain(TOKEN_CRUDO);
  });

  it("logs EMAIL_CHANGED, as critical, only when a verified address is being replaced", async () => {
    findByPk.mockResolvedValue(usuarioRow({ email: "vieja@osefi.net", email_verified_at: new Date() }));
    const c = call(YO_CON_SESION, { email: "nueva@osefi.net", pass: PASS });
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
    const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
    await sendVerificationEmail(c.req, c.res);

    expect(logAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "EMAIL_CHANGED" }),
    );
  });

  it("never puts the plain token in the response, whatever it is", async () => {
    const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
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
      const c = call(YO_CON_SESION, { email: "nueva@osefi.net", pass: PASS });
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
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(enviarCorreo).toHaveBeenCalledTimes(1);
      expect(enviarCorreo.mock.calls[0][0]).toMatchObject({ para: "a@osefi.net" });
    });

    it("mails only the new address when the address it replaces was never verified", async () => {
      // There is a previous address, but it was never confirmed — nobody
      // relies on it as a recovery channel yet, so there is nobody to warn.
      findByPk.mockResolvedValue(usuarioRow({ email: "sin-verificar@osefi.net", email_verified_at: null }));
      const c = call(YO_CON_SESION, { email: "a@osefi.net", pass: PASS });
      await sendVerificationEmail(c.req, c.res);

      expect(c.status).toBe(200);
      expect(enviarCorreo).toHaveBeenCalledTimes(1);
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
        severity: "info",
        metadata: { email_destino: "a@osefi.net" },
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
        expect.objectContaining({ id_usuario: A, metadata: { email_destino: "a@osefi.net" } }),
      );
    });
  });
});
