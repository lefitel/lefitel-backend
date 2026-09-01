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
// in the seed is `archivar: false` in every module that has an `archivar` —
// `reportes` and `bitacora` no longer do — and `editar: true` in
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
// `creatableFrom` and `editableFrom` wrap `pick()` with an explicit field
// list, so they are stricter than the rest. They only became visible from the
// write once this test started following one level of alias.
const FILTERS = ["authoredBy", "withoutAuthor", "assignable", "pick", "creatableFrom", "editableFrom"];

/**
 * A write whose argument is a bare name, resolved to what that name was
 * assigned. Added after a change moved six filters out of the call and into a
 * `const` a line above — which left those six writes correct and this test
 * unable to tell, because the argument no longer said `req.body`. A guarantee
 * that depends on where you put the parentheses is not a guarantee.
 *
 * One level only, and deliberately: the idiom this follows is
 * `const editable = assignable(req.body); row.set(editable);`. Anything deeper
 * is not an idiom, it is somewhere to hide, and it will read as unresolved —
 * which fails closed, because the declaration text is what gets judged.
 */
function unalias(source: string, arg: string): string {
  const name = arg.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return arg;
  // `String.raw`, or the template turns `\b` into a backspace and `\s` into an
  // `s`, and the pattern matches nothing while the test still passes.
  const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*=\s*([^;]+);`);
  return decl.exec(source)?.[1] ?? arg;
}

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
    const all = writes();

    // So a rename or a moved folder cannot make this test vacuous by finding
    // nothing to judge. Same guard `responseShape.test.ts` carries.
    expect(all.length, "el escáner no encontró ninguna escritura que juzgar").toBeGreaterThan(20);

    const raw = all
      .map((w) => ({ ...w, resolved: unalias(readFileSync(join(here, w.file), "utf8"), w.arg) }))
      .filter((w) => w.resolved.includes("req.body"))
      .filter((w) => !FILTERS.some((f) => w.resolved.includes(`${f}(`)))
      .map((w) => `${w.file}:${w.line}  .${w.call}(${w.arg.trim().slice(0, 40)})`);

    expect(
      raw,
      `estas escrituras aceptan id/createdAt/updatedAt/deletedAt del cliente:\n  ${raw.join("\n  ")}`,
    ).toEqual([]);
  });
});
