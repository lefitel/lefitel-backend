/**
 * Every action and entity the audit log can be written with, and what each is
 * called on screen.
 *
 * `logAction` took any string, and the Bitácora screen translated each code to
 * Spanish from a table of its own in the other repository. Nothing tied the
 * two: 58 codes added here since that table was written reached the screen raw,
 * `STEP_UP_DENIED` among them.
 *
 * The names live here now, beside the codes, and the server sends them with
 * every row. That is the only arrangement the compiler can hold: an action
 * cannot be declared without a label and a filter family, and a code that is
 * not declared cannot be written. A test in the web that read this file was
 * tried first and protected nothing where it mattered — the web is built
 * without this repository beside it, so the test skipped itself in the one
 * build that deploys.
 *
 * Adding an action is one line here. No imports, on purpose: `logAction` is
 * imported by nearly everything.
 */

/** What the "Acción" filter offers. An action belongs to exactly one. */
export const BITACORA_FAMILIES = {
  crear:           "Crear",
  editar:          "Editar",
  archivar:        "Archivar y eliminar",
  restaurar:       "Desarchivar",
  eventos:         "Resolver y reabrir",
  archivos:        "Archivos",
  exportar:        "Exportar e informes",
  rechazos:        "Intentos rechazados",
  sesion:          "Sesión",
  credenciales:    "Contraseña, usuario y correo",
  cuenta:          "Cuenta y rol",
  factor:          "Segundo factor",
  reautenticacion: "Reautenticación",
  rescate:         "Rescate",
} as const;

export type BitacoraFamily = keyof typeof BITACORA_FAMILIES;

interface Accion {
  etiqueta: string;
  familia: BitacoraFamily;
}

const a = (etiqueta: string, familia: BitacoraFamily): Accion => ({ etiqueta, familia });

