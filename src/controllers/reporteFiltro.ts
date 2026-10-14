import type { Request } from "express";

// Reading the six fixed reports' filter, once, instead of six times badly.
//
// Every one of them took the same five values out of `req.body` and checked at
// most that two of them were present. What that missed:
//
//   - **`new Date("cualquier cosa")` is `Invalid Date`**, not an error. It went
//     straight into an `Op.between`, Sequelize serialised it as the literal text
//     `'Invalid date'`, Postgres refused the statement, and the caller got the
//     neutral 500 that §3.5 reserves for faults nobody expected. A date typed
//     wrong is not a fault: it is an answer the person can fix, and they cannot
//     fix it if nothing tells them.
//   - **`excludeOld` stops being a boolean the moment the filter travels in the
//     URL**, which is what task C1 does. In a JSON body it was `true`/`false`;
//     as a query parameter it is the *string* `"true"` or `"false"`, and
//     `if (excludeOld)` is true for both. The switch labelled "excluir
//     arrastradas" would have started ignoring its own off position — silently,
//     with a plausible report on screen.
//   - **A repeated parameter arrives as an array**, and the first version of
//     this file read one as "not sent". `?tramo=1&tramo=2` then meant
//     *no stretch at all*, so the report covered every pole in the network while
//     the URL named two of them. Its own audit found that, and the file had
//     a comment promising exactly the opposite.
//
// So there are three answers this file tells apart, and the middle one is the
// whole point: **not sent**, **sent and unreadable**, and **a value**. Collapsing
// the first two is what turns a wrong filter into a wider report instead of a
// refusal — and a wider report is the only failure here that nobody reports.

/** A value nobody sent. Some are optional, so this is not always an error. */
const AUSENTE = Symbol("ausente");
/** A value that was sent and cannot be read: an array, an empty field, a shape. */
const ILEGIBLE = Symbol("ilegible");

/** The four values the six reports filter by, parsed. */
export interface FiltroReporte {
  fechaInicial: Date;
  fechaFinal: Date;
  excludeOld: boolean;
  /** The stretch of line the report is narrowed to, or null when it names none. */
  tramo: number | null;
}

/**
 * Either a filter, or the sentence to answer with — and the sentence is a bare
 * `string` rather than an `{ ok: false }` arm.
 *
 * A discriminated union reads better and this compiler does not narrow it: `if
 * (!r.ok) return r` widens straight back to the whole union, and so does the
 * ternary in a caller. `typeof x === "string"` narrows everywhere and always, so
 * that is what the callers use:
 *
 *     const filtro = leerFiltro(req.query);
 *     if (typeof filtro === "string") return res.status(400).json({ message: filtro });
 */
export type Lectura<T> = T | string;

/** `estado-red` alone takes the range as optional: with none, it counts everything. */
export type FiltroSinRango = Omit<FiltroReporte, "fechaInicial" | "fechaFinal"> & {
  fechaInicial: Date | null;
  fechaFinal: Date | null;
};

/**
 * One value out of `req.query`, telling apart "not sent" from "unreadable".
 *
 * An array is the case that matters: Express builds one from a repeated
 * parameter, and reading it as absent is what makes a filter silently wider. An
 * empty parameter — `?tramo=` — is unreadable for the same reason: a parameter
 * that is present should be readable, and one that is not is refused.
 */
function escalar(valor: unknown): string | typeof AUSENTE | typeof ILEGIBLE {
  if (valor === undefined || valor === null) return AUSENTE;
  // Arrays and objects both land here: Express's default query parser builds an
  // array from a repeated key, and nothing else it produces is worth reading.
  if (typeof valor !== "string") return ILEGIBLE;
  const limpio = valor.trim();
  return limpio === "" ? ILEGIBLE : limpio;
}

/**
 * A date.
 *
 * `Number.isNaN(fecha.getTime())` and not `fecha instanceof Date`: an invalid
 * date **is** a Date. That distinction is the whole reason this file exists.
 */
function fecha(valor: unknown): Date | typeof AUSENTE | typeof ILEGIBLE {
  const texto = escalar(valor);
  if (typeof texto !== "string") return texto;
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? ILEGIBLE : d;
}

/** The largest value Postgres accepts in an `integer` column. */
const MAX_INT4 = 2_147_483_647;

/**
 * A positive integer id.
 *
 * The shape is checked with a pattern rather than with `Number`, which reads
 * `"3abc"` as `NaN` and `"3.5"` as a number that is not an id. And the ceiling
 * is not decoration: `id_tramo` is an `integer`, so a larger value comes back
 * from Postgres as `integer out of range` — another neutral 500 for input this
 * file is supposed to have judged.
 */
function id(valor: unknown): number | typeof AUSENTE | typeof ILEGIBLE {
  const texto = escalar(valor);
  if (typeof texto !== "string") return texto;
  if (!/^\d+$/.test(texto)) return ILEGIBLE;
  const n = Number(texto);
  return n > 0 && n <= MAX_INT4 ? n : ILEGIBLE;
}

