// The report catalog: the closed whitelist that defines what can be queried.
//
// Physical table names were verified against the live schema and are NOT what
// Sequelize's model names suggest: `revicions` carries a typo from the original
// migration, `ciudads`/`materials`/`rols` are naive pluralisations, and
// `eventoObs`/`tipoObs` are camelCase. Logical names used in paths never expose
// any of that — the mapping lives here and only here.

import type { Catalog, EntityDef } from "./types.js";
import { sqlNombreDelTramo } from "../tramos/nombre.js";

// Physical table names, kept in one place so the typo is contained.
const TABLE = {
  evento: "eventos",
  poste: "postes",
  ciudad: "ciudads",
  tramo: "tramos",
  departamento: "departamentos",
  material: "materials",
  propietario: "propietarios",
  obs: "obs",
  tipoObs: "tipoObs",
  eventoObs: "eventoObs",
  solucion: "solucions",
  revision: "revicions",
  usuario: "usuarios",
  rol: "rols",
} as const;

// ─── Leaf entities (no outgoing relations worth exposing) ─────────────────────

/** `p` is a pole; true when it stands on a tramo the city `a` is one end of. */
const enUnTramoDe = (a: string): string =>
  `p."id_tramo" IN (SELECT t."id" FROM "${TABLE.tramo}" t` +
  ` WHERE t."id_ciudad_min" = ${a}."id" OR t."id_ciudad_max" = ${a}."id")`;

const ciudad: EntityDef = {
  table: TABLE.ciudad,
  label: "Ciudad",
  paranoid: true,
  fields: {
    // Exposed because a name does not identify a city: nothing in the table
    // forces names to be unique, and the id is the one thing that does. Today
    // the live names are distinct (94 of 94), so here it is a stable key to
    // match a row against, not a disambiguator; the archived duplicates the
    // tramo migration left behind are never listed, the root being paranoid.
    id: { column: "id", kind: "number", label: "ID de la ciudad" },
    name: { column: "name", kind: "string", label: "Nombre", optionList: true },
    lat: { column: "lat", kind: "number", label: "Latitud", decimals: true },
    lng: { column: "lng", kind: "number", label: "Longitud", decimals: true },
  },
  relations: {},
  /**
   * The counts that make a city worth a row of its own.
   *
   * **Every one of these counts a pole in both of its cities**, and that is not
   * a defect: a pole stands on a tramo between two cities and belongs to both
   * ends. But it means the column does not add up — summed over the 94 cities,
   * "Postes en sus tramos" gives 3.082 against 1.541 real poles (exactly twice:
   * no tramo has the same city at both ends). The generator never totals a
   * column for you, so the risk is somebody doing it in a spreadsheet, and the
   * only defence is the header: every label here says "en sus tramos" so the
   * unit is named where it will be read.
   *
   * A city is reached through no relation, so these are the only way to see it
   * from here — and the reason a city root exists at all is the zeros:
   * grouping events by city shows the cities that *have* events, and never the
   * 13 that have no pole at all.
   */
  calculated: {
    numPostes: {
      kind: "number",
      innerAgg: "count",
      label: "Postes en sus tramos",
      rootOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.poste}" p WHERE p."deletedAt" IS NULL` +
        ` AND ${enUnTramoDe(a)})`,
    },
    numEventos: {
      kind: "number",
      innerAgg: "count",
      label: "Eventos en sus tramos",
      rootOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" e` +
        ` JOIN "${TABLE.poste}" p ON p."id" = e."id_poste" AND p."deletedAt" IS NULL` +
        ` WHERE e."deletedAt" IS NULL` +
        ` AND ${enUnTramoDe(a)})`,
    },
    // `state` is nullable with no default and the app treats anything but true
    // as pending, so IS NOT TRUE keeps eventos = pendientes + resueltos.
    numPendientes: {
      kind: "number",
      innerAgg: "count",
      label: "Eventos pendientes en sus tramos",
      rootOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" e` +
        ` JOIN "${TABLE.poste}" p ON p."id" = e."id_poste" AND p."deletedAt" IS NULL` +
        ` WHERE e."deletedAt" IS NULL AND e."state" IS NOT TRUE` +
        ` AND ${enUnTramoDe(a)})`,
    },
  },
};

