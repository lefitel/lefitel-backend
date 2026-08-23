import { Request, Response } from "express";
import { Op } from "sequelize";
import { ReporteVistaModel } from "../models/reporteVista.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { buildCatalogView } from "../reportBuilder/catalogView.js";
import { MAX_ROWS } from "../reportBuilder/catalog.js";
import { countReport, runReport } from "../reportBuilder/execute.js";
import {
  buildExport, ExportCanceledError, ExportTooHeavyError, ExportTooLargeError,
  type ExportFormat,
} from "../reportBuilder/export/index.js";
import { exportSlot, ExportBusyError } from "../reportBuilder/export/queue.js";
import { buildQuery } from "../reportBuilder/sqlBuilder.js";
import { pruneConfig } from "../reportBuilder/prune.js";
import type { Viewer } from "../reportBuilder/viewer.js";
import { can } from "../permissions/store.js";
import { ReportConfigError, type ReportConfig } from "../reportBuilder/types.js";
import { logAction } from "../utils/logAction.js";
import { IReporteVista } from "../interfaces/index.js";
import { log } from "../utils/logger.js";

/**
 * Who is asking, resolved once per request.
 *
 * Two hand-written role lists used to answer this — `STAFF_ROLES = [1, 2]` here
 * and `STAFF_ONLY = [1, 2]` in the catalog — and both disagreed with the
 * permission matrix, which grants role 2 no `seguridad.ver` at all. So
 * `GET /usuario` answered a coordinator 403 while the generator handed the same
 * person names, login usernames and phone numbers of every user in the system.
 * Now the matrix is asked, which also means an administrator can grant or
 * revoke it from the Seguridad screen instead of asking for a deployment.
 *
 * The matrix lives in memory behind a one-minute cache, so this costs nothing
 * per request.
 */
async function viewerOf(req: Request): Promise<Viewer> {
  const role = roleOf(req);
  return { role, staff: await can(role, "seguridad", "ver") };
}

/**
 * May this caller act on a report that is not theirs?
 *
 * This was `roleOf(req) !== ADMIN_ROLE`, a literal 1: not grantable, not
 * revocable, and invisible on the screen that exists to show who can do what.
 * Archiving somebody else's saved report is the same kind of authority as
 * editing somebody else's account, so it asks the same permission — which role
 * 1 holds today, so nothing changes hands, and now it can be moved.
 */
const mayModerate = (req: Request): Promise<boolean> => can(roleOf(req), "seguridad", "editar");

/** Postgres raises this when SET LOCAL statement_timeout fires. */
const QUERY_CANCELED = "57014";

/**
 * SQLSTATE class 22 is "data exception": every way a value can be wrong for the
 * column it is compared against — unreadable as a number, out of range, a
 * division by zero, a bad cast.
 *
 * The builder validates each filter value before it binds, so reaching here
 * means a shape nobody thought of got through. What the caller must not get is
 * the 500 they used to get: "no se pudo generar el reporte" for one character in
 * one box reads as a broken server, and the honest answer is that the request
 * cannot be answered as written. The message stays generic on purpose — naming
 * the column would echo the physical schema back.
 */
const isDataException = (code: unknown): boolean =>
  typeof code === "string" && code.startsWith("22");

const generadorLog = log("generador");

/**
 * How many saved reports one page of the listing holds.
 *
 * It had no limit at all: the endpoint returned every report the caller can
 * see, each carrying its whole configuration, in one response that grows for as
 * long as the product is used. A hundred is more than any sidebar shows at once
 * and the total comes back beside it, so nothing is hidden by the cap.
 */
const REPORTES_PAGE = 100;
const REPORTES_PAGE_MAX = 200;

/**
 * Refuses, and leaves a trace.
 *
 * Every 403 in this file was silent. Someone walking identifiers looking for
 * other people's private reports produced exactly the same bitácora as someone
 * who never tried — while renaming your own report was logged. The rest of the
 * system records its denials (`ROLE_CHANGE_DENIED` has since the permission
 * migration), and this is the module whose whole purpose is reading data, so it
 * is the one where a refused attempt is worth seeing.
 */
