// Reading TypeScript source as text, for the tests that judge its shape.
//
// Four tests in `src/controllers/` read controller *source* instead of running
// it — `requestShape`, `responseShape`, `logShape`, `errorShape` — because the
// defect each hunts is a missing line, and a missing line recurs when somebody
// writes the next controller by copying the last one. Each of them grew its own
// brace walker and its own one-level alias lookup, and an audit on 3 September
// ran synthetic defects through all four and found the same three holes in
// every one of them:
//
//   - A `}` inside a string or a comment ended a block early, so the code after
//     it was never judged. One of the files had a guard for an unmatched `{`
//     and a comment saying it therefore failed loud; the *other* half — a
//     stray `}` — was the common one and it failed silent.
//   - An alias one level deep was followed; two levels, or a destructured
//     `...rest`, or a name declared twice in one file, were not — and one of
//     the lookups resolved to the *first* declaration in the file rather than
//     the nearest one before the call.
//   - A filter anywhere in the text exempted the whole expression, so
//     `{ ...req.body, x: pick(y) }` counted as filtered.
//
// So this file exists: one reader, tested on its own, that the four share.
// Everything here works on positions in the original string, so a line number
// reported by a test is the line in the file the reader will open.

/**
 * The source with every string, template literal and comment blanked out.
 *
 * Same length as the input, newlines kept, so every index and every line number
 * still means what it meant. A brace walker over this cannot be fooled by a
 * `}` in a Spanish error message or a prose comment, and a search for
 * `req.body` cannot match the words inside a sentence.
 *
 * Template literals keep their `${ … }` holes as code — that is where an
 * expression lives — and the holes may nest braces of their own, so a small
 * stack tracks how deep the hole is. Regular-expression literals are the one
 * thing not handled: telling `/` from division needs a parser, and none of the
 * scanned code puts a brace inside a regex inside a handler. If that ever
 * changes, the unbalanced-brace guard in `cierra()` is what will notice.
 */
export function sinLiterales(source: string): string {
  const out = source.split("");
  type Modo = "codigo" | "linea" | "bloque" | "simple" | "doble" | "plantilla";
  // Each entry is a mode; a `codigo` entry inside a `plantilla` carries the
  // brace depth of its `${ … }` hole.
  const pila: { modo: Modo; llaves: number }[] = [{ modo: "codigo", llaves: 0 }];
  const blanco = (i: number) => { if (out[i] !== "\n") out[i] = " "; };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const d = source[i + 1];
    const top = pila[pila.length - 1];

    switch (top.modo) {
      case "codigo":
        if (c === "/" && d === "/") { pila.push({ modo: "linea", llaves: 0 }); blanco(i); break; }
        if (c === "/" && d === "*") { pila.push({ modo: "bloque", llaves: 0 }); blanco(i); break; }
        if (c === "'") { pila.push({ modo: "simple", llaves: 0 }); break; }
        if (c === '"') { pila.push({ modo: "doble", llaves: 0 }); break; }
        if (c === "`") { pila.push({ modo: "plantilla", llaves: 0 }); break; }
        if (c === "{") { top.llaves++; break; }
        if (c === "}") {
          // The closing brace of a `${ … }` hole hands control back to the
          // template it sits in. Only when this code frame is such a hole.
          if (top.llaves === 0 && pila.length > 1 && pila[pila.length - 2].modo === "plantilla") {
            pila.pop();
            break;
          }
          top.llaves--;
          break;
        }
        break;
      case "linea":
        if (c === "\n") { pila.pop(); break; }
        blanco(i);
        break;
      case "bloque":
        if (c === "*" && d === "/") { pila.pop(); blanco(i); blanco(i + 1); i++; break; }
        blanco(i);
        break;
      case "simple":
      case "doble": {
        const cierre = top.modo === "simple" ? "'" : '"';
        if (c === "\\") { blanco(i); blanco(i + 1); i++; break; }
        if (c === cierre || c === "\n") { pila.pop(); break; }
        blanco(i);
        break;
      }
      case "plantilla":
        if (c === "\\") { blanco(i); blanco(i + 1); i++; break; }
        if (c === "`") { pila.pop(); break; }
        if (c === "$" && d === "{") { pila.push({ modo: "codigo", llaves: 0 }); i++; break; }
        blanco(i);
        break;
    }
  }
  return out.join("");
}

