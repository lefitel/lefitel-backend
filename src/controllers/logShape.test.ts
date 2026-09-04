// No audit entry may describe a change the server refused.
//
// The hermano of `requestShape.test.ts`: that one watches what a write accepts,
// this one watches what the log claims happened. Same reason for being
// source-level — the defect is a missing filter, and it recurs when somebody
// writes the next controller the way the last one was written.
//
// What it exists for. `ce91b1b` put `assignable()` and `withoutAuthor()` on
// every `set()`, so a body carrying `deletedAt` or `id_usuario` no longer
// touches the row. The `logAction` beside it kept building its before/after
// from `req.body` untouched. So `PUT /api/ciudad/5` with `deletedAt` answers
// 200, archives nothing, and writes into the bitácora that it archived — in the
// one record a reader consults precisely to find out whether it happened.
//
// And it was visible, not latent: the bitácora screen filters its diff to the
// fields that changed, so `id` never showed, but a `deletedAt` going from empty
// to a date did.
//
// Two things are deliberately not judged, and both were found by running this
// against the tree before fixing anything.
//
// Only `metadata` is judged. A `detail` string may mention `req.body.id_evento`
// to build a human sentence; that is a label, not a claim about a column.
//
// And only the *whole* body counts. `after: { name: req.body.name }` names one
// field the client is allowed to set, and is how most creations log; the defect
// is handing over the object entire — `after: req.body`, `{...req.body}`,
// `Object.keys(req.body)` — so that whatever the client invented rides along.
//
// **What the second version closed.** The first exempted a whole `metadata`
// block if a filter appeared anywhere in it, so `{ before: pick(row),
// after: req.body }` — the most natural way to write a diff, and the exact
// defect this file exists for — passed. It also could not follow an alias
// (`const b = req.body; … after: b`), skipped a `metadata: diff` written as a
// bare name without recording that it had, and read `logAction(` only with no
// space before the parenthesis. Each property is now judged on its own, aliases
// are followed, and a value this test cannot trace is a finding.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sinLiterales, cierra, resuelve, propiedades, lineaDe } from "../testkit/sourceText.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The wrappers that already drop what a client may not assign. */
const FILTROS = /^(?:assignable|withoutAuthor|authoredBy|pick|creatableFrom|editableFrom)\s*\(/;

/**
 * `req.body` handed over whole — not `req.body.name`, which names one field.
 * The lookahead is what keeps this from flagging every creation in the tree;
 * `?.` is a field access too, and a cast in parentheses is unwrapped first so
 * that `(req.body as Record<string, unknown>)?.id_rol` reads as the field it is.
 */
const CUERPO_ENTERO = /\breq\.body(?!\?\.|[.[\w])/;
const SIN_CASTS = (text: string) => text.replace(/\(\s*(req\.body)\s+as\s+[^()]*\)/g, "$1");
const esCuerpoEntero = (text: string) => CUERPO_ENTERO.test(SIN_CASTS(text));

/** `req[…]` in any form — see `requestShape.test.ts` for why it counts. */
const CORCHETE = /\breq\s*\[/;

/**
 * Files this test deliberately does not scan. Empty, and meant to stay so.
 *
 * `rol.controller.ts` sat here while another session owned it; it got the same
 * one-line fix as the other eight on 3 September. The shape is kept because a
 * list with a staleness test is the honest way to carry a debt, if one ever has
 * to be carried again.
 */
const NOT_OURS: string[] = [];

interface Llamada {
  file: string;
  line: number;
  /** The object literal handed to `logAction`, strings blanked. */
  arg: string;
  at: number;
  clean: string;
}

/** Every `logAction(…)` in the controllers. */
function logCalls(only?: string[]): Llamada[] {
  const found: Llamada[] = [];
  const files = only ?? readdirSync(here).filter(
    (f) => f.endsWith(".controller.ts") && !NOT_OURS.includes(f),
  );

  for (const file of files) {
    const clean = sinLiterales(readFileSync(join(here, file), "utf8"));
    const re = /\blogAction\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = cierra(clean, open, "()");
      found.push({ file, line: lineaDe(clean, m.index), arg: clean.slice(open + 1, close).trim(), at: m.index, clean });
    }
  }
  return found;
}

type Veredicto = "limpio" | "cuerpo entero" | "sin resolver" | "sin metadata";

/**
 * Whether one value inside `metadata` hands the body over whole.
 *
 * Followed through its aliases; an object literal is judged by its spreads and
 * then by its named values; a bare name nothing declares is reported as such.
 */
function juzgaValor(clean: string, expr: string, at: number, depth = 0): Veredicto {
  if (depth > 3) return "sin resolver";
  const { text, resolved } = resuelve(clean, expr, at);
  if (!resolved) return "sin resolver";
  if (FILTROS.test(text)) return "limpio";
  if (CORCHETE.test(text)) return "cuerpo entero";
  if (text.startsWith("{")) {
    for (const p of propiedades(text)) {
      const v = p.key === "..." ? juzgaValor(clean, p.value, at, depth + 1) : (esCuerpoEntero(p.value) ? "cuerpo entero" : "limpio");
      if (v !== "limpio") return v;
    }
    return "limpio";
  }
  return esCuerpoEntero(text) ? "cuerpo entero" : "limpio";
}

/** The verdict on one call's `metadata`, property by property. */
function juzga(c: Llamada): { veredicto: Veredicto; culpable?: string } {
  const meta = propiedades(c.arg).find((p) => p.key === "metadata");
  if (!meta) return { veredicto: "sin metadata" };

  const { text, resolved } = resuelve(c.clean, meta.value, c.at);
  if (!resolved) return { veredicto: "sin resolver", culpable: "metadata" };
  if (!text.startsWith("{")) return { veredicto: "sin resolver", culpable: "metadata" };

  for (const p of propiedades(text)) {
    const v = juzgaValor(c.clean, p.value, c.at);
    if (v !== "limpio") return { veredicto: v, culpable: p.key };
  }
  return { veredicto: "limpio" };
}

const offenders = (files?: string[]) =>
  logCalls(files)
    .map((c) => ({ ...c, ...juzga(c) }))
    .filter((c) => c.veredicto === "cuerpo entero");

describe("what the bitácora may claim", () => {
  const juzgadas = logCalls().map((c) => ({ ...c, ...juzga(c) }));

  // A source-level test that finds nothing to read passes for the wrong reason.
  // `readdirSync` is not recursive and matches one suffix, so moving the
  // controllers into a subfolder, or renaming them, would quietly empty this.
  it("finds calls to judge at all, so an empty walk cannot pass by default", () => {
    expect(juzgadas.length, "el escáner no encontró ninguna llamada a logAction").toBeGreaterThan(30);
    // And judged something: a `metadata` reader that found no block anywhere
    // would make every assertion below true of nothing.
    expect(
      juzgadas.filter((c) => c.veredicto !== "sin metadata").length,
      "ninguna llamada tenía metadata que juzgar",
    ).toBeGreaterThan(15);
  });

  // The exception is a debt, and debts need a due date. `routeGuards.test.ts`
  // keeps three tests of this shape for the same reason: without one, the entry
  // outlives the defect and that file stays unscanned for good.
  it("keeps the exception list honest", () => {
    const perdidos = NOT_OURS.filter((f) => !existsSync(join(here, f)));
    expect(perdidos, `estos ficheros de NOT_OURS ya no existen: quita la entrada:\n  ${perdidos.join("\n  ")}`).toEqual([]);

    const stale = NOT_OURS.filter((f) => offenders([f]).length === 0);
    expect(
      stale,
      `estos ficheros ya no tienen el defecto: quítalos de NOT_OURS en vez de dejarlos sin escanear:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("never builds an audit diff from the unfiltered request body", () => {
    const raw = juzgadas
      .filter((c) => c.veredicto === "cuerpo entero")
      .map((c) => `${c.file}:${c.line}  (${c.culpable})`);

    expect(
      raw,
      `estas entradas de auditoría describen el cuerpo recibido, no lo que se escribió:\n  ${raw.join("\n  ")}`,
    ).toEqual([]);
  });

  // What this file deliberately does not do, unlike `requestShape.test.ts`:
  // fail on a metadata value it cannot trace. A write takes one idiomatic shape
  // and every one in the tree resolves; metadata carries whatever a handler
  // computed — `fuente`, `motivo`, `locked_until`, a function parameter — and
  // seventeen such values across the MFA controllers resolve to nothing this
  // reader parses. Failing on them would report seventeen findings that are
  // not the defect, which is how a test gets switched off. So the rule here is
  // the narrower one: a value that *does* resolve to the whole body is a
  // finding; a value that resolves to nothing is beyond this file, and said so.
  it("judged something it could trace, so the resolver is known to work", () => {
    expect(
      juzgadas.filter((c) => c.veredicto === "limpio").length,
      "ninguna llamada resolvió a un metadata limpio: el resolutor no funciona",
    ).toBeGreaterThan(15);
  });
});
