import { describe, expect, it } from "vitest";
import { coordenadasInvalidas } from "./coordenadas.js";

describe("coordenadasInvalidas", () => {
  it("lets a real pair through, as numbers or as text", () => {
    expect(coordenadasInvalidas({ lat: -22.048385, lng: -63.6844 })).toBeNull();
    expect(coordenadasInvalidas({ lat: "-22.048385", lng: "-63.6844" })).toBeNull();
    // The edges are coordinates too.
    expect(coordenadasInvalidas({ lat: 90, lng: -180 })).toBeNull();
    expect(coordenadasInvalidas({ lat: 0, lng: 0 })).toBeNull();
  });

  it("refuses the six pairs found stored, each for the field that is wrong", () => {
    // As they were in the table: a decimal point lost in the typing.
    for (const lat of [-22048385017.82594, -10101630, -167426350]) {
      expect(coordenadasInvalidas({ lat, lng: -63.6844 })).toMatch(/latitud/);
    }
    for (const lng of [-666.668161, -652112270, -65528673]) {
      expect(coordenadasInvalidas({ lat: -17.710695, lng })).toMatch(/longitud/);
    }
  });

  it("refuses what is not a number at all", () => {
    // `[]`, `false`, `" "` and `null` are the ones `Number()` turns into 0.
    for (const valor of [null, "", " ", "abc", NaN, Infinity, true, false, {}, [], [5]]) {
      expect(coordenadasInvalidas({ lat: valor, lng: -63 })).toMatch(/latitud/);
      expect(coordenadasInvalidas({ lat: -17, lng: valor })).toMatch(/longitud/);
    }
  });

  it("judges only what the request carries", () => {
    // A partial update — renaming a pole — names neither and must pass, and one
    // that moves only the longitude is judged on the longitude alone.
    expect(coordenadasInvalidas({ name: "P52" })).toBeNull();
    expect(coordenadasInvalidas({ lng: -63.68 })).toBeNull();
    expect(coordenadasInvalidas({ lng: -636.8 })).toMatch(/longitud/);
    expect(coordenadasInvalidas(undefined)).toBeNull();
  });
});
