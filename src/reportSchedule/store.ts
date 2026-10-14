// The real implementations behind `run.ts` and `scheduler.ts`: the database,
// the exporter, the permission matrix and the mail chain.
//
// Kept thin on purpose. Every rule about *what should happen* lives in the two
// files above, where it is tested without a database; what is here is the
// reading and the writing, and `store.db.test.ts` runs it against Postgres.

import { Op, UniqueConstraintError } from "sequelize";
import { enviarCorreo } from "../auth/mailer.js";
import { sequelize } from "../database/sequelize.js";
import {
  ReporteEjecucionModel,
  ReporteEntregaModel,
  ReporteProgramacionDestinatarioModel,
  ReporteProgramacionModel,
} from "../models/reporteProgramacion.model.js";
import { ReporteVistaModel } from "../models/reporteVista.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { can } from "../permissions/store.js";
import { buildExport } from "../reportBuilder/export/index.js";
import { exportSlot } from "../reportBuilder/export/queue.js";
import { pruneConfig } from "../reportBuilder/prune.js";
import type { ReportConfig } from "../reportBuilder/types.js";
import { log } from "../utils/logger.js";
import type { IReporteProgramacion } from "../interfaces/index.js";
import { ejecutarTurno, type Contexto, type Dependencias, type Destinatario, type Programacion } from "./run.js";
import type { DependenciasDelProgramador, Vencida } from "./scheduler.js";

const scheduleLog = log("reportSchedule");

/**
 * The permission that lets an owner's schedule run — the same one the routes
 * ask before letting anybody create it. Asked again at every run, not only
 * when the schedule is made: a role that loses it stops sending that night,
 * and the schedule pauses with `sin_permiso` as its reason.
 */
const PERMISO_PARA_PROGRAMAR = { modulo: "generador", accion: "programar" } as const;

/** How many due schedules one tick takes. More than this wait for the next. */
const MAXIMO_POR_TIC = 50;

/** The part of a schedule row the run needs, as a plain object. */
export function aProgramacion(fila: IReporteProgramacion): Programacion {
  return {
    id: fila.id,
    id_reporte: fila.id_reporte,
    id_usuario: fila.id_usuario,
    frecuencia: fila.frecuencia,
    dia_semana: fila.dia_semana ?? null,
    dia_mes: fila.dia_mes ?? null,
    hora: fila.hora,
    minuto: fila.minuto ?? 0,
    formato: fila.formato,
    con_fotos: fila.con_fotos,
    fallos_seguidos: fila.fallos_seguidos,
  };
}

const nombreCompleto = (u: { name?: string; lastname?: string; user?: string }): string =>
  [u.name, u.lastname].filter(Boolean).join(" ").trim() || u.user || "un usuario de Osefi";

/**
 * How a recipient account is called in the history of a run: name and surname,
 * else a generic label. **Never the login name**, which may be an e-mail address
 * and an account's address is the one thing this record must not keep.
 */
const nombreParaElHistorial = (u: { name?: string; lastname?: string }): string =>
  [u.name, u.lastname].filter(Boolean).join(" ").trim() || "un usuario de Osefi";

/** The widest a name or an address goes in `reporte_ejecucion_entregas`. */
const ANCHO_DE_COLUMNA = 255;

