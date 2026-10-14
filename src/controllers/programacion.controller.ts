// Scheduled reports over HTTP: creating, changing, pausing, removing and
// trying out a schedule, and reading its history.
// Design: docs/specs/2026-10-10-informes-programados-design.md §3.6 and §3.8.
//
// **A schedule belongs to whoever created it, and runs under their
// permissions.** Only the owner changes it or sends it now. Administration —
// `seguridad.editar`, the same authority that archives somebody else's saved
// report — may see every schedule and remove one, and nothing else: rewriting
// a colleague's recipients is not moderation.
//
// **What is validated here and what is not.** The shape of the request is
// `reportSchedule/payload.ts`'s, as sentences. What only the database can
// answer is asked here: that the report exists and the caller may open it,
// and that every account named as a recipient exists.

import { Request, Response } from "express";
import { Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import {
  ESTADOS_DE_EJECUCION,
  ReporteEjecucionModel,
  ReporteEntregaModel,
  ReporteProgramacionDestinatarioModel,
  ReporteProgramacionModel,
} from "../models/reporteProgramacion.model.js";
import { ReporteVistaModel } from "../models/reporteVista.model.js";
import { UsuarioModel, USUARIO_AS_AUTHOR } from "../models/usuario.model.js";
import { can } from "../permissions/store.js";
import { ejecutarTurno } from "../reportSchedule/run.js";
import { leerProgramacion, type ProgramacionPedida } from "../reportSchedule/payload.js";
import { proximaEjecucion } from "../reportSchedule/nextRun.js";
import { estadoTrasEditar, reconciliarDestinatarios } from "../reportSchedule/changes.js";
import { RECHAZOS_PARA_DEJAR } from "../reportSchedule/limits.js";
import { dependenciasDeInformes } from "../reportSchedule/runtime.js";
import { aProgramacion } from "../reportSchedule/store.js";
import type {
  IReporteEjecucion,
  IReporteEjecucionEntrega,
  IReporteProgramacion,
  IReporteProgramacionDestinatario,
  IReporteVista,
} from "../interfaces/index.js";
import { excedeElTecho, listar, responderExcede } from "../utils/listado.js";
import { leerPaginacion } from "../utils/paginacion.js";
import { logAction } from "../utils/logAction.js";
import { log } from "../utils/logger.js";
import type { BitacoraAction } from "../utils/bitacoraVocabulary.js";

const programacionLog = log("programacion");

const roleOf = (req: Request): number => req.user?.id_rol ?? -1;
const mayModerate = (req: Request): Promise<boolean> => can(roleOf(req), "seguridad", "editar");

function idDe(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function deny(
  req: Request,
  res: Response,
  action: BitacoraAction,
  detail: string,
  message: string,
  /** The schedule refused, when the address names something else (a run). */
  entityId: number | null = idDe(req),
) {
  logAction({
    id_usuario: req.user?.id,
    action,
    entity: "ReporteProgramacion",
    entity_id: entityId,
    detail,
    severity: "warning",
    ip_address: req.ip ?? null,
  });
  return res.status(403).json({ message });
}

/** Never the database's own words: they name tables and constraints. */
function fallo(res: Response, error: unknown, que: string) {
  programacionLog.error({ err: error }, `programaciones: falló ${que}`);
  return res.status(500).json({ message: "No se pudo completar la operación. Inténtelo de nuevo." });
}

type Fila = IReporteProgramacion & {
  destinatarios?: { dataValues: IReporteProgramacionDestinatario }[];
};

/**
 * A schedule as the screen reads it: the row, what it sends, to whom, and how
 * its last run went.
 *
 * A recipient account is named and nothing more — the three fields an author
 * is shown with anywhere else. Its address is not sent: whether it *has* a
 * verified one is all the screen needs to explain why somebody is not
 * receiving.
 */
async function presentar(filas: Fila[]) {
  if (filas.length === 0) return [];
  const ids = filas.map((f) => f.id);
  const destinatarios = await ReporteProgramacionDestinatarioModel.findAll({
    where: { id_programacion: ids },
    order: [["id", "ASC"]],
  });
  // Recipients and owners in one read: both are shown by name and nothing more.
  const idsDeUsuario = [...new Set([
    ...destinatarios.map((d) => d.dataValues.id_usuario).filter((v): v is number => typeof v === "number"),
    ...filas.map((f) => f.id_usuario),
  ])];
  const [cuentas, informes, ultimas] = await Promise.all([
    idsDeUsuario.length
      ? UsuarioModel.findAll({ where: { id: idsDeUsuario }, attributes: [...USUARIO_AS_AUTHOR, "email_verified_at"], paranoid: false })
      : Promise.resolve([]),
    ReporteVistaModel.findAll({
      where: { id: [...new Set(filas.map((f) => f.id_reporte))] },
      attributes: ["id", "name"],
      paranoid: false,
    }),
    ReporteEjecucionModel.findAll({
      where: { id_programacion: ids, estado: { [Op.ne]: "en_curso" } },
      order: [["programada_para", "DESC"]],
      limit: ids.length * 5,
    }),
  ]);
  const cuenta = new Map(cuentas.map((c) => [c.dataValues.id, c.dataValues]));
  const informe = new Map(informes.map((i) => [i.dataValues.id, i.dataValues as IReporteVista]));

  return filas.map((f) => {
    const suyos = destinatarios.filter((d) => d.dataValues.id_programacion === f.id).map((d) => d.dataValues);
    const ultima = ultimas.find((e) => e.dataValues.id_programacion === f.id)?.dataValues as IReporteEjecucion | undefined;
    const inf = informe.get(f.id_reporte);
    return {
      id: f.id,
      id_reporte: f.id_reporte,
      informe: inf ? { name: inf.name, archivado: Boolean(inf.deletedAt) } : null,
      id_usuario: f.id_usuario,
      dueno: cuenta.has(f.id_usuario)
        ? { name: cuenta.get(f.id_usuario)?.name ?? null, lastname: cuenta.get(f.id_usuario)?.lastname ?? null }
        : null,
      frecuencia: f.frecuencia,
      dia_semana: f.dia_semana ?? null,
      dia_mes: f.dia_mes ?? null,
      hora: f.hora,
      minuto: f.minuto ?? 0,
      formato: f.formato,
      con_fotos: f.con_fotos,
      activa: f.activa,
      motivo_pausa: f.motivo_pausa ?? null,
      fallos_seguidos: f.fallos_seguidos,
      proxima_ejecucion: f.proxima_ejecucion ?? null,
      destinatarios: {
        usuarios: suyos
          .filter((d) => typeof d.id_usuario === "number")
          .map((d) => {
            const c = cuenta.get(d.id_usuario as number);
            return {
              id_usuario: d.id_usuario as number,
              name: c?.name ?? null,
              lastname: c?.lastname ?? null,
              // Why this account is not being written to, when it is not.
              tieneCorreo: Boolean(c?.email_verified_at),
            };
          }),
        correos: suyos
          .filter((d) => typeof d.email === "string")
          .map((d) => ({
            email: d.email as string,
            deBaja: Boolean(d.baja_at),
            rechazado: d.rechazos_seguidos >= RECHAZOS_PARA_DEJAR,
          })),
      },
      ultima: ultima
        ? { estado: ultima.estado, programada_para: ultima.programada_para, enviados: ultima.enviados, detalle: ultima.detalle ?? null }
        : null,
    };
  });
}

/** What goes in the bitácora about who a schedule sends to. Outside addresses in full: that is the point of recording them. */
const destinatariosParaBitacora = (p: ProgramacionPedida) => ({ usuarios: p.usuarios, correos_externos: p.correos });

/**
 * What only the database can say about a request. A sentence for the caller
 * when something is wrong, `null` when it is fine.
 */
async function comprobarContraLaBase(req: Request, pedida: ProgramacionPedida): Promise<{ status: number; message: string } | null> {
  const informe = await ReporteVistaModel.findByPk(pedida.id_reporte, { attributes: ["id", "id_usuario", "visibility"] });
  // Private and somebody else's reads exactly like one that does not exist:
  // a schedule must not be a way of finding out which report ids are taken.
  const row = informe?.dataValues as IReporteVista | undefined;
  if (!row || (row.visibility !== "shared" && row.id_usuario !== req.user?.id)) {
    return { status: 404, message: "El informe no existe." };
  }
  if (pedida.usuarios.length > 0) {
    const existen = await UsuarioModel.count({ where: { id: pedida.usuarios } });
    if (existen !== pedida.usuarios.length) {
      return { status: 400, message: "Alguno de los usuarios destinatarios no existe o está archivado." };
    }
  }
  return null;
}

export async function getProgramaciones(req: Request, res: Response) {
  try {
    const paginacion = leerPaginacion(req.query);
    if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

    const where: Record<string, unknown> = {};
    if (!(await mayModerate(req))) where.id_usuario = req.user!.id;
    const deInforme = Number(req.query.id_reporte);
    if (Number.isInteger(deInforme) && deInforme > 0) where.id_reporte = deInforme;

    const listado = await listar<{ dataValues: IReporteProgramacion }>(
      ReporteProgramacionModel,
      { where, order: [["id", "DESC"]] },
      paginacion,
    );
    if (excedeElTecho(listado)) return responderExcede(res, listado.excede);

    res.status(200).json({ ...listado, data: await presentar(listado.data.map((f) => f.dataValues)) });
  } catch (error) {
    fallo(res, error, "el listado");
  }
}

export async function postProgramacion(req: Request, res: Response) {
  try {
    const lectura = leerProgramacion(req.body);
    if (!lectura.ok) return res.status(400).json({ message: lectura.problemas.join(" ") });
    const pedida = lectura.valor;

    const problema = await comprobarContraLaBase(req, pedida);
    if (problema) return res.status(problema.status).json({ message: problema.message });

    const creada = await sequelize.transaction(async (transaction) => {
      const fila = await ReporteProgramacionModel.create(
        {
          id_reporte: pedida.id_reporte,
          id_usuario: req.user!.id,
          frecuencia: pedida.frecuencia,
          dia_semana: pedida.dia_semana ?? null,
          dia_mes: pedida.dia_mes ?? null,
          hora: pedida.hora,
          minuto: pedida.minuto ?? 0,
          formato: pedida.formato,
          con_fotos: pedida.con_fotos,
          activa: pedida.activa,
          motivo_pausa: pedida.activa ? null : "manual",
          proxima_ejecucion: pedida.activa ? proximaEjecucion(pedida, new Date()) : null,
        },
        { transaction },
      );
      const id_programacion = fila.dataValues.id;
      await ReporteProgramacionDestinatarioModel.bulkCreate(
        [
          ...pedida.usuarios.map((id_usuario) => ({ id_programacion, id_usuario })),
          ...pedida.correos.map((email) => ({ id_programacion, email })),
        ],
        { transaction },
      );
      return fila.dataValues;
    });

    logAction({
      id_usuario: req.user?.id,
      action: "CREATE_PROGRAMACION",
      entity: "ReporteProgramacion",
      entity_id: creada.id,
      detail: `Programó el envío ${pedida.frecuencia} del informe #${pedida.id_reporte} a ${pedida.usuarios.length + pedida.correos.length} destinatarios`,
      metadata: { ...destinatariosParaBitacora(pedida), formato: pedida.formato, hora: pedida.hora, minuto: pedida.minuto ?? 0 },
      severity: pedida.correos.length > 0 ? "warning" : "info",
      ip_address: req.ip ?? null,
    });

    res.status(201).json((await presentar([creada]))[0]);
  } catch (error) {
    fallo(res, error, "la creación");
  }
}

export async function putProgramacion(req: Request, res: Response) {
  try {
    const id = idDe(req);
    const encontrada = id === null ? null : await ReporteProgramacionModel.findByPk(id);
    if (!encontrada) return res.status(404).json({ message: "La programación no existe." });
    const actual = encontrada.dataValues;

    if (actual.id_usuario !== req.user?.id) {
      return deny(
        req, res, "EDIT_PROGRAMACION_DENIED",
        `Intentó modificar el envío programado #${actual.id} de otra persona`,
        "Solo quien programó este envío puede cambiarlo.",
      );
    }

    const lectura = leerProgramacion(req.body);
    if (!lectura.ok) return res.status(400).json({ message: lectura.problemas.join(" ") });
    const pedida = lectura.valor;

    const problema = await comprobarContraLaBase(req, pedida);
    if (problema) return res.status(problema.status).json({ message: problema.message });

    // What an edit does not simply overwrite — see `reportSchedule/changes.ts`.
    const estado = estadoTrasEditar(actual, pedida, new Date());

    await sequelize.transaction(async (transaction) => {
      await encontrada.update(
        {
          id_reporte: pedida.id_reporte,
          frecuencia: pedida.frecuencia,
          dia_semana: pedida.dia_semana ?? null,
          dia_mes: pedida.dia_mes ?? null,
          hora: pedida.hora,
          minuto: pedida.minuto ?? 0,
          formato: pedida.formato,
          con_fotos: pedida.con_fotos,
          activa: pedida.activa,
          ...estado,
        },
        { transaction },
      );

      const existentes = (
        await ReporteProgramacionDestinatarioModel.findAll({ where: { id_programacion: actual.id }, transaction })
      ).map((d) => d.dataValues);
      const { borrar, crear } = reconciliarDestinatarios(existentes, pedida);
      if (borrar.length > 0) {
        await ReporteProgramacionDestinatarioModel.destroy({ where: { id: borrar }, transaction });
      }
      if (crear.length > 0) {
        await ReporteProgramacionDestinatarioModel.bulkCreate(
          crear.map((d) => ({ id_programacion: actual.id, ...d })),
          { transaction },
        );
      }
    });

    logAction({
      id_usuario: req.user?.id,
      action: "UPDATE_PROGRAMACION",
      entity: "ReporteProgramacion",
      entity_id: actual.id,
      detail: `Cambió el envío programado #${actual.id}${pedida.activa ? "" : " (en pausa)"}`,
      metadata: { ...destinatariosParaBitacora(pedida), formato: pedida.formato, hora: pedida.hora, minuto: pedida.minuto ?? 0, activa: pedida.activa },
      severity: "warning",
      ip_address: req.ip ?? null,
    });

    res.status(200).json((await presentar([(await encontrada.reload()).dataValues]))[0]);
  } catch (error) {
    fallo(res, error, "la edición");
  }
}

export async function deleteProgramacion(req: Request, res: Response) {
  try {
    const id = idDe(req);
    const encontrada = id === null ? null : await ReporteProgramacionModel.findByPk(id);
    if (!encontrada) return res.status(404).json({ message: "La programación no existe." });
    const actual = encontrada.dataValues;

    const ajena = actual.id_usuario !== req.user?.id;
    if (ajena && !(await mayModerate(req))) {
      return deny(
        req, res, "DELETE_PROGRAMACION_DENIED",
        `Intentó eliminar el envío programado #${actual.id} de otra persona`,
        "Solo quien programó este envío, o administración, puede eliminarlo.",
      );
    }

    await sequelize.transaction(async (transaction) => {
      // Stopped first, then archived: the table insists that a schedule
      // which is not active has no next run, archived or not.
      await encontrada.update({ activa: false, proxima_ejecucion: null, motivo_pausa: "manual" }, { transaction });
      await encontrada.destroy({ transaction });
    });

    logAction({
      id_usuario: req.user?.id,
      action: "DELETE_PROGRAMACION",
      entity: "ReporteProgramacion",
      entity_id: actual.id,
      detail: `Eliminó el envío programado #${actual.id}${ajena ? " de otra persona" : ""}`,
      severity: "warning",
      ip_address: req.ip ?? null,
    });

    res.status(204).end();
  } catch (error) {
    fallo(res, error, "el borrado");
  }
}

/**
 * "Send it now": one real run, to the real recipients, recorded as manual.
 * It leaves the schedule's next run and its count of failures as they were.
 */
export async function postEjecutarProgramacion(req: Request, res: Response) {
  try {
    const id = idDe(req);
    const encontrada = id === null ? null : await ReporteProgramacionModel.findByPk(id);
    if (!encontrada) return res.status(404).json({ message: "La programación no existe." });
    const actual = encontrada.dataValues;

    if (actual.id_usuario !== req.user?.id) {
      return deny(
        req, res, "RUN_PROGRAMACION_DENIED",
        `Intentó enviar ahora el envío programado #${actual.id} de otra persona`,
        "Solo quien programó este envío puede enviarlo ahora.",
      );
    }

    const resultado = await ejecutarTurno(dependenciasDeInformes(), aProgramacion(actual), new Date(), { manual: true });

    if (resultado.tipo === "ocupado") {
      return res.status(429).json({ message: "Hay una exportación en curso. Espere a que termine e inténtelo de nuevo." });
    }
    if (resultado.tipo === "ya_reclamado") {
      return res.status(409).json({ message: "Este envío ya se está ejecutando." });
    }

    logAction({
      id_usuario: req.user?.id,
      action: "RUN_PROGRAMACION",
      entity: "ReporteProgramacion",
      entity_id: actual.id,
      detail:
        resultado.tipo === "pausada"
          ? `Intentó enviar ahora el envío programado #${actual.id}, que quedó en pausa (${resultado.motivo})`
          : `Envió ahora el envío programado #${actual.id}: ${resultado.estado}, ${resultado.enviados} entregados`,
      metadata: { ...resultado },
      severity: "info",
      ip_address: req.ip ?? null,
    });

    res.status(200).json(resultado);
  } catch (error) {
    fallo(res, error, "el envío inmediato");
  }
}

export async function getEjecucionesDeProgramacion(req: Request, res: Response) {
  try {
    const id = idDe(req);
    const encontrada = id === null ? null : await ReporteProgramacionModel.findByPk(id, { attributes: ["id", "id_usuario"] });
    if (!encontrada) return res.status(404).json({ message: "La programación no existe." });
    if (encontrada.dataValues.id_usuario !== req.user?.id && !(await mayModerate(req))) {
      return deny(
        req, res, "READ_PROGRAMACION_DENIED",
        `Intentó leer el historial del envío programado #${encontrada.dataValues.id} de otra persona`,
        "Este envío programado es de otra persona.",
      );
    }

    const paginacion = leerPaginacion(req.query);
    if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

    const listado = await listar(
      ReporteEjecucionModel,
      { where: { id_programacion: encontrada.dataValues.id }, order: [["programada_para", "DESC"]] },
      paginacion,
    );
    if (excedeElTecho(listado)) return responderExcede(res, listado.excede);
    res.status(200).json(listado);
  } catch (error) {
    fallo(res, error, "el historial");
  }
}

/** The largest id an `integer` column holds; anything above it cannot be one. */
const ID_MAXIMO = 2_147_483_647;

/**
 * One optional filter of the history, read strictly.
 *
 * The house rule: a parameter that is present and empty, repeated or not a
 * value of its kind is a 400, never "all" — a filter that silently stops
 * filtering shows a user a page that looks like the answer and is not.
 */
function leerFiltrosDelHistorial(
  query: Request["query"],
): { estado?: (typeof ESTADOS_DE_EJECUCION)[number]; id_programacion?: number } | string {
  const filtros: { estado?: (typeof ESTADOS_DE_EJECUCION)[number]; id_programacion?: number } = {};

  const estado = query.estado;
  if (estado !== undefined) {
    const conocido = ESTADOS_DE_EJECUCION.find((e) => e === estado);
    if (!conocido) return `El parámetro «estado» debe ser uno de: ${ESTADOS_DE_EJECUCION.join(", ")}.`;
    filtros.estado = conocido;
  }

  const programacion = query.id_programacion;
  if (programacion !== undefined) {
    const id = typeof programacion === "string" && /^\d+$/.test(programacion) ? Number(programacion) : 0;
    if (id < 1 || id > ID_MAXIMO) return "El parámetro «id_programacion» debe ser un número entero positivo.";
    filtros.id_programacion = id;
  }

  return filtros;
}

/**
 * Every run of every schedule the viewer may see, newest first: the history
 * the Envíos screen shows beside the list of schedules.
 *
 * **Who sees what is decided by the query, not by the page.** The schedule is
 * joined as an inner join carrying the owner's condition, so a run of somebody
 * else's schedule is not a row the database returns, whichever page it would
 * have fallen on — filtering afterwards would leave short pages and a `total`
 * that counts what the viewer may not see. Naming a schedule that is not theirs
 * therefore gives an empty page, the same as one that does not exist: this
 * must not be a way to learn which ids are taken.
 *
 * **A deleted schedule keeps its runs** — they are what happened — so the join
 * reads archived rows too and says so (`eliminada`). The report and the owner
 * are named the way the list of schedules names them, archived or not, in one
 * read each for the whole page, and are `null` only when truly gone.
 */
export async function getHistorialDeEjecuciones(req: Request, res: Response) {
  try {
    const paginacion = leerPaginacion(req.query);
    if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });
    const filtros = leerFiltrosDelHistorial(req.query);
    if (typeof filtros === "string") return res.status(400).json({ message: filtros });

    const soloLasMias = !(await mayModerate(req));

    const listado = await listar<{ dataValues: IReporteEjecucion & { reporteProgramacion?: { dataValues: IReporteProgramacion } } }>(
      ReporteEjecucionModel,
      {
        where: filtros,
        order: [["programada_para", "DESC"], ["id", "DESC"]],
        include: [
          {
            model: ReporteProgramacionModel,
            required: true,
            paranoid: false,
            attributes: ["id", "id_reporte", "id_usuario", "formato", "deleted_at"],
            ...(soloLasMias ? { where: { id_usuario: req.user!.id } } : {}),
          },
        ],
      },
      paginacion,
    );
    if (excedeElTecho(listado)) return responderExcede(res, listado.excede);

    const filas = listado.data.map(({ dataValues: { reporteProgramacion, ...propios } }) => ({
      propios,
      programacion: reporteProgramacion!.dataValues,
    }));
    if (filas.length === 0) return res.status(200).json({ ...listado, data: [] });

    const [informes, cuentas, conDestinatarios] = await Promise.all([
      ReporteVistaModel.findAll({
        where: { id: [...new Set(filas.map((f) => f.programacion.id_reporte))] },
        attributes: ["id", "name"],
        paranoid: false,
      }),
      UsuarioModel.findAll({
        where: { id: [...new Set(filas.map((f) => f.programacion.id_usuario))] },
        attributes: [...USUARIO_AS_AUTHOR],
        paranoid: false,
      }),
      // Which of these runs have recipients recorded: the runs from before the
      // record have none, and the screen must tell them from the ones that do
      // without a request per row. **A convenience on top of the history, not
      // part of it**: if this table cannot be read the runs are still served,
      // all marked as having no record, and the failure is warned about.
      ReporteEntregaModel.findAll({
        where: { id_ejecucion: filas.map((f) => f.propios.id) },
        attributes: ["id_ejecucion"],
        group: ["id_ejecucion"],
      }).catch((error: unknown) => {
        programacionLog.warn({ err: error }, "programaciones: no se pudo saber qué ejecuciones tienen destinatarios");
        return [];
      }),
    ]);
    const informe = new Map(informes.map((i) => [i.dataValues.id, i.dataValues as IReporteVista]));
    const cuenta = new Map(cuentas.map((c) => [c.dataValues.id, c.dataValues]));
    const conRegistro = new Set(conDestinatarios.map((e) => e.dataValues.id_ejecucion));

    res.status(200).json({
      ...listado,
      data: filas.map(({ propios, programacion: p }) => {
        const inf = informe.get(p.id_reporte);
        const dueno = cuenta.get(p.id_usuario);
        return {
          ...propios,
          con_destinatarios: conRegistro.has(propios.id),
          programacion: {
            id: p.id,
            formato: p.formato,
            eliminada: Boolean(p.deleted_at),
            informe: inf ? { id: inf.id, name: inf.name } : null,
            dueno: dueno ? { id: dueno.id, name: dueno.name, lastname: dueno.lastname } : null,
          },
        };
      }),
    });
  } catch (error) {
    fallo(res, error, "el historial general");
  }
}

