import { Request } from "express";

/**
 * Who a row says did the work, decided by the session and never by the client.
 *
 * Every controller here creates rows as `Model.create(req.body)`, so the moment
 * `revicions` and `solucions` gained an `id_usuario` the body became a place to
 * type one: a POST carrying `"id_usuario": 2` would have been stored, and the
 * report built on top of it would name a colleague as the author of work
 * somebody else did. Authorship you can type is not authorship, and it is worse
 * than none, because a null reads as unknown while a wrong name reads as fact.
 *
 * The two helpers are the same rule from its two sides: on create the session's
 * id is written over whatever arrived, and on edit the field is dropped, because
 * who did the work is not a thing that gets corrected through the edit form.
 */

/**
 * Columns a request body may never set, whatever it says.
 *
 * `id` is the row's identity and `deletedAt` is whether it is archived — not
 * things a create is entitled to choose. `createdAt` is the one that surprised
 * me: it is the key the authorship backfill matches on (a bitácora entry within
 * two seconds of the row), so a client that can set it can aim a future re-run
 * of that backfill at whichever entry it likes. `updatedAt` travels with it.
 *
 * Sequelize honours all four when they arrive in the values of a `create`, so
 * spreading a body straight in is what makes them writable.
 */
const NOT_THEIRS = ["id", "createdAt", "updatedAt", "deletedAt"] as const;

/**
 * The body to create with, authored by whoever is making the request.
 *
 * `id_usuario` comes last on purpose: spread order is what makes a forged body
 * value impossible to honour rather than merely unlikely. Null when there is no
 * session — the authenticated routes are the only ones that reach here today,
 * and a null is the honest answer if that ever stops being true.
 */
export const authoredBy = <T extends object>(body: T, req: Request): Omit<T, typeof NOT_THEIRS[number]> & { id_usuario: number | null } => {
  const clean = { ...body } as Record<string, unknown>;
  for (const key of NOT_THEIRS) delete clean[key];
  return {
    ...clean,
    id_usuario: req.user?.id ?? null,
  } as Omit<T, typeof NOT_THEIRS[number]> & { id_usuario: number | null };
};

/**
 * The body to edit with, minus any attempt to reassign the author.
 *
 * Dropped rather than overwritten with the editor's id: correcting a typo in a
 * description is not a claim to have done the inspection, and rewriting the
 * author on every edit would quietly credit the last person to touch a row.
 */
export const withoutAuthor = <T extends object>(body: T): Omit<T, "id_usuario"> => {
  const { id_usuario: _ignored, ...rest } = body as T & { id_usuario?: unknown };
  return rest as Omit<T, "id_usuario">;
};
