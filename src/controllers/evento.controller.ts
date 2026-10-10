import { Request, Response } from "express";
import { literal, Op, Order } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { deleteImageIfUnreferenced } from "../utils/imageRefs.js";
import { authoredBy, withoutAuthor } from "../utils/authorship.js";
import { logAction } from "../utils/logAction.js";
import { archivar, NADA_QUE_ARCHIVAR, desarchivar, NADA_QUE_DESARCHIVAR } from "../utils/archivado.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { EventoModel } from "../models/evento.model.js";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { ObsModel } from "../models/obs.model.js";
import { PosteModel, POSTE_PUBLIC_ATTRIBUTES } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { RevisionModel, REVISION_PUBLIC_ATTRIBUTES } from "../models/revision.model.js";
import { SolucionModel } from "../models/solucion.model.js";
import { UsuarioModel, USUARIO_AS_AUTHOR } from "../models/usuario.model.js";
import type { IEvento } from "../interfaces/index.js";
import {
  construirFichero, esFormato, responderFichero, responderFalloDeExport,
  subtituloDeFiltros, type Columna,
} from "../exports/tabla.js";
import { exportSlot } from "../reportBuilder/export/queue.js";
import { MAX_EXPORT_ROWS } from "../reportBuilder/export/index.js";
import { etiquetaCriticidad, peorCriticidad } from "../utils/criticidad.js";
import { nombreDeTramo } from "../utils/tramo.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const eventoLog = log("evento");
const handler = makeHandler(eventoLog);

/**
 * Everything that decides *which* incidents, resolved once for the endpoints
 * that need it.
 *
 * The twin of `filtroDePostes`, and it exists for the same reason: the list and
 * the export have to agree row for row. This one carries more, because an
 * incident is filtered by three things that are not columns of its own table —
 * the pole it stands on, whether it is resolved, and how bad it is, which lives
 * in the observation catalogue and is reached by the sub-select below.
 *
 * `posteWhere` comes back separately because it does not belong in the root
 * `where`: it constrains the joined pole, and putting it in the wrong place is
 * the difference between "incidents on poles named X" and no rows at all.
 */
export interface FiltroEventos {
  where: Record<string, unknown>;
  order: Order;
  paranoid: boolean;
  isArchived: boolean;
  /** Belongs inside the pole include, never in the root `where`. */
  posteWhere: Record<string, unknown> | undefined;
  /** The active filters in the screen\'s own words, for the export to print. */
  descripcion: string[];
}

