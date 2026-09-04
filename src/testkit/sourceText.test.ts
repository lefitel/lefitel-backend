// The reader the four shape tests share, tried on the shapes that fooled them.
//
// Every case below is one the audit of 3 September ran against the old walkers
// and watched pass: a `}` in a string, a `}` in a comment, a two-level alias, a
// destructured rest, a shadowed name. A reader that fails one of these is a
// reader that lets a leaking catch or an unfiltered write through, so this file
// is what has to be green before any of the four can be trusted.

import { describe, it, expect } from "vitest";
import { sinLiterales, cierra, declaracion, resuelve, propiedades, lineaDe } from "./sourceText.js";

describe("sinLiterales", () => {
  it("keeps every position and every newline", () => {
    const src = `const a = "x}y";\n// }\nconst b = 1;`;
    const out = sinLiterales(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).toContain("const a =");
    expect(out).toContain("const b = 1;");
  });

  it("blanks a brace inside a double-quoted string", () => {
    // The quotes stay, the content goes: same length, no brace.
    expect(sinLiterales(`f("}")`)).toBe(`f(" ")`);
  });

  it("blanks a brace inside a single-quoted string and a line comment", () => {
    const out = sinLiterales(`{ const s = '}'; // cierra con }\n}`);
    expect(out).not.toMatch(/'\}'/);
    expect(out.indexOf("}")).toBe(out.length - 1);
  });

  it("blanks a block comment but keeps the code after it", () => {
    const out = sinLiterales(`a /* } { */ b`);
    expect(out).toBe(`a           b`);
  });

  it("blanks a template literal but keeps the expression in its hole", () => {
    const out = sinLiterales("`a}b${x.y}c}`");
    expect(out).toContain("x.y");
    expect(out).not.toContain("}b");
    // The `}` that closes the hole is code and stays; the ones in text do not.
    expect(out.split("}").length - 1).toBe(1);
  });

  it("survives a nested brace inside a template hole", () => {
    const out = sinLiterales("`${ f({ a: 1 }) }` + '}'");
    expect(out).toContain("f({ a: 1 })");
    expect(out.endsWith("' '")).toBe(true);
  });

  it("respects an escaped quote", () => {
    const out = sinLiterales(`"a\\"}" + x`);
    expect(out).toContain("+ x");
    expect(out).not.toContain("}");
  });
});

describe("cierra", () => {
  it("matches the brace it was given, past nested ones", () => {
    const t = `{ a { b } c }`;
    expect(cierra(t, 0)).toBe(t.length - 1);
  });

  it("throws on an unmatched opener", () => {
    expect(() => cierra(`{ a { b }`, 0)).toThrow(/no tiene pareja/);
  });

  it("throws when asked to start on something that is not the opener", () => {
    expect(() => cierra(`x{}`, 0)).toThrow(/no hay/);
  });

  it("works for parentheses and brackets too", () => {
    expect(cierra(`f(a, (b))`, 1, "()")).toBe(8);
    expect(cierra(`[1, [2]]`, 0, "[]")).toBe(7);
  });
});

describe("declaracion and resuelve", () => {
  it("resolves one level", () => {
    const src = `const editable = assignable(req.body); row.set(editable);`;
    expect(resuelve(src, "editable", src.indexOf("row.set"))).toEqual({
      text: "assignable(req.body)",
      resolved: true,
    });
  });

  it("resolves two levels — the shape the old lookup passed over", () => {
    const src = `const b = req.body; const c = b; Model.create(c);`;
    expect(resuelve(src, "c", src.indexOf("Model")).text).toBe("req.body");
  });

  it("resolves a destructured rest to its source", () => {
    const src = `const { id, ...rest } = req.body; Model.create(rest);`;
    expect(resuelve(src, "rest", src.indexOf("Model")).text).toBe("req.body");
  });

  it("takes the nearest declaration before the call, not the first in the file", () => {
    const src = `const p = pick(x); f(p);\nconst p = req.body; g(p);`;
    expect(resuelve(src, "p", src.indexOf("f(p)")).text).toBe("pick(x)");
    expect(resuelve(src, "p", src.indexOf("g(p)")).text).toBe("req.body");
  });

  it("ignores a declaration that comes after the call", () => {
    const src = `f(p); const p = req.body;`;
    expect(resuelve(src, "p", 0)).toEqual({ text: "p", resolved: false });
  });

  it("reports a name nothing declares as unresolved", () => {
    expect(resuelve(`Model.create(values);`, "values", 0)).toEqual({ text: "values", resolved: false });
  });

  it("stops at a bounded depth and says so", () => {
    const src = `const a = req.body; const b = a; const c = b; const d = c; const e = d; const f = e; x(f);`;
    expect(resuelve(src, "f", src.length, 3).resolved).toBe(false);
    expect(resuelve(src, "f", src.length, 10).text).toBe("req.body");
  });

  it("reads through a type annotation", () => {
    const src = `const v: Record<string, unknown> = req.body; x(v);`;
    expect(resuelve(src, "v", src.indexOf("x(v)")).text).toBe("req.body");
  });

  it("does not stop at a semicolon inside the right-hand side", () => {
    const src = `const v = f(() => { a; b; }); x(v);`;
    expect(declaracion(src, "v", src.indexOf("x(v)"))).toBe("f(() => { a; b; })");
  });
});

describe("propiedades", () => {
  it("splits at depth zero only", () => {
    expect(propiedades(`{ before: pick(a, ["x", "y"]), after: req.body }`)).toEqual([
      { key: "before", value: `pick(a, ["x", "y"])` },
      { key: "after", value: "req.body" },
    ]);
  });

  it("reads shorthand and spread", () => {
    expect(propiedades(`{ ...req.body, id_usuario, x: 1 }`)).toEqual([
      { key: "...", value: "req.body" },
      { key: "id_usuario", value: "id_usuario" },
      { key: "x", value: "1" },
    ]);
  });

  it("keeps a nested object as one value", () => {
    expect(propiedades(`{ after: { name: n, deep: { a: 1 } } }`)).toEqual([
      { key: "after", value: "{ name: n, deep: { a: 1 } }" },
    ]);
  });
});

describe("lineaDe", () => {
  it("is one-based", () => {
    expect(lineaDe("a\nb\nc", 0)).toBe(1);
    expect(lineaDe("a\nb\nc", 4)).toBe(3);
  });
});
