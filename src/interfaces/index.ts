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

/**
 * A saved report sent by email on a schedule. See
 * `models/reporteProgramacion.model.ts` for what each vocabulary means.
 */
export interface IReporteProgramacion {
  id: number;
  id_reporte: number;
  /** The owner: whose permissions the report is generated under. */
  id_usuario: number;
  frecuencia: "diaria" | "semanal" | "mensual";
  /** ISO weekday, 1 = Monday. Set exactly when `frecuencia` is `semanal`. */
  dia_semana?: number | null;
  /** 1–28. Set exactly when `frecuencia` is `mensual`. */
  dia_mes?: number | null;
  /** 0–23, in the report's time zone. */
  hora: number;
  formato: "excel" | "pdf";
  con_fotos: boolean;
  activa: boolean;
  motivo_pausa?: string | null;
  fallos_seguidos: number;
  /** `null` exactly when the schedule is not active. */
  proxima_ejecucion?: Date | null;
  created_at?: Date;
  updated_at?: Date;
  deleted_at?: Date | null;
}

/** A recipient: a user of the system or an outside address, never both. */
export interface IReporteProgramacionDestinatario {
  id: number;
  id_programacion: number;
  id_usuario?: number | null;
  email?: string | null;
  rechazos_seguidos: number;
  baja_at?: Date | null;
  baja_token?: string | null;
  created_at?: Date;
}