/**
 * A boolean, and only the two words that are one.
 *
 * Absent means `false`; anything unrecognised is refused rather than treated as
 * false, so `excludeOld=1` is told rather than quietly ignored. A repeated
 * parameter is refused for the same reason — read as absent it would turn the
 * switch off by itself.
 */
function booleano(valor: unknown): boolean | typeof ILEGIBLE {
  const texto = escalar(valor);
  if (texto === AUSENTE) return false;
  if (texto === "true") return true;
  if (texto === "false") return false;
  return ILEGIBLE;
}

const RANGO_REQUERIDO = "Indique la fecha inicial y la final del período.";
const RANGO_INCOMPLETO = "Indique las dos fechas del período, o ninguna.";
const FECHA_INVALIDA = "Las fechas del período no son válidas.";
const RANGO_AL_REVES = "La fecha inicial debe ser anterior a la final.";
const TRAMO_INVALIDO = "El tramo indicado no es válido.";
const TRAMO_REQUERIDO = "Indique el tramo.";
const DOS_CIUDADES_YA_NO = "Los reportes ya no se filtran por dos ciudades: indique el tramo.";
const EXCLUDE_INVALIDO = "El valor de excludeOld debe ser true o false.";

/** What every report shares, once it is readable. */
type Comunes = Pick<FiltroReporte, "excludeOld" | "tramo">;

/**
 * The part every report shares: the switch and the stretch.
 *
 * Returns the values, or the sentence explaining why there are none — as a bare
 * string, so that the callers discriminate with `typeof === "string"`.
 */
function comunes(consulta: Request["query"]): Comunes | string {
  // Total on purpose. Express always provides `req.query`, but a handler called
  // directly — which is how the unit tests in this repository call them — may
  // not, and a `TypeError` there says nothing about the filter.
  const query = consulta ?? {};

  const excludeOld = booleano(query.excludeOld);
  if (excludeOld === ILEGIBLE) return EXCLUDE_INVALIDO;

  // A client from before the cut. Ignoring the two parameters would answer a
  // question about one stretch with the whole network.
  if (query.TramoInicial !== undefined || query.TramoFinal !== undefined) return DOS_CIUDADES_YA_NO;

  // An empty `tramo=` is refused like any other unreadable value: a client that
  // wants every stretch leaves the parameter out.
  const tramo = id(query.tramo);
  if (tramo === ILEGIBLE) return TRAMO_INVALIDO;

  return { excludeOld, tramo: tramo === AUSENTE ? null : tramo };
}

/** The five reports that cannot answer anything without a period. */
export function leerFiltro(
  consulta: Request["query"],
  opciones: { tramo: "obligatorio" | "opcional" } = { tramo: "opcional" },
): Lectura<FiltroReporte> {
  const query = consulta ?? {};
  const base = comunes(query);
  if (typeof base === "string") return base;

  const fechaInicial = fecha(query.fechaInicial);
  const fechaFinal = fecha(query.fechaFinal);
  // "Or neither" is true of `estado-red` and of nothing else, so these five say
  // the other sentence: here the period is the question, not a narrowing of it.
  if (fechaInicial === AUSENTE || fechaFinal === AUSENTE) return RANGO_REQUERIDO;
  if (fechaInicial === ILEGIBLE || fechaFinal === ILEGIBLE) return FECHA_INVALIDA;
  if (fechaInicial > fechaFinal) return RANGO_AL_REVES;

  if (opciones.tramo === "obligatorio" && base.tramo === null) return TRAMO_REQUERIDO;

  return { ...base, fechaInicial, fechaFinal };
}

/**
 * `estado-red`, which answers over the whole history when given no period.
 *
 * Its own function rather than a flag, so that the five above get a
 * `fechaInicial` the type system knows is a date. A shared shape with two
 * nullable fields would push a `!` into every one of them, and a `!` in the one
 * place this file exists to make safe is a poor trade.
 */
export function leerFiltroSinRango(consulta: Request["query"]): Lectura<FiltroSinRango> {
  const query = consulta ?? {};
  const base = comunes(query);
  if (typeof base === "string") return base;

  const fechaInicial = fecha(query.fechaInicial);
  const fechaFinal = fecha(query.fechaFinal);
  // Half a period is refused rather than ignored. The handler used to read
  // `if (fechaInicial && fechaFinal)`, so one date alone quietly meant none: the
  // report covered all of history while the screen showed a start date.
  if ((fechaInicial === AUSENTE) !== (fechaFinal === AUSENTE)) return RANGO_INCOMPLETO;
  if (fechaInicial === AUSENTE || fechaFinal === AUSENTE) {
    return { ...base, fechaInicial: null, fechaFinal: null };
  }
  if (fechaInicial === ILEGIBLE || fechaFinal === ILEGIBLE) return FECHA_INVALIDA;
  if (fechaInicial > fechaFinal) return RANGO_AL_REVES;

  return { ...base, fechaInicial, fechaFinal };
}
