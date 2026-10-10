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
  ReporteEjecucionModel,
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

function deny(req: Request, res: Response, action: BitacoraAction, detail: string, message: string) {
  logAction({
    id_usuario: req.user?.id,
    action,
    entity: "ReporteProgramacion",
    entity_id: idDe(req),
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
      metadata: { ...destinatariosParaBitacora(pedida), formato: pedida.formato, hora: pedida.hora },
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
      metadata: { ...destinatariosParaBitacora(pedida), formato: pedida.formato, hora: pedida.hora, activa: pedida.activa },
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