export const filtroDeEventos = (query: Request["query"]): FiltroEventos | string => {
  const { archived, filterColumn, filterValue, sortBy, sortOrder } = query;
  const isArchived = archived === "true";

  const filterCols = Array.isArray(filterColumn) ? filterColumn as string[] : filterColumn ? [filterColumn as string] : [];
  const filterVals = Array.isArray(filterValue) ? filterValue as string[] : filterValue ? [filterValue as string] : [];
  const getFilterVal = (col: string) => {
    const idx = filterCols.indexOf(col);
    if (idx < 0) return undefined;
    const v = filterVals[idx];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  /**
   * The columns this endpoint really filters by, and anything else is refused.
   *
   * The pole list got this rule in C3 and this one did not, which left the two
   * screens disagreeing about what an unrecognised filter means: one answers a
   * sentence, the other quietly returns every row with the filter chip drawn as
   * active on screen. The second is worse than an error, because the user reads
   * the result as the answer to the question they asked.
   *
   * Five, and the set is exactly what the screen can send: `description` and
   * `poste` from the column filter bar, and `state`, `criticality` and
   * `priority` from the three quick filters above the table.
   */
  const FILTRABLE = new Set(["description", "poste", "state", "criticality", "priority"]);
  const desconocida = filterCols.find((col) => !FILTRABLE.has(col));
  if (desconocida !== undefined) {
    return `No se puede filtrar la lista de incidencias por «${desconocida}».`;
  }

  const where: Record<string, unknown> = isArchived ? { deletedAt: { [Op.ne]: null } } : {};

  const descripcion: string[] = [];
  if (isArchived) descripcion.push("archivadas");

  const descVal = getFilterVal("description");
  if (descVal) {
    where["description"] = { [Op.iLike]: `%${descVal}%` };
    descripcion.push(`descripción contiene «${descVal}»`);
  }

  const posteVal = getFilterVal("poste");
  const posteWhere = posteVal ? { name: { [Op.iLike]: `%${posteVal}%` } } : undefined;
  if (posteVal) descripcion.push(`poste contiene «${posteVal}»`);

  // `state` is nullable, so "pendiente" cannot be `state = false`: that misses
  // the rows where nobody ever set it. The screen calls anything that is not
  // resolved pending, and so does this.
  /**
   * The three closed vocabularies, refused when the value is not one of them.
   *
   * `FILTRABLE` above checks the column and this checks the value, and leaving
   * the second out was the same defect one level deeper:
   * `?filterColumn=state&filterValue=resuelto` — the Spanish word, an easy
   * thing to send — matched neither branch, applied nothing, and answered
   * every incident with the filter drawn as active on screen. Unreachable from
   * the segmented controls, which only emit these values; reachable from the
   * API and from the export, which is where a wrong answer travels furthest.
   *
   * The criticality bands are checked a few lines down, where their Map is.
   */
  const VALORES: Record<string, readonly string[]> = {
    state: ["pending", "solved"],
    priority: ["true", "false"],
  };
  for (const [col, permitidos] of Object.entries(VALORES)) {
    const val = getFilterVal(col);
    if (val !== undefined && !permitidos.includes(val)) {
      return `No se puede filtrar la lista de incidencias por «${col}» con el valor «${val}».`;
    }
  }

  const stateVal = getFilterVal("state");
  if (stateVal === "pending") { where["state"] = { [Op.not]: true }; descripcion.push("pendientes"); }
  if (stateVal === "solved") { where["state"] = true; descripcion.push("resueltas"); }

  const priorityVal = getFilterVal("priority");
  if (priorityVal === "true") { where["priority"] = true; descripcion.push("solo prioritarias"); }
  if (priorityVal === "false") { where["priority"] = { [Op.not]: true }; descripcion.push("sin prioridad"); }

  // Criticality is a property of the observation catalogue, not of the event,
  // so both the filter and the sort below reach it the same way: the worst
  // level — lowest number, 1 is catastrophic — among the event's observations.
  // Same rule as `getEventCriticality` on the frontend, which is what paints
  // the column, so the two cannot disagree about a row.
  //
  // It deliberately does not exclude archived observations, because the include
  // further down sends them (`paranoid: false`) and the column shows them. A
  // filter that hid what its own column displays would make the screen
  // contradict itself. Whether archiving an observation should quietly drop an
  // event out of "críticas" is an open decision — see
  // docs/AUDITORIA-INCIDENCIAS.md — and the report builder answers it the other
  // way today. When that is settled, both places move together.
  const WORST_CRITICALITY =
    '(SELECT MIN(o."criticality") FROM "eventoObs" eo' +
    ' JOIN "obs" o ON o."id" = eo."id_obs"' +
    ' WHERE eo."id_evento" = "evento"."id" AND eo."deletedAt" IS NULL)';

  // A Map, not an object literal: `"constructor" in {}` is true through the
  // prototype, so an object would have accepted `criticality=constructor` and
  // built `BETWEEN undefined AND undefined`. The bands are also the only values
  // that ever reach the SQL string — the request's own text never does.
  const CRITICALITY_BANDS = new Map<string, [number, number] | null>([
    ["criticas", [1, 3]],
    ["altas", [4, 5]],
    ["medias", [6, 7]],
    ["bajas", [8, 9]],
    ["sin", null],
  ]);
  const critVal = getFilterVal("criticality");
  // Same rule as the two above: a band this endpoint does not know is refused,
  // not ignored. Written here rather than in `VALORES` because the list of
  // bands is the Map itself, and a second copy of it would be a second thing to
  // keep in step.
  if (critVal !== undefined && !CRITICALITY_BANDS.has(critVal)) {
    return `No se puede filtrar la lista de incidencias por «criticality» con el valor «${critVal}».`;
  }
  const critBand = critVal !== undefined && CRITICALITY_BANDS.has(critVal)
    // `get` returns null for "sin", which is a band, so the presence check
    // above is what decides — not the value.
    ? { range: CRITICALITY_BANDS.get(critVal) ?? null }
    : undefined;
  const NOMBRE_BANDA: Record<string, string> = {
    criticas: "gravedad crítica (1-3)",
    altas: "gravedad alta (4-5)",
    medias: "gravedad media (6-7)",
    bajas: "gravedad baja (8-9)",
    sin: "sin clasificar",
  };
  if (critBand && critVal !== undefined) descripcion.push(NOMBRE_BANDA[critVal]);

  const critCondition = critBand
    ? literal(
      critBand.range
        ? `${WORST_CRITICALITY} BETWEEN ${critBand.range[0]} AND ${critBand.range[1]}`
        : `${WORST_CRITICALITY} IS NULL`,
    )
    : undefined;

  // `deletedAt` for the Archivados tab, which pages on the server since C3 and
  // would otherwise offer an order the server drops. `updatedAt` for the same
  // reason: the Columnas menu can show it, its header sorts, and it was not
  // here — so the arrow moved and the rows did not.
  const SORTABLE = new Set(["id", "description", "date", "state", "priority", "createdAt", "updatedAt", "deletedAt"]);
  const sortByCols = Array.isArray(sortBy) ? sortBy as string[] : sortBy ? [sortBy as string] : [];
  const sortOrderVals = Array.isArray(sortOrder) ? sortOrder as string[] : sortOrder ? [sortOrder as string] : [];
  const orderEntries = sortByCols.map((col, i) => {
    const dir = sortOrderVals[i] === "asc" ? "ASC" : "DESC";
    if (col === "ultimaRev")        return [literal('(SELECT MAX("date") FROM "revicions" WHERE "revicions"."id_evento" = "evento"."id" AND "revicions"."deletedAt" IS NULL)'), `${dir} NULLS LAST`];
    if (col === "fechaResolucion")  return [literal('(SELECT "date" FROM "solucions" WHERE "solucions"."id_evento" = "evento"."id" AND "solucions"."deletedAt" IS NULL LIMIT 1)'), `${dir} NULLS LAST`];
    if (col === "criticality")      return [literal(WORST_CRITICALITY), `${dir} NULLS LAST`];
    if (col === "poste")            return [PosteModel, "name", dir];
    if (col === "usuario")      return [UsuarioModel, "name", dir];
    if (col === "propietario")  return [PosteModel, PropietarioModel, "name", dir];
    if (col === "tramo")        return [PosteModel, { model: CiudadModel, as: "ciudadA" }, "name", dir];
    return SORTABLE.has(col) ? [col, dir] : null;
  }).filter(Boolean);

  return {
    where: critCondition ? { ...where, [Op.and]: [critCondition] } : where,
    order: (orderEntries.length ? orderEntries : [["id", "DESC"]]) as Order,
    paranoid: !isArchived,
    isArchived,
    posteWhere,
    descripcion,
  };
};

export const getEvento = handler("getEvento", async (req: Request, res: Response) => {
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const filtro = filtroDeEventos(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });

  const queryOptions = {
    order: filtro.order,
    paranoid: filtro.paranoid,
    where: filtro.where,
    attributes: { exclude: ["image"] },
    include: [
      {
        model: RevisionModel,
        separate: true,
        attributes: ["id", "date", "id_evento"],
      },
      {
        model: SolucionModel,
        separate: true,
        attributes: ["id", "date", "id_evento"],
      },
      {
        model: PosteModel,
        paranoid: false,
        attributes: ["id", "name", "lat", "lng", "id_ciudadA", "id_ciudadB", "id_propietario"],
        ...(filtro.posteWhere ? { where: filtro.posteWhere, required: true } : {}),
        include: [
          { model: CiudadModel, as: "ciudadA", paranoid: false, attributes: ["id", "name"] },
          { model: CiudadModel, as: "ciudadB", paranoid: false, attributes: ["id", "name"] },
          { model: PropietarioModel, paranoid: false, attributes: ["id", "name"] },
        ],
      },
      {
        model: EventoObsModel,
        separate: true,
        attributes: ["id", "id_obs", "id_evento"],
        // `criticality` is what the Gravedad column paints and what the filter
        // above selects on. Without it the list could name the observation but
        // not say how bad it is, which is how an urgent event became
        // unfindable on the very screen an alert sends you to.
        include: [{ model: ObsModel, paranoid: false, attributes: ["id", "name", "criticality"] }],
      },
      {
        model: UsuarioModel,
        attributes: [...USUARIO_AS_AUTHOR],
      },
    ],
  };

  // `distinct` because this query joins a `hasMany`: without it Postgres counts
  // one row per revision and the total is several times the number of incidents.
  const listado = await listar(EventoModel, queryOptions, paginacion, true);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});

