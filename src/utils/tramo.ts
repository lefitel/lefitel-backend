// What a pole's stretch is called, in one place.
//
// A pole runs between two cities and the screens print that as "Sucre > Potosí".
// The browser exporters built the same string with a template — `${a ?? ""} >
// ${b ?? ""}` — copied into the pole file and the incident file, which meant a
// pole missing both cities exported a cell containing literally " > ": not a
// name, not empty, and impossible to filter out in a spreadsheet.

interface Ciudad {
  name?: string | null;
}

/**
 * "Sucre > Potosí", "Sucre" when only one end is known, and empty when neither
 * is. An arrow with nothing on either side of it is not information.
 */
export const nombreDeTramo = (a?: Ciudad | null, b?: Ciudad | null): string => {
  const extremos = [a?.name, b?.name].filter((n): n is string => typeof n === "string" && n.trim() !== "");
  return extremos.join(" > ");
};