export const BITACORA_ACTIONS = {
  ADD_REVISION:            a("Nueva revisión", "crear"),
  CREATE_ADSS:             a("Nueva ferretería", "crear"),
  CREATE_CIUDAD:           a("Nueva ciudad", "crear"),
  CREATE_EVENTO:           a("Nuevo evento", "crear"),
  CREATE_MATERIAL:         a("Nuevo material", "crear"),
  CREATE_OBS:              a("Nueva observación", "crear"),
  CREATE_POSTE:            a("Nuevo poste", "crear"),
  CREATE_PROPIETARIO:      a("Nuevo propietario", "crear"),
  CREATE_PROGRAMACION:     a("Nuevo envío programado", "crear"),
  CREATE_REPORTE_VISTA:    a("Nuevo informe guardado", "crear"),
  CREATE_ROL:              a("Nuevo rol", "crear"),
  CREATE_TIPO_OBS:         a("Nuevo tipo de observación", "crear"),
  CREATE_USUARIO:          a("Nuevo usuario", "crear"),
  DUPLICATE_REPORTE_VISTA: a("Duplicó informe guardado", "crear"),

  UPDATE_ADSS:          a("Editó ferretería", "editar"),
  UPDATE_ADSS_POSTE:    a("Actualizó ferretería", "editar"),
  UPDATE_CIUDAD:        a("Editó ciudad", "editar"),
  UPDATE_EVENTO:        a("Editó evento", "editar"),
  UPDATE_MATERIAL:      a("Editó material", "editar"),
  UPDATE_OBS:           a("Editó observación", "editar"),
  UPDATE_OBS_EVENTO:    a("Actualizó observaciones", "editar"),
  UPDATE_PERMISOS:      a("Cambió permisos", "editar"),
  UPDATE_POSTE:         a("Editó poste", "editar"),
  UPDATE_PROPIETARIO:   a("Editó propietario", "editar"),
  UPDATE_PROGRAMACION:  a("Editó envío programado", "editar"),
  UPDATE_REPORTE_VISTA: a("Editó informe guardado", "editar"),
  UPDATE_ROL:           a("Editó rol", "editar"),
  UPDATE_TIPO_OBS:      a("Editó tipo de observación", "editar"),
  UPDATE_USUARIO:       a("Editó usuario", "editar"),

  DELETE_ADSS:          a("Archivó ferretería", "archivar"),
  DELETE_CIUDAD:        a("Archivó ciudad", "archivar"),
  DELETE_EVENTO:        a("Archivó evento", "archivar"),
  DELETE_MATERIAL:      a("Archivó material", "archivar"),
  DELETE_OBS:           a("Archivó observación", "archivar"),
  DELETE_POSTE:         a("Archivó poste", "archivar"),
  DELETE_PROPIETARIO:   a("Archivó propietario", "archivar"),
  DELETE_PROGRAMACION:  a("Eliminó envío programado", "archivar"),
  DELETE_REPORTE_VISTA: a("Archivó informe guardado", "archivar"),
  DELETE_ROL:           a("Archivó rol", "archivar"),
  DELETE_TIPO_OBS:      a("Archivó tipo de observación", "archivar"),
  DELETE_USUARIO:       a("Archivó usuario", "archivar"),

  RESTORE_ADSS:        a("Desarchivó ferretería", "restaurar"),
  RESTORE_CIUDAD:      a("Desarchivó ciudad", "restaurar"),
  RESTORE_EVENTO:      a("Desarchivó evento", "restaurar"),
  RESTORE_MATERIAL:    a("Desarchivó material", "restaurar"),
  RESTORE_OBS:         a("Desarchivó observación", "restaurar"),
  RESTORE_POSTE:       a("Desarchivó poste", "restaurar"),
  RESTORE_PROPIETARIO: a("Desarchivó propietario", "restaurar"),
  RESTORE_ROL:         a("Desarchivó rol", "restaurar"),
  RESTORE_TIPO_OBS:    a("Desarchivó tipo de observación", "restaurar"),
  RESTORE_USUARIO:     a("Desarchivó usuario", "restaurar"),

  REABRIR_EVENTO: a("Reabrió evento", "eventos"),
  RESOLVE_EVENTO: a("Resolvió evento", "eventos"),

  CLEAR_BROKEN_REFS: a("Quitó fotos inexistentes de las fichas", "archivos"),
  DELETE_FILE:       a("Eliminó archivo", "archivos"),
  DELETE_ORPHANS:    a("Eliminó archivos huérfanos", "archivos"),
  UPLOAD_IMAGE:      a("Subió imagen", "archivos"),

  EXPORT_EVENTO:  a("Exportó eventos", "exportar"),
  EXPORT_POSTE:   a("Exportó postes", "exportar"),
  EXPORT_REPORTE: a("Exportó informe", "exportar"),
  EXPORT_USUARIO: a("Exportó usuarios", "exportar"),
  RUN_PROGRAMACION: a("Envió ahora un envío programado", "exportar"),
  RUN_REPORTE:    a("Ejecutó informe", "exportar"),

  DELETE_PROGRAMACION_DENIED: a("Borrado de envío programado rechazado", "rechazos"),
  DELETE_REPORTE_DENIED:    a("Intentó archivar un informe ajeno", "rechazos"),
  DUPLICATE_REPORTE_DENIED: a("Intentó duplicar un informe ajeno", "rechazos"),
  EDIT_PROGRAMACION_DENIED: a("Edición de envío programado rechazada", "rechazos"),
  EDIT_REPORTE_DENIED:      a("Intentó modificar un informe ajeno", "rechazos"),
  READ_PROGRAMACION_DENIED: a("Lectura de envío programado rechazada", "rechazos"),
  READ_REPORTE_DENIED:      a("Intentó abrir un informe ajeno", "rechazos"),
  RUN_PROGRAMACION_DENIED:  a("Envío inmediato rechazado", "rechazos"),
  ROLE_CHANGE_DENIED:       a("Intento de cambio de rol", "rechazos"),

  LOGIN:                       a("Inició sesión", "sesion"),
  LOGIN_FAILED:                a("Inicio de sesión fallido", "sesion"),
  LOGOUT:                      a("Cerró sesión", "sesion"),
  LOGOUT_ALL:                  a("Cerró todas las sesiones", "sesion"),
  SESSION_REVOKED:             a("Cerró una sesión", "sesion"),
  SESSION_ROTATION_FAILED:     a("Renovación de sesión fallida", "sesion"),
  SESSIONS_REVOKED_PRECAUTION: a("Sesiones revocadas por precaución", "sesion"),

  CHANGE_PASSWORD: a("Cambió contraseña", "credenciales"),
  CHANGE_USERNAME: a("Cambió usuario", "credenciales"),
  EMAIL_CHANGED:   a("Sustituyó su correo verificado", "credenciales"),
  EMAIL_SEND:      a("Pidió verificar correo", "credenciales"),
  PASSWORD_FORGOT: a("Se pidió restablecer su contraseña", "credenciales"),
  PASSWORD_RESET:  a("Restableció contraseña", "credenciales"),

  ACCOUNT_LOCKED:   a("Cuenta bloqueada por intentos fallidos", "cuenta"),
  ACCOUNT_UNLOCKED: a("Desbloqueó cuenta", "cuenta"),
  ROLE_ASSIGNED:    a("Asignó rol", "cuenta"),

  EMAIL_VERIFIED:                    a("Verificó correo (queda como segundo factor)", "factor"),
  LAST_CREDENTIAL_REMOVED:           a("Eliminó su última llave", "factor"),
  LAST_CREDENTIAL_REVOCATION_FAILED: a("Última llave eliminada: equipos recordados sin revocar", "factor"),
  LAST_FACTOR_REMOVED:               a("Eliminó su último factor", "factor"),
  LAST_FACTOR_REVOCATION_FAILED:     a("Sin factor y con sesiones abiertas (revocación fallida)", "factor"),
  MFA_CLOCK_SKEW_DETECTED:           a("Código fuera de hora (posible reloj desajustado)", "factor"),
  MFA_EMAIL_CODE_FAILED:             a("Envío de código fallido", "factor"),
  MFA_EMAIL_CODE_SENT:               a("Código enviado por correo", "factor"),
  MFA_GRACE_START_FAILED:            a("Fallo al iniciar el plazo para configurar segundo factor", "factor"),
  MFA_VERIFIED:                      a("Segundo factor verificado", "factor"),
  MFA_VERIFY_FAILED:                 a("Segundo factor fallido", "factor"),
  RECOVERY_CODES_ISSUED:             a("Códigos de recuperación emitidos", "factor"),
  RECOVERY_CODES_REGENERATED:        a("Regeneró códigos de recuperación", "factor"),
  TOTP_CONFIRMED:                    a("Activó aplicación de códigos", "factor"),
  TOTP_DELETED:                      a("Eliminó aplicación de códigos", "factor"),
  TOTP_SETUP_DISCARDED:              a("Alta de aplicación descartada", "factor"),
  WEBAUTHN_ASSERTION_FAILED:         a("Llave de acceso fallida", "factor"),
  WEBAUTHN_ASSERTION_FLOOD:          a("Demasiados intentos con llave", "factor"),
  WEBAUTHN_COUNTER_REGRESSION:       a("Posible llave clonada", "factor"),
  WEBAUTHN_DELETED:                  a("Eliminó llave de acceso", "factor"),
  WEBAUTHN_REGISTERED:               a("Registró llave de acceso", "factor"),

  // Dos de estas las escribe la puerta de reautenticación (`requireStepUp`) sin
  // que la persona las provoque: son cosas que le pasan al servidor y que ella
  // sufre.
  //
  // `STEP_UP_FACTOR_ILEGIBLE`: la cuenta tiene un segundo factor que este
  // servidor no puede descifrar, así que le pide la contraseña en su lugar. Se
  // cuenta durante una avería de claves.
  //
  // `STEP_UP_VENTANA_NO_ABIERTA`: la contraseña era correcta pero no se pudo
  // guardar que lo fuera, así que se le volverá a pedir en la siguiente
  // operación en vez de valerle diez minutos. Si aparece seguido, es que se
  // está pidiendo la contraseña de más.
  PASSWORD_CONFIRM_FAILED:    a("Contraseña incorrecta al confirmar una operación", "reautenticacion"),
  STEP_UP_DENIED:             a("Reautenticación pedida o fallida", "reautenticacion"),
  STEP_UP_FACTOR_ILEGIBLE:    a("Fallo del servidor: no pudo leer el segundo factor", "reautenticacion"),
  STEP_UP_REPROVED:           a("Confirmó identidad con segundo factor", "reautenticacion"),
  STEP_UP_VENTANA_NO_ABIERTA: a("Se le volverá a pedir la contraseña (fallo al guardar)", "reautenticacion"),

  RESCUE_ACCOUNT_UNARCHIVED: a("Rescate: desarchivar cuenta", "rescate"),
  RESCUE_ACCOUNT_UNLOCK:     a("Rescate: desbloquear cuenta", "rescate"),
  RESCUE_EMAIL_CLEARED:      a("Rescate: borrar correo", "rescate"),
  RESCUE_EMAIL_SET:          a("Rescate: asignar correo", "rescate"),
  RESCUE_MFA_RESET:          a("Rescate: restablecer segundo factor", "rescate"),
  RESCUE_SESSIONS_REVOKED:   a("Rescate: revocar sesiones", "rescate"),
} as const satisfies Record<string, Accion>;

