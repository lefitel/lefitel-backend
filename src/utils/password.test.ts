// What counts as a password here.
//
// Length and a blocklist, and nothing else. Composition rules — one capital,
// one digit, one symbol — have been advised against since 2017 because of what
// they actually produce: `Password1!`, and a sticky note on the monitor.

import { describe, it, expect } from "vitest";
import { validarPassword } from "./password.js";

describe("validarPassword", () => {
  it("accepts a long ordinary passphrase", () => {
    expect(validarPassword("el poste de la esquina")).toBeNull();
  });

  it("rejects one that is too short", () => {
    expect(validarPassword("corta1")).toMatch(/12/);
  });

  it("counts characters, not bytes", () => {
    // Twelve accented characters are twelve characters. Counting bytes would
    // let a shorter password through, and would be nobody's intent.
    expect(validarPassword("ñññññññññññí")).toBeNull();
  });

  it("rejects a common password even when it is long enough", () => {
    expect(validarPassword("contraseña123")).not.toBeNull();
    expect(validarPassword("qwertyuiop123")).not.toBeNull();
  });

  it("ignores case when checking the blocklist", () => {
    expect(validarPassword("CONTRASEÑA123")).not.toBeNull();
  });

  it("does not demand symbols or capitals", () => {
    expect(validarPassword("caballo bateria grapa")).toBeNull();
  });

  it("rejects whitespace-only padding", () => {
    // Twelve spaces is twelve characters and no secret at all.
    expect(validarPassword("            ")).not.toBeNull();
  });
});