/**
 * A stretch of line between two cities, and the second dimension that earns a
 * root for the same reason the first did: the zeros. A tramo with no pole on it
 * never shows up in a report that starts from poles, events or inspections, and
 * "which stretches have we not covered" is the question this root answers.
 * Until now a tramo existed here only as two calculated columns of `poste`.
 *
 * **It has no direction, and nothing here may give it one.** `id_ciudad_min` and
 * `id_ciudad_max` are the two city ids in numeric order and nothing more, so a
 * relation or a field for either end would be an "A" and a "B" that the data
 * does not have. That is why there is no relation to a city: the name already
 * carries both, written once by `tramos/nombre.ts`, and the two columns reach
 * the SQL only inside that function.
 *
 * **Unlike the city's, these counts add up.** A pole stands on exactly one
 * tramo, so each pole and each event is counted once, on one row, and the
 * column totals to the poles, events and pending events of the live tramos —
 * which is why the labels do not say "en sus tramos". The city's three count a
 * pole at both of its ends and sum to twice the real figure; the label there is
 * the only defence, and here there is nothing to defend against.
 *
 * **The author is staff-only here, and on a pole it is not.** On a pole or an
 * event the name of whoever registered it is provenance that the client
 * screens already print ("Creador"), so the user entity leaves it open. Nothing
 * prints a tramo's author, so the same name here would be a new disclosure
 * rather than a column the screens already show.
 *
 * Reached from no other entity, on purpose: `poste` keeps its two scalar
 * columns (`tramo`, `departamento`) so that a pole's tramo costs no hop from
 * the deeper roots, and a relation back here would spend one. That also means
 * the `rootOnly` flag below prunes nothing today; it states that these are
 * "one row per tramo" summaries, as the city's and the user's are.
 */
const tramo: EntityDef = {
  table: TABLE.tramo,
  label: "Tramo",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID del tramo" },
    createdAt: { column: "createdAt", kind: "date", label: "Fecha de registro" },
  },
  relations: {
    // Staff-only, unlike `poste.usuario`: no screen prints a tramo's author, so
    // there is no provenance column to defend, and the design keeps it out of
    // other people's responses (§6 of the tramo design; the model says the
    // author is shown behind `seguridad.ver` and nowhere else). A viewer
    // without it does not see the relation, cannot build a path through it,
    // and a saved report carrying one is pruned.
    usuario: {
      kind: "toOne", target: "usuario", label: "Registrado por", localKey: "id_usuario", staffOnly: true,
    },
  },
  calculated: {
    // The field that names the row, as `name` does on the catalogue entities —
    // but it cannot carry `optionList`, which marks a stored column and is
    // read from a model, so a filter on it is a text box.
    nombre: {
      kind: "string",
      label: "Tramo",
      sql: (a) => sqlNombreDelTramo(`${a}."id"`),
      // By the id, as `poste.tramo` does and for the same reason: two stretches
      // can read the same, and grouping by text would merge them into one row.
      groupKeys: (a) => [`${a}."id"`, sqlNombreDelTramo(`${a}."id"`)],
    },
    // NULL when the tramo has none (`id_departamento` is nullable), which the
    // ordinary "está vacío" / "tiene valor" operators of a text field express.
    // `departamentos` has no `deletedAt`, so there is nothing to guard. A closed
    // list of nine, so the filter is offered its values (`fieldOptions.ts`).
    departamento: {
      kind: "string",
      optionList: true,
      label: "Departamento",
      sql: (a) =>
        `(SELECT d."name" FROM "${TABLE.departamento}" d WHERE d."id" = ${a}."id_departamento")`,
    },
    numPostes: {
      kind: "number",
      innerAgg: "count",
      label: "Postes",
      rootOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.poste}" p WHERE p."deletedAt" IS NULL` +
        ` AND p."id_tramo" = ${a}."id")`,
    },
    // Events on live poles only, as the city's count does (the user's
    // `numEventos` has no pole guard: it counts every live event the person
    // registered). An event whose pole was archived is not work in hand.
    numEventos: {
      kind: "number",
      innerAgg: "count",
      label: "Eventos",
      rootOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" e` +
        ` JOIN "${TABLE.poste}" p ON p."id" = e."id_poste" AND p."deletedAt" IS NULL` +
        ` WHERE e."deletedAt" IS NULL AND p."id_tramo" = ${a}."id")`,
    },
    // `state` is nullable with no default and the app treats anything but true
    // as pending, so IS NOT TRUE keeps eventos = pendientes + resueltos.
    numPendientes: {
      kind: "number",
      innerAgg: "count",
      label: "Eventos pendientes",
      rootOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" e` +
        ` JOIN "${TABLE.poste}" p ON p."id" = e."id_poste" AND p."deletedAt" IS NULL` +
        ` WHERE e."deletedAt" IS NULL AND e."state" IS NOT TRUE` +
        ` AND p."id_tramo" = ${a}."id")`,
    },
  },
};

