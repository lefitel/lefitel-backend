// The report catalog: the closed whitelist that defines what can be queried.
//
// Physical table names were verified against the live schema and are NOT what
// Sequelize's model names suggest: `revicions` carries a typo from the original
// migration, `ciudads`/`materials`/`rols` are naive pluralisations, and
// `eventoObs`/`tipoObs` are camelCase. Logical names used in paths never expose
// any of that — the mapping lives here and only here.

import type { Catalog, EntityDef } from "./types.js";

// Physical table names, kept in one place so the typo is contained.
const TABLE = {
  evento: "eventos",
  poste: "postes",
  ciudad: "ciudads",
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

const ciudad: EntityDef = {
  table: TABLE.ciudad,
  label: "Ciudad",
  paranoid: true,
  fields: {
    // Exposed because three cities share a name: without the id, two rows of a
    // city-rooted report are indistinguishable.
    id: { column: "id", kind: "number", label: "ID de la ciudad" },
    name: { column: "name", kind: "string", label: "Nombre" },
    lat: { column: "lat", kind: "number", label: "Latitud", decimals: true },
    lng: { column: "lng", kind: "number", label: "Longitud", decimals: true },
  },
  relations: {},
  /**
   * The counts that make a city worth a row of its own.
   *
   * **Every one of these counts a pole in both of its cities**, and that is not
   * a defect: a pole stands on a tramo between two cities and belongs to both
   * ends. But it means the column does not add up — summed over the 98 cities,
   * "Postes en sus tramos" gives 3.080 against 1.541 real poles (twice, less
   * the two poles whose two ends are the same city). The generator never totals
   * a column for you, so the risk is somebody doing it in a spreadsheet, and
   * the only defence is the header: every label here says "en sus tramos" so
   * the unit is named where it will be read.
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
        ` AND (p."id_ciudadA" = ${a}."id" OR p."id_ciudadB" = ${a}."id"))`,
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
        ` AND (p."id_ciudadA" = ${a}."id" OR p."id_ciudadB" = ${a}."id"))`,
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
        ` AND (p."id_ciudadA" = ${a}."id" OR p."id_ciudadB" = ${a}."id"))`,
    },
  },
};

const material: EntityDef = {
  table: TABLE.material,
  label: "Material",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Material" },
    description: { column: "description", kind: "string", label: "Descripción del material" },
  },
  relations: {},
};

const propietario: EntityDef = {
  table: TABLE.propietario,
  label: "Propietario",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Propietario" },
  },
  relations: {},
};

const tipoObs: EntityDef = {
  table: TABLE.tipoObs,
  label: "Tipo de observación",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Tipo de observación" },
    description: { column: "description", kind: "string", label: "Descripción del tipo" },
  },
  relations: {},
};

const rol: EntityDef = {
  // `rols` has no deletedAt column — verified against the live schema.
  table: TABLE.rol,
  label: "Rol",
  paranoid: false,
  fields: {
    name: { column: "name", kind: "string", label: "Rol" },
  },
  relations: {},
};

const obs: EntityDef = {
  table: TABLE.obs,
  label: "Observación",
  paranoid: true,
  fields: {
    id: { column: "id", kind: "number", label: "ID de la observación" },
    name: { column: "name", kind: "string", label: "Observación" },
    description: { column: "description", kind: "string", label: "Descripción de la observación" },
    criticality: { column: "criticality", kind: "number", label: "Criticidad", semantic: "criticality" },
  },
  relations: {
    tipoObs: { kind: "toOne", target: "tipoObs", label: "Tipo", localKey: "id_tipoObs" },
  },
};

/**
 * A person, and therefore personal data end to end.
 *
 * `staffOnly` on the entity is what hides it as a *root*: the fields already
 * carried the flag, but a root with every field hidden is a level of detail
 * that offers nothing, which is worse than not offering it. Reached through
 * `evento.usuario` the per-field flags still do the work.
 *
 * As a root it answers "who has been registering what" — and answers it only
 * halfway, because `revicions` and `solucions` carry no `id_usuario` at all.
 * An inspection and a repair have no recorded author in this schema; the
 * bitácora knows (1.319 ADD_REVISION entries do name their user) and the
 * business tables do not. So no report here can say who inspects the most.
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
    name: { column: "name", kind: "string", label: "Nombre del usuario", staffOnly: true },
    lastname: { column: "lastname", kind: "string", label: "Apellido del usuario", staffOnly: true },
    user: { column: "user", kind: "string", label: "Usuario", staffOnly: true },
    phone: { column: "phone", kind: "string", label: "Teléfono", staffOnly: true },
  },
  relations: {
    rol: { kind: "toOne", target: "rol", label: "Rol", localKey: "id_rol", staffOnly: true },
  },
  // Only what the schema actually records. There is no `id_usuario` on
  // `revicions` or `solucions`, so "revisiones hechas" cannot be counted here
  // at all — see the note above the entity.
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
  },
};

/**
 * Renders a tramo as "Ciudad A - Ciudad B" with the lower city id first.
 *
 * Archived cities fall out of the paranoid join, so their name is null; the
 * existing reports print "#<id>" in that case (reporte.controller.ts:228) and
 * this keeps that behaviour instead of showing an empty tramo.
 */
const tramoExpr = (a: string, dep: (path: string) => string): string => {
  const nameA = `COALESCE(${dep("ciudadA")}."name", '#' || ${a}."id_ciudadA")`;
  const nameB = `COALESCE(${dep("ciudadB")}."name", '#' || ${a}."id_ciudadB")`;
  return (
    `CASE WHEN ${a}."id_ciudadA" <= ${a}."id_ciudadB"` +
    ` THEN ${nameA} || ' - ' || ${nameB}` +
    ` ELSE ${nameB} || ' - ' || ${nameA} END`
  );
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
    ciudadA: { kind: "toOne", target: "ciudad", label: "Ciudad A", localKey: "id_ciudadA" },
    ciudadB: { kind: "toOne", target: "ciudad", label: "Ciudad B", localKey: "id_ciudadB" },
    usuario: { kind: "toOne", target: "usuario", label: "Registrado por", localKey: "id_usuario", staffOnly: true },
    eventos: { kind: "toMany", target: "evento", label: "Eventos", foreignKey: "id_poste" },
  },
  calculated: {
    // Mirrors reporte.controller.ts:225 — the lower city id always comes first,
    // so tramo (A,B) and (B,A) collapse into the same group.
    tramo: {
      kind: "string",
      label: "Tramo",
      deps: ["ciudadA", "ciudadB"],
      sql: (a, dep) => tramoExpr(a, dep),
      // Group by the id pair, not by the rendered name: the data contains
      // distinct cities sharing a name (Millares, Olivos, Pailas), and grouping
      // by text would merge tramos that are not the same. The name expression
      // is included so Postgres accepts it in the SELECT list; it is functionally
      // dependent on the ids, so it does not change the grouping.
      groupKeys: (a, dep) => [
        `LEAST(${a}."id_ciudadA", ${a}."id_ciudadB")`,
        `GREATEST(${a}."id_ciudadA", ${a}."id_ciudadB")`,
        tramoExpr(a, dep),
      ],
    },
    numEventos: {
      kind: "number",
      innerAgg: "count",
      label: "Total de eventos",
      sql: (a) =>
        `(SELECT COUNT(*) FROM "${TABLE.evento}" ev` +
        ` WHERE ev."id_poste" = ${a}."id" AND ev."deletedAt" IS NULL)`,
    },
    // `state` is nullable with no default, and the app treats any non-true
    // value as pending (reporte.controller.ts:244 uses !e.state). IS NOT TRUE
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
    usuario: { kind: "toOne", target: "usuario", label: "Registrado por", localKey: "id_usuario", staffOnly: true },
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
    // Mirrors reporte.controller.ts:353 — resolution is measured against the
    // last revision date, never updatedAt, and never goes below zero.
    // Resolution is measured against the last revision date, never updatedAt.
    // The inner query is an aggregate, so it always yields a row: with no
    // revisions MAX is NULL and GREATEST(0, NULL) is 0 in Postgres, which fed
    // phantom zeros into every average. The legacy report skips such events, so
    // this returns NULL and they drop out of AVG/MIN the same way.
    tiempoResolucion: {
      kind: "number",
      label: "Días de resolución",
      sql: (a) =>
        `CASE WHEN ${a}."state" IS TRUE THEN (` +
        `SELECT CASE WHEN MAX(r."date") IS NULL THEN NULL ELSE` +
        ` GREATEST(0, ROUND(EXTRACT(EPOCH FROM (MAX(r."date") - ${a}."createdAt")) / 86400))::int END` +
        ` FROM "${TABLE.revision}" r` +
        ` WHERE r."id_evento" = ${a}."id" AND r."deletedAt" IS NULL) END`,
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
   * `ciudad` and `usuario` are dimensions, and a dimension earns a root for one
   * reason only: **the zeros**. Grouping events by city shows the cities that
   * have events and never the 13 with no pole at all; the same for the accounts
   * that have registered nothing. Everything else a dimension can answer is
   * already reachable by grouping, which is why propietario (12), obs (32),
   * tipoObs (4), material (3) and rol (3) are deliberately not here.
   */
  roots: ["evento", "poste", "revision", "eventoObs", "solucion", "ciudad", "usuario"],
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
