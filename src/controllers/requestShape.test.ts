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
// in the seed is `archivar: false` in all ten modules and `editar: true` in
// four, so the shape of role that this affects is not hypothetical: it is the
// one that ships. `requirePermission(module, "archivar")` on the DELETE guarded
// a door the PUT beside it walked past.
//
// `id` is the other one. A create that chooses its own primary key collides with
// a row that exists, or takes an id the sequence will hand out later.
//
// Why the assertion is about the shape of the code. A test per controller would
// pin the seven that exist today; the eighth is the one nobody writes a test
// for. And the filter has to sit at the call, because Sequelize marks every own
// column present in the object as changed and `save()` writes what is marked:
// there is no later place to catch it.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The wrappers that already drop what a client may not assign.
 *
 * A call whose argument goes through one of these is fine. Anything else that
 * mentions `req.body` in the values of a write is what this test is looking
 * for.
 */
const FILTERS = ["authoredBy", "withoutAuthor", "assignable", "pick"];

/** Every `.set(…)` and `.create(…)` in the controllers, with its argument. */
function writes(): { file: string; line: number; call: string; arg: string }[] {
  const found: { file: string; line: number; call: string; arg: string }[] = [];

  for (const file of readdirSync(here).filter((f) => f.endsWith(".controller.ts"))) {
    const source = readFileSync(join(here, file), "utf8");

    for (const call of ["set", "create"] as const) {
      const needle = `.${call}(`;
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
            call,
            arg: source.slice(open + 1, close),
          });
        }
        at = source.indexOf(needle, at + needle.length);
      }
    }
  }

  return found;
}

describe("what a client may assign", () => {
  it("never hands req.body to a model without filtering it first", () => {
    const raw = writes()
      .filter((w) => w.arg.includes("req.body"))
      .filter((w) => !FILTERS.some((f) => w.arg.includes(`${f}(`)))
      .map((w) => `${w.file}:${w.line}  .${w.call}(${w.arg.trim().slice(0, 40)})`);

    expect(
      raw,
      `estas escrituras aceptan id/createdAt/updatedAt/deletedAt del cliente:\n  ${raw.join("\n  ")}`,
    ).toEqual([]);
  });
});