const material: EntityDef = {
  table: TABLE.material,
  label: "Material",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Material", optionList: true },
    description: { column: "description", kind: "string", label: "Descripción del material" },
  },
  relations: {},
};

const propietario: EntityDef = {
  table: TABLE.propietario,
  label: "Propietario",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Propietario", optionList: true },
  },
  relations: {},
};

const tipoObs: EntityDef = {
  table: TABLE.tipoObs,
  label: "Tipo de observación",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Tipo de observación", optionList: true },
    description: { column: "description", kind: "string", label: "Descripción del tipo" },
  },
  relations: {},
};

const rol: EntityDef = {
  // Not paranoid here although the table is: `rols` gained `deletedAt` in
  // 20260826000001-add-rol-archiving, and the role controller refuses to
  // archive a role somebody holds, so a user never points at an archived one.
  // Leaving the guard off keeps a role's name on its user if that ever changes.
  table: TABLE.rol,
  label: "Rol",
  paranoid: false,
  fields: {
    name: { column: "name", kind: "string", label: "Rol", optionList: true },
  },
  relations: {},
};

const obs: EntityDef = {
  table: TABLE.obs,
  label: "Observación",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID de la observación" },
    name: { column: "name", kind: "string", label: "Observación", optionList: true },
    description: { column: "description", kind: "string", label: "Descripción de la observación" },
    criticality: { column: "criticality", kind: "number", label: "Criticidad", semantic: "criticality" },
  },
  relations: {
    tipoObs: { kind: "toOne", target: "tipoObs", label: "Tipo", localKey: "id_tipoObs" },
  },
};

/**
 * A person: partly provenance, partly the staff directory, and the line between
 * them is what this entity's flags draw.
 *
 * **Authorship is provenance, and provenance is not personal data.** Whoever may
 * see a pole may see who registered it and who has worked on it — decision of
 * Isaias, 2026-09-05, correcting a rule that was too wide. The flag used to sit
 * on `name` and `lastname` too, which meant a coordinator could not put
 * "Registrado por" in a report about their own team's work, while the incident
 * list on screen showed them that same name in a column called *Creador*. The
 * client screens are what set the line: they print the person's name as
 * provenance and nothing else about them.
 *
 * So `name` and `lastname` are open, and the rest of the record is not: `user`
 * is a credential half, `phone` is a way to reach somebody, `rol` is what they
 * are allowed to do, and the counts are a productivity ranking. Those are the
 * staff directory, which `seguridad.ver` administers.
 *
 * **`staffOnly` on the entity is what still hides it as a *root*.** That is the
 * question this does not open: "give me everything Juan has done" is asking
 * about a person rather than about the work, and it is the same question
 * `GET /api/usuario/:id/eventos` asks — closed in C5 with the same
 * permission. Reached through `evento.usuario` the per-field flags do the work,
 * and they now let the name through.
 *
 * Said plainly, because it follows and is not hidden: with the name readable as
 * a column and filterable, a reader can ask "the events registered by Juan".
 * The list endpoint already answers that with `limit=all` and a filter in the
 * browser, so refusing it here would hide in one place what another hands over.
 *
 * As a root it answers "who has been registering what", and since the
 * authorship migration that includes inspections and repairs, which are the
 * volume of the field work: 7.741 and 1.071 rows against 1.376 events.
 *
 * Read the four counts knowing what they are counting. Events and poles have
 * had an author since the beginning. Inspections and repairs only have one
 * where the bitácora could name it, and these two counts apply the same
 * archived-event guard a revision-rooted report does, so what they sum to is
 * **1.289 + 422 = 1.711** — not the 1.345 + 513 the backfill wrote, and
 * nowhere near the 8.812 rows the two tables hold. Under two months of a
 * two-year history, three accounts out of fifteen.
 *
 * So they are honest per person and useless as a share of the whole, and a
 * report that ranks people by them is ranking the last two months. What is
 * missing is missing for good; the null author is the record saying so.
 */
