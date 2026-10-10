// How every email of the application looks — pure, so it is tested without
// sending anything.
//
// One frame for all of them: the name over a blue rule, a title, the body as
// plain lines, and the small print under a hairline. Isaias chose it on
// 2026-10-10 from a mock-up of the scheduled report's message and asked for
// the same on the rest. No card, no background, no image: a message that reads
// as written by a person is the one that lands in the inbox and not under
// "Promociones", and with nothing painting a background a dark mailbox
// recolours the text over its own.
//
// **Everything that goes in is text, and is escaped here.** A caller hands
// over strings and says which part is bold or a link; it never hands over
// HTML. Before this module each message built its own `<p>` by hand and
// several interpolated an account name or a masked address straight into it.
//
// Inline styles and nothing else: a mail client throws away a <style> block as
// often as not. The hex values are `--primary-fill`, `--foreground` and
// `--muted-foreground` of the light theme in `web/src/index.css`, converted
// because no mail client reads `oklch()`.

export function esc(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FUENTE = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const AZUL = "#205595";
const TINTA = "#080e15";
const TEXTO = "#3a4350";
const APAGADO = "#5d6774";
const RAYA = "#e4e8ee";

const ESTILO = {
  marco: `max-width:520px;font-family:${FUENTE};font-size:15px;line-height:1.55;color:${TEXTO}`,
  marca: `font-weight:700;font-size:14px;letter-spacing:.02em;color:${AZUL};padding-bottom:12px;border-bottom:2px solid ${AZUL};margin-bottom:20px`,
  titulo: `margin:0 0 10px;font-size:20px;line-height:1.25;font-weight:700;color:${TINTA}`,
  parrafo: "margin:0 0 12px;font-size:14px",
  dato: "margin:0 0 4px;font-size:14px",
  fuerte: `font-weight:600;color:${TINTA}`,
  codigo: `margin:4px 0 16px;font-size:30px;line-height:1.2;font-weight:700;letter-spacing:.22em;color:${TINTA};font-family:Consolas,Menlo,'Courier New',monospace`,
  boton: `display:inline-block;padding:10px 18px;border-radius:8px;background-color:${AZUL};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none`,
  cajaDelBoton: "margin:6px 0 18px",
  pie: `margin-top:22px;padding-top:14px;border-top:1px solid ${RAYA};font-size:12px;line-height:1.5;color:${APAGADO}`,
  enlace: `color:${AZUL}`,
};

// The style attributes are in double quotes and the font stacks carry single
// ones, so a style goes through `esc` like any other attribute.
const con = (estilo: string) => `style="${esc(estilo)}"`;

/** A piece of a line: plain, bold, or a link. */
export type Trozo = string | { fuerte: string } | { enlace: string; href: string };
/** A line of text, in one piece or several. */
export type Linea = Trozo | Trozo[];

/**
 * One thing in the body of a message.
 *
 * - `parrafo` — a paragraph, with air under it.
 * - `dato` — a fact, set tight against the next one: "IP: …", "Fecha: …".
 * - `codigo` — a one-time code, large and spaced so it can be read off a phone.
 * - `boton` — the one thing the message asks the reader to do.
 */
export type Bloque =
  | { parrafo: Linea }
  | { dato: Linea }
  | { codigo: string }
  | { boton: string; href: string };

export interface Correo {
  titulo: string;
  bloques: Bloque[];
  /** The small print, one entry per line. Left out of a message that has none. */
  pie?: Linea[];
}

const trozos = (l: Linea): Trozo[] => (Array.isArray(l) ? l : [l]);

function lineaEnHtml(l: Linea): string {
  return trozos(l)
    .map((t) => {
      if (typeof t === "string") return esc(t);
      if ("fuerte" in t) return `<span ${con(ESTILO.fuerte)}>${esc(t.fuerte)}</span>`;
      return `<a href="${esc(t.href)}" ${con(ESTILO.enlace)}>${esc(t.enlace)}</a>`;
    })
    .join("");
}

/** A line as the plain-text part writes it. A link becomes its words and its address. */
export function lineaEnTexto(l: Linea): string {
  return trozos(l)
    .map((t) => (typeof t === "string" ? t : "fuerte" in t ? t.fuerte : `${t.enlace}: ${t.href}`))
    .join("");
}

function bloqueEnHtml(b: Bloque): string {
  if ("parrafo" in b) return `<p ${con(ESTILO.parrafo)}>${lineaEnHtml(b.parrafo)}</p>`;
  if ("dato" in b) return `<p ${con(ESTILO.dato)}>${lineaEnHtml(b.dato)}</p>`;
  if ("codigo" in b) return `<p ${con(ESTILO.codigo)}>${esc(b.codigo)}</p>`;
  return `<p ${con(ESTILO.cajaDelBoton)}><a href="${esc(b.href)}" ${con(ESTILO.boton)}>${esc(b.boton)}</a></p>`;
}

/** The HTML part of a message, in the application's frame. */
export function vestirCorreo(c: Correo): string {
  return [
    `<div ${con(ESTILO.marco)}>`,
    `<div ${con(ESTILO.marca)}>Osefi</div>`,
    `<p ${con(ESTILO.titulo)}>${esc(c.titulo)}</p>`,
    ...c.bloques.map(bloqueEnHtml),
    ...(c.pie && c.pie.length > 0 ? [`<div ${con(ESTILO.pie)}>${c.pie.map(lineaEnHtml).join("<br>")}</div>`] : []),
    "</div>",
  ].join("\n");
}

/**
 * The plain-text part of the same message: the blocks one under another, facts
 * kept together, and a button written as its words over its address.
 */
export function correoEnTexto(c: Correo): string {
  const partes: string[] = [];
  let datos: string[] = [];
  const cerrarDatos = () => {
    if (datos.length > 0) partes.push(datos.join("\n"));
    datos = [];
  };
  for (const b of c.bloques) {
    if ("dato" in b) {
      datos.push(lineaEnTexto(b.dato));
      continue;
    }
    cerrarDatos();
    if ("parrafo" in b) partes.push(lineaEnTexto(b.parrafo));
    else if ("codigo" in b) partes.push(b.codigo);
    else partes.push(`${b.boton}:\n${b.href}`);
  }
  cerrarDatos();
  if (c.pie) partes.push(...c.pie.map(lineaEnTexto));
  return partes.join("\n\n");
}
