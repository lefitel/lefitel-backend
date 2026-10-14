// What a tramo looks like once it leaves the server, and the one way to ask
// the database for it.
//
// Before this, each controller included the two cities of a pole and each
// screen glued a name out of them. Now a controller includes `INCLUDE_TRAMO`
// and passes its answer through `presentarTramos`; nobody downstream knows
// there is a min and a max.
//
// **Archived rows travel.** A pole can be shown inside an incident long after
// its tramo or one of its cities was archived, and the client reads
// `poste.tramo.ciudades` with no guard — this application has no error
// boundary. So the include asks for them with `paranoid: false`, and the
// presenter says `archivado` instead of sending `null`.

import { CiudadModel } from "../models/ciudad.model.js";
import { DepartamentoModel } from "../models/departamento.model.js";
import { TramoModel, TRAMO_PUBLIC_ATTRIBUTES } from "../models/tramo.model.js";
import { nombreDeTramo, ordenarExtremos } from "./nombre.js";

/** What a caller needs of each end: a label and a point to draw. */
const CIUDAD_DE_TRAMO = ["id", "name", "lat", "lng"] as const;

export const INCLUDE_TRAMO = {
  model: TramoModel,
  paranoid: false,
  attributes: [...TRAMO_PUBLIC_ATTRIBUTES],
  include: [
    { model: CiudadModel, as: "ciudadMin", paranoid: false, attributes: [...CIUDAD_DE_TRAMO] },
    { model: CiudadModel, as: "ciudadMax", paranoid: false, attributes: [...CIUDAD_DE_TRAMO] },
    { model: DepartamentoModel, attributes: ["id", "name"] },
  ],
};

export interface CiudadDeTramo {
  id: number;
  name: string | null;
  lat: number | null;
  lng: number | null;
}

export interface TramoPresentado {
  id: number;
  nombre: string;
  /** The two ends, in the order `nombre` reads them. */
  ciudades: [CiudadDeTramo, CiudadDeTramo];
  id_departamento: number | null;
  departamento: { id: number; name: string } | null;
  archivado: boolean;
}

interface TramoCrudo {
  id: number;
  id_ciudad_min: number;
  id_ciudad_max: number;
  id_departamento?: number | null;
  deletedAt?: unknown;
  ciudadMin?: Partial<CiudadDeTramo> | null;
  ciudadMax?: Partial<CiudadDeTramo> | null;
  departamento?: { id: number; name: string } | null;
}

const esCrudo = (v: unknown): v is TramoCrudo =>
  typeof v === "object" && v !== null && "id_ciudad_min" in v && "id_ciudad_max" in v;

const ciudad = (id: number, c: Partial<CiudadDeTramo> | null | undefined): CiudadDeTramo => ({
  id,
  name: c?.name ?? null,
  lat: c?.lat ?? null,
  lng: c?.lng ?? null,
});

export function presentarTramo(valor: unknown): TramoPresentado {
  const crudo = (typeof (valor as { toJSON?: unknown })?.toJSON === "function"
    ? (valor as { toJSON(): unknown }).toJSON()
    : valor) as TramoCrudo;
  const ciudades = ordenarExtremos(
    ciudad(crudo.id_ciudad_min, crudo.ciudadMin),
    ciudad(crudo.id_ciudad_max, crudo.ciudadMax),
  );
  return {
    id: crudo.id,
    nombre: nombreDeTramo(ciudades[0], ciudades[1]),
    ciudades,
    id_departamento: crudo.id_departamento ?? null,
    departamento: crudo.departamento ? { id: crudo.departamento.id, name: crudo.departamento.name } : null,
    archivado: crudo.deletedAt != null,
  };
}

const recorrer = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(recorrer);
  if (typeof v !== "object" || v === null) return v;
  const salida: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(v)) {
    salida[clave] = clave === "tramo" && esCrudo(valor) ? presentarTramo(valor) : recorrer(valor);
  }
  return salida;
};

/**
 * A whole response, with every raw tramo in it presented.
 *
 * Through JSON first, which is exactly what `res.json` would have done with
 * the same value: model instances become their plain rows and dates become
 * strings. It costs a second serialisation of the list — milliseconds on the
 * 5.000-row ceiling `listar` enforces — and buys not having to know which of
 * the nested values are instances.
 */
export const presentarTramos = (valor: unknown): unknown =>
  recorrer(JSON.parse(JSON.stringify(valor)));
