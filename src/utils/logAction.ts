import { BitacoraModel } from "../models/bitacora.model.js";

interface LogParams {
  id_usuario: number;
  action: string;
  entity: string;
  entity_id?: number | null;
  detail: string;
}

/**
 * Registra una acción en la bitácora. Nunca lanza error —
 * el log no debe interrumpir la operación principal.
 */
export async function logAction(params: LogParams): Promise<void> {
  try {
    await BitacoraModel.create({
      action: params.action,
      detail: params.detail,
      entity: params.entity,
      entity_id: params.entity_id ?? null,
      id_usuario: params.id_usuario,
    });
  } catch {
    // silently ignore logging failures
  }
}
