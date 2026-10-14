import { Request, Response } from "express";
import { literal, Op, type Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { deleteImageIfUnreferenced } from "../utils/imageRefs.js";
import { authoredBy, withoutAuthor } from "../utils/authorship.js";
import { logAction } from "../utils/logAction.js";
import { archivar, NADA_QUE_ARCHIVAR, NADA_QUE_DESARCHIVAR } from "../utils/archivado.js";
import { AdssModel } from "../models/adss.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { MaterialModel } from "../models/material.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { TramoModel } from "../models/tramo.model.js";
import { UsuarioModel, USUARIO_AS_AUTHOR } from "../models/usuario.model.js";
import type { IPoste } from "../interfaces/index.js";
import {
  construirFichero, esFormato, responderFichero, responderFalloDeExport,
  subtituloDeFiltros, type Columna,
} from "../exports/tabla.js";
import { exportSlot } from "../reportBuilder/export/queue.js";
import { MAX_EXPORT_ROWS } from "../reportBuilder/export/index.js";
import { INCLUDE_TRAMO, presentarTramo, presentarTramos } from "../tramos/presentacion.js";
import { sqlNombreDelTramo } from "../tramos/nombre.js";
import { TRAMO_NO_DISPONIBLE } from "./tramo.controller.js";
import { coordenadasInvalidas } from "../utils/coordenadas.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const posteLog = log("poste");
const handler = makeHandler(posteLog);

/**
 * Everything that decides *which* poles, resolved once for the two endpoints
 * that need it.
 *
 * The list and the export have to agree row for row, and before the export
 * moved to the server it did not even try: the button downloaded the whole
 * table whatever the screen was filtered to, so somebody looking at one stretch
 * got a file with all 1.687 poles in it and nothing inside saying so. The file
 * is what the screen shows now, and that only stays true while there is **one**
 * filter builder. A copy would have drifted the first time a column became
 * filterable on one of the two.
 *
 * It returns the sentence to answer with when a filter names a column this
 * endpoint does not have. That is a 400 rather than an empty list, and the
 * caller decides the status because only the caller knows whether it is
 * answering with JSON or with a file.
 */
export interface FiltroPostes {
  where: Record<string, unknown>;
  order: [string, string][];
  paranoid: boolean;
  isArchived: boolean;
  /**
   * The active filters in the words the screen uses, for the export to print
   * inside the file. Built here rather than by the exporter because this is
   * where it is known which of them actually took effect.
   */
  descripcion: string[];
}

const ENTERO = /^\d+$/;
/** The largest value of a PostgreSQL `integer` column. */
const ENTERO_MAXIMO = 2_147_483_647;
/**
 * A positive id the database can hold, out of a query string.
 *
 * Digits alone are not enough: four hundred of them become `Infinity` once
 * turned into a number and written into SQL, and eleven overflow `integer` —
 * both answered 500 instead of the sentence.
 */
const esIdDeQuery = (v: unknown): boolean =>
  typeof v === "string" && ENTERO.test(v) && Number(v) > 0 && Number(v) <= ENTERO_MAXIMO;
const TRAMO_INVALIDO = "El tramo indicado no es válido.";
const CIUDAD_INVALIDA = "La ciudad indicada no es válida.";
const DOS_CIUDADES_YA_NO =
  "La lista de postes ya no se filtra por dos ciudades: indique el tramo.";

/** The tramos that touch a city, as a subquery. The id is digits only by the time it gets here. */
const tramosDeLaCiudad = (id: number) =>
  literal(`(SELECT "id" FROM "tramos" WHERE "id_ciudad_min" = ${id} OR "id_ciudad_max" = ${id})`);

export const filtroDePostes = (query: Request["query"]): FiltroPostes | string => {
  const { tramo, ciudadA, ciudadB, ciudadId, archived, filterColumn, filterValue, sortBy, sortOrder } = query;
  const isArchived = archived === "true";

  // A client from before the cut. Refused by name: answering with every pole
  // to somebody who asked for one stretch is the failure this file exists to
  // prevent.
  if (ciudadA !== undefined || ciudadB !== undefined) return DOS_CIUDADES_YA_NO;
  if (tramo !== undefined && !esIdDeQuery(tramo)) return TRAMO_INVALIDO;
  if (ciudadId !== undefined && !esIdDeQuery(ciudadId)) return CIUDAD_INVALIDA;

  const where: Record<string, unknown> = isArchived
    ? { deletedAt: { [Op.ne]: null } }
    : ciudadId
    ? { id_tramo: { [Op.in]: tramosDeLaCiudad(Number(ciudadId)) } }
    : tramo
      ? { id_tramo: Number(tramo) }
      : {};

  const filterCols = Array.isArray(filterColumn) ? filterColumn as string[] : filterColumn ? [filterColumn as string] : [];
  const filterVals = Array.isArray(filterValue) ? filterValue as string[] : filterValue ? [filterValue as string] : [];
  /**
   * The columns this endpoint really filters by.
   *
   * Declared, and **anything else is refused**. Before C3 an unknown column was
   * dropped on the floor: the table sent `filterColumn=deletedAt`, the server
   * ignored it, and the screen drew every row with the filter chip showing as
   * active. A filter that quietly does nothing is worse than one that says it
   * cannot — the user reads the result as the answer to a question nobody asked.
   */
  const FILTRABLE = new Set(["name"]);
  const desconocida = filterCols.find((col) => !FILTRABLE.has(col));
  if (desconocida !== undefined) {
    return `No se puede filtrar la lista de postes por «${desconocida}».`;
  }
  /**
   * The filters that took effect, and only those.
   *
   * The chain above is exclusive — archived wins over a city, a city wins over a
   * stretch — so this has to be exclusive too. Written as three independent
   * `if`s it produced a file of every archived pole subtitled "Filtrado por
   * archivados · una ciudad", which is the exact failure `subtituloDeFiltros`
   * exists to prevent: a document making a claim its rows do not support.
   */
  const descripcion: string[] = [];
  if (isArchived) descripcion.push("archivados");
  else if (ciudadId) descripcion.push("una ciudad");
  else if (tramo) descripcion.push("un tramo");
  filterCols.forEach((col, i) => {
    const val = filterVals[i];
    if (typeof val !== "string" || !val.trim()) return;
    if (col === "name") {
      where["name"] = { [Op.iLike]: `%${val.trim()}%` };
      descripcion.push(`nombre contiene «${val.trim()}»`);
    }
  });

  /**
   * The orders this endpoint can really apply.
   *
   * An audit measured the claim that used to be here — that the Archivados tab
   * offered `material` and `tramo` — and it was false: those two columns are
   * declared with an `id` and a `cell` and no accessor, so TanStack never made
   * their headers clickable. `usuario` is the same, and the audit was wrong
   * about that one in the other direction: it reported the Creador column as
   * sortable and it is not, for exactly the reason it had just given for the
   * other two. Checked before believing either of us.
   *
   * **`updatedAt` is the real one.** It carries an `accessorKey`, so its header
   * does sort, the Columnas menu can show it, and it was missing here — the
   * arrow moved, the request went out, and the same rows came back in
   * `id DESC`. That is the failure the paragraph above was describing, found in
   * the column nobody had suspected.
   *
   * The mapped entries below stay, dead as three of them are today: they are
   * what the shared filter owes the export the day a screen adds one accessor,
   * and an order the listing can express and the file cannot is a 500 — which
   * is what `sortBy=usuario` on the incident export was until this task.
   */
  const SORTABLE = new Set(["id", "name", "date", "createdAt", "updatedAt", "deletedAt"]);
  const sortByCols = Array.isArray(sortBy) ? sortBy as string[] : sortBy ? [sortBy as string] : [];
  const sortOrderVals = Array.isArray(sortOrder) ? sortOrder as string[] : sortOrder ? [sortOrder as string] : [];
  const orderEntries = sortByCols.flatMap<unknown[]>((col, i) => {
    const dir = sortOrderVals[i] === "asc" ? "ASC" : "DESC";
    if (col === "usuario")      return [[UsuarioModel, "name", dir]];
    if (col === "material")     return [[MaterialModel, "name", dir]];
    if (col === "propietario")  return [[PropietarioModel, "name", dir]];
    // By the name people read, under the collation that name is built with
    // (see `tramos/nombre.ts`) — the same expression and the same reason as the
    // order of `getTramo`. It names the root column and no include, so it holds
    // whatever alias the join to `tramos` ends up with.
    // The id tie-breaker (many poles share a tramo) goes at the end of the whole
    // list, below, so it never shadows a key the screen asked for after this one.
    if (col === "tramo")        return [[literal(`(${sqlNombreDelTramo('"poste"."id_tramo"')}) COLLATE "C"`), dir]];
    return SORTABLE.has(col) ? [[col, col === "id" && !!tramo ? "ASC" : dir]] : [];
  });

  // Without a tie-breaker the database may order the poles of one tramo
  // differently from one page to the next.
  if (sortByCols.includes("tramo")) orderEntries.push(["id", "ASC"]);

  return {
    where,
    order: (orderEntries.length ? orderEntries : [["id", tramo ? "ASC" : "DESC"]]) as [string, string][],
    paranoid: !isArchived,
    isArchived,
    descripcion,
  };
};

export const getPoste = handler("getPoste", async (req: Request, res: Response) => {
  // `?export=true` is gone. It changed the **type** of the response on the
  // same URL — a bare array instead of an envelope — which is the one thing
  // §3.3 exists to stop, and eight of its fourteen callers never exported
  // anything: they used it to mean "give me every row". That is `limit=all`
  // now, and it comes with a ceiling.
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const filtro = filtroDePostes(req.query);
  if (typeof filtro === "string") return res.status(400).json({ message: filtro });

  const queryOptions = {
    where: filtro.where,
    paranoid: filtro.paranoid,
    order: filtro.order,
    attributes: {
      include: [[
        literal(`(SELECT COUNT(*) FROM "eventos" WHERE "eventos"."id_poste" = "poste"."id" AND "eventos"."state" = false AND "eventos"."deletedAt" IS NULL)`),
        "pendingEvents",
      ] as [ReturnType<typeof literal>, string]],
      exclude: ["image"],
    },
    include: [
      { model: MaterialModel, paranoid: false, attributes: ["id", "name"] },
      { model: PropietarioModel, paranoid: false, attributes: ["id", "name"] },
      INCLUDE_TRAMO,
      { model: UsuarioModel, attributes: [...USUARIO_AS_AUTHOR] },
    ],
  };

  const listado = await listar(PosteModel, queryOptions, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json({ ...listado, data: presentarTramos(listado.data) });
});

// ── Export ────────────────────────────────────────────────────────────

/**
 * The columns of the pole file — and, which is the point of writing them out,
 * the only fields that reach it.
 *
 * Not borrowed from the listing, because the listing sends more than it shows:
 * `id_usuario` and the name of whoever registered each pole travel in every row
 * of `GET /api/poste`. In a paginated response that is a leak somebody has to
 * go looking for. In a spreadsheet it is a column — sortable, countable, and
 * naming the employee behind each of 1.687 poles — in the hands of a Cliente
 * role that §6 deliberately keeps away from exactly that. The screen draws no
 * such column, so neither does the file.
 *
 * The eight are the eight the browser exporter had, with two corrections it
 * could not make: `#` is a number rather than the text "1", so a spreadsheet
 * sorts it 1, 2, 10 instead of 1, 10, 2; and the coordinates and the date are
 * typed, so they can be filtered by range instead of only looked at.
 */
const COLUMNAS_POSTE: readonly Columna[] = [
  { key: "n", label: "#", kind: "number" },
  { key: "name", label: "Nombre", kind: "string" },
  { key: "tramo", label: "Tramo", kind: "string" },
  { key: "material", label: "Material", kind: "string" },
  { key: "propietario", label: "Propietario", kind: "string" },
  { key: "lat", label: "Lat", kind: "number" },
  { key: "lng", label: "Lng", kind: "number" },
  { key: "date", label: "Fecha en campo", kind: "date" },
];

/** What the export query brings back, which is `COLUMNAS_POSTE` and nothing else. */
type PosteExportado = Pick<IPoste, "id" | "name" | "lat" | "lng" | "date"> & {
  material?: { name?: string | null } | null;
  propietario?: { name?: string | null } | null;
  tramo?: unknown;
};

/**
 * The pole list as a spreadsheet, a CSV or a document.
 *
 * **It is a POST and it has no body**, which looks odd twice over and is
 * deliberate both times. POST because `requireSameOrigin` only guards the
 * writing verbs: a GET that builds a workbook is a page anyone can embed
 * twenty times over in `<img>` tags and have any logged-in employee's browser
 * fire at the server, which is CPU and memory spent on somebody else's say-so.
 * No body because the filters travel as query parameters — the very same ones
 * the listing takes, read by the very same function — and a second way of
 * expressing "filtered by name" is a second thing to drift.
 */
export const exportarPostes = handler("exportarPostes", async (req: Request, res: Response) => {
  const { format } = req.query;
  if (!esFormato(format)) {
    return res.status(400).json({ message: "Formato no válido. Use «excel», «csv» o «pdf»." });
  }

  const filtro = filtroDePostes(req.query);
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
    const filas = (await PosteModel.findAll({
      where: filtro.where,
      paranoid: filtro.paranoid,
      order: filtro.order,
      attributes: ["id", "name", "lat", "lng", "date"],
      include: [
        { model: MaterialModel, paranoid: false, attributes: ["id", "name"] },
        { model: PropietarioModel, paranoid: false, attributes: ["id", "name"] },
        INCLUDE_TRAMO,
        // Joined so that `sortBy=usuario` has a table to order by, and read by no
        // column below: the file does not name who registered each pole, and §6
        // is the reason. Without the join Postgres answers "missing FROM-clause
        // entry" and the user gets a neutral 500 for pressing a column header.
        { model: UsuarioModel, attributes: ["id", "name"] },
      ],
      // One over the ceiling, so the refusal below is reached rather than a file
      // being built out of a silently truncated table.
      limit: MAX_EXPORT_ROWS + 1,
    })).map((fila, i) => {
      const p = fila.toJSON() as PosteExportado;
      return {
        n: i + 1,
        name: p.name,
        tramo: p.tramo ? presentarTramo(p.tramo).nombre : "",
        material: p.material?.name ?? null,
        propietario: p.propietario?.name ?? null,
        lat: p.lat,
        lng: p.lng,
        date: p.date,
      };
    });

      return construirFichero({
        formato: format,
        columnas: COLUMNAS_POSTE,
        filas,
        titulo: filtro.isArchived ? "Postes archivados" : "Postes",
        subtitulo: subtituloDeFiltros(filtro.descripcion),
        sustantivo: ["poste", "postes"],
        hoja: "Postes",
      });
    });

    logAction({
      id_usuario: req.user?.id,
      action: "EXPORT_POSTE",
      entity: "Poste",
      entity_id: null,
      detail: `Exportó ${fichero.filas} postes a ${format}`,
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

// `getTramos` and its route `GET /api/poste/tramos` no longer exist. They served
// the distinct city pairs poles run between; a tramo is now a row of its own,
// listed by `GET /api/tramo/` and, for the pole form, in the `tramos` block of
// `GET /api/poste/options`.

/** Thrown inside a transaction so it rolls back, and answered as a 400 outside it. */
class TramoNoDisponible extends Error {}

/** The id of a tramo out of a body, or `null` when it is not one. */
const leerIdTramo = (valor: unknown): number | null => {
  const n = typeof valor === "number" ? valor : typeof valor === "string" && ENTERO.test(valor) ? Number(valor) : NaN;
  return Number.isInteger(n) && n > 0 && n <= ENTERO_MAXIMO ? n : null;
};

/**
 * The tramo a pole is about to stand on, locked and live, or a refusal.
 *
 * Shared lock on the tramo for the length of the write: archiving it takes the
 * row FOR UPDATE and counts its poles (`deleteTramo`), so one of the two waits.
 * Whichever goes second sees what the first did — the archive counts this
 * pole, or this read no longer finds a live row. Without it a pole could land
 * on a tramo archived a millisecond before.
 *
 * The read is the default, paranoid one on purpose: an archived tramo is not
 * found, and that is the refusal.
 */
const tramoParaEscribir = async (id: number, t: Transaction): Promise<void> => {
  const tramo = await TramoModel.findOne({ where: { id }, attributes: ["id"], transaction: t, lock: t.LOCK.SHARE });
  if (!tramo) throw new TramoNoDisponible();
};

export const createPoste = handler("createPoste", async (req: Request, res: Response) => {
  const { adss_ids, ...posteBody } = req.body;
  // Before anything is written. See `coordenadasInvalidas` for what one bad
  // pair costs the rest of its stretch.
  const fallo = coordenadasInvalidas(posteBody);
  if (fallo) return res.status(400).json({ message: fallo });
  const idTramo = leerIdTramo(posteBody.id_tramo);
  if (idTramo === null) return res.status(400).json({ message: TRAMO_NO_DISPONIBLE });

  let TempPoste;
  try {
    TempPoste = await sequelize.transaction(async (t) => {
      await tramoParaEscribir(idTramo, t);
      // Same as evento: the author is the session, not a field of the body.
      const poste = await PosteModel.create(authoredBy(posteBody, req), { transaction: t });
      const posteId = poste.dataValues.id as number;
      if (Array.isArray(adss_ids) && adss_ids.length > 0) {
        await Promise.all(
          (adss_ids as number[]).map((id_adss) =>

            AdssPosteModel.create({ id_adss, id_poste: posteId }, { transaction: t })
          )
        );
      }
      return poste;
    });
  } catch (error) {
    if (error instanceof TramoNoDisponible) return res.status(400).json({ message: TRAMO_NO_DISPONIBLE });
    throw error;
  }
  const posteId = TempPoste.dataValues.id as number;

  let adssLabel: string | null = null;
  if (Array.isArray(adss_ids) && adss_ids.length > 0) {
     
    const adssRows = await AdssModel.findAll({
      where: { id: adss_ids },
      attributes: ["name"],
      paranoid: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adssLabel = adssRows.map((r: any) => r.dataValues.name).join(", ") || null;
  }

  logAction({
    id_usuario: req.user?.id,
    action: "CREATE_POSTE",
    entity: "Poste",
    entity_id: posteId,
    detail: `Registró Poste ${posteBody.name}`,
    metadata: { after: { name: posteBody.name, ...(adssLabel ? { adss: adssLabel } : {}) } },
    severity: 'info',
  });
  res.status(201).json(TempPoste);
});
export const searchPoste = handler("searchPoste", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempPoste = await PosteModel.findOne({
    where: { id },
    include: [
      { model: MaterialModel, paranoid: false },
      { model: PropietarioModel, paranoid: false },
      INCLUDE_TRAMO,
      // Never the bare model: it would send `pass`. See USUARIO_AS_AUTHOR.
      { model: UsuarioModel, attributes: [...USUARIO_AS_AUTHOR] },
    ],
  });
  // 404, and the reason is not tidiness. This answered **200 with a body of
  // `null`**, and `PosteSheet` decides between "edit" and "create" with
  // `!!poste?.id`: open the pole list, have somebody else archive a pole, press
  // Editar on that row, and the form came up titled "Nuevo poste" and saved a
  // **duplicate**, announcing "Poste creado correctamente". The detail screen
  // was worse still — it reads `dataPoste.id` with no guard, and this
  // application has no error boundary anywhere, so the whole app went white.
  if (!TempPoste) return res.status(404).json({ message: "El poste no existe." });
  res.status(200).json(presentarTramos(TempPoste));
});
export const updatePoste = handler("updatePoste", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempPoste = await PosteModel.findOne({ where: { id } });
  if (!TempPoste) return res.status(404).json({ message: "Poste no encontrado" });
  const oldImage = TempPoste.dataValues.image;
  const dv = TempPoste.dataValues as unknown as Record<string, unknown>;

  const { adss_ids, ...bodyWithoutAdss } = req.body;
  // The same refusal as on creating. Correcting one of the poles that already
  // has an impossible pair goes through here, and passes: only what the request
  // carries is judged.
  const fallo = coordenadasInvalidas(bodyWithoutAdss);
  if (fallo) return res.status(400).json({ message: fallo });

  const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
  // The diff below is computed from what will actually be written, not from
  // what arrived. `withoutAuthor` refuses `id_usuario` at the write, and a log
  // that records the refused change is worse than no log at all: the bitácora is
  // the one place a reader goes to find out who reassigned a row.
  const editable = withoutAuthor(bodyWithoutAdss);
  const fkKeys = new Set(["id_propietario", "id_material", "id_tramo"]);
  const beforeMeta: Record<string, unknown> = {};
  const afterMeta:  Record<string, unknown> = {};

  for (const k of Object.keys(editable)) {
    const bv = dv[k];
    if (bv === undefined || fkKeys.has(k)) continue;
    if (isPrimVal(bv) && isPrimVal(editable[k])) { beforeMeta[k] = bv; afterMeta[k] = editable[k]; }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fkRef = async (Model: any, pkVal: number | null | undefined) => {
    if (pkVal == null) return null;
    const row = await Model.findByPk(pkVal, { attributes: ["id", "name"], paranoid: false });
    return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
  };
  await Promise.all((
    [["id_propietario", PropietarioModel], ["id_material", MaterialModel]] as [string, unknown][]
  ).map(async ([k, Model]) => {
    const bv = dv[k] as number | null | undefined;
    const av = editable[k] as number | null | undefined;
    // Only when the request actually carries the key. A partial update that
    // omits it leaves the column untouched, but this recorded
    // `after: {id_propietario: null}` — a change nobody asked for, written into
    // the audit log as if it had happened. Same guard `updateEvento` has.
    if (!Object.hasOwn(editable, k) || bv === undefined || bv === av) return;
    [beforeMeta[k], afterMeta[k]] = await Promise.all([fkRef(Model, bv), fkRef(Model, av)]);
  }));

  // The tramo apart from the other two: it has no `name` column — its name is
  // built out of its two cities — and moving a pole onto one has a condition.
  const tramoAntes = dv.id_tramo as number;
  let tramoDespues: number | null = null;
  if (Object.hasOwn(editable, "id_tramo")) {
    const pedido = leerIdTramo(editable.id_tramo);
    if (pedido === null) return res.status(400).json({ message: TRAMO_NO_DISPONIBLE });
    if (pedido !== tramoAntes) tramoDespues = pedido;
  }

  let adssLogData: { before: string | null; after: string | null } | null = null;

  try {
    await sequelize.transaction(async (t) => {
      // The destination is checked here and not before: under the same lock as on
      // creating, held until the pole is saved. See `tramoParaEscribir`.
      if (tramoDespues !== null) await tramoParaEscribir(tramoDespues, t);
      TempPoste.set(editable);
      await TempPoste.save({ transaction: t });

      if (Array.isArray(adss_ids)) {
       
        const currentAdssPoste = await AdssPosteModel.findAll({ where: { id_poste: id }, transaction: t });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentIds = currentAdssPoste.map((a: any) => a.dataValues.id_adss as number);
        const toAdd = (adss_ids as number[]).filter((aid) => !currentIds.includes(aid));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toRemove = currentAdssPoste.filter((a: any) => !(adss_ids as number[]).includes(a.dataValues.id_adss as number));

        if (toAdd.length > 0 || toRemove.length > 0) {
          const allIds = [...new Set([...currentIds, ...(adss_ids as number[])])];
         
          const allRows = await AdssModel.findAll({ where: { id: allIds }, attributes: ["id", "name"], paranoid: false, transaction: t });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nameMap = new Map(allRows.map((r: any) => [r.dataValues.id as number, r.dataValues.name as string]));
          const beforeAdss = currentIds.map((aid: number) => nameMap.get(aid)).filter(Boolean).join(", ");
          const afterAdss = (adss_ids as number[]).map((aid) => nameMap.get(aid)).filter(Boolean).join(", ");

          await Promise.all([
           
            ...toAdd.map((id_adss: number) => AdssPosteModel.create({ id_adss, id_poste: Number(id) }, { transaction: t })),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...toRemove.map((a: any) => a.destroy({ transaction: t })),
          ]);

          adssLogData = { before: beforeAdss || null, after: afterAdss || null };
        }
      }
    });
  } catch (error) {
    if (error instanceof TramoNoDisponible) return res.status(400).json({ message: TRAMO_NO_DISPONIBLE });
    throw error;
  }

  // After the write, so a refused move costs no reads; archived rows included,
  // because the tramo the pole leaves may be archived by the time this runs.
  if (tramoDespues !== null) {
    const tramoRef = async (pk: number | null | undefined) => {
      if (pk == null) return null;
      const fila = await TramoModel.findByPk(pk, {
        paranoid: false, attributes: INCLUDE_TRAMO.attributes, include: INCLUDE_TRAMO.include,
      });
      return fila ? { id: pk, name: presentarTramo(fila).nombre } : null;
    };
    [beforeMeta.id_tramo, afterMeta.id_tramo] = await Promise.all([tramoRef(tramoAntes), tramoRef(tramoDespues)]);
  }

  // Still `bodyWithoutAdss` and not `editable`, and they are the same thing
  // here: `withoutAuthor` drops id/createdAt/updatedAt/deletedAt/id_usuario and
  // never `image`. Said out loud because the day `image` joins that list, this
  // line would delete the old file while the write refused the new one.
  // And only if nothing else names the file — see `imageRefs.ts`.
  if (oldImage && bodyWithoutAdss.image && oldImage !== bodyWithoutAdss.image) {
    void deleteImageIfUnreferenced(oldImage);
  }
  if (Object.keys(beforeMeta).some(k => beforeMeta[k] !== afterMeta[k])) {
    logAction({ id_usuario: req.user?.id, action: "UPDATE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Editó Poste #${id}`, metadata: { before: beforeMeta, after: afterMeta }, severity: 'warning' });
  }
  if (adssLogData) {
    logAction({
      id_usuario: req.user?.id,
      action: "UPDATE_ADSS_POSTE",
      entity: "Poste",
      entity_id: Number(id),
      detail: `Actualizó ADSS del Poste #${id}`,
      metadata: { before: { adss: adssLogData.before }, after: { adss: adssLogData.after } },
      severity: 'warning',
    });
  }

  res.status(200).json(TempPoste);
});
export const deletePoste = handler("deletePoste", async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!(await archivar(PosteModel, id))) return res.status(404).json({ message: NADA_QUE_ARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "DELETE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Archivó Poste #${id}`, severity: 'critical' });
  return res.status(204).end();
});
export const desarchivarPoste = handler("desarchivarPoste", async (req: Request, res: Response) => {
  const { id } = req.params;

  // A live pole cannot stand on an archived tramo: nothing would list it under
  // a stretch, and the pair could not be created again to give it one. So the
  // two restores are one write, and the tramo row is locked for it — the same
  // row `deleteTramo` locks, so an archive of the tramo either sees this pole
  // live and refuses, or finishes first and is undone here.
  //
  // Not through `desarchivar`: that helper takes no transaction, and its look
  // and its write would be two statements outside this one.
  const resultado = await sequelize.transaction(async (t) => {
    const poste = await PosteModel.findOne({
      where: { id }, paranoid: false, attributes: ["id", "id_tramo", "deletedAt"], transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!poste || poste.get("deletedAt") == null) return null;

    const idTramo = poste.get("id_tramo") as number;
    const tramo = await TramoModel.findOne({
      where: { id: idTramo }, paranoid: false, attributes: ["id", "deletedAt"], transaction: t, lock: t.LOCK.UPDATE,
    });
    const tramoArchivado = tramo != null && tramo.get("deletedAt") != null;
    if (tramoArchivado) await TramoModel.restore({ where: { id: idTramo }, transaction: t });
    await PosteModel.restore({ where: { id }, transaction: t });
    return { idTramo, tramoArchivado };
  });

  if (!resultado) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Desarchivó Poste #${id}`, severity: 'info' });
  if (resultado.tramoArchivado) {
    const { idTramo } = resultado;
    logAction({ id_usuario: req.user?.id, action: "RESTORE_TRAMO", entity: "Tramo", entity_id: idTramo, detail: `Desarchivó tramo #${idTramo} al desarchivar el Poste #${id}`, severity: 'info' });
  }
  return res.status(204).end();
});
