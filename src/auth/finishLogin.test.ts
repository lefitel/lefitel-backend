// `terminarLogin` — the half of a login that comes after the credential, and
// the four rules a second copy of it loses. Each rule here has one test that
// goes red for the one-line mutation that drops it, and the passwordless
// guard has three, because it is the one piece with no counterpart in the
// password login and nothing else in the suite would notice it gone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const estadoInicialDeSesion = vi.fn();
vi.mock("./factorInventory.js", () => ({
  estadoInicialDeSesion: (...a: unknown[]) => estadoInicialDeSesion(...a),
}));

const issueSession = vi.fn();
vi.mock("./issueSession.js", () => ({
  issueSession: (...a: unknown[]) => issueSession(...a),
}));

const update = vi.fn();
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { update: (...a: unknown[]) => update(...a) },
}));

const permissionsFor = vi.fn();
vi.mock("../permissions/store.js", () => ({
  permissionsFor: (...a: unknown[]) => permissionsFor(...a),
}));

const error = vi.fn();
const warn = vi.fn();
vi.mock("../utils/logger.js", () => ({
  log: () => ({ error, warn, info: vi.fn(), debug: vi.fn() }),
}));

const { terminarLogin, cuerpoDeLogin, LOGIN_OK } = await import("./finishLogin.js");

const USUARIO = { id: 7, id_rol: 2, user: "isaias", name: "Isaias", lastname: "Salas", image: null };
const PERMISOS = { poste: { ver: true } };
const req = {} as Request;
const res = {} as Response;

/** How every call in this file is made: the shared object, plus what the test changes. */
const llamar = (fuente?: "dispositivo" | "passkey", opciones?: { transaction?: unknown }) =>
  terminarLogin(req, res, { usuario: USUARIO, mfa_grace_until: null }, fuente, opciones as never);

beforeEach(() => {
  vi.clearAllMocks();
  estadoInicialDeSesion.mockResolvedValue({ estado: "completa", graceUntil: null, conFactor: true });
  issueSession.mockResolvedValue({ id: "sesion-nueva" });
  update.mockResolvedValue([1]);
  permissionsFor.mockResolvedValue(PERMISOS);
});

describe("the state is decided by estadoInicialDeSesion, and by nothing else", () => {
  it("hands it the account and the source, and passes whatever it answers to the session", async () => {
    estadoInicialDeSesion.mockResolvedValue({ estado: "onboarding", graceUntil: null, conFactor: false });
    const r = await llamar("dispositivo");
    expect(estadoInicialDeSesion).toHaveBeenCalledWith(
      { id: 7, mfa_grace_until: null },
      expect.any(Date),
      "dispositivo",
      {},
    );
    // The same source reaches the row: one value, both consumers.
    expect(issueSession).toHaveBeenCalledWith(req, res, 7, "onboarding", "dispositivo", {});
    expect(r).toMatchObject({ ok: true, estado: "onboarding" });
  });

  it("forwards the caller's transaction to the counts and the session, and not to the grace stamp", async () => {
    const transaction = { id: "una-transaccion" };
    estadoInicialDeSesion.mockResolvedValue({ estado: "completa", graceUntil: new Date(), conFactor: false });
    await llamar(undefined, { transaction });
    expect(estadoInicialDeSesion.mock.calls[0][3]).toEqual({ transaction });
    expect(issueSession).toHaveBeenCalledWith(req, res, 7, "completa", undefined, { transaction });
    // The grace stamp deliberately stays outside it: inside, a failed
    // statement aborts the whole transaction, session included.
    expect(update.mock.calls[0][1]).toEqual({ where: { id: 7 } });
  });
});

