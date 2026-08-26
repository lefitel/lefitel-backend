export interface IRol {
  id: number;
  name: string;
  description: string;
  /** Set since 20260826000001: archiving a role must not cascade to its users. */
  deletedAt?: Date | null;
}

export interface IUsuario {
  id: number;
  name: string;
  lastname: string;
  birthday: Date;
  image: string;
  phone: string;
  user: string;
  pass: string;
  id_rol: number;
  deletedAt?: Date | null;
  failed_attempts?: number;
  locked_until?: Date | null;
  email?: string | null;
  email_verified_at?: Date | null;
  mfa_grace_until?: Date | null;
  pass_changed_at?: Date;
}

export interface ICiudad {
  id: number;
  name: string;
  image: string;
  lat: number;
  lng: number;
  deletedAt?: Date | null;
}

export interface IMaterial {
  id: number;
  name: string;
  description: string;
  deletedAt?: Date | null;
}

export interface IPropietario {
  id: number;
  name: string;
  deletedAt?: Date | null;
}

export interface IPoste {
  id: number;
  name: string;
  image: string;
  date: Date;
  lat: number;
  lng: number;
  id_propietario: number;
  id_material: number;
  id_ciudadA: number;
  id_ciudadB: number;
  id_usuario?: number;
  deletedAt?: Date | null;
}

export interface IEvento {
  id: number;
  description: string;
  image: string;
  date: Date;
  state: boolean;
  priority: boolean;
  id_poste: number;
  id_usuario?: number;
  deletedAt?: Date | null;
}

export interface ITipoObs {
  id: number;
  name: string;
  description: string;
  deletedAt?: Date | null;
}

export interface IObs {
  id: number;
  name: string;
  description: string;
  id_tipoObs: number;
  /** Criticality level 1-9 (1 = catastrophic, 9 = maintenance). Null = unclassified. */
  criticality?: number | null;
  deletedAt?: Date | null;
}

export interface IEventoObs {
  id: number;
  id_evento: number;
  id_obs: number;
  deletedAt?: Date | null;
}

export interface ISolucion {
  id: number;
  description: string;
  image: string;
  date: Date;
  id_evento: number;
  /**
   * Who carried the repair out, when that is known.
   *
   * Nullable and staying that way: 558 of 1.071 repairs predate the bitácora
   * the authorship migration recovered them from, and no default could name
   * their author without inventing one.
   */
  id_usuario?: number | null;
  deletedAt?: Date | null;
}

export interface IRevision {
  id: number;
  description: string;
  date: Date;
  id_evento: number;
  /** Who carried the inspection out, when that is known. See ISolucion. */
  id_usuario?: number | null;
  deletedAt?: Date | null;
}

export interface IBitacora {
  id: number;
  action: string;
  detail: string;
  entity: string;
  entity_id: number | null;
  id_usuario: number;
  metadata?: Record<string, unknown> | null;
  severity?: 'info' | 'warning' | 'critical';
  ip_address?: string | null;
}

export interface IAdss {
  id: number;
  name: string;
  description: string;
  deletedAt?: Date | null;
}

export interface IAdssPoste {
  id: number;
  id_adss: number;
  id_poste: number;
  deletedAt?: Date | null;
}

/** A saved configuration of the dynamic report builder. */
export interface IReporteVista {
  id: number;
  name: string;
  description?: string | null;
  /** ReportConfig from reportBuilder/types, stored as JSONB. */
  config: Record<string, unknown>;
  id_usuario: number;
  visibility: "private" | "shared";
  favorite: boolean;
  deletedAt?: Date | null;
}


/** One cell of the permission matrix: what a role may do in a module. */
export interface IPermiso {
  id: number;
  id_rol: number;
  modulo: string;
  accion: string;
  permitido: boolean;
}

/**
 * The three states a session can be in on the road to a fully authenticated
 * request. Declared here rather than in `auth/sessionState.ts` (a later task
 * creates that file) so `interfaces/` does not depend on `auth/` — the later
 * task re-exports this type from there instead of redeclaring it.
 */
export type EstadoSesion = "parcial" | "onboarding" | "completa";

/** One logged-in device, backed by the `sesiones` table. */
export interface ISesion {
  id: string;
  id_usuario: number;
  token_hash: string;
  // Required rather than `?:`: a row read back from the database always has
  // these three fields, just sometimes with a null value. `?:` would let a
  // consumer skip checking them instead of handling the null.
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  // Same reasoning as the three above: always present on a row read back
  // from the database, sometimes null. `estado` defaults to "completa" for
  // rows created before this column existed; `mfa_satisfied_at` is null on
  // every session opened via a remembered device, on purpose, and
  // `mfa_source` is null whenever no live proof of a factor happened yet.
  estado: EstadoSesion;
  mfa_satisfied_at: Date | null;
  mfa_source: string | null;
}

/**
 * One outstanding email-verification or password-reset link, backed by the
 * `token_uso_unico` table.
 *
 * `email_destino` is the address the link was sent to, not a reference to
 * `usuarios.email` — it stays what it was at the moment the token was
 * issued even if the account's address changes afterwards, which is exactly
 * the comparison `/email/verify` needs to refuse a token minted for an
 * address the account has since left.
 */
export interface ITokenUsoUnico {
  id: string;
  id_usuario: number;
  email_destino: string;
  token_hash: string;
  proposito: "verify_email" | "reset_password";
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

/** One registered passkey/security key, backed by the `credencial_webauthn` table. */
export interface ICredencialWebauthn {
  id: number;
  id_usuario: number;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  nombre: string;
  created_at: Date;
  last_used_at: Date | null;
}

/** One account's TOTP factor, backed by the `factor_totp` table. */
export interface IFactorTotp {
  id: number;
  id_usuario: number;
  secreto_cifrado: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  ultimo_paso: number | null;
  confirmed_at: Date | null;
  created_at: Date;
}

/** One outstanding recovery code, backed by the `codigo_recuperacion` table. */
export interface ICodigoRecuperacion {
  id: number;
  id_usuario: number;
  codigo_hash: string;
  used_at: Date | null;
  created_at: Date;
}

/** One browser that has already proved a factor, backed by the `dispositivo_recordado` table. */
export interface IDispositivoRecordado {
  id: string;
  id_usuario: number;
  token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}
