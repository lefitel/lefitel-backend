import { Request, Response } from "express";
import { literal, Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { deleteImageIfUnreferenced } from "../utils/imageRefs.js";
import { authoredBy, withoutAuthor } from "../utils/authorship.js";
import { logAction } from "../utils/logAction.js";
import { AdssModel } from "../models/adss.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { MaterialModel } from "../models/material.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { UsuarioModel, USUARIO_AS_AUTHOR } from "../models/usuario.model.js";
import type { IPoste } from "../interfaces/index.js";
import {
  construirFichero, esFormato, responderFichero, responderFalloDeExport,
  subtituloDeFiltros, type Columna,
} from "../exports/tabla.js";
import { exportSlot } from "../reportBuilder/export/queue.js";
import { MAX_EXPORT_ROWS } from "../reportBuilder/export/index.js";
import { nombreDeTramo } from "../utils/tramo.js";

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
  order: [[string, string]];
  paranoid: boolean;
  isArchived: boolean;
  /**
   * The active filters in the words the screen uses, for the export to print
   * inside the file. Built here rather than by the exporter because this is
   * where it is known which of them actually took effect.
   */
  descripcion: string[];
}

export const filtroDePostes = (query: Request["query"]): FiltroPostes | string => {
  const { ciudadA, ciudadB, ciudadId, archived, filterColumn, filterValue, sortBy, sortOrder } = query;
  const isArchived = archived === "true";

  const where: Record<string, unknown> = isArchived
    ? { deletedAt: { [Op.ne]: null } }
    : ciudadId
    ? { [Op.or]: [{ id_ciudadA: Number(ciudadId) }, { id_ciudadB: Number(ciudadId) }] }
    : (ciudadA && ciudadB)
      ? {
          [Op.or]: [
            { id_ciudadA: Number(ciudadA), id_ciudadB: Number(ciudadB) },
            { id_ciudadA: Number(ciudadB), id_ciudadB: Number(ciudadA) },
          ],
        }
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
  else if (ciudadA && ciudadB) descripcion.push("un tramo");
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
  const orderEntries = sortByCols.map((col, i) => {
    const dir = sortOrderVals[i] === "asc" ? "ASC" : "DESC";
    if (col === "usuario")      return [UsuarioModel, "name", dir];
    if (col === "material")     return [MaterialModel, "name", dir];
    if (col === "propietario")  return [PropietarioModel, "name", dir];
    if (col === "tramo")        return [{ model: CiudadModel, as: "ciudadA" }, "name", dir];
    return SORTABLE.has(col) ? [col, col === "id" && !!ciudadA && !!ciudadB ? "ASC" : dir] : null;
  }).filter(Boolean);

  return {
    where,
    order: (orderEntries.length ? orderEntries : [["id", ciudadA && ciudadB ? "ASC" : "DESC"]]) as [[string, string]],
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
      { model: CiudadModel, as: "ciudadA", paranoid: false, attributes: ["id", "name"] },
      { model: CiudadModel, as: "ciudadB", paranoid: false, attributes: ["id", "name"] },
      { model: UsuarioModel, attributes: [...USUARIO_AS_AUTHOR] },
    ],
  };

  const listado = await listar(PosteModel, queryOptions, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
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
  ciudadA?: { name?: string | null } | null;
  ciudadB?: { name?: string | null } | null;
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
        { model: CiudadModel, as: "ciudadA", paranoid: false, attributes: ["id", "name"] },
        { model: CiudadModel, as: "ciudadB", paranoid: false, attributes: ["id", "name"] },
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
        tramo: nombreDeTramo(p.ciudadA, p.ciudadB),
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

// `getTramos` and its route `GET /api/poste/tramos` were removed with C2.
//
// It served the distinct city pairs poles run between, and its only caller
// anywhere was `useTramoNeighbors` in the client, which now reads the same
// pairs from the `tramos` block of `GET /api/reporte/opciones` — a block that
// additionally drops pairs naming an archived city, which this handler
// returned and no combobox could render.
//
// **Two repositories, so two commits, and this is the first task in the arc
// that does not tolerate half of it.** §11 asks that both shores of a task ship
// in the same *cut*, not the same commit — which is impossible across repos.
// C1 and C3 leave tolerating code behind them; this one does not: an `api` that
// has dropped the route beside a `web` that still calls it answers 404, and the
// stretch comboboxes on all three report screens go empty. The pair to ship
// together is named in the C2 entry of §9.
//
// It buys no privacy, and saying otherwise would contradict §6 of the standard,
// which already says this in as many words: `GET /api/poste/` is ungated too and
// projects `id_ciudadA`/`id_ciudadB` on every row, so any live session
// reconstructs exactly the same pairs with one request. One address fewer, one
// dead handler fewer, and nothing closed. C5 is what closes it.

export const createPoste = handler("createPoste", async (req: Request, res: Response) => {
  const { adss_ids, ...posteBody } = req.body;
  const TempPoste = await sequelize.transaction(async (t) => {
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
      { model: CiudadModel, as: "ciudadA", paranoid: false },
      { model: CiudadModel, as: "ciudadB", paranoid: false },
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
  res.status(200).json(TempPoste);
});
export const updatePoste = handler("updatePoste", async (req: Request, res: Response) => {
  const { id } = req.params;

  const TempPoste = await PosteModel.findOne({ where: { id } });
  if (!TempPoste) return res.status(404).json({ message: "Poste no encontrado" });
  const oldImage = TempPoste.dataValues.image;
  const dv = TempPoste.dataValues as unknown as Record<string, unknown>;

  const { adss_ids, ...bodyWithoutAdss } = req.body;

  const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
  // The diff below is computed from what will actually be written, not from
  // what arrived. `withoutAuthor` refuses `id_usuario` at the write, and a log
  // that records the refused change is worse than no log at all: the bitácora is
  // the one place a reader goes to find out who reassigned a row.
  const editable = withoutAuthor(bodyWithoutAdss);
  const fkKeys = new Set(["id_propietario", "id_material", "id_ciudadA", "id_ciudadB"]);
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
    [["id_propietario", PropietarioModel], ["id_material", MaterialModel], ["id_ciudadA", CiudadModel], ["id_ciudadB", CiudadModel]] as [string, unknown][]
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

  let adssLogData: { before: string | null; after: string | null } | null = null;

  await sequelize.transaction(async (t) => {
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

  await PosteModel.destroy({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "DELETE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Archivó Poste #${id}`, severity: 'critical' });
  return res.status(204).end();
});
export const desarchivarPoste = handler("desarchivarPoste", async (req: Request, res: Response) => {
  const { id } = req.params;

  await PosteModel.restore({ where: { id } });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Desarchivó Poste #${id}`, severity: 'info' });
  return res.status(204).end();
});