const usuario: EntityDef = {
  // `pass` is deliberately absent. A test asserts no credential field ever
  // appears in the catalog.
  table: TABLE.usuario,
  label: "Usuario",
  paranoid: true,
  staffOnly: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID del usuario", staffOnly: true },
    // The two that carry provenance, and the only two the client screens print
    // as one: "Creador", on the incident and pole lists. Open to whoever may
    // read the record they hang off.
    name: { column: "name", kind: "string", label: "Nombre del usuario" },
    lastname: { column: "lastname", kind: "string", label: "Apellido del usuario" },
    // The directory half, and it stays shut: `user` is one of the two halves of
    // a credential, `phone` is a way to reach somebody at home.
    user: { column: "user", kind: "string", label: "Usuario", staffOnly: true },
    phone: { column: "phone", kind: "string", label: "Teléfono", staffOnly: true },
  },
  relations: {
    rol: { kind: "toOne", target: "rol", label: "Rol", localKey: "id_rol", staffOnly: true },
  },
  calculated: {
    numEventos: {
      kind: "number",
      innerAgg: "count",
      label: "Eventos registrados",
      rootOnly: true,
      staffOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" e` +
        ` WHERE e."id_usuario" = ${a}."id" AND e."deletedAt" IS NULL)`,
    },
    numPostes: {
      kind: "number",
      innerAgg: "count",
      label: "Postes dados de alta",
      rootOnly: true,
      staffOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.poste}" p` +
        ` WHERE p."id_usuario" = ${a}."id" AND p."deletedAt" IS NULL)`,
    },
    // Both counts exclude rows hanging off an archived event — 404 inspections
    // and 81 repairs. Not a detail: a report rooted at `revision` already drops
    // them (see requiredParentGuards), so without the same guard here the same
    // person's inspections would come to 831 in one report and 846 in another,
    // both looking authoritative and neither explaining itself.
    numRevisiones: {
      kind: "number",
      innerAgg: "count",
      label: "Revisiones hechas",
      rootOnly: true,
      staffOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.revision}" r` +
        ` WHERE r."id_usuario" = ${a}."id" AND r."deletedAt" IS NULL` +
        ` AND EXISTS (SELECT 1 FROM "${TABLE.evento}" e` +
        ` WHERE e."id" = r."id_evento" AND e."deletedAt" IS NULL))`,
    },
    numSoluciones: {
      kind: "number",
      innerAgg: "count",
      label: "Soluciones registradas",
      rootOnly: true,
      staffOnly: true,
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.solucion}" s` +
        ` WHERE s."id_usuario" = ${a}."id" AND s."deletedAt" IS NULL` +
        ` AND EXISTS (SELECT 1 FROM "${TABLE.evento}" e` +
        ` WHERE e."id" = s."id_evento" AND e."deletedAt" IS NULL))`,
    },
  },
};

/**
 * A repair that was carried out.
 *
 * Reachable from an event as `solucion` — a `toOneLatest`, so *the most recent
 * one* — and that was the only way in, which made a whole question
 * unanswerable: "what work was done in March" came out as one row per event
 * whose latest repair fell in March, never one row per repair. Five events
 * carry two solutions, and those five second repairs could not be shown at all.
 *
 * So it is a root as well. The relation up to the event is `required`, like
 * revision's: a repair whose event was archived is history, not work in hand,
 * and leaving it in would show a row with every event column empty.
 */
