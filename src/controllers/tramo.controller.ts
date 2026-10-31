import { Request, Response } from "express";
import { literal, Op, type Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { DepartamentoModel } from "../models/departamento.model.js";
import { PosteModel } from "../models/poste.model.js";
import { TramoModel } from "../models/tramo.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { can } from "../permissions/store.js";
import { INCLUDE_TRAMO, presentarTramo, type TramoPresentado } from "../tramos/presentacion.js";
import { sqlNombreDelTramo } from "../tramos/nombre.js";
import { desarchivar, NADA_QUE_ARCHIVAR, NADA_QUE_DESARCHIVAR } from "../utils/archivado.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";

const tramoLog = log("tramo");
const handler = makeHandler(tramoLog);

const DOS_CIUDADES = "Un tramo une dos ciudades distintas.";
const CIUDAD_INEXISTENTE = "Una de las ciudades no existe o está archivada.";
const DEPARTAMENTO_INEXISTENTE = "El departamento indicado no existe.";
const DEPARTAMENTO_ILEGIBLE = "El departamento indicado no es válido.";
const ENCARGADO_INEXISTENTE = "El encargado indicado no existe o está archivado.";
const ENCARGADO_ILEGIBLE = "El encargado indicado no es válido.";
const YA_EXISTE = "Ese tramo ya existe.";
const EXISTE_ARCHIVADO_SIN_PERMISO =
  "Ese tramo ya existe pero está archivado: debe desarchivarlo alguien con permiso para archivar y desarchivar tramos.";
const YA_EXISTE_ARCHIVADO = "Ese par de ciudades pertenece a un tramo archivado: desarchívalo en lugar de mover este.";
const CON_POSTES = "No se pueden cambiar las ciudades de un tramo que tiene postes.";
const NO_ARCHIVABLE = "No se puede archivar un tramo que tiene postes.";
const NO_ENCONTRADO = "El tramo no existe.";
/** What a pole write answers when its tramo cannot take it. Used by `poste.controller.ts`. */
export const TRAMO_NO_DISPONIBLE = "El tramo indicado no existe o está archivado.";

const entero = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The two ends out of a body, lowest id first, or the sentence to answer with.
 *
 * Lowest first because that is the one form the table accepts. The caller sends
 * them in whatever order the person picked them — a tramo has none.
 */
export const leerCiudades = (body: unknown): [number, number] | string => {
  const ciudades = (body as { ciudades?: unknown } | null)?.ciudades;
  if (!Array.isArray(ciudades) || ciudades.length !== 2) return DOS_CIUDADES;
  const [a, b] = ciudades.map(entero);
  if (a === null || b === null || a === b) return DOS_CIUDADES;
  return a < b ? [a, b] : [b, a];
};

/** `undefined` when the body does not mention it, so a partial update leaves it alone. */
const leerDepartamento = (body: unknown): number | null | undefined | string => {
  if (typeof body !== "object" || body === null || !Object.hasOwn(body, "id_departamento")) return undefined;
  const valor = (body as { id_departamento: unknown }).id_departamento;
  if (valor === null || valor === "") return null;
  return entero(valor) ?? DEPARTAMENTO_ILEGIBLE;
};

/** Same contract as `leerDepartamento`: `undefined` leaves the encargado alone, `null` clears it. */
const leerEncargado = (body: unknown): number | null | undefined | string => {
  if (typeof body !== "object" || body === null || !Object.hasOwn(body, "id_encargado")) return undefined;
  const valor = (body as { id_encargado: unknown }).id_encargado;
  if (valor === null || valor === "") return null;
  return entero(valor) ?? ENCARGADO_ILEGIBLE;
};

/**
 * Whether the encargado a write is about to set is a live account, asked under
 * a share lock on that account's row and inside the write's transaction.
 *
 * The lock is what makes archiving and assigning take turns. `deleteUsuario`
 * locks the same row FOR UPDATE before it looks for the person's tramos, so an
 * assignment either commits first — and the archive finds the tramo and asks
 * for it to be released — or waits for the archive and then finds no live
 * account (`findByPk` is paranoid). Without it, a check that passed a moment
 * before the archive committed left a tramo with an archived encargado.
 * True when the write sets no encargado, or clears it.
 */
const encargadoVivo = async (cambios: Record<string, unknown>, t: Transaction): Promise<boolean> => {
  if (typeof cambios.id_encargado !== "number") return true;
  return !!(await UsuarioModel.findByPk(cambios.id_encargado, { attributes: ["id"], transaction: t, lock: t.LOCK.SHARE }));
};

/** One tramo as it travels, archived or not; the caller decides what an archived one means. */
const cargar = async (id: number): Promise<TramoPresentado | null> => {
  const fila = await TramoModel.findByPk(id, {
    paranoid: false, attributes: INCLUDE_TRAMO.attributes, include: INCLUDE_TRAMO.include,
  });
  return fila ? presentarTramo(fila) : null;
};

const porPar = (min: number, max: number, transaction?: Transaction) =>
  TramoModel.findOne({
    where: { id_ciudad_min: min, id_ciudad_max: max },
    transaction,
    paranoid: false,
    attributes: INCLUDE_TRAMO.attributes,
    include: INCLUDE_TRAMO.include,
  });

/** The 409 for a pair somebody else holds: an archived holder cannot be used, only restored. */
const respuestaDeParOcupado = (otro: TramoPresentado) => ({
  message: otro.archivado ? YA_EXISTE_ARCHIVADO : YA_EXISTE,
  tramo: otro,
});

const esDuplicado = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === "SequelizeUniqueConstraintError";

/** Live poles on a tramo, as a column. Behind `postes.ver`. */
const CIFRA_DE_POSTES: [ReturnType<typeof literal>, string] = [
  literal(`(SELECT COUNT(*)::int FROM "postes" WHERE "postes"."id_tramo" = "tramo"."id" AND "postes"."deletedAt" IS NULL)`),
  "postes",
];

/**
 * Incidents still open on a tramo's live poles, as a column. Behind `eventos.ver`.
 *
 * Counted as the cities' list counts its own `pendientes` (`ciudad.controller.ts`):
 * not solved is `state IS NOT TRUE`, so a null state is pending too, and neither
 * an archived incident nor one on an archived pole is there to be attended.
 */
const CIFRA_DE_PENDIENTES: [ReturnType<typeof literal>, string] = [
  literal(
    `(SELECT COUNT(*)::int FROM "eventos" INNER JOIN "postes" ON "postes"."id" = "eventos"."id_poste" ` +
    `WHERE "postes"."id_tramo" = "tramo"."id" AND "postes"."deletedAt" IS NULL ` +
    `AND "eventos"."deletedAt" IS NULL AND "eventos"."state" IS NOT TRUE)`,
  ),
  "pendientes",
];

export const getTramo = handler("getTramo", async (req: Request, res: Response) => {
  const archived = req.query.archived === "true";
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

  const where: Record<string, unknown> = archived ? { deletedAt: { [Op.ne]: null } } : {};
  const { departamento } = req.query;
  if (departamento !== undefined) {
    if (departamento === "ninguno") where.id_departamento = null;
    else {
      const id = entero(departamento);
      if (id === null) return res.status(400).json({ message: DEPARTAMENTO_ILEGIBLE });
      where.id_departamento = id;
    }
  }

  // The route asks for `tramos.ver`, which says nothing about poles or about
  // incidents. Each figure is absent, not zero, for a role that could not read
  // it on its own screen — and each on its own permission: neither implies the other.
  const rol = req.user?.id_rol;
  const verPostes = rol === undefined ? false : await can(rol, "postes", "ver");
  const verEventos = rol === undefined ? false : await can(rol, "eventos", "ver");

  const listado = await listar(TramoModel, {
    where,
    paranoid: !archived,
    // By the name people read, and by id so that a tie cannot reorder between pages.
    // The name is built under COLLATE "C" (see `tramos/nombre.ts`), so it is
    // sorted under it too: with the database's default collation the order
    // ignores spaces and case, and a client sorting `nombre` in JavaScript
    // would get a different order from the one the list came in.
    order: [[literal(`(${sqlNombreDelTramo(`"tramo"."id"`)}) COLLATE "C"`), "ASC"], ["id", "ASC"]],
    attributes: {
      include: [...(verPostes ? [CIFRA_DE_POSTES] : []), ...(verEventos ? [CIFRA_DE_PENDIENTES] : [])],
    },
    include: INCLUDE_TRAMO.include,
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);

  const data = listado.data.map((fila) => {
    const crudo = JSON.parse(JSON.stringify(fila)) as { postes?: number; pendientes?: number };
    return {
      ...presentarTramo(crudo),
      ...(verPostes ? { postes: Number(crudo.postes ?? 0) } : {}),
      ...(verEventos ? { pendientes: Number(crudo.pendientes ?? 0) } : {}),
    };
  });
  return res.status(200).json({ ...listado, data });
});

export const searchTramo = handler("searchTramo", async (req: Request, res: Response) => {
  const id = entero(req.params.id);
  const tramo = id === null ? null : await cargar(id);
  if (!tramo || tramo.archivado) return res.status(404).json({ message: NO_ENCONTRADO });
  res.status(200).json(tramo);
});

/**
 * `GET /api/usuario/:id/tramos`: the tramos a person is in charge of, by name.
 *
 * Archived ones too, marked: archiving the person releases those as well
 * (`deleteUsuario`), so a tramo restored later does not come back with an
 * archived encargado. The ficha shows the live ones; the archive dialog lists
 * all it is about to release. The gate is the route's.
 */
export const getTramos_usuario = handler("getTramos_usuario", async (req: Request, res: Response) => {
  const paginacion = leerPaginacion(req.query);
  if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });
  // A malformed id matches nobody, as an id that names nobody does.
  const id = entero(req.params.id) ?? 0;

  const listado = await listar(TramoModel, {
    where: { id_encargado: id },
    paranoid: false,
    // As `getTramo` orders, and for the same reasons.
    order: [[literal(`(${sqlNombreDelTramo(`"tramo"."id"`)}) COLLATE "C"`), "ASC"], ["id", "ASC"]],
    attributes: INCLUDE_TRAMO.attributes,
    include: INCLUDE_TRAMO.include,
  }, paginacion);
  if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
  return res.status(200).json({ ...listado, data: listado.data.map(presentarTramo) });
});