export type BitacoraAction = keyof typeof BITACORA_ACTIONS;

/**
 * Codes nothing writes any more. The rows written with them are still in the
 * table, so they keep a name and a family; they are outside `BitacoraAction`,
 * so nothing new can be written with one.
 */
export const BITACORA_LEGACY_ACTIONS: Record<string, Accion> = {
  ADD_OBS:         a("Agregó observación", "crear"),
  CREATE_SOLUCION: a("Nueva solución", "crear"),

  UPDATE_REVISION: a("Editó revisión", "editar"),
  UPDATE_SOLUCION: a("Editó solución", "editar"),

  DELETE_REVISION: a("Eliminó revisión", "archivar"),
  DELETE_SOLUCION: a("Eliminó solución", "archivar"),

  UPLOAD_FILE: a("Subió archivo", "archivos"),
  CLEAR_FILES: a("Limpió archivos", "archivos"),
};

export const BITACORA_ENTITIES = {
  Poste:                "Poste",
  Evento:               "Evento",
  Revisión:             "Revisión",
  Ciudad:               "Ciudad",
  Material:             "Material",
  Propietario:          "Propietario",
  Adss:                 "Ferretería",
  TipoObs:              "Tipo de observación",
  Obs:                  "Observación",
  ReporteVista:         "Informe guardado",
  ReporteProgramacion:  "Envío programado",
  File:                 "Archivo",
  Usuario:              "Usuario",
  Rol:                  "Rol",
  Sesion:               "Sesión",
  FactorTotp:           "Aplicación de códigos",
  credencial_webauthn:  "Llave de acceso",
  CodigoRecuperacion:   "Códigos de recuperación",
} as const;

