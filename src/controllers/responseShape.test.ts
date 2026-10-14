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
// So the assertion is about the shape of the code: for these five models, an
// include without `attributes` fails, wherever it is written.
//
// **What the second version closed**, after an audit ran the spellings past
// the first:
//
//   - `include: [UsuarioModel]` — legal Sequelize, sends every column, and the
//     first version looked only for the string `model: UsuarioModel`, so a bare
//     model in the include array was invisible. So was `model:UsuarioModel`
//     without the space.
//   - `attributes: { exclude: ["pass"] }` — passed as "has attributes", and
//     every column added later leaks. For a guarded model, only a list counts.
//   - A child include's `attributes` satisfying its parent, because the walk
//     took the whole entry, nested entries included. Only the entry's own
//     top-level `attributes` counts now.
//   - The credential-ceiling test skipped any entry mentioning
//     `USUARIO_AS_AUTHOR`, which was six of the seven — so
//     `[...USUARIO_AS_AUTHOR, "pass"]` was exempt by construction. Every entry
//     is judged now; the spread is allowed, anything beside it must be in the
//     list, and any other spread or name is a finding.
//   - Single quotes, and a comment inside the entry: the scan now runs over
//     text with strings and comments blanked and reads field names back from
//     the original at the same positions.
//
// Scanned: `src/controllers/`. Nothing else in `src/` writes an `include:`
// outside a comment today; if a repository or service layer ever does, extend
// `DIRECTORIOS`.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION_PUBLIC_ATTRIBUTES } from "../models/revision.model.js";
import { SOLUCION_PUBLIC_ATTRIBUTES } from "../models/solucion.model.js";
import { USUARIO_AS_AUTHOR } from "../models/usuario.model.js";
import { sinLiterales, cierra, lineaDe } from "../testkit/sourceText.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIRECTORIOS = [here, join(here, "..", "tramos")];

/** Models whose full row must never reach a client. */
const GUARDED = ["UsuarioModel", "RevisionModel", "SolucionModel", "PosteModel", "EventoModel", "TramoModel"] as const;
const GUARDADOS = GUARDED.join("|");

interface Entrada {
  file: string;
  line: number;
  model: string;
  /** How the model was written into the include. */
  forma: "objeto" | "pelado";
  /** The entry's own `attributes` value, from the original text; null if none. */
  attributes: string | null;
}

/**
 * The `{ … }` an occurrence of `model: X` sits in, by walking back to the brace
 * that opens it — over blanked text, so a brace in a string cannot mislead.
 */
function entradaDe(clean: string, at: number): [number, number] | null {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (clean[i] === "}") depth++;
    else if (clean[i] === "{") {
      if (depth === 0) return [i, cierra(clean, i)];
      depth--;
    }
  }
  return null;
}

/**
 * The value of the entry's *own* `attributes`, as `[start, end)` in the entry.
 *
 * Top level only: a nested include has its own entry and its own judgment, and
 * letting a child's list vouch for its parent is one of the holes this version
 * closes. Found by scanning at depth zero for the key.
 */
function attributesPropias(entrada: string): [number, number] | null {
  let depth = 0;
  for (let i = 1; i < entrada.length - 1; i++) {
    const c = entrada[i];
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth !== 0) continue;
    const m = /^attributes\s*:\s*/.exec(entrada.slice(i));
    if (!m || (i > 0 && /[\w$]/.test(entrada[i - 1]))) continue;
    const start = i + m[0].length;
    const abre = entrada[start];
    if (abre === "[" || abre === "{") return [start, cierra(entrada, start, abre === "[" ? "[]" : "{}") + 1];
    // A bare name — `attributes: SOME_LIST` — runs to the next comma or the end.
    const fin = entrada.slice(start).search(/[,}]/);
    return [start, fin === -1 ? entrada.length - 1 : start + fin];
  }
  return null;
}

/**
 * Whether position `at` sits directly inside an array that is the value of an
 * `include:` key — walking back to the `[` that encloses it at depth zero and
 * reading what precedes that bracket.
 */
function dentroDeInclude(clean: string, at: number): boolean {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = clean[i];
    if (c === "]" || c === "}" || c === ")") depth++;
    else if (c === "{" || c === "(") { if (depth === 0) return false; depth--; }
    else if (c === "[") {
      if (depth === 0) return /\binclude\s*:\s*$/.test(clean.slice(0, i));
      depth--;
    }
  }
  return false;
}

