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
 * The body, minus the four a client may not assign. Nothing else removed.
 *
 * For the seven catalogue controllers, which have no author column and so had no
 * reason to reach `authoredBy` or `withoutAuthor` — and therefore reached
 * nothing at all: they passed `req.body` to `create` and to `set` directly, on
 * both doors, which is what made `deletedAt` writable from a PUT that only asks
 * for `editar`.
 *
 * Separate from `withoutAuthor` rather than folded into it because these rows
 * have no `id_usuario` to drop, and a function that claims to remove one from a
 * table that never had one is a function whose name stops meaning anything.
 */
export const assignable = <T extends object>(
  body: T,
): Omit<T, typeof NOT_THEIRS[number]> => {
  const clean = { ...body } as Record<string, unknown>;
  for (const key of NOT_THEIRS) delete clean[key];
  return clean as Omit<T, typeof NOT_THEIRS[number]>;
};

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
 * The body to edit with, minus the author and minus the four above.
 *
 * The author is dropped rather than overwritten with the editor's id:
 * correcting a typo in a description is not a claim to have done the
 * inspection, and rewriting the author on every edit would quietly credit the
 * last person to touch a row.
 *
 * `NOT_THEIRS` is here too, and for a while it was not — which is the whole
 * defect. The pass that wrote this file closed `create` and left `update`
 * alone, so `deletedAt` in the body of a PUT reached `set()` verbatim. Every
 * model these controllers edit is `paranoid: true`, which makes that column the
 * archive: a role holding `editar` could archive rows with no `archivar`
 * anywhere in its matrix, and `requirePermission(module, "archivar")` on the
 * DELETE beside it guarded a door the PUT walked past. The Coordinador role is
 * defined with `archivar: false` in all ten modules, so that was not a
 * hypothetical shape of role — it is the one in the seed.
 *
 * Sequelize is what makes it reachable: `set()` marks any own column present in
 * the object as changed, and `save()` writes what is marked. So the filter has
 * to be here, before the values are handed over, and not a check further in.
 */
export const withoutAuthor = <T extends object>(
  body: T,
): Omit<T, typeof NOT_THEIRS[number] | "id_usuario"> => {
  const clean = { ...body } as Record<string, unknown>;
  for (const key of NOT_THEIRS) delete clean[key];
  delete clean["id_usuario"];
  return clean as Omit<T, typeof NOT_THEIRS[number] | "id_usuario">;
};