function deny(
  req: Request,
  res: Response,
  action: string,
  detail: string,
  message: string,
) {
  logAction({
    id_usuario: req.user?.id,
    action,
    entity: "ReporteVista",
    // Not `parseId`: this runs on a path that already parsed, and a log that
    // throws while refusing a request would turn a 403 into a 500.
    entity_id: Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) || null,
    detail,
    severity: "warning",
    ip_address: req.ip ?? null,
  });
  return res.status(403).json({ message });
}

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
  if (error instanceof ExportTooLargeError || error instanceof ExportTooHeavyError) {
    return res.status(413).json({ message: error.message });
  }
  // Nobody is listening: the socket closed, which is why the build stopped.
  // Answering would throw on a finished response, so this only leaves a trace.
  if (error instanceof ExportCanceledError) {
    generadorLog.info("exportación cancelada por el cliente");
    return;
  }
  if (error instanceof ExportBusyError) {
    return res.status(429).json({ message: error.message });
  }
  const code = (error as { parent?: { code?: string } })?.parent?.code;
  if (code === QUERY_CANCELED) {
    return res.status(400).json({
      // The count query runs first, in the same transaction and under the same
      // statement_timeout, and buildCountQuery never looks at the columns — so
      // when the timeout fires there, removing columns changes the SQL that
      // expired not at all. Filtering is the lever that actually moves.
      message:
        "La consulta tardó demasiado. Añada o acote un filtro para que el reporte " +
        "devuelva menos registros. Quitar columnas sólo ayuda si el reporte usa " +
        "resúmenes o campos calculados.",
    });
  }
  if (isDataException(code)) {
    // Logged as a warning, not swallowed: every one of these is a hole in the
    // validation upstream, and the only way to find the next one is to see it.
    generadorLog.warn({ code }, "un valor de filtro llegó a Postgres y fue rechazado");
    return res.status(400).json({
      message:
        "Alguno de los valores de los filtros no es válido para el campo que filtra. " +
        "Revise los filtros del reporte.",
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
    res.status(200).json(buildCatalogView(await viewerOf(req)));
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

    // Validate first, then size. A configuration naming a field that does not
    // exist used to come back as "too many cells", which sends someone to
    // delete columns that were not the problem — the same inversion the export
    // path was fixed for, reintroduced here.
    const viewer = await viewerOf(req);
    buildQuery(config, viewer);

    // Refused before the rows are read: materialising three million cells only
    // to decide they were too many is precisely the memory the cap protects.
    //
    // Measured against the limit the builder will actually use, not the one the
    // caller asked for. `limit` is clamped to MAX_ROWS downstream, so asking
    // for a million rows of one column was refused for a size the answer could
    // never have reached, quoting a cell count that was arithmetically
    // impossible.
    const width = Array.isArray(config?.columns) ? config.columns.length : 0;
    const asked = Number(config?.limit);
    const rows = Number.isFinite(asked)
      ? Math.min(Math.max(1, Math.trunc(asked)), MAX_ROWS)
      : DEFAULT_CONSULTA_ROWS;
    if (width > 0 && rows * width > MAX_CONSULTA_CELLS) {
      return res.status(413).json({
        message:
          `La consulta pide demasiados datos de una vez (${es(rows * width)} celdas, ` +
          `máximo ${es(MAX_CONSULTA_CELLS)}). Pida menos filas por página o quite columnas.`,
      });
    }

    const result = await runReport(config, viewer);

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
      ip_address: req.ip ?? null,
    });

    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * How many rows the report would return, and nothing else.
 *
 * Split from `/consulta` because the two are asked at completely different
 * rates. A person wants to know that a filter leaves 118 rows and not 40.000
 * *while they are still typing it*, which is many times a minute — and asking
 * the full query that often would burn the 30-per-minute budget that exists to
 * stop one person locking the database for everyone.
 *
 * This reads no rows: `buildCountQuery` never looks at the columns, so it costs
 * one aggregate over the filtered set. Its own limiter is four times the other
 * one, which is what a keystroke-rate question needs and what this can afford.
 */
export async function postConteo(req: Request, res: Response) {
  try {
    const config = req.body as ReportConfig;
    const viewer = await viewerOf(req);
    // Validated the same way, so a broken configuration answers with the same
    // sentence here as it does on the way to a table.
    buildQuery(config, viewer);

    const total = await countReport(config, viewer);
    res.status(200).json({ total });
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

    // Resolved before the slot is taken: the export slot is the only one in the
    // process, and holding it while asking anything else is holding it for
    // everybody.
    const viewer = await viewerOf(req);

    // Cancelling used to cancel nothing. The browser drops the request — the
    // page has an AbortController on the button — and the server carried on
    // building a file for nobody while holding the only export slot in the
    // process, so the next person read "ya hay una exportación en curso" about
    // their own abandoned one, with no way to tell.
    //
    // `close` also fires on a response that finished normally, so the guard is
    // on whether anything was written yet.
    const abort = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const output = await exportSlot.run(() => buildExport({
      config: body.config as ReportConfig,
      viewer,
      format,
      title,
      subtitle,
      photos: body.photos === true,
      signal: abort.signal,
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
      ip_address: req.ip ?? null,
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

/**
 * Own reports plus everything shared by others, one page at a time.
 *
 * The page is capped and the total travels with it, so the client can say how
 * many it is not showing instead of quietly showing fewer.
 */
export async function getReportes(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    const viewer = await viewerOf(req);
    // The catalog hides other people's personal data from whoever lacks
    // `seguridad.ver`, so the listing must not hand it back through the author
    // of every shared report.
    const canSeeAuthors = viewer.staff;

    const asked = Number(req.query.limit);
    const limit = Number.isFinite(asked)
      ? Math.min(Math.max(1, Math.trunc(asked)), REPORTES_PAGE_MAX)
      : REPORTES_PAGE;
    const askedOffset = Number(req.query.offset);
    const offset = Number.isFinite(askedOffset) ? Math.max(0, Math.trunc(askedOffset)) : 0;

    const { rows, count } = await ReporteVistaModel.findAndCountAll({
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
      limit,
      offset,
      // The include makes Sequelize count joined rows unless told otherwise.
      distinct: true,
    });

    res.status(200).json({
      // Pruned one by one: a shared report names the fields it was built from,
      // and some of those are fields this caller may not see. Handing the
      // configuration over verbatim published the paths and the values filtered
      // against them — the listing was the widest door to that, since it
      // carries every report at once.
      rows: rows.map((model) => {
        const row = model.toJSON() as IReporteVista;
        const pruned = pruneConfig(row.config as unknown as ReportConfig, viewer);
        return { ...row, config: pruned.config, omitted: pruned.omitted };
      }),
      total: count,
      limit,
      offset,
    });
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
      return deny(
        req, res, "READ_REPORTE_DENIED",
        `Intentó abrir el reporte privado #${row.id} de otra persona`,
        "Este reporte es privado.",
      );
    }

    const pruned = pruneConfig(row.config as unknown as ReportConfig, await viewerOf(req));
    res.status(200).json({ ...row, config: pruned.config, omitted: pruned.omitted });
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
    buildQuery(payload.config as unknown as ReportConfig, await viewerOf(req));

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
      ip_address: req.ip ?? null,
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
      return deny(
        req, res, "EDIT_REPORTE_DENIED",
        `Intentó modificar el reporte #${row.id} de otra persona`,
        "Solo el autor puede editar este reporte.",
      );
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
      buildQuery(payload.config as unknown as ReportConfig, await viewerOf(req));
    }

    await found.update(payload);

    logAction({
      id_usuario: req.user?.id,
      action: "UPDATE_REPORTE_VISTA",
      entity: "ReporteVista",
      entity_id: parseId(req),
      detail: `Editó el reporte "${payload.name}"`,
      severity: "warning",
      ip_address: req.ip ?? null,
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
    if (row.id_usuario !== req.user?.id && !(await mayModerate(req))) {
      return deny(
        req, res, "DELETE_REPORTE_DENIED",
        `Intentó archivar el reporte #${row.id} de otra persona`,
        // Not "solo el autor": the guard above lets a moderator through, so
        // that sentence told the reader a false rule about the product. And
        // this handler reports success as "Reporte archivado", so it says
        // archivar here too.
        "No tiene permiso para archivar reportes de otras personas.",
      );
    }

    await found.destroy();

    logAction({
      id_usuario: req.user?.id,
      action: "DELETE_REPORTE_VISTA",
      entity: "ReporteVista",
      entity_id: parseId(req),
      detail: `Archivó el reporte "${row.name}"`,
      severity: "critical",
      ip_address: req.ip ?? null,
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
      return deny(
        req, res, "DUPLICATE_REPORTE_DENIED",
        `Intentó duplicar el reporte privado #${row.id} de otra persona`,
        "Este reporte es privado.",
      );
    }

    // Pruned to what the copier may use, then validated. It used to be validated
    // as it stood, so a shared report naming a field their account cannot see —
    // one the screen had just listed with a Duplicar button on it — answered 400
    // quoting an internal path like "usuario.user", which is both unreadable and
    // the very name the catalog was hiding. Copying what they can use, and
    // telling them how much was left out, is the answer that makes sense to
    // somebody who did not build the original.
    const viewer = await viewerOf(req);
    const pruned = pruneConfig(row.config as unknown as ReportConfig, viewer);
    if (!pruned.config.columns?.length) {
      throw new ReportConfigError(
        "No se puede duplicar este reporte: ninguna de sus columnas está disponible para su cuenta.",
      );
    }
    buildQuery(pruned.config, viewer);

    const created = await ReporteVistaModel.create({
      name: `${row.name} (copia)`.slice(0, 120),
      description: row.description ?? null,
      config: pruned.config as unknown as Record<string, unknown>,
      id_usuario: req.user!.id,
      visibility: "private",
      favorite: false,
    });

    logAction({
      id_usuario: req.user?.id,
      action: "DUPLICATE_REPORTE_VISTA",
      entity: "ReporteVista",
      entity_id: created.dataValues.id as number,
      detail:
        `Duplicó el reporte "${row.name}"` +
        (pruned.omitted > 0 ? ` (sin ${pruned.omitted} elemento(s) no disponibles)` : ""),
      severity: "info",
      ip_address: req.ip ?? null,
    });

    res.status(201).json(created);
  } catch (error) {
    handleError(error, res);
  }
}
