import { describe, expect, it } from "vitest";
import { validarWaypoints } from "./waypoints.js";

/** `n` valid points somewhere over Bolivia, so only the count is under test. */
const puntos = (n: number) =>
  Array.from({ length: n }, (_, i) => [-68 + i * 0.001, -16 - i * 0.001]);

describe("validarWaypoints", () => {
  it("rechaza más puntos de los que ORS acepta por petición", () => {
    // Cincuenta es el tope documentado de ORS para directions. Sin este corte,
    // el servidor gasta una petición de la cuota para que ORS conteste 400 —
    // que es lo que hoy le pasa a tres de las cuatro pantallas.
    const res = validarWaypoints(puntos(51));

    expect(res.ok).toBe(false);
  });

  it("acepta justo el tope", () => {
    expect(validarWaypoints(puntos(50)).ok).toBe(true);
  });

  it("rechaza lo que no es un par de números", () => {
    // Sin esto, cualquier cosa con menos de cincuenta elementos se reenvía a
    // ORS tal cual y el 400 lo devuelve el proveedor, gastando cuota.
    expect(validarWaypoints([[-68, -16], ["hola", null]]).ok).toBe(false);
  });

  it("rechaza coordenadas fuera del planeta", () => {
    // Longitud 200 no existe. Un dedo de más en un formulario, o un [lat, lng]
    // puesto del revés cerca de los polos, llegan aquí antes que a la cuota.
    expect(validarWaypoints([[-68, -16], [200, -16]]).ok).toBe(false);
  });

  it("rechaza un trazado de menos de dos puntos", () => {
    expect(validarWaypoints([[-68, -16]]).ok).toBe(false);
  });
});
