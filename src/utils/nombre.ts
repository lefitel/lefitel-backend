/**
 * Everything that draws as nothing: whitespace, the format characters (zero
 * width space and joiners, word joiner, soft hyphen, the BOM) and the four
 * Hangul fillers, which are letters to Unicode and blanks to the eye. A name
 * made only of these passes `trim()` and renders as an empty line.
 */
const INVISIBLE = /[\s\p{Cf}ᅟᅠㅤﾠ]/gu;

/**
 * The name of a record as it will be stored, or why it is refused.
 *
 * Every catalogue here — roles, cities, materials, owners, observations and
 * their types, hardware — has a `name` column that takes NULL, and for a long
 * time nothing in front of any of them asked. One role saved without a name
 * was enough to take a screen down far from where it was made: the account
 * form lists the roles in a searchable picker, and the search lower-cases each
 * name. The pickers survive that now, but a nameless row is still a blank line
 * in every list and every report that shows it, so it is refused where it is
 * written rather than tolerated by every reader.
 *
 * What comes back is trimmed, and it is what gets written: checking the trimmed
 * name and storing the raw one would keep the padding the check looked past.
 *
 * `required` is false for an edit, which may leave the name alone — but may
 * not blank it. `name: undefined` is then the answer, and means "not sent".
 *
 * `mensaje` is the caller's, because the sentence names the thing: "La ciudad
 * necesita un nombre." tells somebody which field of which form to go back to.
 */
export function leerNombre(
  body: unknown,
  required: boolean,
  mensaje: string,
): { error: string } | { name: string | undefined } {
  const name = (body as { name?: unknown } | null | undefined)?.name;
  if (name === undefined && !required) return { name: undefined };
  if (typeof name !== "string" || name.replace(INVISIBLE, "") === "") return { error: mensaje };
  return { name: name.trim() };
}
