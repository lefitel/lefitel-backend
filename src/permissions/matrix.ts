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

/**
 * Every action name the system knows, across all modules.
 *
 * Declared before `PERMISSIONS` rather than after it, and that order is the
 * whole point: it is what lets the `satisfies` below refuse a module that
 * declares an action nobody can translate or tick. An audit proved the earlier
 * `readonly string[]` let `postes: [..., "exportar"]` compile with no error at
 * all — and the result would have been a permission the reader honours and
 * grants, the endpoint refuses to change because `isAction` rejects it, and the
 * screen never draws because `ACTION_LABELS` has no label for it. Granted,
 * invisible, and unrevocable from the interface. Adding an action means adding
 * it here first.
 *
 * Its meaning has changed with this file: it is no longer "what every module
 * has", it is the vocabulary.
 */
export const ACTIONS = ["ver", "crear", "editar", "archivar"] as const;

/**
 * What each module can be asked, module by module.
 *
 * This used to be two flat lists — ten modules and four actions — and every
 * module carried all four whether it used them or not. Eight of those forty
 * cells were never asked by anything: `bitacora` and `reportes` only ever
 * answer `ver`, and `archivos` only `ver` and `archivar`. They were not merely
 * unused, they were *granted*: all eight sat at `true` for the Administrador
 * role, so the Seguridad screen was promising an authority that no code ever
 * consulted.
 *
 * The half that actually blocked work is the vocabulary. A permission that is
 * not one of the four verbs had nowhere to live — "may export", "sees every
 * client" — so it either got forced into a verb meaning something else, which
 * makes the screen lie about what it grants, or it went unchecked. The export
 * buttons on postes and eventos are the second case: they check nothing.
 *
 * Adding one now is a line here, plus its label below, plus a seeded row.
 */
export const PERMISSIONS = {
  postes: ["ver", "crear", "editar", "archivar"],
  eventos: ["ver", "crear", "editar", "archivar"],
  ciudades: ["ver", "crear", "editar", "archivar"],
  parametros: ["ver", "crear", "editar", "archivar"],
  // `reportes` sits fifth because that is where the screen has always drawn it.
  // `MODULES` is `Object.keys` of this object now, so this order *is* the order
  // of the rows — moving an entry here moves a row for everybody.
  reportes: ["ver"],
  generador: ["ver", "crear", "editar", "archivar"],
  seguridad: ["ver", "crear", "editar", "archivar"],
  roles: ["ver", "crear", "editar", "archivar"],

  // `crear` is absent rather than forgotten: uploading is `POST /api/upload`,
  // which is a declared exception in `routeGuards.test.ts` and passes through
  // no gate at all. Giving `archivos` a `crear` is how that route gets closed,
  // and it changes who may upload field photographs — its own decision.
  archivos: ["ver", "archivar"],
  // A log that could be edited would not be a log.
  bitacora: ["ver"],
} as const satisfies Record<string, readonly (typeof ACTIONS)[number][]>;

export const MODULES = Object.keys(PERMISSIONS) as readonly Module[];

export type Module = keyof typeof PERMISSIONS;
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

/**
 * What a single role may do, as the client receives it.
 *
 * `Partial` on the inner record because a module only carries its own actions
 * now, and the type has to say so: claiming `bitacora.archivar` is a boolean
 * when it is `undefined` is the kind of lie that reads fine and then hands a
 * caller nothing. Both readers already cope — `can()` here compares `=== true`,
 * and the web mirror ends in `?? false` — which is exactly why neither the
 * table nor the reader needed changing.
 */
export type RolePermissions = Record<Module, Partial<Record<Action, boolean>>>;

export const isModule = (value: unknown): value is Module =>
  typeof value === "string" && (MODULES as readonly string[]).includes(value);

export const isAction = (value: unknown): value is Action =>
  typeof value === "string" && (ACTIONS as readonly string[]).includes(value);

/**
 * Does this module have this action?
 *
 * The one that matters, and the reason `isAction` alone is no longer enough to
 * decide anything. Asked of `bitacora.archivar`, `isModule` says yes and
 * `isAction` says yes — two true halves making a pair that does not exist.
 * Checked one half at a time, such a row is accepted, stored, read by nobody,
 * and starts meaning yes the day `bitacora` gains `archivar` for real. Nobody
 * would remember granting it.
 */
export const isActionOf = (modulo: unknown, accion: unknown): accion is Action =>
  isModule(modulo) &&
  typeof accion === "string" &&
  (PERMISSIONS[modulo] as readonly string[]).includes(accion);

/** The actions this module has, in the order the screen should draw them. */
export const actionsOf = (modulo: Module): readonly Action[] =>
  PERMISSIONS[modulo] as readonly Action[];

/** Every cell false. The starting point for a role nobody has configured. */
export function emptyPermissions(): RolePermissions {
  const out = {} as RolePermissions;
  for (const modulo of MODULES) {
    out[modulo] = {} as Partial<Record<Action, boolean>>;
    for (const accion of actionsOf(modulo)) out[modulo][accion] = false;
  }
  return out;
}