const solucion: EntityDef = {
  table: TABLE.solucion,
  label: "Solución",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID de la solución" },
    description: { column: "description", kind: "string", label: "Descripción de la solución" },
    date: { column: "date", kind: "date", label: "Fecha de solución" },
    image: { column: "image", kind: "image", label: "Foto de la solución" },
  },
  relations: {
    evento: {
      kind: "toOne", target: "evento", label: "Evento", localKey: "id_evento", required: true,
    },
    // Deliberately NOT `required`, unlike the event above, and the difference
    // is 558 rows. `required` is an unconditional EXISTS on the FK, so with a
    // null `id_usuario` it matches nothing and the row leaves the report —
    // whether or not the report ever mentions the author. Every repair from
    // before the bitácora would vanish from every count, silently.
    usuario: {
      kind: "toOne", target: "usuario", label: "Resuelto por", localKey: "id_usuario",
    },
  },
};

// ─── Core entities ────────────────────────────────────────────────────────────

const poste: EntityDef = {
  table: TABLE.poste,
  label: "Poste",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID del poste" },
    name: { column: "name", kind: "string", label: "Nº de poste" },
    image: { column: "image", kind: "image", label: "Foto del poste" },
    date: { column: "date", kind: "date", label: "Fecha de instalación" },
    lat: { column: "lat", kind: "number", label: "Latitud", decimals: true },
    lng: { column: "lng", kind: "number", label: "Longitud", decimals: true },
  },
  relations: {
    propietario: { kind: "toOne", target: "propietario", label: "Propietario", localKey: "id_propietario" },
    material: { kind: "toOne", target: "material", label: "Material", localKey: "id_material" },
    usuario: { kind: "toOne", target: "usuario", label: "Registrado por", localKey: "id_usuario" },
    eventos: { kind: "toMany", target: "evento", label: "Eventos", foreignKey: "id_poste" },
  },
  calculated: {
    // The name a tramo has everywhere else: `tramos/nombre.ts`, whose SQL twin
    // this is. A scalar subquery rather than a relation, and that is the point:
    // a pole is already two hops away from an inspection or a repair, and the
    // cities sit two further — one more than MAX_DEPTH allows. Costing no hop
    // is what keeps this field offered from every root.
    tramo: {
      kind: "string",
      label: "Tramo",
      sql: (a) => sqlNombreDelTramo(`${a}."id_tramo"`),
      // By the id, not by the rendered name: two stretches can read the same.
      // The name is listed so Postgres accepts it in the SELECT; it depends on
      // the id, so it does not change the grouping.
      groupKeys: (a) => [`${a}."id_tramo"`, sqlNombreDelTramo(`${a}."id_tramo"`)],
    },
    departamento: {
      kind: "string",
      optionList: true,
      label: "Departamento del tramo",
      sql: (a) =>
        `(SELECT d."name" FROM "${TABLE.tramo}" t` +
        ` JOIN "${TABLE.departamento}" d ON d."id" = t."id_departamento"` +
        ` WHERE t."id" = ${a}."id_tramo")`,
    },
    numEventos: {
      kind: "number",
      innerAgg: "count",
      // "Nº de …" like its two siblings on `evento`, not "Total de …": the same
      // number had two names depending on which root you reached it from, and
      // the server quoted whichever one the configuration happened to use.
      label: "Nº de eventos",
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" ev` +
        ` WHERE ev."id_poste" = ${a}."id" AND ev."deletedAt" IS NULL)`,
    },
    // `state` is nullable with no default, and the app treats any non-true
    // value as pending (the fixed reports count `!e.state` as pending). IS NOT TRUE
    // keeps numEventos = numPendientes + numResueltos even with null states.
    numPendientes: {
      kind: "number",
      innerAgg: "count",
      label: "Eventos pendientes",
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" ev` +
        ` WHERE ev."id_poste" = ${a}."id" AND ev."deletedAt" IS NULL AND ev."state" IS NOT TRUE)`,
    },
    numResueltos: {
      kind: "number",
      innerAgg: "count",
      label: "Eventos resueltos",
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" ev` +
        ` WHERE ev."id_poste" = ${a}."id" AND ev."deletedAt" IS NULL AND ev."state" IS TRUE)`,
    },
  },
};

