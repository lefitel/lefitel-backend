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
//
// **How it looks** is `auth/mailLook.ts`, the frame every email of the
// application wears. No "open in Osefi" button here, by Isaias's choice on
// 2026-10-10 ("por ahora"); the generator opens a saved report from
// `/app/generador?vista=ID` the day one is wanted.

import { correoEnTexto, esc, vestirCorreo, type Bloque, type Linea } from "../auth/mailLook.js";
import type { Frecuencia, Horario } from "./nextRun.js";

export { esc };

export interface DatosDelMensaje {
  /** The saved report's name, as its owner typed it. */
  informe: string;
  /** Who scheduled it, as a name a recipient would recognise. */
  programadoPor: string;
  /** When it is sent, said in the small print of every message. */
  horario: Horario;
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

/** ISO weekdays, Monday first, as "los lunes" reads. */
const LOS_DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];

const dosCifras = (n: number) => String(n).padStart(2, "0");

/** "cada día a las 07:00" · "cada semana, los sábados a las 07:20" · "cada mes, el día 1 a las 08:00". */
export function cadaCuanto(h: Horario): string {
  const hora = `a las ${dosCifras(h.hora)}:${dosCifras(h.minuto ?? 0)}`;
  if (h.frecuencia === "semanal" && typeof h.dia_semana === "number") {
    return `${CADA.semanal}, los ${LOS_DIAS[h.dia_semana - 1]} ${hora}`;
  }
  if (h.frecuencia === "mensual" && typeof h.dia_mes === "number") return `${CADA.mensual}, el día ${h.dia_mes} ${hora}`;
  return `${CADA[h.frecuencia]} ${hora}`;
}

interface Cuerpo {
  titulo: string;
  parrafos: string[];
  datos?: Linea[];
  /** The small print. Left out of a message that has none. */
  pie?: string | null;
  enlaceDeBaja?: string | null;
}

function vestir(asunto: string, c: Cuerpo): Mensaje {
  const bloques: Bloque[] = [
    ...c.parrafos.map((parrafo) => ({ parrafo })),
    ...(c.datos ?? []).map((dato) => ({ dato })),
  ];
  const pie = c.pie ? [c.pie] : [];
  return {
    asunto: unaLinea(asunto),
    html: vestirCorreo({
      titulo: c.titulo,
      bloques,
      pie: [
        ...pie,
        ...(c.enlaceDeBaja
          ? [["Si no quieres seguir recibiéndolo, puedes ", { enlace: "dejar de recibirlo", href: c.enlaceDeBaja }, "."]]
          : []),
      ],
    }),
    // The link is written out its own way here: an address on a line of its
    // own is what a plain-text reader can click.
    texto: [
      correoEnTexto({ titulo: c.titulo, bloques, pie }),
      ...(c.enlaceDeBaja ? [`Para dejar de recibirlo: ${c.enlaceDeBaja}`] : []),
    ].join("\n\n"),
  };
}

function armar(d: DatosDelMensaje, asunto: string, parrafos: string[], datos: Linea[] = []): Mensaje {
  return vestir(asunto, {
    titulo: d.informe,
    parrafos,
    datos,
    pie: `Este informe lo programó ${d.programadoPor} en Osefi y se envía ${cadaCuanto(d.horario)}.`,
    enlaceDeBaja: d.enlaceDeBaja,
  });
}

const filas = (n: number) => `${n.toLocaleString("es-BO")} ${n === 1 ? "fila" : "filas"}`;

const peso = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toLocaleString("es-BO", { maximumFractionDigits: 1 })} MB`;

const FORMATO: Record<string, string> = { excel: "Excel", pdf: "PDF" };

/** "10/10/2026 a las 06:24", on the wall clock of the report's zone. */
function cuando(instante: Date): string {
  const partes = new Intl.DateTimeFormat("es-BO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "America/La_Paz",
  }).formatToParts(instante);
  const de = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${de("day")}/${de("month")}/${de("year")} a las ${de("hour")}:${de("minute")}`;
}

/** The report, attached. */
export function mensajeConInforme(
  d: DatosDelMensaje,
  datos: { filas: number; nombreDelFichero: string; bytes: number; formato: string; generado: Date },
): Mensaje {
  return armar(
    d,
    `${d.informe} — Osefi`,
    [`Va adjunto el informe «${d.informe}», con ${filas(datos.filas)}.`],
    [
      [{ fuerte: FORMATO[datos.formato] ?? datos.formato }, ` · ${peso(datos.bytes)} · generado el ${cuando(datos.generado)}`],
      `Fichero: ${datos.nombreDelFichero}`,
    ],
  );
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
  // No small print: the owner needs no telling who scheduled it.
  return vestir(`${datos.informe}: no se pudo enviar — Osefi`, { titulo: datos.informe, parrafos });
}
