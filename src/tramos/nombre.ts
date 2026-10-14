// What a tramo is called, and in which order its two ends are read.
//
// A tramo has no direction: Sucre and Potosí are each the start or the end
// depending on where you set off from. So nothing in the data can decide which
// city comes first in the name, and a name that changed with the order of two
// columns is how the same stretch came to be written five ways on five
// screens. The order is decided here, once, by the names themselves.
//
// **It exists twice, on purpose, and the two must agree.** Controllers hold
// rows and call `nombreDeTramo`; the report generator and every `ORDER BY`
// hold SQL and call `sqlNombreDeTramo`. They agree because both compare the
// trimmed names without any locale: `<` on JavaScript strings (UTF-16 code
// units), `COLLATE "C"` in Postgres (bytes of the UTF-8, i.e. code points). Those
// orders coincide except between a character above U+FFFF and one in
// U+E000–U+FFFF, which city names do not contain. The price is visible and
// accepted: an accented capital sorts after Z.
// `tramos.db.test.ts` compares the two over every row of a real database.

const SEPARADOR = " – ";

export interface Extremo {
  id: number;
  name?: string | null;
}

const etiqueta = (e: Extremo): string => {
  const nombre = typeof e.name === "string" ? e.name.trim() : "";
  return nombre !== "" ? nombre : `#${e.id}`;
};

/** The two ends in the order the name reads them. Ties go to the lower id. */
export const ordenarExtremos = <T extends Extremo>(a: T, b: T): [T, T] => {
  const na = etiqueta(a);
  const nb = etiqueta(b);
  if (na !== nb) return na < nb ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
};

export const nombreDeTramo = (a: Extremo, b: Extremo): string =>
  ordenarExtremos(a, b).map(etiqueta).join(SEPARADOR);

/**
 * The same name as an SQL expression.
 *
 * @param t   alias of a `tramos` row
 * @param min alias of the `ciudads` row joined on `id_ciudad_min`
 * @param max alias of the `ciudads` row joined on `id_ciudad_max`
 *
 * The joins are the caller's and must be LEFT and unfiltered: an archived city
 * still names its tramo, exactly as the includes do with `paranoid: false`.
 */
export const sqlNombreDeTramo = (t: string, min: string, max: string): string => {
  const a = `COALESCE(NULLIF(btrim(${min}."name"), ''), '#' || ${t}."id_ciudad_min")`;
  const b = `COALESCE(NULLIF(btrim(${max}."name"), ''), '#' || ${t}."id_ciudad_max")`;
  return (
    `CASE WHEN (${a} COLLATE "C", ${t}."id_ciudad_min") <= (${b} COLLATE "C", ${t}."id_ciudad_max")` +
    ` THEN ${a} || '${SEPARADOR}' || ${b} ELSE ${b} || '${SEPARADOR}' || ${a} END`
  );
};

const DESDE_TRAMOS =
  `FROM "tramos" t` +
  ` LEFT JOIN "ciudads" cmin ON cmin."id" = t."id_ciudad_min"` +
  ` LEFT JOIN "ciudads" cmax ON cmax."id" = t."id_ciudad_max"`;

/** The name of the tramo whose id is the given SQL expression. */
export const sqlNombreDelTramo = (idTramo: string): string =>
  `(SELECT ${sqlNombreDeTramo("t", "cmin", "cmax")} ${DESDE_TRAMOS} WHERE t."id" = ${idTramo})`;

/**
 * The name of the tramo of the pole whose id is the given SQL expression.
 *
 * For an `ORDER BY` on a query whose pole is a joined include: Sequelize may
 * wrap the main table in a subquery to paginate, and an order that names the
 * include's alias then points at nothing. This one names only the root column.
 */
export const sqlNombreDelTramoDelPoste = (idPoste: string): string =>
  `(SELECT ${sqlNombreDeTramo("t", "cmin", "cmax")} ${DESDE_TRAMOS}` +
  ` INNER JOIN "postes" p ON p."id_tramo" = t."id" WHERE p."id" = ${idPoste})`;
