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

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The wrappers that already drop what a client may not assign. */
const FILTERS = ["assignable", "withoutAuthor", "authoredBy", "pick", "creatableFrom"];

/**
 * `req.body` handed over whole — not `req.body.name`, which names one field.
 * The lookahead is what keeps this from flagging every creation in the tree.
 */
const CUERPO_ENTERO = /req\.body(?![.[\w])/;

/**
 * `rol.controller.ts` carries the same defect and belongs to the roles session,
 * which owns that file while its screen is being built. Listed rather than
 * fixed, so this test is honest about what it does not cover. Remove the entry
 * — do not relax the rule — when that session lands the same one-line change.
 */
const NOT_OURS = ["rol.controller.ts"];

/** Every `logAction(...)` argument in the controllers, with its file and line. */
function logCalls() {
  const found: { file: string; line: number; arg: string }[] = [];
  const files = readdirSync(here).filter(
    (f) => f.endsWith(".controller.ts") && !NOT_OURS.includes(f),
  );

  for (const file of files) {
    const source = readFileSync(join(here, file), "utf8");
    const needle = "logAction(";
    let at = source.indexOf(needle);
    while (at !== -1) {
      // Walk from the opening paren to its match, so a nested call inside the
      // argument does not end the argument early.
      const open = at + needle.length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) { close = i; break; }
        }
      }
      if (close !== -1) {
        found.push({
          file,
          line: source.slice(0, at).split("\n").length,
          arg: source.slice(open + 1, close),
        });
      }
      at = source.indexOf(needle, at + needle.length);
    }
  }
  return found;
}

/** The `metadata:` value of one call, from its brace to the matching one. */
function metadataOf(arg: string): string | null {
  const at = arg.indexOf("metadata:");
  if (at === -1) return null;
  const open = arg.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < arg.length; i++) {
    if (arg[i] === "{") depth++;
    else if (arg[i] === "}") {
      depth--;
      if (depth === 0) return arg.slice(open, i + 1);
    }
  }
  return null;
}

describe("what the bitácora may claim", () => {
  it("never builds an audit diff from the unfiltered request body", () => {
    const raw = logCalls()
      .map((c) => ({ ...c, meta: metadataOf(c.arg) }))
      .filter((c) => c.meta !== null && CUERPO_ENTERO.test(c.meta))
      .filter((c) => !FILTERS.some((f) => c.meta!.includes(`${f}(`)))
      .map((c) => `${c.file}:${c.line}`);

    expect(
      raw,
      `estas entradas de auditoría describen el cuerpo recibido, no lo que se escribió:\n  ${raw.join("\n  ")}`,
    ).toEqual([]);
  });
});