/**
 * Who one run was sent to, and what became of each of them.
 *
 * **The same rule as the history of one schedule**, because it is the same
 * information: the owner of the run's schedule reads it, and so does
 * administration; anybody else is refused and the attempt recorded, and a run
 * that does not exist is a 404. The first read finds the run with its schedule
 * (archived ones too: a deleted schedule keeps its runs); the second, the
 * recipients, repeats the owner's condition in its own query, so that the check
 * is not the only thing between a viewer and somebody else's recipients.
 *
 * It is a listing of a table's rows and answers the house envelope. At most ten
 * a run is not a reason to exempt it: section 3.3 of the API standard says a
 * handful of rows is exactly the weak criterion it removed.
 *
 * **An account's address is never served.** The row does not even keep it, and
 * the response has no field for an address at all: an outside recipient appears
 * under its address because that is its `nombre`.
 */
export async function getDestinatariosDeEjecucion(req: Request, res: Response) {
  try {
    const id = idDe(req);
    const ejecucion = id === null
      ? null
      : await ReporteEjecucionModel.findByPk(id, {
          attributes: ["id"],
          include: [{ model: ReporteProgramacionModel, attributes: ["id", "id_usuario"], required: true, paranoid: false }],
        });
    if (!ejecucion) return res.status(404).json({ message: "El envío no existe." });

    const programacion = (ejecucion.dataValues as { reporteProgramacion?: { dataValues: IReporteProgramacion } }).reporteProgramacion!.dataValues;
    const modera = await mayModerate(req);
    if (programacion.id_usuario !== req.user?.id && !modera) {
      return deny(
        req, res, "READ_PROGRAMACION_DENIED",
        `Intentó leer a quién se envió la ejecución #${ejecucion.dataValues.id} del envío programado #${programacion.id} de otra persona`,
        "Este envío programado es de otra persona.",
        programacion.id,
      );
    }

    const paginacion = leerPaginacion(req.query);
    if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

    const listado = await listar<{ dataValues: IReporteEjecucionEntrega }>(
      ReporteEntregaModel,
      {
        where: { id_ejecucion: ejecucion.dataValues.id },
        order: [["id", "ASC"]],
        include: [
          {
            model: ReporteEjecucionModel,
            required: true,
            attributes: [],
            include: [
              {
                model: ReporteProgramacionModel,
                required: true,
                paranoid: false,
                attributes: [],
                ...(modera ? {} : { where: { id_usuario: req.user!.id } }),
              },
            ],
          },
        ],
      },
      paginacion,
    );
    if (excedeElTecho(listado)) return responderExcede(res, listado.excede);

    res.status(200).json({
      ...listado,
      data: listado.data.map(({ dataValues: e }) => ({
        id: e.id,
        tipo: e.tipo,
        // An outside recipient is called by its address, so `nombre` is all
        // there is to show: no field of its own for an address, which is how an
        // account's could never be served by mistake.
        nombre: e.nombre,
        resultado: e.resultado,
      })),
    });
  } catch (error) {
    fallo(res, error, "los destinatarios del envío");
  }
}

/**
 * The accounts that can be picked as recipients: a name each, and whether a
 * verified address stands behind it. Never the address.
 */
export async function getDestinatariosPosibles(req: Request, res: Response) {
  try {
    const paginacion = leerPaginacion(req.query);
    if (typeof paginacion === "string") return res.status(400).json({ message: paginacion });

    const listado = await listar<{ dataValues: { id: number; name: string; lastname: string; email_verified_at?: Date | null } }>(
      UsuarioModel,
      { attributes: [...USUARIO_AS_AUTHOR, "email_verified_at"], order: [["name", "ASC"], ["lastname", "ASC"]] },
      paginacion,
    );
    if (excedeElTecho(listado)) return responderExcede(res, listado.excede);

    res.status(200).json({
      ...listado,
      data: listado.data.map(({ dataValues: u }) => ({
        id: u.id,
        name: u.name,
        lastname: u.lastname,
        tieneCorreo: Boolean(u.email_verified_at),
      })),
    });
  } catch (error) {
    fallo(res, error, "la lista de destinatarios");
  }
}