export const createTramo = handler("createTramo", async (req: Request, res: Response) => {
  const ciudades = leerCiudades(req.body);
  if (typeof ciudades === "string") return res.status(400).json({ message: ciudades });
  const [min, max] = ciudades;

  const departamento = leerDepartamento(req.body);
  if (typeof departamento === "string") return res.status(400).json({ message: departamento });

  if ((await CiudadModel.count({ where: { id: [min, max] } })) !== 2) {
    return res.status(400).json({ message: CIUDAD_INEXISTENTE });
  }
  if (typeof departamento === "number" && !(await DepartamentoModel.findByPk(departamento))) {
    return res.status(400).json({ message: DEPARTAMENTO_INEXISTENTE });
  }

  const existente = await porPar(min, max);
  if (existente && existente.get("deletedAt") == null) {
    return res.status(409).json({ message: YA_EXISTE, tramo: presentarTramo(existente) });
  }

  if (existente) {
    // Coming back is un-archiving, and the route's gate (`tramos.crear`) does not
    // cover that: the button for it asks for `tramos.archivar`, so this does too.
    // Without it the person is told where the tramo is and nothing is written.
    const rol = req.user?.id_rol;
    if (rol === undefined || !(await can(rol, "tramos", "archivar"))) {
      return res.status(409).json({ message: EXISTE_ARCHIVADO_SIN_PERMISO, tramo: presentarTramo(existente) });
    }
    // One row per pair for ever: the archived one comes back, with its
    // archived poles still on it. What the request says about the department
    // wins; silence leaves the one it had.
    // The two writes are one: a restore with the department left behind
    // would answer the next reader with a tramo the request never described.
    await sequelize.transaction(async (t) => {
      await existente.restore({ transaction: t });
      if (departamento !== undefined) {
        existente.set({ id_departamento: departamento });
        await existente.save({ transaction: t });
      }
    });
    const id = existente.get("id") as number;
    const tramo = presentarTramo((await porPar(min, max)) ?? existente);
    logAction({ id_usuario: req.user?.id, action: "RESTORE_TRAMO", entity: "Tramo", entity_id: id, detail: `Desarchivó tramo ${tramo.nombre}`, severity: "info" });
    return res.status(201).json(tramo);
  }

  let idCreado: number;
  try {
    const fila = await TramoModel.create({
      id_ciudad_min: min, id_ciudad_max: max, id_departamento: departamento ?? null, id_usuario: req.user?.id ?? null,
    });
    idCreado = fila.get("id") as number;
  } catch (error) {
    // Somebody created it between the look above and this write. The unique
    // index is what cannot be raced; this turns its refusal into the same
    // answer the look would have given.
    if (!esDuplicado(error)) throw error;
    const ganador = await porPar(min, max);
    if (!ganador) throw error;
    return res.status(409).json({ message: YA_EXISTE, tramo: presentarTramo(ganador) });
  }

  const tramo = await cargar(idCreado);
  if (!tramo) throw new Error(`Tramo ${idCreado} could not be read back after creating it`);
  logAction({
    id_usuario: req.user?.id, action: "CREATE_TRAMO", entity: "Tramo", entity_id: tramo.id,
    detail: `Creó tramo ${tramo.nombre}`,
    metadata: { after: { name: tramo.nombre, departamento: tramo.departamento?.name ?? null } }, severity: "info",
  });
  res.status(201).json(tramo);
});

