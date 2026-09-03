// `configuracionDeCorreo` — the mail chain read from the environment, plan
// 4E. Pure, so every case is a plain object in and a plain object out; the
// two things worth pinning hardest are that no secret ever appears in the
// result, and where the line between "degraded" and "refuse to boot" falls.

import { describe, it, expect } from "vitest";
import { configuracionDeCorreo, requiredEnv, MAIL_CUPOS_POR_DEFECTO, SMTP_CONOCIDOS } from "./security.js";

const COMPLETO = {
  MAIL_FROM: "osefi@osefi.net",
  MAIL_PROVIDERS: "resend,mailjet,smtp2go,mailtrap,elastic",
  RESEND_API_KEY: "re_secret",
  MAIL_RESEND_DAILY: "80",
  MAIL_SMTP_MAILJET_USER: "pub",
  MAIL_SMTP_MAILJET_PASS: "priv",
  MAIL_SMTP_MAILJET_DAILY: "180",
  MAIL_SMTP_SMTP2GO_USER: "u",
  MAIL_SMTP_SMTP2GO_PASS: "p",
  MAIL_SMTP_SMTP2GO_DAILY: "30",
  MAIL_SMTP_MAILTRAP_USER: "api",
  MAIL_SMTP_MAILTRAP_PASS: "tok",
  MAIL_SMTP_MAILTRAP_DAILY: "120",
  MAIL_SMTP_ELASTIC_USER: "cuenta@osefi.net",
  MAIL_SMTP_ELASTIC_PASS: "cred",
  MAIL_SMTP_ELASTIC_DAILY: "80",
};

describe("a complete chain", () => {
  it("builds the five in the order of MAIL_PROVIDERS, with hosts and headers from the table", () => {
    const c = configuracionDeCorreo(COMPLETO, "production");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.modo).toBe("envia");
    expect(c.from).toBe("osefi@osefi.net");
    expect(c.descartados).toEqual([]);
    expect(c.proveedores.map((p) => p.nombre)).toEqual(["resend", "mailjet", "smtp2go", "mailtrap", "elastic"]);
    expect(c.proveedores[0]).toEqual({ tipo: "resend", nombre: "resend", claveVar: "RESEND_API_KEY", cupoDiario: 80 });
    expect(c.proveedores[1]).toEqual({
      tipo: "smtp",
      nombre: "mailjet",
      host: "in-v3.mailjet.com",
      puerto: 587,
      usuarioVar: "MAIL_SMTP_MAILJET_USER",
      passVar: "MAIL_SMTP_MAILJET_PASS",
      cupoDiario: 180,
      cabeceras: { "X-Mailjet-TrackOpen": "0", "X-Mailjet-TrackClick": "0" },
    });
    expect(c.proveedores[4]).toMatchObject({ host: "smtp.elasticemail.com", cabeceras: { trackopens: "false", trackclicks: "false" } });
  });

  // 🔴 Names, never values: the whole object is written to the boot log.
  it("carries no secret anywhere in the result", () => {
    const texto = JSON.stringify(configuracionDeCorreo(COMPLETO, "production"));
    for (const secreto of ["re_secret", "priv", "tok", "cred"]) expect(texto).not.toContain(`"${secreto}"`);
    expect(texto).not.toContain('"pass"');
  });

  it("lets HOST and PORT override the table for a known provider", () => {
    const c = configuracionDeCorreo({ ...COMPLETO, MAIL_SMTP_MAILJET_HOST: "in.mailjet.com", MAIL_SMTP_MAILJET_PORT: "2525" }, "production");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.proveedores[1]).toMatchObject({ host: "in.mailjet.com", puerto: 2525 });
  });

  it("accepts a provider nobody wrote code for, given the five variables and no headers", () => {
    const c = configuracionDeCorreo(
      {
        MAIL_FROM: "osefi@osefi.net",
        MAIL_PROVIDERS: "otro",
        MAIL_SMTP_OTRO_HOST: "smtp.otro.com",
        MAIL_SMTP_OTRO_PORT: "587",
        MAIL_SMTP_OTRO_USER: "u",
        MAIL_SMTP_OTRO_PASS: "p",
        MAIL_SMTP_OTRO_DAILY: "50",
      },
      "production",
    );
    if (!c.ok) throw new Error("ok esperado");
    expect(c.proveedores).toEqual([
      { tipo: "smtp", nombre: "otro", host: "smtp.otro.com", puerto: 587, usuarioVar: "MAIL_SMTP_OTRO_USER", passVar: "MAIL_SMTP_OTRO_PASS", cupoDiario: 50, cabeceras: {} },
    ]);
  });
});

