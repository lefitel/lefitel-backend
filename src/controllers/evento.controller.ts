import { Request, Response } from "express";
import { Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { EventoModel } from "../models/evento.model.js";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { ObsModel } from "../models/obs.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { RevisionModel } from "../models/revision.model.js";
import { SolucionModel } from "../models/solucion.model.js";
import { UsuarioModel } from "../models/usuario.model.js";

export async function getEvento(req: Request, res: Response) {
  const { archived, page, limit, filterColumn, filterValue, export: isExport } = req.query;
  const isArchived = archived === "true";

  const where: Record<string, unknown> = isArchived ? { deletedAt: { [Op.ne]: null } } : {};

  if (filterColumn && filterValue && typeof filterValue === "string" && filterValue.trim()) {
    if (filterColumn === "description") {
      where["description"] = { [Op.iLike]: `%${filterValue.trim()}%` };
    }
  }

  const posteWhere = filterColumn === "poste" && filterValue && typeof filterValue === "string" && filterValue.trim()
    ? { name: { [Op.iLike]: `%${filterValue.trim()}%` } }
    : undefined;

  const queryOptions = {
    order: [["id", "DESC"]] as [[string, string]],
    paranoid: !isArchived,
    where,
    attributes: { exclude: ["image"] },
    include: [
      {
        model: RevisionModel,
        separate: true,
        attributes: ["id", "date", "id_evento"],
      },
      {
        model: PosteModel,
        paranoid: false,
        attributes: ["id", "name", "id_ciudadA", "id_ciudadB", "id_propietario"],
        ...(posteWhere ? { where: posteWhere, required: true } : {}),
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
        include: [{ model: ObsModel, paranoid: false, attributes: ["id", "name"] }],
      },
      {
        model: UsuarioModel,
        attributes: ["id", "name", "lastname"],
      },
    ],
  };

  try {
    if (isExport === "true") {
      const data = await EventoModel.findAll(queryOptions);
      return res.status(200).json(data);
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(15, Number(limit) || 50));
    const offset = (pageNum - 1) * limitNum;

    const { count, rows } = await EventoModel.findAndCountAll({
      ...queryOptions,
      limit: limitNum,
      offset,
      distinct: true,
    });

    return res.status(200).json({
      data: rows,
      total: count,
      page: pageNum,
      totalPages: Math.ceil(count / limitNum),
      limit: limitNum,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getEvento_poste(req: Request, res: Response) {
  const { id_poste } = req.params;

  try {
    const TempEvento = await EventoModel.findAll({
      where: { id_poste },
      order: [["id", "DESC"]],
    });
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getEvento_usuario(req: Request, res: Response) {
  const { id_usuario } = req.params;
  try {
    const TempEvento = await EventoModel.findAll({
      where: { id_usuario },
      order: [["id", "DESC"]],
      include: [{ model: PosteModel, attributes: ["id", "name"] }],
    });
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function searchEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempEvento = await EventoModel.findOne({
      where: { id },
      include: [
        { model: RevisionModel },
        {
          model: PosteModel,
          include: [
            { model: CiudadModel, as: "ciudadA" },
            { model: CiudadModel, as: "ciudadB" },
            { model: PropietarioModel },
          ],
        },
        { model: UsuarioModel },
        { model: EventoObsModel, include: [{ model: ObsModel, paranoid: false }] },
      ],
    });
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createEvento(req: Request, res: Response) {
  try {
    const { revision, obs_ids, ...eventoBody } = req.body;
    const TempEvento = await sequelize.transaction(async (t) => {
      const evento = await EventoModel.create(eventoBody, { transaction: t });
      const eventoId = evento.dataValues.id as number;
      if (revision?.description) {
        await RevisionModel.create({
          description: revision.description,
          date: revision.date ?? eventoBody.date ?? new Date(),
          id_evento: eventoId,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obsRows = await (ObsModel as any).findAll({
        where: { id: obs_ids },
        attributes: ["name"],
        paranoid: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      obsLabel = obsRows.map((r: any) => r.dataValues.name).join(", ") || null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const posteRow = eventoBody.id_poste != null ? await (PosteModel as any).findByPk(eventoBody.id_poste, { attributes: ["id", "name"], paranoid: false }) : null;
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
    res.status(200).json(TempEvento);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempEvento = await EventoModel.findOne({ where: { id } });
    if (!TempEvento) return res.status(404).json({ message: "Evento no encontrado" });
    const wasResolved = TempEvento.dataValues.state;
    const oldImage = TempEvento.dataValues.image;
    const edv = TempEvento.dataValues as unknown as Record<string, unknown>;

    const { obs_ids, ...bodyWithoutObs } = req.body;

    const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
    const beforeMeta: Record<string, unknown> = {};
    const afterMeta:  Record<string, unknown> = {};
    for (const k of Object.keys(bodyWithoutObs)) {
      const bv = edv[k];
      if (bv === undefined || k === "id_poste") continue;
      if (isPrimVal(bv) && isPrimVal(bodyWithoutObs[k])) { beforeMeta[k] = bv; afterMeta[k] = bodyWithoutObs[k]; }
    }
    const bvPoste = edv["id_poste"] as number | null | undefined;
    const avPoste = bodyWithoutObs["id_poste"] as number | null | undefined;
    if (bvPoste !== undefined && bvPoste !== avPoste) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fkRef = async (pkVal: number | null | undefined) => {
        if (pkVal == null) return null;
        const row = await (PosteModel as any).findByPk(pkVal, { attributes: ["id", "name"], paranoid: false });
        return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
      };
      [beforeMeta["id_poste"], afterMeta["id_poste"]] = await Promise.all([fkRef(bvPoste), fkRef(avPoste)]);
    }
    let obsLogData: { before: string | null; after: string | null } | null = null;

    await sequelize.transaction(async (t) => {
      TempEvento.set(bodyWithoutObs);
      await TempEvento.save({ transaction: t });

      if (Array.isArray(obs_ids)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentEventoObs = await (EventoObsModel as any).findAll({ where: { id_evento: id }, transaction: t });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentIds = currentEventoObs.map((eo: any) => eo.dataValues.id_obs as number);
        const toAdd = (obs_ids as number[]).filter((oid) => !currentIds.includes(oid));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toRemove = currentEventoObs.filter((eo: any) => !(obs_ids as number[]).includes(eo.dataValues.id_obs as number));

        if (toAdd.length > 0 || toRemove.length > 0) {
          const allIds = [...new Set([...currentIds, ...(obs_ids as number[])])];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const allRows = await (ObsModel as any).findAll({ where: { id: allIds }, attributes: ["id", "name"], paranoid: false, transaction: t });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nameMap = new Map(allRows.map((r: any) => [r.dataValues.id as number, r.dataValues.name as string]));
          const beforeObs = currentIds.map((oid: number) => nameMap.get(oid)).filter(Boolean).join(", ");
          const afterObs = (obs_ids as number[]).map((oid) => nameMap.get(oid)).filter(Boolean).join(", ");

          await Promise.all([
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...toAdd.map((id_obs: number) => (EventoObsModel as any).create({ id_obs, id_evento: Number(id) }, { transaction: t })),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...toRemove.map((eo: any) => eo.destroy({ transaction: t })),
          ]);

          obsLogData = { before: beforeObs || null, after: afterObs || null };
        }
      }
    });

    if (oldImage && bodyWithoutObs.image && oldImage !== bodyWithoutObs.image) {
      deleteImageFile(oldImage);
    }
    if (!wasResolved && bodyWithoutObs.state === true) {
      logAction({ id_usuario: req.user?.id, action: "RESOLVE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Resolvió Evento #${id}`, metadata: { before: { state: false }, after: { state: true } }, severity: 'info' });
    } else if (Object.keys(beforeMeta).some(k => beforeMeta[k] !== afterMeta[k])) {
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
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function reabrirEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
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

    if (solucionImage) deleteImageFile(solucionImage);

    logAction({ id_usuario: req.user?.id, action: "REABRIR_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Reabrió Evento #${id}`, metadata: { before: { state: true }, after: { state: false } }, severity: 'warning' });
    res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function deleteEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await EventoModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Archivó Evento #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await EventoModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Desarchivó Evento #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function resolverEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const evento = await EventoModel.findOne({ where: { id } });
    if (!evento) return res.status(404).json({ message: "Evento no encontrado" });
    if (evento.dataValues.state) return res.status(400).json({ message: "El evento ya está resuelto" });

    const { description, date, image } = req.body;

    await sequelize.transaction(async (t) => {
      await SolucionModel.create(
        { description, date: date ?? new Date(), image: image || null, id_evento: Number(id) },
        { transaction: t }
      );
      evento.set({ state: true });
      await evento.save({ transaction: t });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const posteRow = evento.dataValues.id_poste != null ? await (PosteModel as any).findByPk(evento.dataValues.id_poste, { attributes: ["id", "name"], paranoid: false }) : null;
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

    res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