describe("the passkey guard: no factor found is a refusal", () => {
  // 🔴 The race: the credential was deleted between the read and here, the
  // deleter revoked every live session, and a session opened now would be
  // inserted after that revocation and survive it. Drop the guard and this
  // opens `completa` with a fresh fourteen days on an account with nothing
  // registered.
  it("refuses when the account turned out to have no factor, whatever state the clock gave it", async () => {
    // Three answers the no-factor branches can give, one of them identical to
    // the factor branch's own — which is why the guard reads `conFactor` and
    // not the state.
    for (const respuesta of [
      { estado: "completa", graceUntil: new Date(), conFactor: false },
      { estado: "completa", graceUntil: null, conFactor: false },
      { estado: "onboarding", graceUntil: null, conFactor: false },
    ]) {
      vi.clearAllMocks();
      estadoInicialDeSesion.mockResolvedValue(respuesta);
      const r = await llamar("passkey");
      expect(r, respuesta.estado).toEqual({ ok: false, motivo: "factor-desaparecido" });
      expect(issueSession, respuesta.estado).not.toHaveBeenCalled();
      expect(update, respuesta.estado).not.toHaveBeenCalled();
      expect(warn, respuesta.estado).toHaveBeenCalled();
    }
  });

  it("applies only to the passkey source: a password login with no factor is the ordinary case", async () => {
    estadoInicialDeSesion.mockResolvedValue({ estado: "completa", graceUntil: new Date(), conFactor: false });
    const r = await llamar(undefined);
    expect(r).toMatchObject({ ok: true, estado: "completa" });
    expect(issueSession).toHaveBeenCalled();
  });

  it("applies only to the passkey source: a remembered device opening parcial is not refused", async () => {
    // `parcial` from a device login is an invalid cookie on an account with a
    // factor — the ordinary case, and the password door's business.
    estadoInicialDeSesion.mockResolvedValue({ estado: "parcial", graceUntil: null, conFactor: true });
    const r = await llamar("dispositivo");
    expect(r).toMatchObject({ ok: true, estado: "parcial" });
    expect(issueSession).toHaveBeenCalled();
  });
});

describe("a session that cannot be opened is a login that cannot be granted", () => {
  it("answers the 503 verdict, writes nothing else, and says so at error level", async () => {
    estadoInicialDeSesion.mockResolvedValue({ estado: "completa", graceUntil: new Date(), conFactor: false });
    issueSession.mockRejectedValue(new Error("pool agotado"));
    const r = await llamar();
    expect(r).toEqual({ ok: false, motivo: "sesion-no-disponible" });
    // No grace clock started on a login that never happened.
    expect(update).not.toHaveBeenCalled();
    expect(permissionsFor).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

describe("the grace clock starts after the session, never before it", () => {
  it("writes the deadline it was told, after the session exists", async () => {
    const deadline = new Date("2026-09-17T00:00:00.000Z");
    estadoInicialDeSesion.mockResolvedValue({ estado: "completa", graceUntil: deadline, conFactor: false });
    await llamar();
    expect(update).toHaveBeenCalledWith({ mfa_grace_until: deadline }, { where: { id: 7 } });
    // Order, read off the mocks: the session first.
    expect(issueSession.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  it("leaves the column alone when told to", async () => {
    await llamar();
    expect(update).not.toHaveBeenCalled();
  });

  it("still finishes the login when the deadline cannot be written, and says so", async () => {
    estadoInicialDeSesion.mockResolvedValue({ estado: "completa", graceUntil: new Date(), conFactor: false });
    update.mockRejectedValue(new Error("la tabla está bloqueada"));
    const r = await llamar();
    expect(r.ok).toBe(true);
    expect(error).toHaveBeenCalled();
  });
});

describe("what terminarLogin hands back", () => {
  it("hands back the id of the session it opened, for the bitácora line the door writes", async () => {
    const r = await llamar();
    expect(r.ok && r.id_sesion).toBe("sesion-nueva");
  });

  it("never reads the permission matrix itself: that read goes around a transaction", async () => {
    // `cuerpoDeLogin` builds the body after the door's commit — see its
    // docblock. Read here, inside a passwordless login's transaction, it would
    // borrow a second pool connection.
    await llamar("passkey", { transaction: { id: "t" } });
    expect(permissionsFor).not.toHaveBeenCalled();
  });

  it("never carries the deadline it was given", async () => {
    const r = await terminarLogin(
      req,
      res,
      { usuario: USUARIO, mfa_grace_until: new Date("2026-09-17T00:00:00.000Z") },
      undefined,
    );
    expect(JSON.stringify(r)).not.toContain("mfa_grace_until");
  });
});

describe("cuerpoDeLogin — the body", () => {
  it("carries the permission matrix only for a session that opens completa", async () => {
    const cuerpo = await cuerpoDeLogin(USUARIO, "completa");
    expect(cuerpo).toEqual({ usuario: USUARIO, permisos: PERMISOS, message: LOGIN_OK });
    expect(permissionsFor).toHaveBeenCalledWith(2);
  });

  it("withholds it — absent, not empty — for any other state, without even asking for it", async () => {
    for (const estado of ["parcial", "onboarding"] as const) {
      permissionsFor.mockClear();
      const cuerpo = await cuerpoDeLogin(USUARIO, estado);
      expect(Object.keys(cuerpo).sort(), estado).toEqual(["message", "usuario"]);
      expect(permissionsFor, estado).not.toHaveBeenCalled();
    }
  });

  it("puts the object it was given into the body, as is", async () => {
    const cuerpo = await cuerpoDeLogin(USUARIO, "completa");
    expect(cuerpo.usuario).toBe(USUARIO);
  });
});