export const updateTramo = handler("updateTramo", async (req: Request, res: Response) => {
  const id = entero(req.params.id);
  const fila = id === null ? null : await TramoModel.findOne({
    where: { id }, attributes: INCLUDE_TRAMO.attributes, include: INCLUDE_TRAMO.include,
  });
  if (!fila || id === null) return res.status(404).json({ message: NO_ENCONTRADO });
  const antes = presentarTramo(fila);

  const cambios: Record<string, unknown> = {};

  const departamento = leerDepartamento(req.body);
  if (typeof departamento === "string") return res.status(400).json({ message: departamento });
  if (departamento !== undefined && departamento !== antes.id_departamento) {
    if (typeof departamento === "number" && !(await DepartamentoModel.findByPk(departamento))) {
      return res.status(400).json({ message: DEPARTAMENTO_INEXISTENTE });
    }
    cambios.id_departamento = departamento;
  }

  // Whether the account exists is asked inside the transaction that writes
  // (`encargadoVivo`), not here.
  const encargado = leerEncargado(req.body);
  if (typeof encargado === "string") return res.status(400).json({ message: encargado });
  if (encargado !== undefined && encargado !== antes.id_encargado) cambios.id_encargado = encargado;

  let extremos: [number, number] | null = null;
  if (Object.hasOwn(req.body ?? {}, "ciudades")) {
    const ciudades = leerCiudades(req.body);
    if (typeof ciudades === "string") return res.status(400).json({ message: ciudades });
    if (ciudades[0] !== fila.get("id_ciudad_min") || ciudades[1] !== fila.get("id_ciudad_max")) extremos = ciudades;
  }

  if (extremos === null) {
    if (Object.keys(cambios).length > 0) {
      const escrito = await sequelize.transaction(async (t) => {
        if (!(await encargadoVivo(cambios, t))) return false;
        fila.set(cambios);
        await fila.save({ transaction: t });
        return true;
      });
      if (!escrito) return res.status(400).json({ message: ENCARGADO_INEXISTENTE });
    }
  } else {
    const [min, max] = extremos;
    // The count of poles and the move of the ends under one lock on the row:
    // without it a pole created in between would be left standing on a tramo
    // that now joins two other cities. The lock is taken on the bare row, since
    // FOR UPDATE does not work over the LEFT JOINs of the include.
    let resultado;
    try {
      resultado = await sequelize.transaction(async (t) => {
      const bloqueada = await TramoModel.findOne({ where: { id }, transaction: t, lock: t.LOCK.UPDATE });
      if (!bloqueada) return "nada" as const;
      // Archived poles count: they still belong to this stretch, and would
      // come back standing somewhere else.
      if ((await PosteModel.count({ where: { id_tramo: id }, paranoid: false, transaction: t })) > 0) {
        return "con-postes" as const;
      }
      if ((await CiudadModel.count({ where: { id: [min, max] }, transaction: t })) !== 2) return "sin-ciudad" as const;
      if (!(await encargadoVivo(cambios, t))) return "sin-encargado" as const;
      const otro = await porPar(min, max, t);
      if (otro) return presentarTramo(otro);
      bloqueada.set({ ...cambios, id_ciudad_min: min, id_ciudad_max: max });
      await bloqueada.save({ transaction: t });
      return "movido" as const;
      });
    } catch (error) {
      // Two tramos moved onto the same pair at once: the look above found it
      // free for both, and the unique index is what cannot be raced. The loser
      // is told what the look would have told it. The winner is read here, after
      // the transaction the index aborted has rolled back.
      if (!esDuplicado(error)) throw error;
      const ganador = await porPar(min, max);
      if (!ganador) throw error;
      return res.status(409).json(respuestaDeParOcupado(presentarTramo(ganador)));
    }

    if (resultado === "nada") return res.status(404).json({ message: NO_ENCONTRADO });
    if (resultado === "con-postes") return res.status(409).json({ message: CON_POSTES });
    if (resultado === "sin-ciudad") return res.status(400).json({ message: CIUDAD_INEXISTENTE });
    if (resultado === "sin-encargado") return res.status(400).json({ message: ENCARGADO_INEXISTENTE });
    if (resultado !== "movido") return res.status(409).json(respuestaDeParOcupado(resultado));
    cambios.id_ciudad_min = min;
    cambios.id_ciudad_max = max;
  }

  const despues = (await cargar(id)) ?? antes;
  if (Object.keys(cambios).length > 0) {
    logAction({
      id_usuario: req.user?.id, action: "UPDATE_TRAMO", entity: "Tramo", entity_id: id,
      detail: `Editó tramo ${despues.nombre}`,
      metadata: {
        before: {
          name: antes.nombre, departamento: antes.departamento?.name ?? null,
          encargado: antes.encargado?.nombre ?? null, id_encargado: antes.id_encargado,
        },
        after: {
          name: despues.nombre, departamento: despues.departamento?.name ?? null,
          encargado: despues.encargado?.nombre ?? null, id_encargado: despues.id_encargado,
        },
      },
      severity: "warning",
    });
  }
  res.status(200).json(despues);
});