// ── Export ────────────────────────────────────────────────────────────

/**
 * The columns of the incident file.
 *
 * Thirteen where the browser had twelve, and the difference is what pays for
 * the colour. The spreadsheet tints a resolved row green and shades the rest by
 * how bad they are — the same rule, and the same palette, the report generator
 * has always used — but it can only tint by a column it is printing: there is
 * no way to colour a row by a value the sheet does not contain. So the two
 * columns the tint reads are real columns.
 *
 * That is why `Estado` became `Resuelto` with Sí/No rather than staying
 * Resuelto/Pendiente: the tint needs the boolean, and a boolean column headed
 * "Estado" reading "Sí" would be a worse cell than either. And why `Gravedad`
 * is now the number and `Clasificación` its name, where the browser wrote
 * "3 - Sujeto a árbol" into one: the tint needs the number, and a reader who
 * only gets the number has to go and find out what 3 means.
 *
 * No author column, and no `id_usuario`. The listing sends both in every row;
 * the screen draws neither, and a file naming the employee behind each of
 * 1.514 incidents is the report §6 closed `/api/usuario/:id/eventos` to prevent.
 */
const COLUMNAS_EVENTO: readonly Columna[] = [
  { key: "n", label: "#", kind: "number" },
  { key: "poste", label: "Poste", kind: "string" },
  { key: "tramo", label: "Tramo", kind: "string" },
  { key: "propietario", label: "Propietario", kind: "string" },
  { key: "lat", label: "Lat", kind: "number" },
  { key: "lng", label: "Lng", kind: "number" },
  { key: "description", label: "Descripción", kind: "string" },
  { key: "state", label: "Resuelto", kind: "boolean", semantic: "state" },
  { key: "criticality", label: "Gravedad", kind: "number", semantic: "criticality" },
  { key: "clasificacion", label: "Clasificación", kind: "string" },
  { key: "priority", label: "Prioritario", kind: "boolean" },
  { key: "ultimaRevision", label: "Última revisión", kind: "date" },
  { key: "observaciones", label: "Observaciones", kind: "string" },
];

