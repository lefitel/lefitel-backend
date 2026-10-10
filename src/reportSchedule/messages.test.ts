// The words of a scheduled report's email. What matters here is what a
// stranger's text can do to them, and that each message says what it is.

import { describe, it, expect } from "vitest";
import {
  esc,
  mensajeConInforme,
  mensajeDeFalloAlDueno,
  mensajeDemasiadoGrande,
  mensajeVacio,
  type DatosDelMensaje,
} from "./messages.js";

const DATOS: DatosDelMensaje = {
  informe: "Eventos de la semana",
  programadoPor: "Ana Pérez",
  frecuencia: "semanal",
  externo: false,
};

describe("somebody else's text", () => {
  const HOSTIL = `<img src=x onerror=alert(1)> & "comillas" 'simples'`;

  it("is escaped everywhere it reaches the HTML part", () => {
    const m = mensajeConInforme(
      { ...DATOS, informe: HOSTIL, programadoPor: HOSTIL },
      { filas: 3, nombreDelFichero: `${HOSTIL}.xlsx` },
    );
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain('"comillas"');
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;comillas&quot; &#39;simples&#39;");
  });

  it("is left as it is in the plain-text part, which renders nothing", () => {
    const m = mensajeVacio({ ...DATOS, informe: HOSTIL });
    expect(m.texto).toContain(HOSTIL);
  });

  it("cannot break the subject into a second header line", () => {
    const m = mensajeVacio({ ...DATOS, informe: "Informe\r\nBcc: todos@fuera.com\tfin" });
    expect(m.asunto).not.toMatch(/[\r\n\t]/);
    expect(m.asunto).toContain("Informe Bcc: todos@fuera.com fin");
  });

  it("keeps the subject to a readable length", () => {
    const m = mensajeConInforme({ ...DATOS, informe: "x".repeat(400) }, { filas: 1, nombreDelFichero: "a.xlsx" });
    expect(m.asunto.length).toBeLessThanOrEqual(120);
    expect(m.asunto.endsWith("…")).toBe(true);
  });

  it("escapes the unsubscribe link as an attribute, and gives it whole in plain text", () => {
    const enlace = `https://www.osefi.net/baja/abc?x=1&y="2"`;
    const m = mensajeVacio({ ...DATOS, externo: true, enlaceDeBaja: enlace });
    expect(m.html).toContain('href="https://www.osefi.net/baja/abc?x=1&amp;y=&quot;2&quot;"');
    expect(m.texto).toContain(enlace);
  });

  it("escapes the ampersand first, so nothing is escaped twice", () => {
    expect(esc("a < b & c")).toBe("a &lt; b &amp; c");
  });
});

describe("what each message says", () => {
  it("names who scheduled it and how often, in every message to a recipient", () => {
    for (const m of [
      mensajeConInforme(DATOS, { filas: 2, nombreDelFichero: "a.xlsx" }),
      mensajeVacio(DATOS),
      mensajeDemasiadoGrande(DATOS, { filas: 9000 }),
    ]) {
      expect(m.texto).toMatch(/lo programó Ana Pérez en Osefi y se envía cada semana/);
      expect(m.html).toMatch(/lo programó Ana Pérez en Osefi y se envía cada semana/);
    }
    expect(mensajeVacio({ ...DATOS, frecuencia: "diaria" }).texto).toMatch(/cada día/);
    expect(mensajeVacio({ ...DATOS, frecuencia: "mensual" }).texto).toMatch(/cada mes/);
  });

  it("offers the way out only when it was given one", () => {
    expect(mensajeVacio(DATOS).texto).not.toMatch(/dejar de recibirlo/);
    expect(mensajeVacio(DATOS).html).not.toMatch(/dejar de recibirlo/);
    const conBaja = mensajeVacio({ ...DATOS, externo: true, enlaceDeBaja: "https://www.osefi.net/baja/t" });
    expect(conBaja.texto).toMatch(/dejar de recibirlo: https:\/\/www\.osefi\.net\/baja\/t/);
  });

  it("counts rows in the singular and the plural, and with the thousands separator", () => {
    expect(mensajeConInforme(DATOS, { filas: 1, nombreDelFichero: "a.xlsx" }).texto).toMatch(/con 1 fila\./);
    expect(mensajeConInforme(DATOS, { filas: 12500, nombreDelFichero: "a.xlsx" }).texto).toMatch(/con 12\.500 filas\./);
  });

  it("says the empty report is not a broken one", () => {
    const m = mensajeVacio(DATOS);
    expect(m.asunto).toMatch(/sin resultados/);
    expect(m.texto).toMatch(/El envío funcionó con normalidad/);
  });

  it("sends an account to the application for a file too large, and an outside address to the owner", () => {
    expect(mensajeDemasiadoGrande(DATOS, { filas: 9000 }).texto).toMatch(/Ábrelo en Osefi/);
    const fuera = mensajeDemasiadoGrande({ ...DATOS, externo: true }, { filas: 9000 }).texto;
    expect(fuera).toMatch(/Pídeselo a Ana Pérez/);
    expect(fuera).not.toMatch(/Ábrelo en Osefi/);
  });

  it("does not invent a row count it was not given", () => {
    const m = mensajeDemasiadoGrande(DATOS, { filas: null });
    expect(m.texto).not.toMatch(/filas?/);
    expect(m.texto).toMatch(/pesa más de lo que cabe en un correo/);
  });

  it("tells the owner whether a failure paused the schedule or will be retried", () => {
    const seguira = mensajeDeFalloAlDueno({ informe: "X", motivo: "se acabó el tiempo", pausada: false, fallosSeguidos: 1 });
    expect(seguira.texto).toMatch(/Motivo: se acabó el tiempo/);
    expect(seguira.texto).toMatch(/Se volverá a intentar/);
    const pausada = mensajeDeFalloAlDueno({ informe: "X", motivo: "m", pausada: true, fallosSeguidos: 3 });
    expect(pausada.texto).toMatch(/Ha fallado 3 veces seguidas.*queda en pausa/);
    expect(pausada.html).not.toContain("<script");
  });
});