describe("a degraded chain — dropped, named, and the process boots", () => {
  it("drops a listed provider missing a variable and names the variable, never a value", () => {
    const { MAIL_SMTP_MAILJET_PASS: _omitida, ...sinPass } = COMPLETO;
    const c = configuracionDeCorreo(sinPass, "production");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.modo).toBe("envia");
    expect(c.proveedores.map((p) => p.nombre)).toEqual(["resend", "smtp2go", "mailtrap", "elastic"]);
    expect(c.descartados).toEqual([{ nombre: "mailjet", motivo: "faltan: MAIL_SMTP_MAILJET_PASS" }]);
  });

  it("names every missing variable of a provider at once", () => {
    const c = configuracionDeCorreo({ MAIL_FROM: "o@o.net", MAIL_PROVIDERS: "resend,otro", RESEND_API_KEY: "k", MAIL_RESEND_DAILY: "80" }, "production");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.descartados[0].nombre).toBe("otro");
    for (const v of ["MAIL_SMTP_OTRO_HOST", "MAIL_SMTP_OTRO_PORT", "MAIL_SMTP_OTRO_USER", "MAIL_SMTP_OTRO_PASS", "MAIL_SMTP_OTRO_DAILY"]) {
      expect(c.descartados[0].motivo).toContain(v);
    }
  });

  it("drops resend without its key, and a provider with a malformed port or ceiling", () => {
    const c = configuracionDeCorreo(
      { ...COMPLETO, RESEND_API_KEY: "", MAIL_SMTP_MAILJET_PORT: "puerto", MAIL_SMTP_ELASTIC_DAILY: "-3" },
      "production",
    );
    if (!c.ok) throw new Error("ok esperado");
    expect(c.proveedores.map((p) => p.nombre)).toEqual(["smtp2go", "mailtrap"]);
    expect(c.descartados.map((d) => d.nombre)).toEqual(["resend", "mailjet", "elastic"]);
    expect(c.descartados[0].motivo).toContain("RESEND_API_KEY");
    expect(c.descartados[1].motivo).toContain("MAIL_SMTP_MAILJET_PORT");
    expect(c.descartados[2].motivo).toContain("MAIL_SMTP_ELASTIC_DAILY");
  });

  it("drops a repeated name rather than counting a provider twice", () => {
    const c = configuracionDeCorreo({ ...COMPLETO, MAIL_PROVIDERS: "resend,resend" }, "production");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.proveedores).toHaveLength(1);
    expect(c.descartados).toEqual([{ nombre: "resend", motivo: "repetido en MAIL_PROVIDERS" }]);
  });

  it("reads the names case-insensitively and ignores spaces around the commas", () => {
    const c = configuracionDeCorreo({ ...COMPLETO, MAIL_PROVIDERS: " Resend , MAILJET " }, "production");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.proveedores.map((p) => p.nombre)).toEqual(["resend", "mailjet"]);
    expect(c.descartados).toEqual([]);
  });

  it("drops a provider whose port is out of range", () => {
    const c = configuracionDeCorreo({ ...COMPLETO, MAIL_SMTP_MAILJET_PORT: "70000" }, "production");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.proveedores.map((p) => p.nombre)).not.toContain("mailjet");
    expect(c.descartados[0]).toMatchObject({ nombre: "mailjet" });
    expect(c.descartados[0].motivo).toContain("MAIL_SMTP_MAILJET_PORT");
  });

  it("requires the daily ceiling in production — a promise to the provider is typed, not defaulted", () => {
    const { MAIL_RESEND_DAILY: _omitida, ...sinCupo } = COMPLETO;
    const c = configuracionDeCorreo(sinCupo, "production");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.descartados).toEqual([{ nombre: "resend", motivo: "faltan: MAIL_RESEND_DAILY (entero mayor que 0)" }]);
  });
});

