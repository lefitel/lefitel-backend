import { Request, Response } from "express";
import { Op } from "sequelize";
import { ReporteVistaModel } from "../models/reporteVista.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { buildCatalogView } from "../reportBuilder/catalogView.js";
import { runReport } from "../reportBuilder/execute.js";
import { buildQuery } from "../reportBuilder/sqlBuilder.js";
import { ReportConfigError, type ReportConfig } from "../reportBuilder/types.js";
import { logAction } from "../utils/logAction.js";
import { IReporteVista } from "../interfaces/index.js";

const ADMIN_ROLE = 1;

/** Postgres raises this when SET LOCAL statement_timeout fires. */
const QUERY_CANCELED = "57014";

const roleOf = (req: Request): number => req.user?.id_rol ?? -1;

/**
 * Express types `req.params.id` as string | string[]; a crafted request can send
 * an array. Parse it to a positive integer or reject.
 */
function parseId(req: Request): number {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ReportConfigError("Identificador de reporte no válido.");
  }
  return id;
}

function handleError(error: unknown, res: Response) {
  if (error instanceof ReportConfigError) {
    return res.status(400).json({ message: error.message });
  }
  const code = (error as { parent?: { code?: string } })?.parent?.code;
  if (code === QUERY_CANCELED) {
    return res.status(400).json({
      message:
        "La consulta tardó demasiado. Acote el rango de fechas o reduzca las columnas del reporte.",
    });
  }
  const message = error instanceof Error ? error.message : "Error desconocido";
  return res.status(500).json({ message });
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export async function getCatalogo(req: Request, res: Response) {
  try {
    res.status(200).json(buildCatalogView(roleOf(req)));
  } catch (error) {
    handleError(error, res);
  }
}

// ─── Query execution ─────────────────────────────────────────────────────────

export async function postConsulta(req: Request, res: Response) {
  try {
    const result = await runReport(req.body as ReportConfig, roleOf(req));
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── Saved reports ───────────────────────────────────────────────────────────

/** Own reports plus everything shared by others. */
export async function getReportes(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    const data = await ReporteVistaModel.findAll({
      where: {
        [Op.or]: [{ id_usuario: userId }, { visibility: "shared" }],
      },
      include: [{ model: UsuarioModel, attributes: ["id", "name", "lastname"] }],
      order: [
        ["favorite", "DESC"],
        ["updatedAt", "DESC"],
      ],
    });
    res.status(200).json(data);
  } catch (error) {
    handleError(error, res);
  }
}

export async function getReporte(req: Request, res: Response) {
  try {
    const found = await ReporteVistaModel.findByPk(parseId(req));
    if (!found) return res.status(404).json({ message: "El reporte no existe." });

    const row = found.toJSON() as IReporteVista;
    if (row.visibility !== "shared" && row.id_usuario !== req.user?.id) {
      return res.status(403).json({ message: "Este reporte es privado." });
    }
    res.status(200).json(row);
  } catch (error) {
    handleError(error, res);
  }
}

function readPayload(req: Request) {
  const { name, description, config, visibility, favorite } = req.body ?? {};

  if (typeof name !== "string" || name.trim() === "") {
    throw new ReportConfigError("El reporte necesita un nombre.");
  }
  if (name.trim().length > 120) {
    throw new ReportConfigError("El nombre del reporte es demasiado largo (máximo 120 caracteres).");
  }
  if (!config || typeof config !== "object") {
    throw new ReportConfigError("El reporte no tiene configuración.");
  }
  if (visibility !== undefined && visibility !== "private" && visibility !== "shared") {
    throw new ReportConfigError("La visibilidad del reporte no es válida.");
  }

  return {
    name: name.trim(),
    description: typeof description === "string" ? description.trim() : null,
    config: config as Record<string, unknown>,
    visibility: (visibility ?? "private") as "private" | "shared",
    favorite: favorite === true,
  };
}

export async function postReporte(req: Request, res: Response) {
  try {
    const payload = readPayload(req);
    // Validating by building the query catches a broken configuration at save
    // time instead of the first time somebody opens the report.
    buildQuery(payload.config as unknown as ReportConfig, roleOf(req));

    const created = await ReporteVistaModel.create({
      ...payload,
      id_usuario: req.user!.id,
    });

    logAction({
      id_usuario: req.user?.id,
      action: "CREATE_REPORTE_VISTA",
      entity: "ReporteVista",
      entity_id: created.dataValues.id as number,
      detail: `Creó el reporte "${payload.name}"`,
      severity: "info",
    });

    res.status(201).json(created);
  } catch (error) {
    handleError(error, res);
  }
}

export async function putReporte(req: Request, res: Response) {
  try {
    const found = await ReporteVistaModel.findByPk(parseId(req));
    if (!found) return res.status(404).json({ message: "El reporte no existe." });

    const row = found.toJSON() as IReporteVista;
    if (row.id_usuario !== req.user?.id && roleOf(req) !== ADMIN_ROLE) {
      return res.status(403).json({ message: "Solo el autor puede editar este reporte." });
    }

    const payload = readPayload(req);
    buildQuery(payload.config as unknown as ReportConfig, roleOf(req));

    await found.update(payload);

    logAction({
      id_usuario: req.user?.id,
      action: "UPDATE_REPORTE_VISTA",
      entity: "ReporteVista",
      entity_id: parseId(req),
      detail: `Editó el reporte "${payload.name}"`,
      severity: "warning",
    });

    res.status(200).json(found);
  } catch (error) {
    handleError(error, res);
  }
}

export async function deleteReporte(req: Request, res: Response) {
  try {
    const found = await ReporteVistaModel.findByPk(parseId(req));
    if (!found) return res.status(404).json({ message: "El reporte no existe." });

    const row = found.toJSON() as IReporteVista;
    if (row.id_usuario !== req.user?.id && roleOf(req) !== ADMIN_ROLE) {
      return res.status(403).json({ message: "Solo el autor puede eliminar este reporte." });
    }

    await found.destroy();

    logAction({
      id_usuario: req.user?.id,
      action: "DELETE_REPORTE_VISTA",
      entity: "ReporteVista",
      entity_id: parseId(req),
      detail: `Archivó el reporte "${row.name}"`,
      severity: "critical",
    });

    res.status(200).json({ message: "Reporte archivado." });
  } catch (error) {
    handleError(error, res);
  }
}

/** Copies a report into the caller's account, always as private. */
export async function postDuplicar(req: Request, res: Response) {
  try {
    const found = await ReporteVistaModel.findByPk(parseId(req));
    if (!found) return res.status(404).json({ message: "El reporte no existe." });

    const row = found.toJSON() as IReporteVista;
    if (row.visibility !== "shared" && row.id_usuario !== req.user?.id) {
      return res.status(403).json({ message: "Este reporte es privado." });
    }

    const created = await ReporteVistaModel.create({
      name: `${row.name} (copia)`.slice(0, 120),
      description: row.description ?? null,
      config: row.config,
      id_usuario: req.user!.id,
      visibility: "private",
      favorite: false,
    });

    logAction({
      id_usuario: req.user?.id,
      action: "DUPLICATE_REPORTE_VISTA",
      entity: "ReporteVista",
      entity_id: created.dataValues.id as number,
      detail: `Duplicó el reporte "${row.name}"`,
      severity: "info",
    });

    res.status(201).json(created);
  } catch (error) {
    handleError(error, res);
  }
}
