// No failure may answer the browser with the text of the exception.
//
// The third source-level test in this family, and the same reasoning as its two
// siblings: `requestShape.test.ts` watches what a write accepts,
// `logShape.test.ts` watches what the audit log claims, this one watches what a
// crash says out loud. All three exist because the defect is a missing line, and
// the way it recurs is somebody writing the next controller the way the last one
// was written.
//
// What it exists for. `res.status(500).json({ message: error.message })` sends
// the browser whatever Sequelize or Postgres raised: column names, constraint
// names, sometimes the SQL. A caller who can reach any route can map the schema
// by feeding it bad input. There were ninety of these across nineteen
// controllers. Seventy-four went in A3; the last sixteen — ten in `evento`, one
// in `eventoObs`, five in `rol` — went when the audit of 3 September found that
// the condition A3 had set for converting them ("the moment that work lands")
// had been met by the very next commit and nobody had come back.
//
// The fix is not a neutral string in place — that trades a leak for blindness,
// because these failures are logged nowhere else and the browser was the only
// place they surfaced. It is `makeHandler` in `utils/handler.ts`, which logs the
// error under its own controller's name with the route attached and answers a
// neutral 500. This test is what stops the pattern coming back one controller at
// a time.
//
// Scoped to 500 on purpose. The generator answers 400, 413 and 429 with typed
// messages of its own, written for a person to read, and those must keep working.
//
// **What the second version closed.** The first walked braces over the raw
// source, so a `}` inside a string or a comment ended the `catch` body before
// the 500 and the block read as clean — while its own comment claimed it failed
// loud, having guarded only the rarer case of an unmatched `{`. It also could
// not follow `const payload = { message: e.message }; res.status(500).json(payload)`,
// nor `const code = 500; res.status(code)`. The walk now runs over text with
// every string and comment blanked, and both aliases are resolved.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sinLiterales, cierra, resuelve, lineaDe } from "../testkit/sourceText.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Files this test deliberately does not scan. Empty, and meant to stay so.
 *
 * It held three for a while — `rol` because another session owned the file,
 * `evento` and `eventoObs` because they had uncommitted work in them — and the
 * shape is kept because a list with a staleness test is the honest way to carry
 * a debt, if one ever has to be carried again. `keeps the exception list
 * honest` below fails if an entry outlives the defect: remove the entry then,
 * do not relax the rule.
 */
const NOT_OURS: string[] = [];

/** The controller files this test is responsible for. */
const escaneados = () =>
  readdirSync(here).filter((f) => f.endsWith(".controller.ts") && !NOT_OURS.includes(f));

interface Catch {
  file: string;
  line: number;
  /** The binding: `error` in `catch (error)`. */
  name: string;
  /** The block, strings and comments blanked. */
  body: string;
  /** Where the block starts in the cleaned file, for alias resolution. */
  at: number;
  clean: string;
}

function catchBlocks(only?: string[]): Catch[] {
  const found: Catch[] = [];
  const files = only ?? escaneados();

  for (const file of files) {
    const clean = sinLiterales(readFileSync(join(here, file), "utf8"));
    // The binding may carry a type annotation. `catch (e: unknown)` is what
    // `useUnknownInCatchVariables` pushes you to write, and the first version of
    // this pattern went blind the moment somebody wrote one.
    const re = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const open = m.index + m[0].length - 1;
      // Throws on unbalanced text, in either direction. On blanked text that
      // means real code is unbalanced, which is worth stopping on — and it is
      // the opposite of the first version, where a stray `}` ended the walk
      // early and the block read as clean.
      const close = cierra(clean, open);
      found.push({
        file,
        line: lineaDe(clean, m.index),
        name: m[1],
        body: clean.slice(open, close + 1),
        at: open,
        clean,
      });
    }
  }
  return found;
}

