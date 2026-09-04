// No write may hand the request body straight to a model.
//
// The hermano of `responseShape.test.ts`: that one watches what leaves, this one
// watches what arrives. Both are source-level tests for the same reason — the
// defect is not a wrong value, it is a missing line, and the way it recurs is
// somebody writing the next controller the way the last one was written.
//
// What it exists for. `authoredBy` deletes `id`, `createdAt`, `updatedAt` and
// `deletedAt` from the values of a create, and `withoutAuthor` now does the same
// for an update. Seven controllers reach neither: they call
// `Model.create(req.body)` and `row.set(req.body)`, so those four columns were
// client-writable on both doors.
//
// `deletedAt` is the one that matters. Every model these seven edit is
// `paranoid: true`, which makes that column the archive — so a role holding
// `editar` could archive rows without `archivar` appearing anywhere in its
// matrix, and a create could mint a row already archived. The Coordinador role
// in the seed is `archivar: false` in every module that has an `archivar` and
// `editar: true` in four, so the shape of role that this affects is not
// hypothetical: it is the one that ships. `requirePermission(module, "archivar")`
// on the DELETE guarded a door the PUT beside it walked past.
//
// `id` is the other one. A create that chooses its own primary key collides with
// a row that exists, or takes an id the sequence will hand out later.
//
// Why the assertion is about the shape of the code. A test per controller would
// pin the seven that exist today; the eighth is the one nobody writes a test
// for. And the filter has to sit at the call, because Sequelize marks every own
// column present in the object as changed and `save()` writes what is marked:
// there is no later place to catch it.
//
// **What the second version closed**, after an audit ran synthetic defects
// through the first and watched five of them pass:
//
//   - `Model.update(req.body, { where })`, `bulkCreate`, `build`, `upsert` —
//     four ways to write that the first version never looked at. `update` is
//     the one that matters: it honours `deletedAt` in its values exactly as
//     `set()` does, and rewriting any of the eight fixed handlers that way
//     reopened the archive door with the whole suite green.
//   - A two-level alias. The first version followed one, and its comment said
//     anything deeper "fails closed"; it failed open — the second name did not
//     contain `req.body`, so nothing was flagged.
//   - `const { id, ...rest } = req.body`, which the declaration regex could not
//     see and which carries `deletedAt` in `rest` untouched.
//   - A filter anywhere in the text exempting the whole expression, so that
//     `{ ...req.body, x: pick(y) }` counted as filtered.
//   - A name declared twice in one file resolving to the first declaration
//     rather than the one in scope at the call.
//
// The rule now: the value handed to a write must *be* a filter call, or an
// object whose every spread is one. A name that resolves to nothing — a
// parameter, an import — is a finding, not a pass: what cannot be proven
// filtered is reported as unfiltered.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sinLiterales, cierra, resuelve, propiedades, lineaDe } from "../testkit/sourceText.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The wrappers that already drop what a client may not assign.
 *
 * An expression is filtered when it *starts* with one of these — not when one
 * of them appears somewhere inside it. `creatableFrom` and `editableFrom` wrap
 * `pick()` with an explicit field list, so they are stricter than the rest.
 */
