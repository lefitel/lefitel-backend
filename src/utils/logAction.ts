import { BitacoraModel } from "../models/bitacora.model.js";

interface LogParams {
  id_usuario: number;
  action: string;
  entity: string;
  entity_id?: number | null;
  detail: string;
  metadata?: Record<string, unknown> | null;
  severity?: 'info' | 'warning' | 'critical';
  ip_address?: string | null;
}

/**
 * Registra una acción en la bitácora. Nunca lanza error —
 * el log no debe interrumpir la operación principal.
 */
function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

export async function logAction(params: LogParams): Promise<void> {
  try {
    await BitacoraModel.create({
      action: params.action,
      detail: params.detail,
      entity: params.entity,
      entity_id: params.entity_id ?? null,
      id_usuario: params.id_usuario,
      metadata: params.metadata ?? null,
      severity: params.severity ?? 'info',
      ip_address: normalizeIp(params.ip_address),
    });
  } catch {
    // silently ignore logging failures
  }
}