async function cargarContexto(p: Programacion): Promise<Contexto> {
  // Both models are paranoid: an archived report and a disabled account are
  // simply not found, which is exactly the answer wanted.
  const [informe, dueno, filas] = await Promise.all([
    ReporteVistaModel.findByPk(p.id_reporte, { attributes: ["name", "config"] }),
    UsuarioModel.findByPk(p.id_usuario, {
      attributes: ["name", "lastname", "user", "email", "email_verified_at", "id_rol"],
    }),
    ReporteProgramacionDestinatarioModel.findAll({
      where: { id_programacion: p.id },
      order: [["id", "ASC"]],
    }),
  ]);

  const idsDeUsuario = filas.map((f) => f.dataValues.id_usuario).filter((id): id is number => typeof id === "number");
  const cuentas = idsDeUsuario.length
    ? await UsuarioModel.findAll({
        where: { id: idsDeUsuario },
        // The name is for the history row of this run, which keeps it as it
        // reads now. It goes nowhere else.
        attributes: ["id", "name", "lastname", "email", "email_verified_at", "id_rol"],
      })
    : [];
  const cuentaPorId = new Map(cuentas.map((c) => [c.dataValues.id, c.dataValues]));

  const destinatarios: Destinatario[] = [];
  for (const fila of filas) {
    const f = fila.dataValues;
    if (typeof f.id_usuario === "number") {
      const cuenta = cuentaPorId.get(f.id_usuario);
      // A recipient account that is gone, or has no verified address, cannot
      // be written to. It is left out of this run and stays on the schedule:
      // verifying an address later brings it back without anybody re-adding it.
      if (!cuenta?.email || !cuenta.email_verified_at) continue;
      destinatarios.push({
        id: f.id,
        nombre: nombreParaElHistorial(cuenta),
        id_usuario: f.id_usuario,
        email: cuenta.email,
        externo: false,
        staff: await can(cuenta.id_rol, "seguridad", "ver"),
        rechazos_seguidos: f.rechazos_seguidos,
        deBaja: false,
      });
    } else if (f.email) {
      destinatarios.push({
        id: f.id,
        // An outside address has no name but itself.
        nombre: f.email,
        email: f.email,
        externo: true,
        staff: false,
        rechazos_seguidos: f.rechazos_seguidos,
        deBaja: f.baja_at !== null && f.baja_at !== undefined,
      });
    }
  }

  const d = dueno?.dataValues;
  return {
    informe: informe
      ? { nombre: informe.dataValues.name, config: informe.dataValues.config as unknown as ReportConfig }
      : null,
    dueno: d
      ? {
          nombre: nombreCompleto(d),
          email: d.email && d.email_verified_at ? d.email : null,
          role: d.id_rol,
          staff: await can(d.id_rol, "seguridad", "ver"),
          puedeProgramar: await can(d.id_rol, PERMISO_PARA_PROGRAMAR.modulo, PERMISO_PARA_PROGRAMAR.accion),
        }
      : null,
    destinatarios,
  };
}

/** Claims a run by inserting its row. `null` when it is already taken. */
async function reclamar(id_programacion: number, turno: Date, manual: boolean): Promise<number | null> {
  try {
    const fila = await ReporteEjecucionModel.create({ id_programacion, programada_para: turno, manual });
    return fila.dataValues.id;
  } catch (e) {
    // The unique key on (schedule, moment due) is the lock: losing the race
    // is the expected way of finding out somebody else has this run.
    if (e instanceof UniqueConstraintError) return null;
    throw e;
  }
}

/**
 * Everything `run.ts` needs, for real.
 *
 * `enlaceDeBaja` is handed in rather than built here: the link's shape belongs
 * to the unsubscribe route, and this file must not know a URL.
 */