/** One run that was due. `(id_programacion, programada_para)` is unique. */
export interface IReporteEjecucion {
  id: number;
  id_programacion: number;
  programada_para: Date;
  manual: boolean;
  estado: "en_curso" | "enviado" | "vacio" | "demasiado_grande" | "fallido" | "omitido";
  iniciada_at: Date;
  terminada_at?: Date | null;
  filas?: number | null;
  bytes?: number | null;
  enviados: number;
  no_enviados: number;
  detalle?: string | null;
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
  /**
   * When this session last confirmed its password, and **not** a second
   * spelling of `mfa_satisfied_at`. That one means "a FACTOR was proved
   * here", and `estadoEfectivo` reads it to decide an account has nothing
   * left to set up: a password confirmation written there would let an
   * account with no factor at all read as `completa` past its fourteen-day
   * deadline. Two separate columns is what keeps those two facts apart —
   * see the migration `20260908000001` for the longer version.
   *
   * Null on every session until somebody types their password into the
   * step-up gate, which is every session in production the day this ships.
   */
  password_confirmed_at: Date | null;
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

/**
 * One WebAuthn ceremony in flight, backed by the `reto_webauthn` table.
 *
 * **`proposito` is a security control, not a label.** It goes inside the same
 * `WHERE` that spends the challenge, so a value minted to register a
 * credential cannot be redeemed completing an authentication — the same job
 * `ITokenUsoUnico.proposito` does, put there by the same finding.
 *
 * **`id_usuario` is nullable and `id_sesion` is nullable, and between them
 * they are the reason this is a table and not two columns on `sesiones`.**
 * A null owner is the passwordless ceremony, where the credential *is* the
 * identity and nobody is named until the assertion verifies. A null session
 * is the same ceremony seen from the other side: there is no session yet.
 * Both nulls are free here and ruinous on `sesiones`, whose `id_usuario` is
 * NOT NULL in two layers and whose null owner makes `authenticate` answer
 * 401 to everything.
 */
export interface IRetoWebauthn {
  id: string;
  reto_hash: string;
  /**
   * 🔴 **Three words, and `"stepup"` is deliberately not among them.** The
   * plan reserved a fourth for re-proving a factor mid-session, on the
   * assumption that step-up would grow its own passkey branch inside
   * `/api/auth/stepup`. It did not need one: `/api/auth/webauthn/login/*`
   * already serves both ceremonies — `loginVerify` promotes a session that
   * was still `parcial` and re-seals one that was already `completa` — and
   * that route is reachable from all three session states where
   * `/api/auth/stepup` is reachable from none of the restricted ones. A
   * purpose nothing ever mints is not a spare part; it is a value the `WHERE`
   * that spends a challenge can never match, waiting for somebody to write it
   * on one side only.
   *
   * `"login"` is different and stays: phase 2 of the same plan mints it for
   * the passwordless ceremony, where there is no session to scope by. If that
   * phase is dropped, this word goes with it.
   */
  proposito: "registro" | "segundo_factor" | "login";
  id_usuario: number | null;
  id_sesion: string | null;
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
  /**
   * The authenticator's signature counter — **typed as the string it really
   * is**, exactly like `IFactorTotp.ultimo_paso` below and for the same
   * reason: `pg` hands a `BIGINT` column back as a string, always.
   *
   * This one matters more than `ultimo_paso` did, because it is not an
   * implementation detail: **it is the whole clone-detection mechanism.** A
   * cloned passkey is caught by the counter of an assertion failing to
   * exceed the stored one, and every obvious way to write that with a
   * `number` declaration is a hole — `recibido === guardado` is **false for
   * every value** (`===` never coerces across types), `guardado !== 0` is
   * **true for every value**, and `guardado + 1` concatenates: `"5" + 1` is
   * `"51"`, which rejects every later assertion and bricks the passkey.
   * Only the relational operators (`>`, `<=`) coerce the way the reader
   * expects.
   *
   * 🔴 And there is a second half `ultimo_paso` never had. **Synced passkeys
   * — iCloud Keychain, Google Password Manager, which is exactly what a
   * phone will offer — report a counter of 0 on every assertion, forever.**
   * A rule written as a bare `recibido > guardado` reads `0 > 0`, refuses,
   * and the passkey works once and never again. What protects those
   * credentials against a replayed assertion is the single-use challenge in
   * `auth/retoStore.ts`, not this column.
   *
   * Compare through `esContadorDeClon` in `auth/passkeyStore.ts`, never by
   * hand, and write it back with `GREATEST` so a reported 0 cannot erase a
   * real count.
   */
  counter: string;
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
  /**
   * The last TOTP step this factor accepted — **typed as the string it really
   * is**, not as the number it looks like.
   *
   * `pg` hands a `BIGINT` column back as a string, always, and declaring this
   * `number` was a lie the compiler then helped enforce in the wrong direction.
   * The consequences were measured (finding C10) and two of the three obvious
   * ways to use it are holes: `paso === ultimo_paso` is **false for every
   * value**, so an anti-replay rule written as equality — which is exactly how
   * the spec words it — never rejects anything and the same six digits stay
   * usable for ninety seconds; and `ultimo_paso + 1` concatenates instead of
   * adding. Only `<=` coerces the way the reader expects.
   *
   * Compare through `pasoYaUsado` in `auth/totpStore.ts`, never by hand.
   */
  ultimo_paso: string | null;
  confirmed_at: Date | null;
  created_at: Date;
}

/** One outstanding recovery code, backed by the `codigo_recuperacion` table. */
export interface ICodigoRecuperacion {
  id: number;
  id_usuario: number;
  codigo_hash: string;
  /**
   * The first 8 characters of the code, **stored in clear** — and not a leak.
   * `codigo_hash` covers the whole code, prefix included, so whoever steals the
   * database still faces bcrypt for the rest of it.
   *
   * It exists because verifying a code without it means bcrypt-comparing the
   * account's ten codes one by one, and that was measured at **2646 ms with the
   * event loop stalled 88% of the time** — five attempts is 12.4 seconds of
   * stopped server, and provoking it does not require guessing any code right.
   * With the prefix indexed there is exactly one candidate, so it is one
   * compare. See `20260902000001-recovery-code-prefix.ts`.
   *
   * Not optional, because it is derived from the code at the same instant as
   * `codigo_hash`: there is no creation path that has one without the other.
   */
  prefijo: string;
  used_at: Date | null;
  created_at: Date;
}

/**
 * One login code sent by email, backed by the `codigo_correo` table.
 *
 * Six digits, bcrypt-hashed, ten minutes, one pending per account. The row is
 * the whole state of the code: `intentos` is charged **before** the compare by
 * the statement that reads `codigo_hash`, and at the cap that same statement
 * sets `used_at` — see `auth/emailCodeStore.ts`.
 */
export interface ICodigoCorreo {
  id: number;
  id_usuario: number;
  /**
   * Where the code went. Compared with `usuarios.email` when spent, so a code
   * minted for an address the account has since left is worth nothing — the
   * rule `ITokenUsoUnico.email_destino` carries for the verification link.
   */
  email_destino: string;
  /** bcrypt: six digits under a fast hash are an offline break in milliseconds. */
  codigo_hash: string;
  /** Wrong guesses so far; `EMAIL_CODE_MAX_ATTEMPTS` burns the code. */
  intentos: number;
  expires_at: Date;
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
