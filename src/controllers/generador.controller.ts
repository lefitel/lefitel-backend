import { Request, Response } from "express";
import { Op } from "sequelize";
import { ReporteVistaModel } from "../models/reporteVista.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { buildCatalogView } from "../reportBuilder/catalogView.js";
import { runReport } from "../reportBuilder/execute.js";
import {
  buildExport, ExportTooLargeError, type ExportFormat,
} from "../reportBuilder/export/index.js";
import { exportSlot, ExportBusyError } from "../reportBuilder/export/queue.js";
import { buildQuery } from "../reportBuilder/sqlBuilder.js";
import { ReportConfigError, type ReportConfig } from "../reportBuilder/types.js";
import { logAction } from "../utils/logAction.js";
import { IReporteVista } from "../interfaces/index.js";
import { log } from "../utils/logger.js";

const ADMIN_ROLE = 1;

/** Roles allowed to see other users' personal data, mirroring the catalog. */
const STAFF_ROLES = [1, 2];

/** Postgres raises this when SET LOCAL statement_timeout fires. */
const QUERY_CANCELED = "57014";

const generadorLog = log("generador");

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
  // Both carry a sentence written for the user, saying what to do about it.
  if (error instanceof ExportTooLargeError) {
    return res.status(413).json({ message: error.message });
  }
  if (error instanceof ExportBusyError) {
    return res.status(429).json({ message: error.message });
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
  generadorLog.error({ err: error }, "fallo al atender una petición del generador");
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

/**
 * What a single answer may weigh.
 *
 * `/exportar` refuses more than 200.000 cells and `/consulta` — the endpoint
 * the screen actually uses — refused nothing: 50.000 rows × 60 columns is three
 * million cells, fifteen times the export cap, serialised by `res.json` into
 * one string that is held in memory twice while it is written. The limiter caps
 * how *often* it can be asked, not how big each answer is, and there is no
 * queue on this path at all.
 *
 * Well above any page a person reads — the screen asks for a hundred rows — and
 * below what puts the process in trouble.
 */
export const MAX_CONSULTA_CELLS = 300_000;

/** What the builder falls back to when the caller names no page size. */
const DEFAULT_CONSULTA_ROWS = 500;

const es = (n: number) => n.toLocaleString("es-BO");

export async function postConsulta(req: Request, res: Response) {
  try {
    const config = req.body as ReportConfig;

    // Refused before the rows are read, not after: materialising three million
    // cells only to decide they were too many is precisely the memory the cap
    // exists to protect. The number of columns is known from the configuration
    // and `buildQuery` — which `runReport` calls next — is what guarantees the
    // list is a valid one.
    const width = Array.isArray(config?.columns) ? config.columns.length : 0;
    const asked = Number(config?.limit);
    const rows = Number.isFinite(asked) ? Math.max(1, Math.trunc(asked)) : DEFAULT_CONSULTA_ROWS;
    if (width > 0 && rows * width > MAX_CONSULTA_CELLS) {
      return res.status(413).json({
        message:
          `La consulta pide demasiados datos de una vez (${es(rows * width)} celdas, ` +
          `máximo ${es(MAX_CONSULTA_CELLS)}). Pida menos filas por página o quite columnas.`,
      });
    }

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

// ─── Export ──────────────────────────────────────────────────────────────────

const FORMATS: ExportFormat[] = ["excel", "pdf"];
/** Same cap the saved report name uses. */
const MAX_TITLE = 120;

/**
 * Builds the file on the server and streams it back.
 *
 * The body carries the configuration, not the rows. Doing it here removes the
 * round trip that downloaded the whole result set as JSON, removes the one HTTP
 * request per photograph the browser used to make, and keeps the photographs
 * off the unauthenticated static root for the length of an export.
 */
export async function postExportar(req: Request, res: Response) {
  try {
    const body = req.body as {
      config?: ReportConfig; format?: string; title?: string;
      subtitle?: string | null; photos?: boolean;
    };

    const format = FORMATS.find((f) => f === body.format);
    if (!format) {
      throw new ReportConfigError("Formato de exportación no válido. Use 'excel' o 'pdf'.");
    }
    const title = typeof body.title === "string" ? body.title.slice(0, MAX_TITLE) : "Reporte";
    const subtitle = typeof body.subtitle === "string" ? body.subtitle.slice(0, 500) : null;

    const output = await exportSlot.run(() => buildExport({
      config: body.config as ReportConfig,
      role: roleOf(req),
      format,
      title,
      subtitle,
      photos: body.photos === true,
    }));

    logAction({
      id_usuario: req.user?.id,
      action: "EXPORT_REPORTE",
      entity: "ReporteVista",
      entity_id: null,
      detail: `Exportó un reporte sobre ${String(body.config?.root ?? "?")} a ${format} (${output.rows} filas)`,
      metadata: {
        root: body.config?.root,
        formato: format,
        filas: output.rows,
        bytes: output.buffer.length,
        fotos: output.photos,
      },
      severity: "info",
    });

    res.setHeader("Content-Type", output.contentType);
    res.setHeader("Content-Length", output.buffer.length);
    // Both forms: the plain one for anything that ignores RFC 5987, the encoded
    // one so accents survive. Exposed through CORS in app.ts, or the browser
    // cannot read it and every download is called "download".
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${output.filename.replace(/[^\x20-\x7e]/g, "_")}"; ` +
      `filename*=UTF-8''${encodeURIComponent(output.filename)}`,
    );
    res.status(200).send(output.buffer);
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
    // Only when the configuration is the thing being written.
    //
    // It used to be rebuilt on every update, including a body that says nothing
    // but `{favorite: true}` — which is exactly what the star sends. So a
    // configuration that no longer builds under today's rules made its own
    // report uneditable forever: a label written before the 120-character cap
    // existed, or a field its author lost access to when their role changed.
    // The star answered 400 with a message about a column, and renaming,
    // sharing and unfavouriting were shut too. The row could be deleted and
    // nothing else.
    if (Object.hasOwn((req.body ?? {}) as Record<string, unknown>, "config")) {
      buildQuery(payload.config as unknown as ReportConfig, roleOf(req));
    }

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