/** What the export query brings back, and nothing else. */
type EventoExportado = Pick<IEvento, "id" | "description" | "state" | "priority"> & {
  poste?: {
    name?: string | null;
    lat?: number | null;
    lng?: number | null;
    ciudadA?: { name?: string | null } | null;
    ciudadB?: { name?: string | null } | null;
    propietario?: { name?: string | null } | null;
  } | null;
  revisions?: { date: Date | string }[] | null;
  eventoObs?: { ob?: { name?: string | null; criticality?: number | null } | null }[] | null;
};

/**
 * The incident list as a spreadsheet, a CSV or a document.
 *
 * POST with no body, filters in the query — the reasons are written out over
 * `exportarPostes`, and they are the same two here.
 */
export const exportarEventos = handler("exportarEventos", async (req: Request, res: Response) => {
  const { format } = req.query;
  if (!esFormato(format)) {
    return res.status(400).json({ message: "Formato no válido. Use «excel», «csv» o «pdf»." });
  }

  const filtro = filtroDeEventos(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });

  /**
   * The rows are read **inside** the slot, not before it.
   *
   * The slot exists so that only one export is assembling anything at a time,
   * and the first version took it only around `construirFichero` — which left
   * the larger half unprotected. Twenty thousand incidents plus their
   * revisions and observations, all resident, is a bigger peak than the
   * workbook built from them; and ten of those can be in flight at once per
   * person, which is what the budget allows. The report generator resolves
   * only the viewer outside its slot and runs its query inside, for this
   * reason.
   */
  try {
    const fichero = await exportSlot.run(async () => {
    const filas = (await EventoModel.findAll({
      where: filtro.where,
      paranoid: filtro.paranoid,
      order: filtro.order,
      attributes: ["id", "description", "state", "priority"],
      include: [
        { model: RevisionModel, separate: true, attributes: ["id", "date", "id_evento"] },
        {
          model: PosteModel,
          paranoid: false,
          attributes: ["id", "name", "lat", "lng"],
          ...(filtro.posteWhere ? { where: filtro.posteWhere, required: true } : {}),
          include: [
            { model: CiudadModel, as: "ciudadA", paranoid: false, attributes: ["id", "name"] },
            { model: CiudadModel, as: "ciudadB", paranoid: false, attributes: ["id", "name"] },
            { model: PropietarioModel, paranoid: false, attributes: ["id", "name"] },
          ],
        },
        {
          model: EventoObsModel,
          separate: true,
          attributes: ["id", "id_obs", "id_evento"],
          include: [{ model: ObsModel, paranoid: false, attributes: ["id", "name", "criticality"] }],
        },
        // Joined so `sortBy=usuario` has a table to order by, and read by no
        // column below. The shared filter maps that order to `UsuarioModel`, the
        // listing includes it and this did not, so pressing the Creador header
        // and then Exportar answered a neutral 500 — Postgres refusing an
        // `ORDER BY "usuario"."name"` with no such table in the query.
        { model: UsuarioModel, attributes: ["id", "name"] },
      ],
      limit: MAX_EXPORT_ROWS + 1,
    })).map((fila, i) => {
      const e = fila.toJSON() as EventoExportado;
      const nivel = peorCriticidad(e.eventoObs);
      // `Math.max` of an empty list is -Infinity, which becomes an Excel date in
      // 1899 rather than an empty cell. Hence the length check and not a `??`.
      const fechas = (e.revisions ?? [])
        .map((r) => new Date(r.date).getTime())
        .filter((t) => Number.isFinite(t));
      return {
        n: i + 1,
        poste: e.poste?.name ?? null,
        tramo: nombreDeTramo(e.poste?.ciudadA, e.poste?.ciudadB),
        propietario: e.poste?.propietario?.name ?? null,
        lat: e.poste?.lat ?? null,
        lng: e.poste?.lng ?? null,
        description: e.description,
        state: e.state === true,
        criticality: nivel,
        clasificacion: etiquetaCriticidad(nivel),
        priority: e.priority === true,
        ultimaRevision: fechas.length ? new Date(Math.max(...fechas)) : null,
        observaciones: (e.eventoObs ?? []).map((eo) => eo.ob?.name).filter(Boolean).join(", "),
      };
    });

      return construirFichero({
        formato: format,
        columnas: COLUMNAS_EVENTO,
        filas,
        titulo: filtro.isArchived ? "Incidencias archivadas" : "Incidencias",
        subtitulo: subtituloDeFiltros(filtro.descripcion),
        sustantivo: ["incidencia", "incidencias"],
        hoja: "Incidencias",
      });
    });

    logAction({
      id_usuario: req.user?.id,
      action: "EXPORT_EVENTO",
      entity: "Evento",
      entity_id: null,
      detail: `Exportó ${fichero.filas} incidencias a ${format}`,
      metadata: { formato: format, filas: fichero.filas, bytes: fichero.buffer.length, archivados: filtro.isArchived, filtros: filtro.descripcion },
      severity: "info",
      ip_address: req.ip ?? null,
    });

    return responderFichero(res, fichero);
  } catch (error) {
    if (responderFalloDeExport(res, error)) return;
    throw error;
  }
});