/** Every include of a guarded model, in every scanned file. */
function includes(): Entrada[] {
  const found: Entrada[] = [];
  for (const dir of DIRECTORIOS) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      const clean = sinLiterales(source);

      // `model: X`, with any whitespace.
      const objeto = new RegExp(String.raw`\bmodel\s*:\s*(${GUARDADOS})\b`, "g");
      let m: RegExpExecArray | null;
      while ((m = objeto.exec(clean)) !== null) {
        const span = entradaDe(clean, m.index);
        if (span === null) continue;
        const [open, close] = span;
        const entrada = clean.slice(open, close + 1);
        const attrs = attributesPropias(entrada);
        found.push({
          file,
          line: lineaDe(clean, m.index),
          model: m[1],
          forma: "objeto",
          attributes: attrs === null ? null : source.slice(open + attrs[0], open + attrs[1]),
        });
      }

      // `X` alone as an element of an *include* array: preceded by `[` or `,`,
      // followed by `,` or `]`, and the array is the value of `include:`. Sends
      // every column, and the first version could not see it at all. The last
      // condition is what keeps `order: [[PosteModel, "name", dir]]` — a sort
      // key, which is the other place a bare model legitimately sits in an
      // array — from being reported as a bare include.
      const pelado = new RegExp(String.raw`(?<=[\[,]\s*)(${GUARDADOS})(?=\s*[,\]])`, "g");
      while ((m = pelado.exec(clean)) !== null) {
        if (!dentroDeInclude(clean, m.index)) continue;
        found.push({ file, line: lineaDe(clean, m.index), model: m[1], forma: "pelado", attributes: null });
      }
    }
  }
  return found;
}

/** The string elements of an `attributes` array, and whatever else is in it. */
function elementos(lista: string): { campos: string[]; otros: string[] } {
  const body = lista.trim().replace(/^\[/, "").replace(/\]$/, "");
  const campos: string[] = [];
  const otros: string[] = [];
  let depth = 0;
  let start = 0;
  const partes: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) { partes.push(body.slice(start, i)); start = i + 1; }
  }
  partes.push(body.slice(start));
  for (const p of partes.map((x) => x.trim()).filter((x) => x.length > 0)) {
    const s = /^["']([^"']+)["']$/.exec(p);
    if (s) campos.push(s[1]);
    else otros.push(p);
  }
  return { campos, otros };
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
      .filter((i) => i.attributes === null)
      .map((i) => `${i.file}:${i.line} — ${i.model} sin attributes${i.forma === "pelado" ? " (modelo pelado en el array)" : ""}`);

    // The message is the point: it names the file and the line, because the fix
    // is one line and the reader needs to know where.
    expect(bare).toEqual([]);
  });

  it("never uses an exclude list where a guarded model is concerned", () => {
    // `attributes: { exclude: ["pass"] }` is a promise about today's columns.
    // The next column added to `usuarios` travels. For these five models, only
    // a list of what to send counts.
    const excluye = includes()
      .filter((i) => i.attributes !== null && i.attributes.trim().startsWith("{"))
      .map((i) => `${i.file}:${i.line} — ${i.model} con exclude`);
    expect(excluye).toEqual([]);
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

  // And no include may send more of an account than that list holds.
  //
  // The test above passed while the bitácora shipped the login name anyway,
  // because it wrote its own array — `["id", "name", "lastname", "user"]` —
  // instead of reaching for the constant. Asserting the contents of a list
  // nobody is obliged to use proves nothing: it states the right answer without
  // checking that anybody gave it.
  //
  // Narrower is allowed, and deliberately: the report builder sends `["id"]`
  // alone to a viewer who may not see authors. The rule is a ceiling, not an
  // equality.
  //
  // Every usuario include is judged — the first version exempted any entry that
  // mentioned `USUARIO_AS_AUTHOR`, which was six of seven, so that
  // `[...USUARIO_AS_AUTHOR, "user", "pass"]` passed by construction. The spread
  // of the constant is fine; a string beside it must be in the constant; and any
  // other spread or bare name is something this test cannot vouch for.
  it("never sends more of an account than USUARIO_AS_AUTHOR holds", () => {
    const allowed = new Set<string>(USUARIO_AS_AUTHOR);
    const usuario = includes().filter((i) => i.model === "UsuarioModel");
    // Judged, not skipped: the count is what the old exemption hid.
    expect(usuario.length, "no se encontró ningún include de usuario").toBeGreaterThan(5);

    const over = usuario.flatMap((i) => {
      if (i.attributes === null) return [`${i.file}:${i.line} (sin attributes)`];
      const lista = i.attributes.trim();
      if (lista === "USUARIO_AS_AUTHOR" || lista === "[...USUARIO_AS_AUTHOR]") return [];
      if (!lista.startsWith("[")) return [`${i.file}:${i.line} attributes es ${lista.slice(0, 30)}, no una lista`];
      const { campos, otros } = elementos(lista);
      return [
        ...campos.filter((f) => !allowed.has(f)).map((f) => `${i.file}:${i.line} manda "${f}"`),
        ...otros.filter((o) => o !== "...USUARIO_AS_AUTHOR").map((o) => `${i.file}:${i.line} lleva ${o.slice(0, 30)}, que este test no puede juzgar`),
      ];
    });

    expect(
      over,
      `estos includes de usuario mandan campos fuera de USUARIO_AS_AUTHOR: ${over.join(", ")}`,
    ).toEqual([]);
  });
});
