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

/** Roles allowed to see other users' personal data, mirroring the catalog. */
const STAFF_ROLES = [1, 2];

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
  // Never echo the database error back. It leaks physical table and column
  // names, types, and the server locale — an oracle for anyone probing the
  // schema, and unreadable for the user anyway.
  console.error("[generador]", error);
  return res.status(500).json({
    message: "No se pudo generar el reporte. Intente de nuevo o revise su configuración.",
  });
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
    const config = req.body as ReportConfig;
    const result = await runReport(config, roleOf(req));

    // Running a report is the operation that actually extracts data, and it was
    // the only one with no audit trail: someone paging through the whole
    // dataset was invisible while renaming a saved report was logged.
    logAction({
      id_usuario: req.user?.id,
      action: "RUN_REPORTE",
      entity: "ReporteVista",
      entity_id: null,
      detail: `Ejecutó un reporte sobre ${String(config?.root ?? "?")} (${result.rows.length} filas)`,
      metadata: {
        root: config?.root,
        columnas: Array.isArray(config?.columns) ? config.columns.length : 0,
        agrupado: (config?.groupBy?.length ?? 0) > 0,
        limit: result.limit,
        offset: result.offset,
        filas: result.rows.length,
      },
      severity: "info",
    });

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
    // The catalog hides other users' names from role 3, so the listing must not
    // hand them over through the author of every shared report.
    const canSeeAuthors = STAFF_ROLES.includes(roleOf(req));

    const data = await ReporteVistaModel.findAll({
      where: {
        [Op.or]: [{ id_usuario: userId }, { visibility: "shared" }],
      },
      include: canSeeAuthors
        ? [{ model: UsuarioModel, attributes: ["id", "name", "lastname"] }]
        : [{ model: UsuarioModel, attributes: ["id"] }],
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

/**
 * Reads a report payload. When `existing` is given, absent fields keep their
 * current value, so a client can flip `favorite` without resending the whole
 * report.
 */
function readPayload(req: Request, existing?: IReporteVista) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const has = (key: string) => Object.hasOwn(body, key);

  const name = has("name") ? body.name : existing?.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new ReportConfigError("El reporte necesita un nombre.");
  }
  if (name.trim().length > 120) {
    throw new ReportConfigError("El nombre del reporte es demasiado largo (máximo 120 caracteres).");
  }

  const config = has("config") ? body.config : existing?.config;
  if (!config || typeof config !== "object") {
    throw new ReportConfigError("El reporte no tiene configuración.");
  }

  const rawVisibility = has("visibility") ? body.visibility : existing?.visibility ?? "private";
  if (rawVisibility !== "private" && rawVisibility !== "shared") {
    throw new ReportConfigError("La visibilidad del reporte no es válida.");
  }
  const visibility: "private" | "shared" = rawVisibility;

  const rawDescription = has("description") ? body.description : existing?.description ?? null;
  if (rawDescription !== null && rawDescription !== undefined && typeof rawDescription !== "string") {
    throw new ReportConfigError("La descripción del reporte no es válida.");
  }
  const description: string | null =
    typeof rawDescription === "string" ? rawDescription.trim() : null;
  // The column is STRING(500) and Sequelize does not length-check it, so an
  // over-long description would surface as an opaque database error.
  if (description !== null && description.length > 500) {
    throw new ReportConfigError(
      "La descripción del reporte es demasiado larga (máximo 500 caracteres).",
    );
  }

  const favorite = has("favorite") ? body.favorite === true : existing?.favorite ?? false;

  return {
    name: name.trim(),
    description,
    config: config as Record<string, unknown>,
    visibility,
    favorite,
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
    // Editing content is the author's alone. Administration can archive a
    // report (moderation) but not rewrite it: the previous bypass let an admin
    // open a colleague's shared report, change it and save, replacing their
    // work with no notice to anyone.
    if (row.id_usuario !== req.user?.id) {
      return res.status(403).json({ message: "Solo el autor puede editar este reporte." });
    }

    const payload = readPayload(req, row);
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

    // Revalidate with the duplicating user's role. Without this, a copy that
    // references fields their role cannot use becomes theirs, and every attempt
    // to run it fails afterwards.
    buildQuery(row.config as unknown as ReportConfig, roleOf(req));

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
