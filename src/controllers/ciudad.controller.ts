import { Request, Response } from "express";
import { Op, literal } from "sequelize";
import { CiudadModel } from "../models/ciudad.model.js";
import { can } from "../permissions/store.js";
import { deleteImageIfUnreferenced } from "../utils/imageRefs.js";
import { logAction } from "../utils/logAction.js";
import { archivar, NADA_QUE_ARCHIVAR, desarchivar, NADA_QUE_DESARCHIVAR } from "../utils/archivado.js";
import { assignable } from "../utils/authorship.js";
import { leerNombre } from "../utils/nombre.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const ciudadLog = log("ciudad");
const handler = makeHandler(ciudadLog);

type Columna = [ReturnType<typeof literal>, string];

/** The live poles of a city: a pole belongs to both ends of its tramo. */
const DE_LA_CIUDAD =
  `("postes"."id_ciudadA" = "ciudad"."id" OR "postes"."id_ciudadB" = "ciudad"."id") AND "postes"."deletedAt" IS NULL`;

/** The live incidents on those poles. */
const EVENTOS_DE_LA_CIUDAD =
  `FROM "eventos" INNER JOIN "postes" ON "postes"."id" = "eventos"."id_poste" ` +
  `WHERE ${DE_LA_CIUDAD} AND "eventos"."deletedAt" IS NULL`;

/**
 * What a city's row says about its poles. Behind `postes.ver`.
 *
 * `vecinas` is the ids of the cities it shares a tramo with, and only the live
 * ones — the rule `tramosEntre` in `opciones.controller.ts` already follows, so
 * the list never names a city the same response does not carry.
 *
 * `::int` because `COUNT` is a bigint and the driver hands a bigint over as a
 * string.
 */
const CIFRAS_DE_POSTES: Columna[] = [
  [literal(`(SELECT COUNT(*)::int FROM "postes" WHERE ${DE_LA_CIUDAD})`), "postes"],
  [literal(
    `ARRAY(SELECT DISTINCT "vecina"."id" FROM "postes" ` +
    `INNER JOIN "ciudads" AS "vecina" ON "vecina"."id" = CASE WHEN "postes"."id_ciudadA" = "ciudad"."id" ` +
    `THEN "postes"."id_ciudadB" ELSE "postes"."id_ciudadA" END AND "vecina"."deletedAt" IS NULL ` +
    `WHERE ${DE_LA_CIUDAD} AND "vecina"."id" <> "ciudad"."id" ORDER BY "vecina"."id")`,
  ), "vecinas"],
];

/**
 * What it says about its incidents. Behind `eventos.ver`.
 *
 * Pending is `IS NOT TRUE` and not `= false`: `state` is nullable, and this has
 * to count what the incident list shows under "Pendientes".
 */
const CIFRAS_DE_EVENTOS: Columna[] = [
  [literal(`(SELECT COUNT(*)::int ${EVENTOS_DE_LA_CIUDAD} AND "eventos"."state" IS NOT TRUE)`), "pendientes"],
  [literal(
    `(SELECT COUNT(*)::int ${EVENTOS_DE_LA_CIUDAD} AND "eventos"."state" IS NOT TRUE AND "eventos"."priority" = true)`,
  ), "prioritarios"],
  [literal(`(SELECT MAX("eventos"."date") ${EVENTOS_DE_LA_CIUDAD})`), "ultimoEvento"],
];

export const getCiudad = handler("getCiudad", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  // The route is gated by `ciudades.ver`, which says nothing about poles or
  // incidents. Each block is asked for only by a role that could read it on its
  // own screen; for the rest the fields are absent, not zero.
  const rol = req.user?.id_rol;
  const [verPostes, verEventos] = rol === undefined
    ? [false, false]
    : await Promise.all([can(rol, "postes", "ver"), can(rol, "eventos", "ver")]);

  const listado = await listar(CiudadModel, {
    order: [["id", "DESC"]],
    paranoid: !archived,
    where: archived ? { deletedAt: { [Op.ne]: null } } : {},
    attributes: {
      include: [...(verPostes ? CIFRAS_DE_POSTES : []), ...(verEventos ? CIFRAS_DE_EVENTOS : [])],
    },
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json(listado);
});
export const createCiudad = handler("createCiudad", async (req: Request, res: Response) => {
  const nombre = leerNombre(req.body, true, "La ciudad necesita un nombre.");
  if ("error" in nombre) return res.status(400).json({ message: nombre.error });

  // The name that was checked is the name that is written: trimmed.
  const TempCiudad = await CiudadModel.create({ ...assignable(req.body), name: nombre.name });
  logAction({ id_usuario: req.user?.id, action: "CREATE_CIUDAD", entity: "Ciudad", entity_id: TempCiudad.dataValues.id as number, detail: `Creó ciudad ${nombre.name}`, metadata: { after: { name: nombre.name } }, severity: 'info' });
  res.status(201).json(TempCiudad);
});
export const updateCiudad = handler("updateCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  const nombre = leerNombre(req.body, false, "La ciudad necesita un nombre.");
  if ("error" in nombre) return res.status(400).json({ message: nombre.error });

  const TempCiudad = await CiudadModel.findOne({ where: { id } });
  if (!TempCiudad) return res.status(404).json({ message: "Ciudad no encontrada" });
  const oldImage = TempCiudad.dataValues.image;
  const dv = TempCiudad.dataValues as unknown as Record<string, unknown>;
  // The diff is built from what will actually be written. `assignable` refuses
  // id/createdAt/updatedAt/deletedAt at the write, and an entry that records the
  // refused change is worse than no entry at all: the bitácora is where a reader
  // goes to find out whether the row was archived.
  const editable: Record<string, unknown> = assignable(req.body);
  if (nombre.name !== undefined) editable.name = nombre.name;
  const beforeCiudad = Object.fromEntries(Object.keys(editable).map(k => [k, dv[k]]));
  TempCiudad.set(editable);
  await TempCiudad.save();
  // Only if nothing else names the file — see `imageRefs.ts`.
  if (oldImage && req.body.image && oldImage !== req.body.image) {
    void deleteImageIfUnreferenced(oldImage);
  }
  logAction({ id_usuario: req.user?.id, action: "UPDATE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Editó ciudad #${id}`, metadata: { before: beforeCiudad, after: editable }, severity: 'warning' });
  res.status(200).json(TempCiudad);
});
export const searchCiudad = handler("searchCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  const ciudad = await CiudadModel.findByPk(Number(id));
  if (!ciudad) return res.status(404).json({ message: "Ciudad no encontrada" });
  res.status(200).json(ciudad);
});
export const desarchivarCiudad = handler("desarchivarCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!(await desarchivar(CiudadModel, id))) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Desarchivó ciudad #${id}`, severity: 'info' });
  return res.status(204).end();
});
export const deleteCiudad = handler("deleteCiudad", async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!(await archivar(CiudadModel, id))) return res.status(404).json({ message: NADA_QUE_ARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "DELETE_CIUDAD", entity: "Ciudad", entity_id: Number(id), detail: `Archivó ciudad #${id}`, severity: 'critical' });
  return res.status(204).end();
});
