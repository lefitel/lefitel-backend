import { Request, Response } from "express";
import { Op } from "sequelize";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { EventoModel } from "../models/evento.model.js";
import { EventoObsModel } from "../models/eventoObs.model.js";
import { ObsModel } from "../models/obs.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { RevicionModel } from "../models/revicion.model.js";
import { SolucionModel } from "../models/solucion.model.js";
import { UsuarioModel } from "../models/usuario.model.js";

export async function getEvento(req: Request, res: Response) {
  const isArchived = req.query.archived === "true";
  try {
    const TempEvento = await EventoModel.findAll({
      order: [["id", "DESC"]],
      paranoid: !isArchived,
      where: isArchived ? { deletedAt: { [Op.ne]: null } } : {},
      include: [
        {
          model: RevicionModel,
          separate: true,
          attributes: ["id", "date", "id_evento"],
        },
        {
          model: PosteModel,
          paranoid: false,
          attributes: ["id", "name", "id_ciudadA", "id_ciudadB", "id_propietario"],
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
    });
    res.status(200).json(TempEvento);
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
        { model: RevicionModel },
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
    const TempEvento = await EventoModel.create(req.body);
    const eventoId = TempEvento.dataValues.id as number;
    logAction({ id_usuario: req.user?.id, action: "CREATE_EVENTO", entity: "Evento", entity_id: eventoId, detail: `Creó evento en Poste #${req.body.id_poste}` });
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
    TempEvento.set(req.body);
    await TempEvento.save();
    if (oldImage && req.body.image && oldImage !== req.body.image) {
      deleteImageFile(oldImage);
    }
    if (!wasResolved && req.body.state === true) {
      logAction({ id_usuario: req.user?.id, action: "RESOLVE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Resolvió Evento #${id}` });
    } else {
      logAction({ id_usuario: req.user?.id, action: "UPDATE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Editó Evento #${id}` });
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
    if (solucion) {
      deleteImageFile(solucion.dataValues.image);
      await solucion.destroy();
    }

    evento.set({ state: false });
    await evento.save();

    logAction({ id_usuario: req.user?.id, action: "REABRIR_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Reabrió Evento #${id}` });
    res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function deleteEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await EventoModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Archivó Evento #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarEvento(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await EventoModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_EVENTO", entity: "Evento", entity_id: Number(id), detail: `Desarchivó Evento #${id}` });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