export function dependenciasReales(opciones: {
  enlaceDeBaja: (id_destinatario: number) => Promise<string | null>;
}): Dependencias {
  return {
    ahora: () => new Date(),
    cargarContexto,
    podar: (config, viewer) => pruneConfig(config, viewer).config,
    exportadorOcupado: () => exportSlot.isBusy,
    exportar: (peticion) => exportSlot.run(() => buildExport({ ...peticion, scope: "all" })),
    reclamar,
    async liberar(id_ejecucion) {
      await ReporteEjecucionModel.destroy({ where: { id: id_ejecucion, estado: "en_curso" } });
    },
    async cerrar(id_ejecucion, cierre) {
      await ReporteEjecucionModel.update(
        { ...cierre, terminada_at: new Date() },
        { where: { id: id_ejecucion } },
      );
    },
    async enviadosHoy() {
      const desde = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const total = await ReporteEjecucionModel.sum("enviados", { where: { iniciada_at: { [Op.gt]: desde } } });
      return Number(total ?? 0);
    },
    enviar: (correo, o) => enviarCorreo(correo, o),
    async anotarEntrega(id_destinatario, resultado) {
      if (resultado === "entregado") {
        await ReporteProgramacionDestinatarioModel.update(
          { rechazos_seguidos: 0 },
          { where: { id: id_destinatario, rechazos_seguidos: { [Op.gt]: 0 } } },
        );
      } else {
        await ReporteProgramacionDestinatarioModel.increment("rechazos_seguidos", {
          by: 1,
          where: { id: id_destinatario },
        });
      }
    },
    async anotarEntregaDeEjecucion(id_ejecucion, { destinatario: d, resultado }) {
      // An account is kept by its id and its name and **never its address**; an
      // outside address is kept as it was, since it is the only thing it has.
      await ReporteEntregaModel.create({
        id_ejecucion,
        tipo: d.externo ? "externo" : "usuario",
        id_usuario: d.externo ? null : (d.id_usuario ?? null),
        // Cut to the column, not refused by it: a name past 255 characters would
        // fail the insert and lose the row, and a history row is not worth that.
        correo: d.externo ? d.email.slice(0, ANCHO_DE_COLUMNA) : null,
        nombre: d.nombre.slice(0, ANCHO_DE_COLUMNA),
        resultado,
      });
    },
    enlaceDeBaja: opciones.enlaceDeBaja,
    async reprogramar(id_programacion, cambios) {
      await ReporteProgramacionModel.update(cambios, { where: { id: id_programacion } });
    },
    registrar: (nivel, datos, mensaje) => scheduleLog[nivel](datos, mensaje),
  };
}

/** Everything `scheduler.ts` needs, for real, on top of the run's own. */
export function dependenciasDelProgramadorReales(deps: Dependencias): DependenciasDelProgramador {
  return {
    ahora: deps.ahora,
    async vencidas(ahora): Promise<Vencida[]> {
      const filas = await ReporteProgramacionModel.findAll({
        where: { activa: true, proxima_ejecucion: { [Op.lte]: ahora } },
        order: [["proxima_ejecucion", "ASC"], ["id", "ASC"]],
        limit: MAXIMO_POR_TIC,
      });
      return filas.map((f) => ({
        programacion: aProgramacion(f.dataValues),
        turno: f.dataValues.proxima_ejecucion as Date,
      }));
    },
    ejecutar: (p, turno) => ejecutarTurno(deps, p, turno),
    async omitir(p, turno, proxima) {
      // One transaction: a skipped run with no next run would be found due
      // again on the following tick and "skipped" a second time into the key.
      await sequelize.transaction(async (transaction) => {
        const ahora = new Date();
        await ReporteEjecucionModel.findOrCreate({
          where: { id_programacion: p.id, programada_para: turno },
          defaults: {
            id_programacion: p.id,
            programada_para: turno,
            estado: "omitido",
            terminada_at: ahora,
            detalle: "El servidor no estaba disponible cuando tocaba y ya era tarde para enviarlo.",
          },
          transaction,
        });
        await ReporteProgramacionModel.update(
          { proxima_ejecucion: proxima },
          { where: { id: p.id }, transaction },
        );
      });
    },
    async cerrarAbandonadas(antesDe) {
      // Who got it was written as each send finished, so the counts of a run
      // that died half way are what those rows say: delivered is `enviados`,
      // the other three results are `no_enviados`. Left alone they would read
      // «0 de 0» over a list of «Entregado».
      const contar = (condicion: string) =>
        sequelize.literal(
          `(SELECT count(*) FROM reporte_ejecucion_entregas WHERE id_ejecucion = reporte_ejecuciones.id AND resultado ${condicion})`,
        );
      const [cuantas] = await ReporteEjecucionModel.update(
        {
          estado: "fallido",
          terminada_at: new Date(),
          detalle: "Interrumpida: el servidor se detuvo mientras se enviaba.",
          enviados: contar("= 'entregado'"),
          no_enviados: contar("<> 'entregado'"),
        },
        { where: { estado: "en_curso", iniciada_at: { [Op.lt]: antesDe } } },
      );
      return cuantas;
    },
    registrar: deps.registrar,
  };
}
