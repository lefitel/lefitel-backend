export interface IRol {
  id: number;
  name: string;
  description: string;
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
  deletedAt?: Date | null;
}

export interface IRevision {
  id: number;
  description: string;
  date: Date;
  id_evento: number;
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

