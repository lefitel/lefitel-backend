/**
 * Whether a body's `lat` and `lng` are coordinates at all.
 *
 * Nothing checked them. The form parses whatever is typed and the API stored
 * it, so a decimal point lost in the typing went in as written: a pole at
 * latitude -22.048.385.017 where -22,048385 was meant. Six of 1.541 poles
 * carried one, and each cost more than itself — every screen that draws a
 * stretch sends all of its poles to the routing endpoint, which refuses the
 * whole request over one impossible point, so the stretch came out as a
 * straight line for everybody on it.
 *
 * Only what is present is judged, so a partial update that names neither field
 * passes untouched. A number written as text is read as that number — the body
 * can arrive either way — and anything else is not a coordinate.
 *
 * @returns the sentence to answer with, or null when there is nothing wrong.
 */
export function coordenadasInvalidas(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { lat, lng } = body as { lat?: unknown; lng?: unknown };

  const fuera = (valor: unknown, limite: number): boolean => {
    if (valor === undefined) return false;
    // A number, or text that is one — and nothing else. `Number` is generous:
    // `""`, `" "`, `null`, `false` and `[]` all come out as 0, which is a real
    // latitude, so the type is settled before it is asked.
    if (typeof valor === "string" ? valor.trim() === "" : typeof valor !== "number") return true;
    const n = Number(valor);
    return !Number.isFinite(n) || n < -limite || n > limite;
  };

  if (fuera(lat, 90)) return "La latitud debe ser un número entre -90 y 90.";
  if (fuera(lng, 180)) return "La longitud debe ser un número entre -180 y 180.";
  return null;
}