const evento: EntityDef = {
  table: TABLE.evento,
  label: "Evento",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID del evento" },
    description: { column: "description", kind: "string", label: "Descripción" },
    date: { column: "date", kind: "date", label: "Fecha del evento" },
    state: { column: "state", kind: "boolean", label: "Resuelto", semantic: "state" },
    priority: { column: "priority", kind: "boolean", label: "Prioritario" },
    image: { column: "image", kind: "image", label: "Foto del evento" },
    createdAt: { column: "createdAt", kind: "date", label: "Fecha de registro" },
  },
  relations: {
    poste: { kind: "toOne", target: "poste", label: "Poste", localKey: "id_poste" },
    usuario: { kind: "toOne", target: "usuario", label: "Registrado por", localKey: "id_usuario" },
    // Modelled as hasMany in Sequelize, but every existing report renders a
    // single solution. Resolved with LATERAL so it behaves as a plain column.
    solucion: { kind: "toOneLatest", target: "solucion", label: "Solución", foreignKey: "id_evento", latestBy: "date" },
    ultimaRevision: { kind: "toOneLatest", target: "revision", label: "Última revisión", foreignKey: "id_evento", latestBy: "date" },
    revisiones: { kind: "toMany", target: "revision", label: "Revisiones", foreignKey: "id_evento" },
    observaciones: { kind: "toMany", target: "eventoObs", label: "Observaciones", foreignKey: "id_evento" },
  },
  calculated: {
    // Lowest criticality across the event's observations (1 = catastrophic),
    // null when none are classified. Mirrors getEventCriticality in the frontend.
    criticidad: {
      kind: "number",
      label: "Criticidad del evento",
      semantic: "criticality",
      sql: (a) =>
        `(SELECT MIN(o."criticality") FROM "${TABLE.eventoObs}" eo` +
        ` JOIN "${TABLE.obs}" o ON o."id" = eo."id_obs" AND o."deletedAt" IS NULL` +
        ` WHERE eo."id_evento" = ${a}."id" AND eo."deletedAt" IS NULL)`,
    },
    // Measured from `date`, the date of the incident, which is what the event
    // detail screen shows. Using createdAt diverged by 157 days on average
    // (max 678) because events are often registered long after they happen,
    // so every row would have contradicted the screen opened right after.
    // `date` is nullable, and `GREATEST` in Postgres ignores nulls rather than
    // propagating them: `GREATEST(0, NULL)` is 0, so an event with no date read
    // as "abierto hace 0 días" — a fact, printed with the same confidence as
    // the real ones, about something nobody knows. The sibling below documents
    // the same trap and guards against it; this one did not. Today only one
    // event has no date and it is resolved, so the CASE hides it: the day
    // somebody registers a pending event without a date, the column lies.
    diasAbierto: {
      kind: "number",
      label: "Días abierto",
      sql: (a) =>
        `CASE WHEN ${a}."state" IS NOT TRUE AND ${a}."date" IS NOT NULL` +
        ` THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - ${a}."date")) / 86400))::int END`,
    },
    // Mirrors getTiemposResumen: evento.date → the solution's date. The repair
    // closes the evento; a revision is a site visit and closes nothing, so
    // measuring to the last revision measured the wrong thing entirely.
    //
    // The inner query is an aggregate and always yields a row, so an evento
    // with no solution must return NULL explicitly or MAX being NULL would feed
    // a phantom into the averages. Same for the incoherent ones — a repair
    // dated before the fault: the legacy report discards them, and NULL is how
    // they drop out of AVG/MIN/MAX here too. A GREATEST(0, …) would instead
    // publish them as repaired the same day, which is what used to happen to a
    // third of the closed eventos.
    tiempoResolucion: {
      kind: "number",
      label: "Días hasta la reparación",
      sql: (a) =>
        `CASE WHEN ${a}."state" IS TRUE THEN (` +
        `SELECT CASE WHEN MAX(s."date") IS NULL OR MAX(s."date") < ${a}."date" THEN NULL ELSE` +
        ` ROUND(EXTRACT(EPOCH FROM (MAX(s."date") - ${a}."date")) / 86400)::int END` +
        ` FROM "${TABLE.solucion}" s` +
        ` WHERE s."id_evento" = ${a}."id" AND s."deletedAt" IS NULL) END`,
    },
    numRevisiones: {
      kind: "number",
      innerAgg: "count",
      label: "Nº de revisiones",
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.revision}" r` +
        ` WHERE r."id_evento" = ${a}."id" AND r."deletedAt" IS NULL)`,
    },
    numObservaciones: {
      kind: "number",
      innerAgg: "count",
      label: "Nº de observaciones",
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.eventoObs}" eo` +
        ` WHERE eo."id_evento" = ${a}."id" AND eo."deletedAt" IS NULL)`,
    },
  },
};