export const deleteTramo = handler("deleteTramo", async (req: Request, res: Response) => {
  const id = entero(req.params.id);
  if (id === null) return res.status(404).json({ message: NADA_QUE_ARCHIVAR });

  // The look and the archive under one lock on the row: nothing that takes
  // the same lock can change the poles of this tramo between the count and the
  // archive. A pole write takes a shared lock on this row and re-checks that
  // the tramo is live (`tramoParaEscribir` in `poste.controller.ts`), so a pole
  // created or moved here either is counted below, or finds the tramo archived
  // and is refused: it cannot land in the gap.
  const resultado = await sequelize.transaction(async (t) => {
    const fila = await TramoModel.findOne({ where: { id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!fila) return "nada" as const;
    if ((await PosteModel.count({ where: { id_tramo: id }, transaction: t })) > 0) return "con-postes" as const;
    await fila.destroy({ transaction: t });
    return "archivado" as const;
  });

  if (resultado === "nada") return res.status(404).json({ message: NADA_QUE_ARCHIVAR });
  if (resultado === "con-postes") return res.status(409).json({ message: NO_ARCHIVABLE });
  logAction({ id_usuario: req.user?.id, action: "DELETE_TRAMO", entity: "Tramo", entity_id: id, detail: `Archivó tramo #${id}`, severity: "critical" });
  return res.status(204).end();
});

export const desarchivarTramo = handler("desarchivarTramo", async (req: Request, res: Response) => {
  const id = entero(req.params.id);
  if (id === null) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  // No clash to ask about first, unlike a role: the pair is unique among the
  // archived too, so nothing can have taken its place.
  if (!(await desarchivar(TramoModel, id))) return res.status(404).json({ message: NADA_QUE_DESARCHIVAR });
  logAction({ id_usuario: req.user?.id, action: "RESTORE_TRAMO", entity: "Tramo", entity_id: id, detail: `Desarchivó tramo #${id}`, severity: "info" });
  return res.status(204).end();
});