describe("refusing to boot — only an empty chain in production", () => {
  it("is ok:false when every listed provider was dropped, listing why", () => {
    const c = configuracionDeCorreo({ MAIL_FROM: "o@o.net", MAIL_PROVIDERS: "resend,mailjet" }, "production");
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.errores).toHaveLength(2);
    expect(c.errores[0]).toContain('MAIL_PROVIDERS lista "resend"');
    expect(c.errores[0]).toContain("RESEND_API_KEY");
  });

  it("is ok:false without MAIL_PROVIDERS or without MAIL_FROM in production", () => {
    expect(configuracionDeCorreo({ MAIL_FROM: "o@o.net" }, "production")).toMatchObject({ ok: false });
    expect(configuracionDeCorreo({ MAIL_PROVIDERS: "resend", RESEND_API_KEY: "k", MAIL_RESEND_DAILY: "1" }, "production")).toMatchObject({
      ok: false,
      errores: ["MAIL_FROM no está configurada"],
    });
  });

  it("requiredEnv names MAIL_PROVIDERS and MAIL_FROM in production, and not RESEND_API_KEY", () => {
    const exigidas = requiredEnv("production");
    expect(exigidas).toContain("MAIL_PROVIDERS");
    expect(exigidas).toContain("MAIL_FROM");
    expect(exigidas).not.toContain("RESEND_API_KEY");
  });
});

describe("outside production", () => {
  it("is development mode with nothing configured, and never ok:false", () => {
    expect(configuracionDeCorreo({}, "development")).toEqual({ ok: true, modo: "desarrollo", from: null, proveedores: [], descartados: [] });
    expect(configuracionDeCorreo({}, undefined)).toMatchObject({ ok: true, modo: "desarrollo" });
  });

  it("assumes resend, with a note, when only the old pair of variables is present — the .env this repo shipped with", () => {
    const c = configuracionDeCorreo({ RESEND_API_KEY: "k", MAIL_FROM: "o@o.net" }, "development");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.modo).toBe("envia");
    expect(c.proveedores).toEqual([{ tipo: "resend", nombre: "resend", claveVar: "RESEND_API_KEY", cupoDiario: MAIL_CUPOS_POR_DEFECTO.resend }]);
    expect(c.descartados[0]).toMatchObject({ nombre: "MAIL_PROVIDERS" });
  });

  it("defaults the daily ceilings for the known providers", () => {
    const { MAIL_RESEND_DAILY: _a, MAIL_SMTP_MAILJET_DAILY: _b, ...sinCupos } = COMPLETO;
    const c = configuracionDeCorreo(sinCupos, "development");
    if (!c.ok) throw new Error("ok esperado");
    expect(c.proveedores[0].cupoDiario).toBe(MAIL_CUPOS_POR_DEFECTO.resend);
    expect(c.proveedores[1].cupoDiario).toBe(MAIL_CUPOS_POR_DEFECTO.mailjet);
  });

  it("drops an incomplete provider with a note and stays ok, even when nothing is left", () => {
    const c = configuracionDeCorreo({ MAIL_FROM: "o@o.net", MAIL_PROVIDERS: "mailjet" }, "development");
    expect(c).toMatchObject({ ok: true, modo: "desarrollo", proveedores: [] });
    if (c.ok) expect(c.descartados[0].nombre).toBe("mailjet");
  });
});

describe("the table of known providers", () => {
  it("names the four SMTP providers the design chose, all on 587", () => {
    expect(Object.keys(SMTP_CONOCIDOS).sort()).toEqual(["elastic", "mailjet", "mailtrap", "smtp2go"]);
    for (const p of Object.values(SMTP_CONOCIDOS)) expect(p.puerto).toBe(587);
  });

  it("turns tracking off by header for the two providers that have one", () => {
    expect(SMTP_CONOCIDOS.mailjet.cabeceras).toEqual({ "X-Mailjet-TrackOpen": "0", "X-Mailjet-TrackClick": "0" });
    expect(SMTP_CONOCIDOS.elastic.cabeceras).toEqual({ trackopens: "false", trackclicks: "false" });
  });
});