const revision: EntityDef = {
  table: TABLE.revision,
  label: "Revisión",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID de la revisión" },
    date: { column: "date", kind: "date", label: "Fecha de revisión" },
    description: { column: "description", kind: "string", label: "Descripción de la revisión" },
  },
  relations: {
    evento: {
      kind: "toOne", target: "evento", label: "Evento", localKey: "id_evento", required: true,
    },
    // Optional, for the same reason as solucion.usuario and at eleven times the
    // cost: 6.396 of 7.741 inspections have no recorded author, against 558 of
    // 1.071 repairs.
    usuario: {
      kind: "toOne", target: "usuario", label: "Revisado por", localKey: "id_usuario",
    },
  },
};

const eventoObs: EntityDef = {
  table: TABLE.eventoObs,
  label: "Observación registrada",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID del registro" },
  },
  relations: {
    evento: {
      kind: "toOne", target: "evento", label: "Evento", localKey: "id_evento", required: true,
    },
    ob: { kind: "toOne", target: "obs", label: "Observación", localKey: "id_obs" },
  },
};

export const catalog: Catalog = {
  entities: {
    evento,
    poste,
    revision,
    eventoObs,
    ciudad,
    tramo,
    material,
    propietario,
    obs,
    tipoObs,
    solucion,
    usuario,
    rol,
  },
  // Each root defines what a single row of the report represents.
  /**
   * Each root defines what one row means, so this list is the set of questions
   * the generator can answer. The four facts came first — an event, a pole, an
   * inspection, an observation. `solucion` is the fifth fact and was missing.
   *
   * `ciudad`, `tramo` and `usuario` are dimensions, and a dimension earns a root
   * for one reason only: **the zeros**. Grouping events by city shows the cities
   * that have events and never the 13 with no pole at all; grouping poles by
   * tramo shows the tramos that have poles and never one that has none; the same
   * for the accounts that have registered nothing. Everything else a dimension
   * can answer is already reachable by grouping, which is why propietario (12),
   * obs (32), tipoObs (4), material (3), rol (3) and departamento (9, only ever
   * a name beside a tramo) are deliberately not here.
   */
  roots: ["evento", "poste", "revision", "eventoObs", "solucion", "ciudad", "tramo", "usuario"],
};

/** Maximum relation hops allowed in a path, counted from the root. */
export const MAX_DEPTH = 3;

/** Hard ceiling on returned rows, applied above whatever limit the user asks for. */
export const MAX_ROWS = 50_000;

/** Per-query statement timeout in milliseconds. */
export const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Every date in a report is read in Bolivia, wherever the server happens to run.
 *
 * It lives here rather than beside the formatters because filtering needs it
 * too: a date column is `timestamp with time zone`, and asking for "los eventos
 * del 23 de mayo" has to mean the day the report prints, not the day the
 * server's session happens to be in. When the two disagreed, 362 of 1.376
 * events — 26% — were filed under a day the same report showed differently.
 */
export const REPORT_TIME_ZONE = "America/La_Paz";
