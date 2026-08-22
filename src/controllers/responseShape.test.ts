// No include may send a whole table.
//
// This is a source-level test, deliberately, because the defect it exists for
// is not a wrong value — it is a missing line. `include: [{ model: UsuarioModel }]`
// with no `attributes` sends every column of `usuarios`, and one of them is
// `pass`. `GET /evento/:id` and `GET /poste/:id` did that on routes gated only
// by "be logged in", so any account could read the bcrypt hash of whoever
// registered an event. The same omission on `RevisionModel` is what handed the
// new `id_usuario` to the Cliente role the moment the column existed, one file
// away from a catalog that puts the author behind `seguridad.ver`.
//
// Nothing in the suite watched for it. `routeGuards.test.ts` walks the *write*
// routes and asserts which permission each demands; both leaks were reads. And
// a test per endpoint would only pin the endpoints that exist today, while the
// way this recurs is somebody adding a column — or a controller — later.
//
// So the assertion is about the shape of the code: for these three models, an
// include without `attributes` fails, wherever it is written.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVISION_PUBLIC_ATTRIBUTES,
} from "../models/revision.model.js";
import { SOLUCION_PUBLIC_ATTRIBUTES } from "../models/solucion.model.js";
import { USUARIO_AS_AUTHOR } from "../models/usuario.model.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Models whose full row must never reach a client. */
const GUARDED = ["UsuarioModel", "RevisionModel", "SolucionModel"];

/**
 * Finds the object literal an `include` entry sits in, by matching braces.
 *
 * A regex cannot do this: the entry may be one line or six, and may itself
 * contain nested includes with their own braces. Walking from the `{` that
 * opens the entry to its match is the only way to ask "does *this* entry name
 * its attributes" rather than "does the word appear somewhere nearby".
 */
function enclosingLiteral(source: string, modelAt: number): string | null {
  let open = -1;
  let depth = 0;
  // Walk backwards to the `{` that opens this entry.
  for (let i = modelAt; i >= 0; i--) {
    if (source[i] === "}") depth++;
    else if (source[i] === "{") {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  if (open === -1) return null;

  depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** Every `model: XModel` in the controllers, with the entry it belongs to. */
function includes(): { file: string; line: number; model: string; literal: string }[] {
  const found: { file: string; line: number; model: string; literal: string }[] = [];
  for (const file of readdirSync(here).filter((f) => f.endsWith(".controller.ts"))) {
    const source = readFileSync(join(here, file), "utf8");
    for (const model of GUARDED) {
      const needle = `model: ${model}`;
      let at = source.indexOf(needle);
      while (at !== -1) {
        const literal = enclosingLiteral(source, at);
        if (literal !== null) {
          found.push({
            file,
            line: source.slice(0, at).split("\n").length,
            model,
            literal,
          });
        }
        at = source.indexOf(needle, at + 1);
      }
    }
  }
  return found;
}

describe("every include names the columns it wants", () => {
  it("finds the includes at all, so a rename cannot make this test vacuous", () => {
    // Without this, renaming a model or moving the controllers turns the loop
    // below into zero iterations and the suite goes green over nothing.
    const all = includes();
    expect(all.length).toBeGreaterThan(8);
    expect(new Set(all.map((i) => i.model))).toEqual(new Set(GUARDED));
  });

  it("never includes one of the guarded models bare", () => {
    const bare = includes()
      .filter((i) => !/\battributes\b/.test(i.literal))
      .map((i) => `${i.file}:${i.line} — ${i.model} sin attributes`);

    // The message is the point: it names the file and the line, because the fix
    // is one line and the reader needs to know where.
    expect(bare).toEqual([]);
  });
});

describe("the lists themselves", () => {
  it("keeps the author out of what a revision or a repair sends", () => {
    expect(REVISION_PUBLIC_ATTRIBUTES).not.toContain("id_usuario");
    expect(SOLUCION_PUBLIC_ATTRIBUTES).not.toContain("id_usuario");
    // And they do carry what the screens need, so nobody "fixes" the leak by
    // emptying them.
    expect(REVISION_PUBLIC_ATTRIBUTES).toContain("description");
    expect(REVISION_PUBLIC_ATTRIBUTES).toContain("date");
    expect(SOLUCION_PUBLIC_ATTRIBUTES).toContain("image");
  });

  it("never lets a credential out as part of an author", () => {
    expect(USUARIO_AS_AUTHOR).not.toContain("pass");
    // Nor the rest of what an account is. An author is a name.
    for (const field of ["phone", "user", "birthday", "failed_attempts", "locked_until", "id_rol"]) {
      expect(USUARIO_AS_AUTHOR).not.toContain(field);
    }
  });
});
