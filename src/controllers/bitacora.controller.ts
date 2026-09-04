import { Request, Response } from "express";
import { literal, Op, WhereOptions } from "sequelize";
import { BitacoraModel } from "../models/bitacora.model.js";
import { UsuarioModel, USUARIO_AS_AUTHOR } from "../models/usuario.model.js";

import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const bitacoraLog = log("bitacora");
const handler = makeHandler(bitacoraLog);

/**
 * The accounts that have entries, asked as a semi-join.
 *
 * A `literal` rather than an `include`, and that choice is the reason this
 * endpoint arrived with a migration. Asked with a join and a `GROUP BY`,
 * Postgres reads every row of `bitacoras` and aggregates it. Asked with
 * `EXISTS`, and given `idx_bitacoras_id_usuario`, it probes the index once per
 * account and stops at the first row it finds: a cost that follows the number of
 * people, not the size of the log — which is the one table here that only grows,
 * a row per login and per write, pruned by nothing.
 *
 * Both forms plan identically *without* that index; it was measured before this
 * was written. So the query and the migration are one change in two files, and
 * either alone is half of it.
 *
 * `"usuario"` is the alias Sequelize gives the table in a `UsuarioModel` query —
 * the singular model name, not `usuarios`. Both column references are qualified
 * because `bitacoras` has an `id` of its own: unqualified, the statement is
 * ambiguous and Postgres refuses it outright.
 */
const CON_ENTRADAS = literal(
  'EXISTS (SELECT 1 FROM "bitacoras" WHERE "bitacoras"."id_usuario" = "usuario"."id")',
);

export const getAllBitacora = handler("getAllBitacora", async (req: Request, res: Response) => {
  const page   = Math.max(Number(req.query.page)  || 1,   1);
  const limit  = Math.min(Number(req.query.limit) || 50, 100);
  const offset = (page - 1) * limit;
  const { id_usuario, action, entity, entity_id, from, to, severity, sortBy, sortOrder } = req.query;

  const where: WhereOptions = {};
  if (id_usuario) where["id_usuario"] = Number(id_usuario);
  if (action)     where["action"]     = { [Op.like]: `${action}%` };
  if (entity)     where["entity"]     = entity;
  if (entity_id)  where["entity_id"]  = Number(entity_id);
  if (severity)   where["severity"]   = severity;
  if (from || to) {
    where["createdAt"] = {
      ...(from ? { [Op.gte]: new Date(from as string) } : {}),
      ...(to   ? { [Op.lte]: new Date(to   as string) } : {}),
    };
  }

  const SORTABLE = new Set(["id", "action", "entity", "severity", "createdAt"]);
  const sortByCols = Array.isArray(sortBy) ? sortBy as string[] : sortBy ? [sortBy as string] : [];
  const sortOrderVals = Array.isArray(sortOrder) ? sortOrder as string[] : sortOrder ? [sortOrder as string] : [];
  const orderEntries = sortByCols.map((col, i) => {
    const dir = sortOrderVals[i] === "asc" ? "ASC" : "DESC";
    return SORTABLE.has(col) ? [col, dir] : null;
  }).filter(Boolean);

  const { count, rows } = await BitacoraModel.findAndCountAll({
    where,
    order: orderEntries.length ? orderEntries as [[string, string]] : [["id", "DESC"]],
    limit,
    offset,
    include: [{
      model: UsuarioModel,
      attributes: [...USUARIO_AS_AUTHOR],
      // Without this, an entry written by an account that has since been
      // archived arrives with `usuario: null`. Sequelize hangs `deletedAt IS
      // NULL` on the join's ON clause rather than on the query, so the row
      // itself survives and only its author vanishes: the Bitácora screen falls
      // back to printing `#12`, and `BitacoraPanel` — the activity block on the
      // city, incident and pole sheets — prints no author at all. An audit log
      // that forgets who did something on the day that person leaves is at its
      // least useful exactly when it is most needed. Measured against today's
      // data: 13 entries from 2 archived accounts, and more with every account
      // archived from here on.
      paranoid: false,
    }],
  });
  res.status(200).json({ data: rows, total: count });
});

/**
 * Who appears in the log, for the author filter on the Bitácora screen.
 *
 * That dropdown was filled from `GET /api/usuario/` — the staff directory, which
 * asks for `seguridad:ver`. A role holding `bitacora:ver` without it gets a 403
 * there, the screen swallowed it, and the filter offered "Todos" and nothing
 * else: an empty system rather than a refusal. None of the three seeded roles is
 * in that state today (role 1 holds both), so this is hardening rather than a
 * live fault — but the matrix editor can create that role in two clicks, and
 * nothing would have said why the filter was empty.
 *
 * **Is this new access? Partly, and the first version of this comment denied it
 * flatly.** For a live account the claim held: those names already travel in the
 * rows of the log, under this same permission, through the `include` above. For
 * an archived one it did not, and the proof offered was circular — that include
 * only started carrying archived authors in this same change. And `deletedAt`,
 * the date an account was archived, travelled nowhere under `bitacora:ver`
 * before now.
 *
 * So the honest statement is narrower than "nothing new": whoever may read the
 * audit log may now also learn which of its authors have left, and when. That is
 * the point rather than a side effect — an author list that omits the people who
 * left is the wrong list for a log people consult precisely to review their work
 * — but it is a widening, and calling it none was wrong.
 *
 * The question it still does not answer is "who works here": an account that
 * never touched the system does not appear at all.
 *
 * **Archived accounts are in the list on purpose.** They are the ones somebody
 * reviewing after the fact is most likely to be looking for — a person who has
 * left, whose work is being checked. `deletedAt` travels so the screen can mark
 * them instead of showing them as current staff.
 */
export const getAutoresBitacora = handler("getAutoresBitacora", async (_req: Request, res: Response) => {
  const autores = await UsuarioModel.findAll({
    attributes: [...USUARIO_AS_AUTHOR, "deletedAt"],
    where: CON_ENTRADAS,
    // Alphabetical, and deliberately not the `id DESC` every catalogue endpoint
    // uses. That order exists so an export's columns stay put between runs; this
    // list is read by a person looking for a name in it.
    order: [["name", "ASC"], ["lastname", "ASC"]],
    paranoid: false,
    raw: true,
  });
  // Two projections of the same person live in this file — this one with
  // `deletedAt` and the one in `getAllBitacora` without — and that is a decision
  // rather than an oversight. `responseShape.test.ts` holds every author include
  // to `USUARIO_AS_AUTHOR` as a ceiling, and it exists because this very file
  // once shipped the login name by writing its own array. Widening that ceiling
  // for every author include in the application, to add a marker to a dropdown,
  // is the wrong trade. So the flag travels where somebody is *choosing* between
  // people and two of them may read alike, and not on the rows, where the name
  // states who did something — a fact that does not change when they leave.
  // A bare list, no envelope: §3.3 of the API standard keeps the envelope for
  // paginated collections, and this is a block of id/name pairs like the three
  // `/opciones` responses.
  res.status(200).json(autores);
});

export const getBitacora = handler("getBitacora", async (req: Request, res: Response) => {
  const { id_usuario } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const data = await BitacoraModel.findAll({
    where: { id_usuario },
    order: [["id", "DESC"]],
    limit,
  });
  res.status(200).json(data);
});