/**
 * The index of the bracket that closes the one at `open`.
 *
 * Throws on an unbalanced text — in either direction. A walk that returned -1
 * for an unmatched opener and merrily ended early on a stray closer is exactly
 * what let a `}` in a comment hide a leaking `catch`. Callers pass text that
 * has been through `sinLiterales()`, so a throw here means real code is
 * unbalanced, which is a defect worth stopping on.
 */
export function cierra(text: string, open: number, par: "{}" | "()" | "[]" = "{}"): number {
  const [a, z] = par;
  if (text[open] !== a) throw new Error(`cierra(): en ${open} no hay '${a}', hay '${text[open]}'`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === a) depth++;
    else if (text[i] === z) {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) break;
    }
  }
  throw new Error(`cierra(): '${a}' en ${open} no tiene pareja (¿una llave suelta en código real?)`);
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * What `name` was most recently assigned before position `before`.
 *
 * Reads the nearest `const`/`let`/`var` declaration of that name that ends
 * before `before`, so a name declared twice in one file resolves to the one in
 * scope at the call, not the first one in the file. Two shapes are read:
 *
 *   - `const name = RHS;` → `RHS`
 *   - `const { a, b, ...name } = RHS;` → `RHS`, because a rest element carries
 *     everything the pattern did not pick off, which for a request body means
 *     `deletedAt` and friends ride along untouched.
 *
 * `null` when nothing declares it: a parameter, an import, a global. The caller
 * decides what an unresolvable name means — for a write, it means "cannot be
 * proven filtered", which is a finding, not a pass.
 */
export function declaracion(clean: string, name: string, before: number): string | null {
  if (!IDENT.test(name)) return null;
  let best: { end: number; rhs: string } | null = null;
  const directa = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*(?::[^=;]+)?=\s*`, "g");
  const resto = new RegExp(String.raw`\b(?:const|let|var)\s*\{[^}]*\.\.\.${name}\s*\}\s*=\s*`, "g");
  for (const re of [directa, resto]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const start = m.index + m[0].length;
      if (start >= before) break;
      // The RHS runs to the `;` that ends the statement at depth zero.
      let depth = 0;
      let end = -1;
      for (let i = start; i < clean.length; i++) {
        const c = clean[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === ";" && depth === 0) { end = i; break; }
      }
      if (end === -1 || end > before) continue;
      if (best === null || end > best.end) best = { end, rhs: clean.slice(start, end) };
    }
  }
  return best?.rhs ?? null;
}

/**
 * An expression followed through its aliases until it stops being a bare name.
 *
 * `resolved` is false when the chain ends at a name nothing declares, or when
 * it is deeper than `maxDepth` — both read as "this cannot be proven", and the
 * caller treats that as a finding. Depth is bounded because a chain that long
 * is not an idiom, it is somewhere to hide.
 */
export function resuelve(
  clean: string,
  expr: string,
  before: number,
  maxDepth = 5,
): { text: string; resolved: boolean } {
  let text = expr.trim();
  for (let i = 0; i < maxDepth; i++) {
    if (!IDENT.test(text)) return { text, resolved: true };
    const rhs = declaracion(clean, text, before);
    if (rhs === null) return { text, resolved: false };
    text = rhs.trim();
  }
  return { text, resolved: !IDENT.test(text) };
}

/**
 * The top-level properties of an object literal, `{ a: 1, b: f(x, y) }` → two
 * entries, split only at depth zero so a comma inside a call or a nested
 * object stays inside its value. Shorthand `{ a }` reads as `a: a`; a spread
 * reads as key `...` with the spread expression as its value.
 */
export function propiedades(literal: string): { key: string; value: string }[] {
  const body = literal.trim().replace(/^\{/, "").replace(/\}$/, "");
  const partes: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) { partes.push(body.slice(start, i)); start = i + 1; }
  }
  partes.push(body.slice(start));

  return partes
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      if (p.startsWith("...")) return { key: "...", value: p.slice(3).trim() };
      const colon = p.search(/:(?!:)/);
      if (colon === -1) return { key: p, value: p };
      return { key: p.slice(0, colon).trim().replace(/^["']|["']$/g, ""), value: p.slice(colon + 1).trim() };
    });
}

/** The 1-based line of position `at` in `text`. */
export const lineaDe = (text: string, at: number) => text.slice(0, at).split("\n").length;