export type BitacoraEntity = keyof typeof BITACORA_ENTITIES;

/** Same as the legacy actions: still in old rows, no longer written. */
export const BITACORA_LEGACY_ENTITIES: Record<string, string> = {
  "Solución": "Solución",
};

const declarada = (action: string): Accion | undefined =>
  Object.hasOwn(BITACORA_ACTIONS, action)
    ? BITACORA_ACTIONS[action as BitacoraAction]
    : Object.hasOwn(BITACORA_LEGACY_ACTIONS, action) ? BITACORA_LEGACY_ACTIONS[action] : undefined;

/**
 * `STEP_UP_DENIED` is one code for five different things, told apart by
 * `metadata.motivo`. Two of them are the server asking for the password before
 * a protected operation — the ordinary first step, written on every one — and
 * a single label made each of those read as an incident.
 *
 * Keyed by the literal motive rather than by `requireStepUp`'s constants, to
 * keep this file free of imports; `bitacoraVocabulary.test.ts` holds the two
 * lists equal.
 */
export const STEP_UP_DENIED_POR_MOTIVO: Record<string, string> = {
  "sin-factor-reciente":   "Se le pidió confirmar su identidad",
  "contraseña-requerida":  "Se le pidió confirmar su identidad",
  "contraseña-incorrecta": "Contraseña incorrecta al confirmar identidad",
  "presupuesto-agotado":   "Demasiados intentos de confirmar identidad",
  "estado-incompleto":     "Operación bloqueada: falta configurar el segundo factor",
};

/**
 * What a row's action is called on screen.
 *
 * Takes the metadata because two families of code mean different things row by
 * row: the step-up refusals above, and the rescues, which are written with the
 * same code whether the rescue was carried out or failed.
 *
 * A code nobody declares comes back as itself: a row older than every table
 * here is shown as stored rather than as nothing.
 */
export function etiquetaDeAccion(action: string, metadata?: unknown): string {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  if (
    action === "STEP_UP_DENIED" &&
    typeof m.motivo === "string" &&
    Object.hasOwn(STEP_UP_DENIED_POR_MOTIVO, m.motivo)
  ) {
    return STEP_UP_DENIED_POR_MOTIVO[m.motivo];
  }
  const base = declarada(action)?.etiqueta ?? action;
  if (action.startsWith("RESCUE_") && (m.resultado === "error" || m.resultado === "conflicto")) {
    return `${base} (no se completó)`;
  }
  return base;
}

export const etiquetaDeEntidad = (entity: string): string =>
  Object.hasOwn(BITACORA_ENTITIES, entity)
    ? BITACORA_ENTITIES[entity as BitacoraEntity]
    : Object.hasOwn(BITACORA_LEGACY_ENTITIES, entity) ? BITACORA_LEGACY_ENTITIES[entity] : entity;

export const esFamilia = (v: unknown): v is BitacoraFamily =>
  typeof v === "string" && Object.hasOwn(BITACORA_FAMILIES, v);

/** Every code of a family, the ones no longer written included. */
export const accionesDeFamilia = (familia: BitacoraFamily): string[] =>
  [...Object.entries(BITACORA_ACTIONS), ...Object.entries(BITACORA_LEGACY_ACTIONS)]
    .filter(([, accion]) => accion.familia === familia)
    .map(([codigo]) => codigo);
