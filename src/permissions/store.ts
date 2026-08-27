import { PermisoModel } from "../models/permiso.model.js";
import {
  actionsOf,
  MODULES,
  emptyPermissions,
  isActionOf,
  isModule,
  type Action,
  type Module,
  type RolePermissions,
} from "./matrix.js";

/**
 * The permission matrix, kept in memory.
 *
 * It is asked on every request that writes anything, and it is 96 rows that
 * change perhaps twice a year — going to Postgres each time would be paying a
 * round trip for an answer that never moves. So it is read once and cached.
 *
 * Two things keep the cache from going stale. `invalidate()` is called by the
 * handler that saves a change, which covers the ordinary case immediately. The
 * TTL covers the case the first one cannot: a second server process, which has
 * its own memory and never sees the write.
 */
const TTL_MS = 60_000;

let cache: Map<number, RolePermissions> | null = null;
let loadedAt = 0;
/** Concurrent requests during a reload share one query rather than racing. */
let inFlight: Promise<Map<number, RolePermissions>> | null = null;

function buildMatrix(rows: { id_rol: number; modulo: string; accion: string; permitido: boolean }[]) {
  const matrix = new Map<number, RolePermissions>();
  for (const row of rows) {
    // A row naming a module or action the code no longer knows about is history,
    // not permission. Ignoring it beats letting it grant something unnamed.
    //
    // The pair, not each half. `isModule("bitacora")` and `isAction("archivar")`
    // both answer yes to a combination that does not exist, and a row like that
    // grants nothing today only because nothing reads it — until `bitacora`
    // gains `archivar` for real, at which point it grants it, and nobody
    // remembers writing it.
    if (!isModule(row.modulo) || !isActionOf(row.modulo, row.accion)) continue;
    let role = matrix.get(row.id_rol);
    if (!role) {
      role = emptyPermissions();
      matrix.set(row.id_rol, role);
    }
    role[row.modulo][row.accion] = row.permitido === true;
  }
  return matrix;
}

async function load(): Promise<Map<number, RolePermissions>> {
  const rows = await PermisoModel.findAll({
    attributes: ["id_rol", "modulo", "accion", "permitido"],
    raw: true,
  });
  const matrix = buildMatrix(rows as unknown as Parameters<typeof buildMatrix>[0]);
  cache = matrix;
  loadedAt = Date.now();
  return matrix;
}

async function matrix(): Promise<Map<number, RolePermissions>> {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  inFlight ??= load().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Forget the cached matrix, so the next question reads the table again. */
export function invalidatePermissions(): void {
  cache = null;
  loadedAt = 0;
}

/**
 * May this role do this, in this module?
 *
 * Everything unknown is a no: a role with no rows, a module nobody granted, a
 * table that has not been migrated yet. A permission system that guesses "yes"
 * when it is unsure is not a permission system.
 */
export async function can(
  id_rol: number | undefined,
  modulo: Module,
  accion: Action,
): Promise<boolean> {
  if (id_rol === undefined || id_rol === null) return false;
  const found = await matrix();
  return found.get(id_rol)?.[modulo]?.[accion] === true;
}

/** Everything one role may do, shaped for the client. */
export async function permissionsFor(id_rol: number | undefined): Promise<RolePermissions> {
  if (id_rol === undefined || id_rol === null) return emptyPermissions();
  const found = await matrix();
  return found.get(id_rol) ?? emptyPermissions();
}

/** Every role's permissions, for the Seguridad screen. */
export async function allPermissions(): Promise<Record<number, RolePermissions>> {
  const found = await matrix();
  const out: Record<number, RolePermissions> = {};
  for (const [id_rol, permissions] of found) out[id_rol] = permissions;
  return out;
}

/**
 * Give a brand-new role a row for every cell it can have, all denied.
 *
 * Without this a role created from the Seguridad screen has no rows at all, and
 * the screen has no checkboxes to show — the administrator would see an empty
 * form and no way to grant anything.
 *
 * Each module's own actions, not the product of the two lists. The product
 * writes the eight cells no module has, so the first role created from the
 * screen would put back exactly what the cleanup migration deleted — and put it
 * back for a role somebody is about to configure.
 */
export async function seedRolePermissions(id_rol: number): Promise<void> {
  const rows = MODULES.flatMap((modulo) =>
    actionsOf(modulo).map((accion) => ({ id_rol, modulo, accion, permitido: false })),
  );
  await PermisoModel.bulkCreate(rows, { ignoreDuplicates: true });
  invalidatePermissions();
}
