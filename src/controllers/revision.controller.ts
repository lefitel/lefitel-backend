import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { RevisionModel } from "../models/revision.model.js";
import { logAction } from "../utils/logAction.js";

export async function getRevision(req: Request, res: Response) {
  const { id_evento } = req.params;

  try {
    const revisions = await RevisionModel.findAll({
      where: { id_evento },
      order: [["id", "DESC"]],
    });
    res.status(200).json(revisions);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eventoRef = async (id_evento: unknown) => {
  if (id_evento == null) return id_evento ?? null;
  const row = await (EventoModel as any).findByPk(id_evento, { attributes: ["id", "description"], paranoid: false });
  return row ? { id: row.dataValues.id, name: row.dataValues.description } : id_evento;
};

export async function createRevision(req: Request, res: Response) {
  try {
    const revision = await RevisionModel.create(req.body);
    const evRef = await eventoRef(req.body.id_evento);
    logAction({ id_usuario: req.user?.id, action: "ADD_REVISION", entity: "Revisión", entity_id: Number(req.body.id_evento), detail: `Agregó revisión al Evento #${req.body.id_evento}`, metadata: { after: { id_evento: evRef, description: req.body.description } }, severity: 'info' });
    res.status(200).json(revision);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updateRevision(req: Request, res: Response) {
  const { id } = req.params;
  if (id) {
    try {
      const revision = await RevisionModel.findOne({ where: { id } });
      if (!revision) return res.status(404).json({ message: "Revisión no encontrada" });
      const rdv = revision.dataValues as unknown as Record<string, unknown>;
      const id_evento = revision.dataValues.id_evento;
      const beforeRevision = Object.fromEntries(Object.keys(req.body).map(k => [k, rdv[k]]));
      revision.set(req.body);
      await revision.save();
      logAction({ id_usuario: req.user?.id, action: "UPDATE_REVISION", entity: "Revisión", entity_id: Number(id_evento), detail: `Editó revisión del Evento #${id_evento}`, metadata: { before: beforeRevision, after: req.body }, severity: 'warning' });
      res.status(200).json(revision);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  } else {
    try {
      const revision = await RevisionModel.create(req.body);
      const evRef2 = await eventoRef(req.body.id_evento);
      logAction({ id_usuario: req.user?.id, action: "ADD_REVISION", entity: "Revisión", entity_id: Number(req.body.id_evento) || null, detail: `Agregó revisión al Evento #${req.body.id_evento}`, metadata: { after: { id_evento: evRef2, description: req.body.description } }, severity: 'info' });
      res.status(200).json(revision);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }
}
export async function deleteRevision(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const revision = await RevisionModel.findOne({ where: { id } });
    const id_evento = revision?.dataValues.id_evento;
    await RevisionModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_REVISION", entity: "Revisión", entity_id: id_evento ? Number(id_evento) : null, detail: `Eliminó revisión del Evento #${id_evento ?? id}`, severity: 'warning' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
