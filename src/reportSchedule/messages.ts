// The words of a scheduled report's email — pure, so they can be read and
// tested without sending anything. Design §3.7.
//
// **Everything interpolated is somebody's text.** A report's name is typed by
// a user and so is the owner's; both go through `esc` before they touch HTML,
// and the subject loses its line breaks. The plain-text part takes them as
// they are.
//
// **Every message says who scheduled it.** A file that arrives every Monday
// from "no-reply" with nobody's name on it is how a recipient ends up pressing
// "spam" — on the same domain the login codes leave from. An outside address
// also gets a link that stops the messages with one click.

import type { Frecuencia } from "./nextRun.js";

export interface DatosDelMensaje {
  /** The saved report's name, as its owner typed it. */
  informe: string;
  /** Who scheduled it, as a name a recipient would recognise. */
  programadoPor: string;
  frecuencia: Frecuencia;
  /** Only for outside addresses: stops the messages, no login needed. */
  enlaceDeBaja?: string | null;
  /** True when the recipient has no account to open the report in. */
  externo: boolean;
}

export interface Mensaje {
  asunto: string;
  html: string;
  texto: string;
}

export function esc(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A subject is one line. Control characters go, and it stops at a readable length. */
function unaLinea(texto: string): string {
  // eslint-disable-next-line no-control-regex
  const limpio = texto.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return limpio.length > 120 ? `${limpio.slice(0, 117)}…` : limpio;
}

const CADA: Record<Frecuencia, string> = {
  diaria: "cada día",
  semanal: "cada semana",
  mensual: "cada mes",
};

function armar(d: DatosDelMensaje, asunto: string, parrafos: string[]): Mensaje {
  const pie = `Este informe lo programó ${d.programadoPor} en Osefi y se envía ${CADA[d.frecuencia]}.`;
  const baja = d.enlaceDeBaja ? `Para dejar de recibirlo: ${d.enlaceDeBaja}` : null;
  const lineas = [...parrafos, pie, ...(baja ? [baja] : [])];

  const htmlPie = `<p style="color:#666;font-size:12px">${esc(pie)}${
    d.enlaceDeBaja
      ? `<br>Para dejar de recibirlo, <a href="${esc(d.enlaceDeBaja)}">pulsa aquí</a>.`
      : ""
  }</p>`;

  return {
    asunto: unaLinea(asunto),
    html: [...parrafos.map((p) => `<p>${esc(p)}</p>`), htmlPie].join("\n"),
    texto: lineas.join("\n\n"),
  };
}

const filas = (n: number) => `${n.toLocaleString("es-BO")} ${n === 1 ? "fila" : "filas"}`;

/** The report, attached. */
export function mensajeConInforme(d: DatosDelMensaje, datos: { filas: number; nombreDelFichero: string }): Mensaje {
  return armar(d, `${d.informe} — Osefi`, [
    `Adjunto va el informe «${d.informe}», con ${filas(datos.filas)}.`,
    `Fichero: ${datos.nombreDelFichero}`,
  ]);
}

/** The report had no rows. Sent so that silence never has to be interpreted. */
export function mensajeVacio(d: DatosDelMensaje): Mensaje {
  return armar(d, `${d.informe}: sin resultados — Osefi`, [
    `El informe «${d.informe}» no tiene resultados en este periodo.`,
    "No se adjunta ningún fichero porque no hay nada que mostrar. El envío funcionó con normalidad.",
  ]);
}

/** The file was over what a message can carry. */
export function mensajeDemasiadoGrande(d: DatosDelMensaje, datos: { filas: number | null }): Mensaje {
  return armar(d, `${d.informe}: demasiado grande para adjuntarlo — Osefi`, [
    // The count is unknown when the file was weighed and refused after it was
    // built: that refusal carries bytes, not rows.
    datos.filas === null
      ? `El fichero del informe «${d.informe}» pesa más de lo que cabe en un correo.`
      : `El informe «${d.informe}» tiene ${filas(datos.filas)} y su fichero pesa más de lo que cabe en un correo.`,
    d.externo
      ? `Pídeselo a ${d.programadoPor}, que puede descargarlo desde la aplicación.`
      : "Ábrelo en Osefi, en el generador de reportes, y descárgalo desde ahí.",
  ]);
}

/** To the owner: a run could not be generated or delivered. */
export function mensajeDeFalloAlDueno(datos: {
  informe: string;
  motivo: string;
  pausada: boolean;
  fallosSeguidos: number;
}): Mensaje {
  const parrafos = [
    `El informe programado «${datos.informe}» no se pudo enviar.`,
    `Motivo: ${datos.motivo}`,
    datos.pausada
      ? `Ha fallado ${datos.fallosSeguidos} veces seguidas, así que el envío queda en pausa. Revísalo en el generador de reportes y vuelve a activarlo cuando esté resuelto.`
      : "Se volverá a intentar en el próximo envío previsto. No hace falta que hagas nada.",
  ];
  return {
    asunto: unaLinea(`${datos.informe}: no se pudo enviar — Osefi`),
    html: parrafos.map((p) => `<p>${esc(p)}</p>`).join("\n"),
    texto: parrafos.join("\n\n"),
  };
}
