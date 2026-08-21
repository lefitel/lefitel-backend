/**
 * The vocabulary of the permission matrix: what can be asked about, and what can
 * be asked of it.
 *
 * These names are the contract between three places — the `permisos` table, the
 * route gates, and the Seguridad screen where an administrator ticks the boxes.
 * Adding a module here without seeding rows for it denies it to everybody, which
 * is the safe direction: a new part of the system is closed until somebody opens
 * it on purpose.
 */

export const MODULES = [
  "postes",
  "eventos",
  "ciudades",
  "parametros",
  "reportes",
  "generador",
  "seguridad",
  "roles",
  "archivos",
  "bitacora",
] as const;

export const ACTIONS = ["ver", "crear", "editar", "archivar"] as const;

export type Module = (typeof MODULES)[number];
export type Action = (typeof ACTIONS)[number];

/** How each module reads on the Seguridad screen. */
export const MODULE_LABELS: Record<Module, string> = {
  postes: "Postes",
  eventos: "Eventos",
  ciudades: "Ciudades",
  parametros: "Parámetros",
  reportes: "Reportes",
  generador: "Generador",
  seguridad: "Seguridad",
  roles: "Roles y permisos",
  archivos: "Archivos",
  bitacora: "Bitácora",
};

export const ACTION_LABELS: Record<Action, string> = {
  ver: "Ver",
  crear: "Crear",
  editar: "Editar",
  archivar: "Archivar",
};

/** What a single role may do, as the client receives it. */
export type RolePermissions = Record<Module, Record<Action, boolean>>;

export const isModule = (value: unknown): value is Module =>
  typeof value === "string" && (MODULES as readonly string[]).includes(value);

export const isAction = (value: unknown): value is Action =>
  typeof value === "string" && (ACTIONS as readonly string[]).includes(value);

/** Every cell false. The starting point for a role nobody has configured. */
export function emptyPermissions(): RolePermissions {
  const out = {} as RolePermissions;
  for (const modulo of MODULES) {
    out[modulo] = {} as Record<Action, boolean>;
    for (const accion of ACTIONS) out[modulo][accion] = false;
  }
  return out;
}