/**
 * Everything that reaches into the exception for something to say out loud.
 *
 * `.message` is the spelling this codebase had, and on its own it is the weakest
 * of the set. Sequelize hangs the raw driver error off `.original` and
 * `.parent`, and Postgres fills `parent.detail` with things like
 * `Key (user)=(pepe) already exists.` — the column name and the value together.
 * `String(err)` and `err.toString()` hand back the message anyway, and `.stack`
 * adds the file layout of the server on top.
 *
 * The list came from an audit that ran eighteen spellings past the first version
 * of this test: it caught four.
 */
const ACCESOS = /\.\s*(message|stack|original|parent|detail|sql|toString\s*\()|String\s*\(/;

/**
 * The argument of the 500 answer in a catch block, if there is one.
 *
 * Judging the argument rather than the whole block is what makes this both
 * stricter and kinder. Stricter, because `catch (e: unknown)` forces a cast and
 * the leak then reads `(e as {parent?: …}).parent` — the binding is no longer
 * next to the property, so looking for `e.parent` in the block misses it.
 * Kinder, because a block that hands the exception to the logger and answers a
 * neutral 500 is correct, and looking at the whole block would have flagged it.
 *
 * Both the status and the argument are followed through one alias: `const code
 * = 500; res.status(code)` is a 500, and `res.status(500).json(payload)` is
 * judged on what `payload` was assigned.
 */
function respuesta500(c: Catch): string | null {
  const status = /res\s*\.\s*status\s*\(\s*([^)]+?)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = status.exec(c.body)) !== null) {
    const codigo = resuelve(c.clean, m[1], c.at + m.index).text.trim();
    if (codigo !== "500") continue;
    const rest = c.body.slice(m.index + m[0].length);
    const call = rest.search(/^\s*\.\s*(json|send)\s*\(/);
    if (call === -1) return "";
    const open = c.body.indexOf("(", m.index + m[0].length + rest.indexOf("("));
    const close = cierra(c.body, open, "()");
    const arg = c.body.slice(open + 1, close);
    return resuelve(c.clean, arg, c.at + open).text;
  }
  return /sendStatus\s*\(\s*500\s*\)/.test(c.body) ? "" : null;
}

/** A catch that answers 500 with something taken off the exception. */
const leaks = (files?: string[]) =>
  catchBlocks(files).filter((c) => {
    const arg = respuesta500(c);
    if (arg === null) return false;
    // Naming the binding inside the answer at all is enough. Whatever is being
    // done with it there, it is the exception talking to the browser.
    return new RegExp(String.raw`\b${c.name}\b`).test(arg) || ACCESOS.test(arg);
  });

describe("what a failure may say out loud", () => {
  // A source-level test that finds nothing to read passes for the wrong reason.
  // Two bounds: files read, so an empty walk cannot pass; and blocks found, so
  // a `catch` regex that went blind on some spelling cannot either. The second
  // is low on purpose — `makeHandler` is the point, so few catches remain — but
  // `usuario` keeps three for its 409 branches and `generador` ten that route
  // through `handleError`, and those are not going anywhere.
  it("reads the controllers at all, so an empty walk cannot pass", () => {
    expect(escaneados().length, "el escáner no encontró ningún controlador que leer").toBeGreaterThan(15);
    expect(catchBlocks().length, "el escáner no encontró ningún catch que leer").toBeGreaterThan(5);
  });

  it("keeps the exception list honest", () => {
    const perdidos = NOT_OURS.filter((f) => !existsSync(join(here, f)));
    expect(
      perdidos,
      `estos ficheros de NOT_OURS ya no existen: quita la entrada:\n  ${perdidos.join("\n  ")}`,
    ).toEqual([]);

    const stale = NOT_OURS.filter((f) => leaks([f]).length === 0);
    expect(
      stale,
      `estos ficheros ya no tienen el defecto: quítalos de NOT_OURS en vez de dejarlos sin escanear:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("never sends the text of the exception in a 500", () => {
    const raw = leaks().map((c) => `${c.file}:${c.line}`);

    expect(
      raw,
      `estos fallos le cuentan al navegador lo que dijo Postgres:\n  ${raw.join("\n  ")}`,
    ).toEqual([]);
  });
});
