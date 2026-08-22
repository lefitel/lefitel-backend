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
    // Six emoji are six characters, not twelve: each one is a surrogate
    // pair, two UTF-16 code units apiece, so `.length` would report 12 and
    // wrongly accept this as long enough. Only counting code points — the
    // spread in the implementation — correctly sees 6 and rejects it.
    // Accented BMP characters like "ñ" could not tell these two
    // implementations apart: they take one code unit each, so `.length`
    // and the spread agree on them, and a regression back to `.length`
    // would still pass a test built on those.
    const seisEmoji = "\u{1F600}".repeat(6);
    expect(validarPassword(seisEmoji)).not.toBeNull();
  });

  it("accepts twelve multi-byte characters as the twelve they are", () => {
    // The other side of the same fix: twelve emoji are twelve characters
    // and must be enough, even though `.length` would see 24.
    const doceEmoji = "\u{1F600}".repeat(12);
    expect(validarPassword(doceEmoji)).toBeNull();
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

  it("rejects a short secret padded out to the minimum with trailing spaces", () => {
    // "clave1" is six characters of actual secret; the other six are
    // trailing padding. Measuring the raw string let this through — the
    // length that matters is the trimmed one.
    expect(validarPassword("clave1      ")).not.toBeNull();
  });

  it("still counts spaces between words as part of the secret, not padding", () => {
    // Trimming only touches the two ends. A passphrase's internal spaces
    // are real secret and must stay counted, or this rule and the padding
    // rule above would be the same check pointed the wrong way.
    expect(validarPassword("el poste de la esquina")).toBeNull();
  });
});
