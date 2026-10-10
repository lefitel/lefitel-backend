// The frame every email wears. What matters: nothing a caller hands over can
// become markup, the two parts of a message say the same thing, and the frame
// stays the plain one that was chosen.

import { describe, it, expect } from "vitest";
import { correoEnTexto, esc, lineaEnTexto, vestirCorreo, type Correo } from "./mailLook.js";

const HOSTIL = `<img src=x onerror=alert(1)> & "comillas" 'simples'`;
const ESCAPADO = "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;comillas&quot; &#39;simples&#39;";

const CORREO: Correo = {
  titulo: "Contraseña restablecida",
  bloques: [
    { parrafo: ["La cuenta ", { fuerte: "@ana" }, " cambió su contraseña."] },
    { dato: "IP: 10.0.0.1" },
    { dato: "Fecha: hoy" },
    { codigo: "123456" },
    { boton: "Elegir una contraseña nueva", href: "https://www.osefi.net/nueva-contrasena#t=abc" },
  ],
  pie: ["Aviso de seguridad.", ["Puedes ", { enlace: "dejar de recibirlo", href: "https://www.osefi.net/baja#t=x" }, "."]],
};

describe("the frame", () => {
  it("is the name, then the title, then the body, and closes what it opens", () => {
    const html = vestirCorreo(CORREO);
    expect(html).toMatch(/^<div style="[^"]*">\n<div style="[^"]*">Osefi<\/div>\n<p style="[^"]*">Contraseña restablecida<\/p>/);
    expect(html.endsWith("</div>")).toBe(true);
    expect(html.match(/<div/g)).toHaveLength(html.match(/<\/div>/g)?.length ?? -1);
    expect(html.match(/<p /g)).toHaveLength(html.match(/<\/p>/g)?.length ?? -1);
  });

  it("carries no image, no script, no style block and paints no page background", () => {
    const html = vestirCorreo(CORREO);
    expect(html).not.toMatch(/<img|<script|<style|<table/);
    // The button is the one thing with a fill; nothing else has one.
    expect(html.match(/background/g)).toHaveLength(1);
  });

  it("keeps every style inside its attribute: no raw quote ends one early", () => {
    for (const [, estilo] of vestirCorreo(CORREO).matchAll(/style="([^"]*)"/g)) {
      expect(estilo).not.toMatch(/[<>]/);
      expect(estilo.length).toBeGreaterThan(5);
    }
  });

  it("leaves the small print out altogether when there is none", () => {
    const sin = vestirCorreo({ titulo: "T", bloques: [{ parrafo: "p" }] });
    expect(sin.match(/<div/g)).toHaveLength(2);
    expect(vestirCorreo({ titulo: "T", bloques: [], pie: [] }).match(/<div/g)).toHaveLength(2);
  });
});

describe("somebody else's text", () => {
  it("is escaped wherever it lands: title, paragraph, bold, fact, code, button, small print", () => {
    const html = vestirCorreo({
      titulo: HOSTIL,
      bloques: [
        { parrafo: [HOSTIL, { fuerte: HOSTIL }] },
        { dato: HOSTIL },
        { codigo: HOSTIL },
        { boton: HOSTIL, href: "https://www.osefi.net/" },
      ],
      pie: [HOSTIL, [{ enlace: HOSTIL, href: "https://www.osefi.net/" }]],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain('"comillas"');
    // Eight places, so nine pieces.
    expect(html.split(ESCAPADO)).toHaveLength(9);
  });

  it("cannot break out of a link's address", () => {
    const href = `https://www.osefi.net/x?a=1&b="2"><script>`;
    const html = vestirCorreo({ titulo: "T", bloques: [{ boton: "Abrir", href }], pie: [[{ enlace: "aquí", href }]] });
    expect(html).not.toContain("<script>");
    expect(html.split('href="https://www.osefi.net/x?a=1&amp;b=&quot;2&quot;&gt;&lt;script&gt;"')).toHaveLength(3);
  });

  it("escapes the ampersand first, so nothing is escaped twice", () => {
    expect(esc("a < b & c")).toBe("a &lt; b &amp; c");
  });
});

describe("the plain-text part", () => {
  it("says what the HTML says, with facts kept together and a link written out", () => {
    expect(correoEnTexto(CORREO)).toBe(
      [
        "La cuenta @ana cambió su contraseña.",
        "IP: 10.0.0.1\nFecha: hoy",
        "123456",
        "Elegir una contraseña nueva:\nhttps://www.osefi.net/nueva-contrasena#t=abc",
        "Aviso de seguridad.",
        "Puedes dejar de recibirlo: https://www.osefi.net/baja#t=x.",
      ].join("\n\n"),
    );
  });

  it("takes text as it is: nothing is rendered there, so nothing is escaped", () => {
    expect(lineaEnTexto([HOSTIL, { fuerte: HOSTIL }])).toBe(HOSTIL + HOSTIL);
    expect(correoEnTexto({ titulo: "T", bloques: [{ parrafo: HOSTIL }] })).toBe(HOSTIL);
  });
});
