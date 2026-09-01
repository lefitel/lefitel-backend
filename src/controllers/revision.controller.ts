import { Request, Response } from "express";
import { EventoModel } from "../models/evento.model.js";
import { RevisionModel, REVISION_PUBLIC_ATTRIBUTES } from "../models/revision.model.js";
import { authoredBy } from "../utils/authorship.js";
import { logAction } from "../utils/logAction.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const revisionLog = log("revision");
const handler = makeHandler(revisionLog);

export const getRevision = handler("getRevision", async (req: Request, res: Response) => {
  const { id_evento } = req.params;

  const revisions = await RevisionModel.findAll({
    where: { id_evento },
    // Not the whole row: this route is authenticated and nothing more, and
    // the author belongs to the generator's gate. See the attribute list.
    attributes: [...REVISION_PUBLIC_ATTRIBUTES],
    order: [["id", "DESC"]],
  });
  res.status(200).json(revisions);
});
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

export const createRevision = handler("createRevision", async (req: Request, res: Response) => {
  const revision = await RevisionModel.create(authoredBy(req.body, req));
  const evRef = await eventoRef(req.body.id_evento);
  logAction({ id_usuario: req.user?.id, action: "ADD_REVISION", entity: "Revisión", entity_id: Number(req.body.id_evento), detail: `Agregó revisión al Evento #${req.body.id_evento}`, metadata: { after: { id_evento: evRef, description: req.body.description } }, severity: 'info' });
  res.status(200).json(revision);
});

// No `updateRevision` and no `deleteRevision`. Their routes had no caller ever,
// and `updateRevision` carried a second, unreachable life: with no `:id` it fell
// through to a create, duplicating `createRevision` for a request the router
// could never produce — `put("/:id")` does not match an empty segment.
//
// What it did have that nothing else did was refusing an authorship change
// *and* keeping it out of the audit log. That guarantee did not go with it: A0
// moved it to `updateEvento` and `updatePoste` first, with a test on each.