const FILTROS = /^(?:authoredBy|withoutAuthor|assignable|pick|creatableFrom|editableFrom)\s*\(/;

/**
 * `req.body` handed over whole — not `req.body.name`, which names one field the
 * client is allowed to set. `?.` is a field access too, and a cast in
 * parentheses is unwrapped first so `(req.body as X)?.name` reads as the field
 * it is — the same two refinements `logShape.test.ts` carries.
 */
const CUERPO_ENTERO = /\breq\.body(?!\?\.|[.[\w])/;
const SIN_CASTS = (text: string) => text.replace(/\(\s*(req\.body)\s+as\s+[^()]*\)/g, "$1");
const esCuerpoEntero = (text: string) => CUERPO_ENTERO.test(SIN_CASTS(text));

/**
 * `req[…]` in any form. The scanner works on text whose strings are blanked, so
 * `req["body"]` reads as `req["    "]` and the rule above cannot see it. Nobody
 * writes a request property by bracket for a good reason; treat any of it as
 * the body until proven otherwise.
 */
const CORCHETE = /\breq\s*\[/;

/** The six ways Sequelize takes values from an object, values first. */
const ESCRITURAS = /\.(set|create|update|bulkCreate|build|upsert)\s*\(/g;

interface Escritura {
  file: string;
  line: number;
  call: string;
  /** The first argument, as written. */
  arg: string;
  /** Where the call sits in the cleaned source, for alias resolution. */
  at: number;
}

/** The first argument of a call, given the text between its parentheses. */
function primerArgumento(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) return args.slice(0, i);
  }
  return args;
}

/** Every write in the controllers, with its first argument. */
function escrituras(): { writes: Escritura[]; clean: Map<string, string> } {
  const writes: Escritura[] = [];
  const clean = new Map<string, string>();

  for (const file of readdirSync(here).filter((f) => f.endsWith(".controller.ts"))) {
    const source = readFileSync(join(here, file), "utf8");
    const text = sinLiterales(source);
    clean.set(file, text);

    let m: RegExpExecArray | null;
    ESCRITURAS.lastIndex = 0;
    while ((m = ESCRITURAS.exec(text)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = cierra(text, open, "()");
      writes.push({
        file,
        line: lineaDe(text, m.index),
        call: m[1],
        arg: primerArgumento(text.slice(open + 1, close)),
        at: m.index,
      });
    }
  }
  return { writes, clean };
}

type Veredicto = "filtrado" | "sin req.body" | "cuerpo entero" | "corchete" | "sin resolver";

/**
 * What a value handed to a write is, once its aliases are followed.
 *
 * An object literal is judged by its spreads: `{ ...assignable(req.body), x }`
 * is filtered, `{ ...req.body, x: pick(y) }` is not. Anything else is judged
 * whole. A name that resolves to nothing declared in the file is reported as
 * such — it may be a helper's parameter or an import, and either way this test
 * cannot see what went into it.
 */
function juzga(clean: string, expr: string, at: number, depth = 0): Veredicto {
  if (depth > 3) return "sin resolver";
  const { text, resolved } = resuelve(clean, expr, at);
  if (!resolved) return "sin resolver";
  if (CORCHETE.test(text)) return "corchete";
  if (FILTROS.test(text)) return "filtrado";

  if (text.startsWith("{")) {
    const spreads = propiedades(text).filter((p) => p.key === "...");
    const veredictos = spreads.map((p) => juzga(clean, p.value, at, depth + 1));
    if (veredictos.includes("cuerpo entero")) return "cuerpo entero";
    if (veredictos.includes("corchete")) return "corchete";
    if (veredictos.includes("sin resolver")) return "sin resolver";
    // No spread is the body; the named properties choose their fields.
    const propias = propiedades(text).filter((p) => p.key !== "...");
    if (propias.some((p) => esCuerpoEntero(p.value))) return "cuerpo entero";
    return veredictos.length > 0 ? "filtrado" : "sin req.body";
  }

  if (esCuerpoEntero(text)) return "cuerpo entero";
  return "sin req.body";
}

describe("what a client may assign", () => {
  const { writes, clean } = escrituras();
  const juzgadas = writes.map((w) => ({ ...w, veredicto: juzga(clean.get(w.file)!, w.arg, w.at) }));

  it("finds writes to judge at all, so a rename cannot make this test vacuous", () => {
    // Two lower bounds, and the second is the one that matters: a broken alias
    // resolver would report every filtered write as "sin resolver", and this
    // would go red rather than quietly passing over a scanner that sees nothing.
    expect(writes.length, "el escáner no encontró ninguna escritura que juzgar").toBeGreaterThan(20);
    expect(
      juzgadas.filter((w) => w.veredicto === "filtrado").length,
      "ninguna escritura resolvió a un filtro: el resolutor de alias no funciona",
    ).toBeGreaterThan(10);
  });

  it("never hands req.body to a model without filtering it first", () => {
    const raw = juzgadas
      .filter((w) => w.veredicto === "cuerpo entero" || w.veredicto === "corchete")
      .map((w) => `${w.file}:${w.line}  .${w.call}(${w.arg.trim().slice(0, 40)})`);

    expect(
      raw,
      `estas escrituras aceptan id/createdAt/updatedAt/deletedAt del cliente:\n  ${raw.join("\n  ")}`,
    ).toEqual([]);
  });

  it("can prove what every write receives, or names the one it cannot", () => {
    // Fail closed. A value this test cannot trace — a helper's parameter, an
    // imported constant — is not known to be filtered, and "not known" is the
    // state the first version of this file mistook for "fine". If one of these
    // is legitimate, the fix is to make the filter visible at the call, not to
    // widen this list.
    const ciegas = juzgadas
      .filter((w) => w.veredicto === "sin resolver")
      .map((w) => `${w.file}:${w.line}  .${w.call}(${w.arg.trim().slice(0, 40)})`);

    expect(
      ciegas,
      `estas escrituras reciben un valor que este test no puede seguir hasta su origen:\n  ${ciegas.join("\n  ")}`,
    ).toEqual([]);
  });
});
