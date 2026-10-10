// The unsubscribe link and what redeems it, with the models faked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/logger.js", () => ({ log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

const {
  ReporteProgramacionDestinatarioModel,
  ReporteProgramacionModel,
} = await import("../models/reporteProgramacion.model.js");
const { ReporteVistaModel } = await import("../models/reporteVista.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");

// `unscoped()` is how the token is read at all: the default scope hides it.
const sinAlcance = { findByPk: vi.fn(), findOne: vi.fn() };
vi.spyOn(ReporteProgramacionDestinatarioModel, "unscoped").mockReturnValue(sinAlcance as never);
const actualizar = vi.spyOn(ReporteProgramacionDestinatarioModel, "update");
const programacionFindByPk = vi.spyOn(ReporteProgramacionModel, "findByPk");
const informeFindByPk = vi.spyOn(ReporteVistaModel, "findByPk");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");

const {
  FORMA_DEL_TOKEN,
  consultarBaja,
  darDeBaja,
  enlaceCon,
  enlaceDeBaja,
  nuevoToken,
  origenDeLaWeb,
} = await import("./unsubscribe.js");

const TOKEN = "A".repeat(43);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CORS_ORIGIN", "https://www.osefi.net");
  vi.stubEnv("NODE_ENV", "production");
  actualizar.mockResolvedValue([1] as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("the token", () => {
  it("is forty-three url-safe characters and different every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, nuevoToken));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t).toMatch(FORMA_DEL_TOKEN);
  });
});

describe("the link", () => {
  it("points at a page of the web application, with the token in the fragment, which no server ever receives", () => {
    expect(enlaceCon("https://www.osefi.net", TOKEN)).toBe(`https://www.osefi.net/baja-informe#t=${TOKEN}`);
  });

  it("takes the web's address from the first origin the server accepts, without a trailing slash", () => {
    expect(origenDeLaWeb({ CORS_ORIGIN: "https://www.osefi.net/, https://otra.osefi.net", NODE_ENV: "production" })).toBe("https://www.osefi.net");
    expect(origenDeLaWeb({ NODE_ENV: "production" })).toBeNull();
  });
});