export const getEvento_poste = handler("getEvento_poste", async (req: Request, res: Response) => {
  const { id } = req.params;
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const listado = await listar(EventoModel, {
    where: { id_poste: id },
    order: [["id", "DESC"]],
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});

export const getEvento_usuario = handler("getEvento_usuario", async (req: Request, res: Response) => {
  const { id } = req.params;
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  // The envelope earns its keep here more than anywhere: the profile screen and
  // the staff detail screen both compute "total incidents" and a resolution
  // percentage from `length`, so a truncated list did not look truncated — it
  // looked like an appraisal.
  const listado = await listar(EventoModel, {
    where: { id_usuario: id },
    order: [["id", "DESC"]],
    include: [{ model: PosteModel, attributes: ["id", "name"] }],
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});

export const searchEvento = handler("searchEvento", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempEvento = await EventoModel.findOne({
    where: { id },
    include: [
      { model: RevisionModel, attributes: [...REVISION_PUBLIC_ATTRIBUTES] },
      {
        model: PosteModel,
        attributes: [...POSTE_PUBLIC_ATTRIBUTES],
        include: [
          { model: CiudadModel, as: "ciudadA" },
          { model: CiudadModel, as: "ciudadB" },
          { model: PropietarioModel },
        ],
      },
      // Never the bare model: it would send `pass`. See USUARIO_AS_AUTHOR.
      { model: UsuarioModel, attributes: [...USUARIO_AS_AUTHOR] },
      { model: EventoObsModel, include: [{ model: ObsModel, paranoid: false }] },
    ],
  });
  // 404 rather than 200 with `null`: see `searchPoste`. Here the screen does
  // guard every read with `?.`, so the result was a detail page with every
  // field empty and nothing saying why.
  if (!TempEvento) return res.status(404).json({ message: "El evento no existe." });
  res.status(200).json(TempEvento);
});

export const createEvento = handler("createEvento", async (req: Request, res: Response) => {
  const { revision, obs_ids, ...eventoBody } = req.body;
  const TempEvento = await sequelize.transaction(async (t) => {
    // `eventoBody` is the request body minus two keys, so without this an
    // account could register an event in somebody else's name — and two of
    // the four counts in the per-person report (catalog.ts, the `usuario`
    // root) would be client-controlled. The frontend only ever sends the
    // logged-in user's own id, so nothing legitimate changes.
    const evento = await EventoModel.create(authoredBy(eventoBody, req), { transaction: t });
    const eventoId = evento.dataValues.id as number;
    if (revision?.description) {
      await RevisionModel.create({
        description: revision.description,
        date: revision.date ?? eventoBody.date ?? new Date(),
        id_evento: eventoId,
        // Built field by field rather than spread from the body, so the
        // author is the session by construction. The event's own
        // `id_usuario` travels in `eventoBody` and is a separate question.
        id_usuario: req.user?.id ?? null,
      }, { transaction: t });
    }
    if (Array.isArray(obs_ids) && obs_ids.length > 0) {
      await Promise.all(
        (obs_ids as number[]).map((id_obs) =>
          EventoObsModel.create({ id_obs, id_evento: eventoId }, { transaction: t })
        )
      );
    }
    return evento;
  });
  const eventoId = TempEvento.dataValues.id as number;

  let obsLabel: string | null = null;
  if (Array.isArray(obs_ids) && obs_ids.length > 0) {
    const obsRows = await ObsModel.findAll({
      where: { id: obs_ids },
      attributes: ["name"],
      paranoid: false,
    });
    obsLabel = obsRows.map((r) => r.dataValues.name).join(", ") || null;
  }

  const posteRow = eventoBody.id_poste != null ? await PosteModel.findByPk(eventoBody.id_poste, { attributes: ["id", "name"], paranoid: false }) : null;
  const posteRef = posteRow ? { id: posteRow.dataValues.id, name: posteRow.dataValues.name } : (eventoBody.id_poste ?? null);
  logAction({
    id_usuario: req.user?.id,
    action: "CREATE_EVENTO",
    entity: "Evento",
    entity_id: eventoId,
    detail: `Creó evento en Poste #${eventoBody.id_poste}`,
    metadata: {
      after: {
        description: eventoBody.description,
        id_poste: posteRef,
        ...(obsLabel ? { obs: obsLabel } : {}),
        ...(revision?.description ? { revision: revision.description } : {}),
      },
    },
    severity: 'info',
  });
  res.status(201).json(TempEvento);
});
export const updateEvento = handler("updateEvento", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempEvento = await EventoModel.findOne({ where: { id } });
  if (!TempEvento) return res.status(404).json({ message: "Evento no encontrado" });
  const oldImage = TempEvento.dataValues.image;
  const edv = TempEvento.dataValues as unknown as Record<string, unknown>;

  // `state` is dropped before anything reads the body, not overwritten after.
  //
  // Whether an event is resolved is kept in step with its `solucions` row by
  // `/resolve` and `/reopen`, and by nothing else. Letting a PUT move it
  // broke that pairing in both directions: the priority toggle in the events
  // table sends the whole row it had loaded (`{ ...evento, priority }`), so a
  // stale `state: false` reopened an event somebody had just resolved and
  // left the solution alive underneath it. Two people working at once was
  // enough; no bad actor required.
  //
  // Dropping it here rather than at the write also keeps it out of the diff
  // below, which otherwise recorded a state change in the bitácora that the
  // request never applied.
  const { obs_ids, state: _stateIsNotEditable, ...bodyWithoutObs } = req.body;

  // The diff below is computed from what will actually be written, not from
  // what arrived. `withoutAuthor` refuses `id_usuario` at the write, and a log
  // that records the refused change is worse than no log at all: the bitácora is
  // the one place a reader goes to find out who reassigned a row.
  const editable = withoutAuthor(bodyWithoutObs);
  const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
  const beforeMeta: Record<string, unknown> = {};
  const afterMeta:  Record<string, unknown> = {};
  for (const k of Object.keys(editable)) {
    const bv = edv[k];
    if (bv === undefined || k === "id_poste") continue;
    if (isPrimVal(bv) && isPrimVal(editable[k])) { beforeMeta[k] = bv; afterMeta[k] = editable[k]; }
  }
  const bvPoste = edv["id_poste"] as number | null | undefined;
  const avPoste = editable["id_poste"] as number | null | undefined;
  // Only when the request actually carries id_poste. A partial update that
  // omits it leaves the column untouched, but this used to record
  // `after: {id_poste: null}` — a change that never happened, written into
  // the audit log as if it had.
  const postePresent = Object.hasOwn(editable, "id_poste");
  if (postePresent && bvPoste !== undefined && bvPoste !== avPoste) {
    const fkRef = async (pkVal: number | null | undefined) => {
      if (pkVal == null) return null;
      const row = await PosteModel.findByPk(pkVal, { attributes: ["id", "name"], paranoid: false });
      return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
    };
    [beforeMeta["id_poste"], afterMeta["id_poste"]] = await Promise.all([fkRef(bvPoste), fkRef(avPoste)]);
  }
  let obsLogData: { before: string | null; after: string | null } | null = null;

  await sequelize.transaction(async (t) => {
    // Not reassignable through the edit form either: this used to let a PUT
    // change the author of an event that already existed, and CREATE_EVENTO's
    // bitácora metadata does not carry `id_usuario`, so nothing recorded it.
    TempEvento.set(editable);
    await TempEvento.save({ transaction: t });

    if (Array.isArray(obs_ids)) {
      const currentEventoObs = await EventoObsModel.findAll({ where: { id_evento: id }, transaction: t });
      const currentIds = currentEventoObs.map((eo) => eo.dataValues.id_obs as number);
      const toAdd = (obs_ids as number[]).filter((oid) => !currentIds.includes(oid));
      const toRemove = currentEventoObs.filter((eo) => !(obs_ids as number[]).includes(eo.dataValues.id_obs as number));

      if (toAdd.length > 0 || toRemove.length > 0) {
        const allIds = [...new Set([...currentIds, ...(obs_ids as number[])])];
        const allRows = await ObsModel.findAll({ where: { id: allIds }, attributes: ["id", "name"], paranoid: false, transaction: t });
        const nameMap = new Map(allRows.map((r) => [r.dataValues.id as number, r.dataValues.name as string]));
        const beforeObs = currentIds.map((oid: number) => nameMap.get(oid)).filter(Boolean).join(", ");
        const afterObs = (obs_ids as number[]).map((oid) => nameMap.get(oid)).filter(Boolean).join(", ");

        await Promise.all([
          ...toAdd.map((id_obs: number) => EventoObsModel.create({ id_obs, id_evento: Number(id) }, { transaction: t })),
          ...toRemove.map((eo) => eo.destroy({ transaction: t })),
        ]);

        obsLogData = { before: beforeObs || null, after: afterObs || null };
      }
    }
  });

  // Still `bodyWithoutObs` and not `editable`, and they are the same thing
  // here: `withoutAuthor` drops id/createdAt/updatedAt/deletedAt/id_usuario and
  // never `image`. Said out loud because the day `image` joins that list, this
  // line would delete the old file while the write refused the new one.
  // And only if nothing else names the file — see `imageRefs.ts`.
  if (oldImage && bodyWithoutObs.image && oldImage !== bodyWithoutObs.image) {
    void deleteImageIfUnreferenced(oldImage);
  }
  // No RESOLVE_EVENTO branch here any more, and there has not been a reachable
  // one since `state` started being destructured out of the body above: the
  // condition read `bodyWithoutObs.state`, which is `undefined` by construction.
  // Resolving is `POST /:id/resolve`, which logs it itself.
  if (Object.keys(beforeMeta).some(k => beforeMeta[k] !== afterMeta[k])) {
    logAction({ id_usuario: req.user?.id, action: "UPDATE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Editó Evento #${id}`, metadata: { before: beforeMeta, after: afterMeta }, severity: 'warning' });
  }
  if (obsLogData) {
    logAction({
      id_usuario: req.user?.id,
      action: "UPDATE_OBS_EVENTO",
      entity: "Evento",
      entity_id: Number(id),
      detail: `Actualizó observaciones del Evento #${id}`,
      metadata: { before: { obs: obsLogData.before }, after: { obs: obsLogData.after } },
      severity: 'warning',
    });
  }

  res.status(200).json(TempEvento);
});
export const reabrirEvento = handler("reabrirEvento", async (req: Request, res: Response) => {
  const { id } = req.params;

  const evento = await EventoModel.findOne({ where: { id } });
  if (!evento) return res.status(404).json({ message: "Evento no encontrado" });
  if (!evento.dataValues.state) return res.status(400).json({ message: "El evento no está resuelto" });

  const solucion = await SolucionModel.findOne({ where: { id_evento: id } });
  const solucionImage = solucion?.dataValues.image ?? null;

  await sequelize.transaction(async (t) => {
    if (solucion) await solucion.destroy({ transaction: t });
    evento.set({ state: false });
    await evento.save({ transaction: t });
  });

  // The repair photo, only if nothing else names it. The `solucions` row was
  // soft-deleted just above and still names it — so in practice the file now
  // stays until the row is purged, which is what the Archivos cleaner already
  // assumes about archived rows. Deleting it left that row pointing at nothing.
  if (solucionImage) void deleteImageIfUnreferenced(solucionImage);

  logAction({ id_usuario: req.user?.id, action: "REABRIR_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Reabrió Evento #${id}`, metadata: { before: { state: true }, after: { state: false } }, severity: 'warning' });
  res.status(204).end();
});

export const deleteEvento = handler("deleteEvento", async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!(await archivar(EventoModel, id))) return res.status(404).json({ message: NADA_QUE_ARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "DELETE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Archivó Evento #${id}`, severity: 'critical' });
  return res.status(204).end();
});
export const desarchivarEvento = handler("desarchivarEvento", async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!(await desarchivar(EventoModel, id))) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Desarchivó Evento #${id}`, severity: 'info' });
  return res.status(204).end();
});
export const resolverEvento = handler("resolverEvento", async (req: Request, res: Response) => {
  const { id } = req.params;

  const evento = await EventoModel.findOne({ where: { id } });
  if (!evento) return res.status(404).json({ message: "Evento no encontrado" });
  if (evento.dataValues.state) return res.status(400).json({ message: "El evento ya está resuelto" });

  const { description, date, image } = req.body;

  await sequelize.transaction(async (t) => {
    await SolucionModel.create(
      {
        description, date: date ?? new Date(), image: image || null,
        id_evento: Number(id), id_usuario: req.user?.id ?? null,
      },
      { transaction: t }
    );
    evento.set({ state: true });
    await evento.save({ transaction: t });
  });

  const posteRow = evento.dataValues.id_poste != null ? await PosteModel.findByPk(evento.dataValues.id_poste, { attributes: ["id", "name"], paranoid: false }) : null;
  const posteRef = posteRow ? { id: posteRow.dataValues.id, name: posteRow.dataValues.name } : (evento.dataValues.id_poste ?? null);

  logAction({
    id_usuario: req.user?.id,
    action: "RESOLVE_EVENTO",
    entity: "Evento",
    entity_id: Number(id),
    detail: `Resolvió Evento #${id}`,
    metadata: { description, id_poste: posteRef },
    severity: 'info',
  });

  res.status(204).end();
});
