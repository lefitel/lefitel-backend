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

/** Roles allowed to see personal data of other users. */
const STAFF_ONLY = [1, 2];

// ─── Leaf entities (no outgoing relations worth exposing) ─────────────────────

const ciudad: EntityDef = {
  table: TABLE.ciudad,
  label: "Ciudad",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Nombre" },
    lat: { column: "lat", kind: "number", label: "Latitud" },
    lng: { column: "lng", kind: "number", label: "Longitud" },
  },
  relations: {},
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
    criticality: { column: "criticality", kind: "number", label: "Criticidad" },
  },
  relations: {
    tipoObs: { kind: "toOne", target: "tipoObs", label: "Tipo", localKey: "id_tipoObs" },
  },
};

const usuario: EntityDef = {
  // `pass` is deliberately absent. A test asserts no credential field ever
  // appears in the catalog.
  table: TABLE.usuario,
  label: "Usuario",
  paranoid: true,
  fields: {
    name: { column: "name", kind: "string", label: "Nombre del usuario", roles: STAFF_ONLY },
    lastname: { column: "lastname", kind: "string", label: "Apellido del usuario", roles: STAFF_ONLY },
    user: { column: "user", kind: "string", label: "Usuario", roles: STAFF_ONLY },
    phone: { column: "phone", kind: "string", label: "Teléfono", roles: STAFF_ONLY },
  },
  relations: {
    rol: { kind: "toOne", target: "rol", label: "Rol", localKey: "id_rol", roles: STAFF_ONLY },
  },
};

const solucion: EntityDef = {
  table: TABLE.solucion,
  label: "Solución",
  paranoid: true,
  fields: {
    description: { column: "description", kind: "string", label: "Descripción de la solución" },
    date: { column: "date", kind: "date", label: "Fecha de solución" },
    image: { column: "image", kind: "image", label: "Foto de la solución" },
  },
  relations: {},
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
    lat: { column: "lat", kind: "number", label: "Latitud" },
    lng: { column: "lng", kind: "number", label: "Longitud" },
  },
  relations: {
    propietario: { kind: "toOne", target: "propietario", label: "Propietario", localKey: "id_propietario" },
    material: { kind: "toOne", target: "material", label: "Material", localKey: "id_material" },
    ciudadA: { kind: "toOne", target: "ciudad", label: "Ciudad A", localKey: "id_ciudadA" },
    ciudadB: { kind: "toOne", target: "ciudad", label: "Ciudad B", localKey: "id_ciudadB" },
    usuario: { kind: "toOne", target: "usuario", label: "Registrado por", localKey: "id_usuario", roles: STAFF_ONLY },
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
    state: { column: "state", kind: "boolean", label: "Resuelto" },
    priority: { column: "priority", kind: "boolean", label: "Prioritario" },
    image: { column: "image", kind: "image", label: "Foto del evento" },
    createdAt: { column: "createdAt", kind: "date", label: "Fecha de registro" },
  },
  relations: {
    poste: { kind: "toOne", target: "poste", label: "Poste", localKey: "id_poste" },
    usuario: { kind: "toOne", target: "usuario", label: "Registrado por", localKey: "id_usuario", roles: STAFF_ONLY },
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
      sql: (a) =>
        `(SELECT MIN(o."criticality") FROM "${TABLE.eventoObs}" eo` +
        ` JOIN "${TABLE.obs}" o ON o."id" = eo."id_obs" AND o."deletedAt" IS NULL` +
        ` WHERE eo."id_evento" = ${a}."id" AND eo."deletedAt" IS NULL)`,
    },
    // Measured from `date`, the date of the incident, which is what the event
    // detail screen shows. Using createdAt diverged by 157 days on average
    // (max 678) because events are often registered long after they happen,
    // so every row would have contradicted the screen opened right after.
    diasAbierto: {
      kind: "number",
      label: "Días abierto",
      sql: (a) =>
        `CASE WHEN ${a}."state" IS NOT TRUE` +
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
    evento: { kind: "toOne", target: "evento", label: "Evento", localKey: "id_evento" },
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
    evento: { kind: "toOne", target: "evento", label: "Evento", localKey: "id_evento" },
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
  roots: ["evento", "poste", "revision", "eventoObs"],
};

/** Maximum relation hops allowed in a path, counted from the root. */
export const MAX_DEPTH = 3;

/** Hard ceiling on returned rows, applied above whatever limit the user asks for. */
export const MAX_ROWS = 50_000;

/** Per-query statement timeout in milliseconds. */
export const STATEMENT_TIMEOUT_MS = 15_000;
