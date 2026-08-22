import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { RevisionModel, REVISION_PUBLIC_ATTRIBUTES } from "../models/revision.model.js";
import { authoredBy, withoutAuthor } from "../utils/authorship.js";
import { logAction } from "../utils/logAction.js";

export async function getRevision(req: Request, res: Response) {
  const { id_evento } = req.params;

  try {
    const revisions = await RevisionModel.findAll({
      where: { id_evento },
      // Not the whole row: this route is authenticated and nothing more, and
      // the author belongs to the generator's gate. See the attribute list.
      attributes: [...REVISION_PUBLIC_ATTRIBUTES],
      order: [["id", "DESC"]],
    });
    res.status(200).json(revisions);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
/**
 * Resolves the event a revision belongs to, for the audit log.
 *
 * The value arrives from the request body, so it is narrowed here rather than
 * cast away: an `as any` on the lookup silenced the compiler and would have let
 * an object or an array reach findByPk untouched.
 */
const eventoRef = async (id_evento: unknown) => {
  if (id_evento == null) return null;
  if (typeof id_evento !== "number" && typeof id_evento !== "string") return id_evento;
  const row = await EventoModel.findByPk(id_evento, { attributes: ["id", "description"], paranoid: false });
  return row ? { id: row.dataValues.id, name: row.dataValues.description } : id_evento;
};

export async function createRevision(req: Request, res: Response) {
  try {
    const revision = await RevisionModel.create(authoredBy(req.body, req));
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
      // The author is not editable: see withoutAuthor. Stripping it before the
      // `before` snapshot too, so the bitácora does not record a change that
      // was refused.
      const body = withoutAuthor(req.body);
      const beforeRevision = Object.fromEntries(Object.keys(body).map(k => [k, rdv[k]]));
      revision.set(body);
      await revision.save();
      logAction({ id_usuario: req.user?.id, action: "UPDATE_REVISION", entity: "Revisión", entity_id: Number(id_evento), detail: `Editó revisión del Evento #${id_evento}`, metadata: { before: beforeRevision, after: body }, severity: 'warning' });
      res.status(200).json(revision);
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  } else {
    try {
      const revision = await RevisionModel.create(authoredBy(req.body, req));
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
