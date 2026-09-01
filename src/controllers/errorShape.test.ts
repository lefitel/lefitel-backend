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
// by feeding it bad input. There were eighty-eight of these across twenty
// controllers.
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
import { readFileSync, readdirSync } from "node:fs";
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

/** Every `catch (x) { … }` in the controllers, with its binding and its body. */
function catchBlocks(only?: string[]) {
  const found: { file: string; line: number; name: string; body: string }[] = [];
  const files = only ?? readdirSync(here).filter(
    (f) => f.endsWith(".controller.ts") && !NOT_OURS.includes(f),
  );

  for (const file of files) {
    const source = readFileSync(join(here, file), "utf8");
    const re = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
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
      if (close !== -1) {
        found.push({
          file,
          line: source.slice(0, m.index).split("\n").length,
          name: m[1],
          body: source.slice(open, close + 1),
        });
      }
    }
  }
  return found;
}

/** A catch that answers 500 with something taken off the exception. */
const leaks = (files?: string[]) =>
  catchBlocks(files).filter(
    (c) =>
      new RegExp(String.raw`\b${c.name}\s*\.\s*message`).test(c.body) &&
      /res\s*\.\s*(status\s*\(\s*500\s*\)|sendStatus\s*\(\s*500\s*\))/.test(c.body),
  );

describe("what a failure may say out loud", () => {
  // A source-level test that finds nothing to read passes for the wrong reason.
  it("finds catch blocks to judge at all, so an empty walk cannot pass", () => {
    expect(
      catchBlocks().length,
      "el escáner no encontró ningún catch que juzgar",
    ).toBeGreaterThan(10);
  });

  it("keeps the exception list honest", () => {
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
