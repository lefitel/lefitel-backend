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
// controllers: seventy-four converted, sixteen left in the three files named
// below. (The commit that did the work says eighty-five, counted before the
// audit recounted — this is the number that matches the tree.)
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

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Three files not converted, for two different reasons, both about other
 * sessions working the same tree.
 *
 * `rol.controller.ts` belongs to the roles session, which owns that file while
 * its screen is being built.
 *
 * `evento.controller.ts` and `eventoObs.controller.ts` are nobody else's, but
 * had uncommitted work in them when this ran, and converting a file somebody is
 * halfway through editing is how two people lose an afternoon. Ten and one leak
 * respectively; convert them the moment that work lands.
 *
 * Listed rather than converted, so this test is honest about what it does not
 * cover. `keeps the exception list honest` below fails if an entry outlives the
 * defect — remove it then, do not relax the rule.
 */
const NOT_OURS = ["rol.controller.ts", "evento.controller.ts", "eventoObs.controller.ts"];

/** The controller files this test is responsible for. */
const escaneados = () =>
  readdirSync(here).filter((f) => f.endsWith(".controller.ts") && !NOT_OURS.includes(f));

function catchBlocks(only?: string[]) {
  const found: { file: string; line: number; name: string; body: string }[] = [];
  const files = only ?? escaneados();

  for (const file of files) {
    const source = readFileSync(join(here, file), "utf8");
    // The binding may carry a type annotation. `catch (e: unknown)` is what
    // `useUnknownInCatchVariables` pushes you to write, and the first version of
    // this pattern went blind the moment somebody wrote one.
    const re = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // Walk from the block's opening brace to its match, so a nested block
      // does not end the body early.
      const open = source.indexOf("{", m.index + m[0].length - 1);
      let depth = 0;
      let close = -1;
      for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) { close = i; break; }
        }
      }
      // Loud, not silent. The brace walk knows nothing about strings or
      // comments, so an unbalanced `{` inside one leaves `close` at -1 — and a
      // block dropped quietly reads to every check below as "this file is
      // clean", including the one that decides an exception has expired.
      if (close === -1) {
        throw new Error(
          `${file}: no se pudo cerrar el catch de la línea ` +
            `${source.slice(0, m.index).split("\n").length}. ` +
            "Probablemente una llave suelta en un comentario o una cadena.",
        );
      }
      found.push({
        file,
        line: source.slice(0, m.index).split("\n").length,
        name: m[1],
        body: source.slice(open, close + 1),
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
 * next to the property, so looking for `e.parent` in the block misses it, which
 * is exactly what an audit of the first version caught. Kinder, because a block
 * that hands the exception to the logger and answers a neutral 500 is correct,
 * and looking at the whole block would have flagged it.
 */
function respuesta500(body: string): string | null {
  const at = body.search(/res\s*\.\s*status\s*\(\s*500\s*\)/);
  if (at === -1) return /sendStatus\s*\(\s*500\s*\)/.test(body) ? "" : null;
  const call = body.slice(at).search(/\.\s*(json|send)\s*\(/);
  if (call === -1) return "";
  const open = body.indexOf("(", at + call);
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") {
      depth--;
      if (depth === 0) return body.slice(open + 1, i);
    }
  }
  return body.slice(open + 1);
}

/** A catch that answers 500 with something taken off the exception. */
const leaks = (files?: string[]) =>
  catchBlocks(files).filter((c) => {
    const arg = respuesta500(c.body);
    if (arg === null) return false;
    // Naming the binding inside the answer at all is enough. Whatever is being
    // done with it there, it is the exception talking to the browser.
    return new RegExp(String.raw`\b${c.name}\b`).test(arg) || ACCESOS.test(arg);
  });

describe("what a failure may say out loud", () => {
  // A source-level test that finds nothing to read passes for the wrong reason.
  // Counts files read, not `catch` blocks found. The first version asserted on
  // blocks, which measures how much unconverted code is left — so finishing the
  // job would have reddened the test that guards it. `generador` alone holds ten
  // of the eighteen that remain.
  it("reads the controllers at all, so an empty walk cannot pass", () => {
    expect(
      escaneados().length,
      "el escáner no encontró ningún controlador que leer",
    ).toBeGreaterThan(15);
  });

  it("keeps the exception list honest", () => {
    // A named file that no longer exists is a stale entry too, and reading it
    // would otherwise throw ENOENT with no explanation of what to do about it.
    const perdidos = NOT_OURS.filter((f) => !escaneados().concat(NOT_OURS).includes(f) || !existsSync(join(here, f)));
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
