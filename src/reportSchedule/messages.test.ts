// The words of a scheduled report's email. What matters here is what a
// stranger's text can do to them, and that each message says what it is.

import { describe, it, expect } from "vitest";
import {
  cadaCuanto,
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
  horario: { frecuencia: "semanal", dia_semana: 6, dia_mes: null, hora: 7, minuto: 0 },
  externo: false,
};

/** What the run knows about a file it attaches. */
const fichero = (filas: number, nombreDelFichero = "a.xlsx") => ({
  filas,
  nombreDelFichero,
  bytes: 217_000,
  formato: "excel",
  // 06:24 in La Paz.
  generado: new Date("2026-10-10T10:24:31Z"),
});

describe("somebody else's text", () => {
  const HOSTIL = `<img src=x onerror=alert(1)> & "comillas" 'simples'`;

  it("is escaped everywhere it reaches the HTML part", () => {
    const m = mensajeConInforme(
      { ...DATOS, informe: HOSTIL, programadoPor: HOSTIL },
      fichero(3, `${HOSTIL}.xlsx`),
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
    const m = mensajeConInforme({ ...DATOS, informe: "x".repeat(400) }, fichero(1));
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
      mensajeConInforme(DATOS, fichero(2)),
      mensajeVacio(DATOS),
      mensajeDemasiadoGrande(DATOS, { filas: 9000 }),
    ]) {
      expect(m.texto).toMatch(/lo programó Ana Pérez en Osefi y se envía cada semana/);
      expect(m.html).toMatch(/lo programó Ana Pérez en Osefi y se envía cada semana/);
    }
  });

  it("says when, to the minute, in the words of each frequency", () => {
    expect(cadaCuanto(DATOS.horario)).toBe("cada semana, los sábados a las 07:00");
    expect(cadaCuanto({ frecuencia: "semanal", dia_semana: 1, hora: 7, minuto: 20 })).toBe("cada semana, los lunes a las 07:20");
    expect(cadaCuanto({ frecuencia: "semanal", dia_semana: 7, hora: 18 })).toBe("cada semana, los domingos a las 18:00");
    expect(cadaCuanto({ frecuencia: "diaria", hora: 6, minuto: 5 })).toBe("cada día a las 06:05");
    expect(cadaCuanto({ frecuencia: "mensual", dia_mes: 1, hora: 8 })).toBe("cada mes, el día 1 a las 08:00");
    expect(mensajeVacio(DATOS).texto).toContain("se envía cada semana, los sábados a las 07:00.");
  });

  it("says what the attached file is: format, weight, and when it was built in Bolivia's time", () => {
    const m = mensajeConInforme(DATOS, fichero(438, "Eventos_10-10-2026.xlsx"));
    expect(m.texto).toContain("Excel · 212 KB · generado el 10/10/2026 a las 06:24");
    expect(m.texto).toContain("Fichero: Eventos_10-10-2026.xlsx");
    expect(m.html).toContain("generado el 10/10/2026 a las 06:24");
    const pesado = mensajeConInforme(DATOS, { ...fichero(9), bytes: 3_400_000, formato: "pdf" });
    expect(pesado.texto).toContain("PDF · 3,2 MB");
  });

  it("wears the same frame in every message: the name, the report as a title, and no image or script", () => {
    for (const m of [
      mensajeConInforme(DATOS, fichero(2)),
      mensajeVacio(DATOS),
      mensajeDemasiadoGrande(DATOS, { filas: 9000 }),
      mensajeDeFalloAlDueno({ informe: "Eventos de la semana", motivo: "m", pausada: false, fallosSeguidos: 1 }),
    ]) {
      expect(m.html).toMatch(/^<div style="[^"]*">\n<div style="[^"]*">Osefi<\/div>\n<p style="[^"]*">Eventos de la semana<\/p>/);
      expect(m.html.endsWith("</div>")).toBe(true);
      expect(m.html).not.toMatch(/<img|<script|<style|background/);
      // A double quote inside a style would end the attribute early.
      for (const [, estilo] of m.html.matchAll(/style="([^"]*)"/g)) expect(estilo).not.toMatch(/[<>]/);
    }
  });

  it("gives the owner's failure notice no small print", () => {
    const m = mensajeDeFalloAlDueno({ informe: "X", motivo: "m", pausada: false, fallosSeguidos: 1 });
    expect(m.texto).not.toMatch(/lo programó/);
  });

  it("offers the way out only when it was given one", () => {
    expect(mensajeVacio(DATOS).texto).not.toMatch(/dejar de recibirlo/);
    expect(mensajeVacio(DATOS).html).not.toMatch(/dejar de recibirlo/);
    const conBaja = mensajeVacio({ ...DATOS, externo: true, enlaceDeBaja: "https://www.osefi.net/baja/t" });
    expect(conBaja.texto).toMatch(/dejar de recibirlo: https:\/\/www\.osefi\.net\/baja\/t/);
  });

  it("counts rows in the singular and the plural, and with the thousands separator", () => {
    expect(mensajeConInforme(DATOS, fichero(1)).texto).toMatch(/con 1 fila\./);
    expect(mensajeConInforme(DATOS, fichero(12500)).texto).toMatch(/con 12\.500 filas\./);
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