describe("enlaceDeBaja", () => {
  it("creates the token the first time and writes it only where there is none", async () => {
    sinAlcance.findByPk.mockResolvedValue({ dataValues: { id: 9, email: "cliente@fuera.com", baja_token: null } });
    const enlace = await enlaceDeBaja(9);

    expect(enlace).toMatch(/^https:\/\/www\.osefi\.net\/baja-informe#t=[A-Za-z0-9_-]{43}$/);
    const [valores, opciones] = actualizar.mock.calls[0];
    expect(opciones).toEqual({ where: { id: 9, baja_token: null } });
    expect(enlace).toContain((valores as { baja_token: string }).baja_token);
  });

  it("gives the same link every time once the token exists, and writes nothing", async () => {
    sinAlcance.findByPk.mockResolvedValue({ dataValues: { id: 9, email: "cliente@fuera.com", baja_token: TOKEN } });
    expect(await enlaceDeBaja(9)).toBe(`https://www.osefi.net/baja-informe#t=${TOKEN}`);
    expect(await enlaceDeBaja(9)).toBe(`https://www.osefi.net/baja-informe#t=${TOKEN}`);
    expect(actualizar).not.toHaveBeenCalled();
  });

  it("uses the token another run wrote first, so two runs never mail two different links", async () => {
    sinAlcance.findByPk
      .mockResolvedValueOnce({ dataValues: { id: 9, email: "cliente@fuera.com", baja_token: null } })
      .mockResolvedValueOnce({ dataValues: { baja_token: TOKEN } });
    actualizar.mockResolvedValue([0] as never);
    expect(await enlaceDeBaja(9)).toBe(`https://www.osefi.net/baja-informe#t=${TOKEN}`);
  });

  it("gives an account no link: it has a login and somebody to ask", async () => {
    sinAlcance.findByPk.mockResolvedValue({ dataValues: { id: 9, email: null, baja_token: null } });
    expect(await enlaceDeBaja(9)).toBeNull();
    expect(actualizar).not.toHaveBeenCalled();
  });

  it("writes no link at all when the web's address is not known, and does not touch the database", async () => {
    vi.stubEnv("CORS_ORIGIN", "");
    expect(await enlaceDeBaja(9)).toBeNull();
    expect(sinAlcance.findByPk).not.toHaveBeenCalled();
  });
});

describe("consultarBaja", () => {
  it("says what the link would stop and who set it up — including a schedule since removed", async () => {
    sinAlcance.findOne.mockResolvedValue({ dataValues: { id: 9, id_programacion: 5, email: "c@fuera.com", baja_at: null } });
    programacionFindByPk.mockResolvedValue({ dataValues: { id_reporte: 3, id_usuario: 1 } } as never);
    informeFindByPk.mockResolvedValue({ dataValues: { name: "Informe semanal" } } as never);
    usuarioFindByPk.mockResolvedValue({ dataValues: { name: "Ana", lastname: "Pérez" } } as never);

    expect(await consultarBaja(TOKEN)).toEqual({ informe: "Informe semanal", programadoPor: "Ana Pérez", deBaja: false });
    expect(sinAlcance.findOne.mock.calls[0][0]).toMatchObject({ where: { baja_token: TOKEN } });
    for (const espia of [programacionFindByPk, informeFindByPk, usuarioFindByPk]) {
      expect(espia.mock.calls[0][1]).toMatchObject({ paranoid: false });
    }
  });

  it("says so when it was already used", async () => {
    sinAlcance.findOne.mockResolvedValue({ dataValues: { id: 9, id_programacion: 5, email: "c@fuera.com", baja_at: new Date() } });
    programacionFindByPk.mockResolvedValue(null as never);
    expect(await consultarBaja(TOKEN)).toEqual({ informe: null, programadoPor: null, deBaja: true });
  });

  it("never returns the address the token belongs to", async () => {
    sinAlcance.findOne.mockResolvedValue({ dataValues: { id: 9, id_programacion: 5, email: "secreto@fuera.com", baja_at: null } });
    programacionFindByPk.mockResolvedValue(null as never);
    expect(JSON.stringify(await consultarBaja(TOKEN))).not.toContain("secreto");
  });

  it("answers null for a token nobody holds, and does not even ask the database for one of the wrong shape", async () => {
    sinAlcance.findOne.mockResolvedValue(null);
    expect(await consultarBaja(TOKEN)).toBeNull();
    expect(sinAlcance.findOne).toHaveBeenCalledTimes(1);

    for (const malo of ["", "corto", "A".repeat(44), `${"A".repeat(42)}!`, 7, null, undefined, { token: TOKEN }]) {
      expect(await consultarBaja(malo as never), String(malo)).toBeNull();
    }
    expect(sinAlcance.findOne).toHaveBeenCalledTimes(1);
  });
});

describe("darDeBaja", () => {
  it("stamps the moment, only where it is not stamped yet", async () => {
    sinAlcance.findOne.mockResolvedValue({ dataValues: { id: 9, id_programacion: 5, email: "c@fuera.com", baja_at: null } });
    expect(await darDeBaja(TOKEN)).toBe(true);
    const [valores, opciones] = actualizar.mock.calls[0];
    expect((valores as { baja_at: Date }).baja_at).toBeInstanceOf(Date);
    expect(opciones).toEqual({ where: { id: 9, baja_at: null } });
  });

  it("is not an error the second time, and does not move the date", async () => {
    sinAlcance.findOne.mockResolvedValue({ dataValues: { id: 9, id_programacion: 5, email: "c@fuera.com", baja_at: new Date("2026-01-01") } });
    expect(await darDeBaja(TOKEN)).toBe(true);
    expect(actualizar).not.toHaveBeenCalled();
  });

  it("answers false for a token nobody holds, and writes nothing", async () => {
    sinAlcance.findOne.mockResolvedValue(null);
    expect(await darDeBaja(TOKEN)).toBe(false);
    expect(await darDeBaja("no-es-un-token")).toBe(false);
    expect(actualizar).not.toHaveBeenCalled();
  });
});

describe("what the scheduler is given", () => {
  it("is this link and not a placeholder", async () => {
    const { dependenciasDeInformes } = await import("./runtime.js");
    sinAlcance.findByPk.mockResolvedValue({ dataValues: { id: 9, email: "cliente@fuera.com", baja_token: TOKEN } });
    expect(await dependenciasDeInformes().enlaceDeBaja(9)).toBe(`https://www.osefi.net/baja-informe#t=${TOKEN}`);
  });
});
