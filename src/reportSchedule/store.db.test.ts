// The scheduled reports against a real PostgreSQL: the database layer
// (`store.ts`), the unsubscribe functions, the real exporter, and the
// migrations that create what they use. Everything else in this folder is
// tested with fakes; this is what proves the fakes describe the real thing.
//
// **It runs only against a throwaway database, and never by accident.** It
// writes accounts, permissions and schedules, and the database the rest of the
// suite reads is a copy of production shared by every session working in this
// tree. So it asks for a database called exactly `probe_informes` and is
// skipped — loudly — anywhere else, the Docker build included.
//
// To run it:
//
//   docker run -d --name osefi-informes -e POSTGRES_PASSWORD=probe \
//     -e POSTGRES_DB=probe_informes -p 127.0.0.1:55433:5432 postgres:17
//   PG_DATABASE=probe_informes PG_USER=postgres PG_PASS=probe PG_IP=127.0.0.1 \
//     PG_PORT=55433 CORS_ORIGIN=https://www.osefi.net \
//     npx vitest run src/reportSchedule/store.db.test.ts
//   docker rm -f osefi-informes
//
// The schema is built from the models (`sync`), and then the three tables of
// the scheduled reports are dropped and created again by their own migration,
// so what is exercised is the migrated shape, CHECK constraints included.
//
// No mail leaves: `enviar` is replaced by a recorder. `mailer.ts` refuses
// under the test runner anyway; this is so the test can read what would go.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sequelize } from "../database/sequelize.js";
import type { CorreoAEnviar, ResultadoDeCorreo } from "../auth/mailer.js";
import { invalidatePermissions } from "../permissions/store.js";
import { RECHAZOS_PARA_DEJAR } from "./limits.js";
import { tic } from "./scheduler.js";
import { dependenciasDelProgramadorReales, dependenciasReales } from "./store.js";
import { consultarBaja, darDeBaja, enlaceDeBaja } from "./unsubscribe.js";

const habilitado = process.env.PG_DATABASE === "probe_informes";

const fila = async <T = Record<string, unknown>>(sql: string): Promise<T> =>
  ((await sequelize.query(sql))[0] as T[])[0];
const filas = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => (await sequelize.query(sql))[0] as T[];
const sql = (texto: string) => sequelize.query(texto);

interface Recibido {
  para: string;
  adjunto: string | null;
  texto: string;
}
const buzon: Recibido[] = [];
let respuesta: (para: string) => ResultadoDeCorreo = () => ({ ok: true });
const vaciar = () => buzon.splice(0, buzon.length);

const reales = dependenciasReales({ enlaceDeBaja });
const programador = dependenciasDelProgramadorReales({
  ...reales,
  enviar: async (correo: CorreoAEnviar) => {
    buzon.push({ para: correo.para, adjunto: correo.adjuntos?.[0]?.nombre ?? null, texto: correo.texto });
    return respuesta(correo.para);
  },
});

/** An account that nothing refers to, so that it can be removed. */
const usuarioSinHistorial = (id: number) =>
  sql(
    `INSERT INTO usuarios (id, name, lastname, birthday, image, phone, "user", pass, id_rol, pass_changed_at, "createdAt", "updatedAt")
     VALUES (${id}, 'Nombre${id}', 'Apellido${id}', now(), '', '', 'u${id}', 'x', 3, now(), now(), now())`,
  );

/** Make a schedule due `haceSegundos` ago. */
const vencer = (id: number, haceSegundos = 1) =>
  sql(`UPDATE reporte_programaciones SET proxima_ejecucion = now() - interval '${haceSegundos} seconds' WHERE id = ${id}`);
const programar = (id: number, id_reporte: number) =>
  sql(
    `INSERT INTO reporte_programaciones (id, id_reporte, id_usuario, frecuencia, hora, minuto, formato, activa, proxima_ejecucion)
     VALUES (${id}, ${id_reporte}, 1, 'diaria', 7, 20, 'excel', true, now() - interval '1 minute')`,
  );

beforeAll(async () => {
  if (!habilitado) {
    console.warn(
      "\n  !! store.db: sin la base desechable `probe_informes`. Nada comprueba la capa de base de datos\n" +
        "     de los informes programados contra PostgreSQL. Ver la cabecera del fichero para ejecutarlo.\n",
    );
    return;
  }
  // Belt and braces: the variable was read above, the connection is asked here.
  const { db } = await fila<{ db: string }>("SELECT current_database() AS db");
  if (db !== "probe_informes") throw new Error(`store.db: conectado a "${db}", no a la base desechable`);

  const carpeta = fileURLToPath(new URL("../models/", import.meta.url));
  for (const f of readdirSync(carpeta).filter((n) => n.endsWith(".model.ts"))) await import(`../models/${f}`);
  await sequelize.sync({ force: true });
  await sql("DROP TABLE IF EXISTS reporte_ejecucion_entregas, reporte_ejecuciones, reporte_programacion_destinatarios, reporte_programaciones CASCADE");
  const tablas = await import("../migrations/20261010000001-create-reporte-programaciones.js");
  await tablas.up({ context: sequelize.getQueryInterface() });
  const minuto = await import("../migrations/20261010000004-add-minuto-to-reporte-programaciones.js");
  await minuto.up({ context: sequelize.getQueryInterface() });
  const entregas = await import("../migrations/20261010000007-create-reporte-ejecucion-entregas.js");
  await entregas.up({ context: sequelize.getQueryInterface() });

  await sql(`INSERT INTO rols (id, name, description, "createdAt", "updatedAt") VALUES (1,'Administrador','a',now(),now()), (3,'Cliente','c',now(),now())`);
  await sql(`INSERT INTO permisos (id_rol, modulo, accion, permitido, "createdAt", "updatedAt") VALUES (1,'seguridad','ver',true,now(),now())`);
  // The permission itself comes from its migration: one row per role, granted to role 1 alone.
  const permiso = await import("../migrations/20261010000002-add-generador-programar.js");
  await permiso.up({ context: sequelize.getQueryInterface() });
  invalidatePermissions();

  const usuario = (id: number, rol: number, email: string | null) =>
    sql(
      `INSERT INTO usuarios (id, name, lastname, birthday, image, phone, "user", pass, id_rol, email, email_verified_at, pass_changed_at, "createdAt", "updatedAt")
       VALUES (${id}, 'Nombre${id}', 'Apellido${id}', now(), '', '', 'u${id}', 'x', ${rol}, ${email ? `'${email}'` : "NULL"}, ${email ? "now()" : "NULL"}, now(), now(), now())`,
    );
  await usuario(1, 1, "ana@osefi.net");
  await usuario(2, 3, "beto@osefi.net");
  await usuario(3, 3, null);
  await usuario(4, 1, "jefa@osefi.net");
  await sql(`INSERT INTO ciudads (name, lat, lng, image, "createdAt", "updatedAt") VALUES ('Cochabamba', -17.39, -66.15, '', now(), now()), ('La Paz', -16.5, -68.15, '', now(), now())`);
  await sql(
    `INSERT INTO reporte_vistas (id, name, config, id_usuario, visibility, favorite, "createdAt", "updatedAt") VALUES
       (1, 'Ciudades <b>de prueba</b>', '{"root":"ciudad","columns":[{"path":"name"}]}', 1, 'private', false, now(), now()),
       (2, 'Informe roto', '{"root":"ciudad","columns":[{"path":"no_existe"}]}', 1, 'private', false, now(), now())`,
  );
  await programar(1, 1);
  await sql(
    `INSERT INTO reporte_programacion_destinatarios (id, id_programacion, id_usuario, email) VALUES
       (1, 1, 2, NULL), (2, 1, 3, NULL), (3, 1, NULL, 'cliente@fuera.com'), (4, 1, 4, NULL)`,
  );
}, 60_000);

afterAll(async () => {
  if (habilitado) await sequelize.close();
});

// One story told in order: each step starts from what the one before left.
describe.skipIf(!habilitado).sequential("the scheduled reports against PostgreSQL", () => {
  it("seeds the permission for the Administrador alone", async () => {
    const { celdas } = await fila<{ celdas: string }>(
      `SELECT string_agg(id_rol || '=' || permitido, ' ' ORDER BY id_rol) AS celdas FROM permisos WHERE modulo = 'generador' AND accion = 'programar'`,
    );
    expect(celdas).toBe("1=true 3=false");
  });

  it("runs a due schedule: builds the file, writes to who can be written to, closes the run and moves on", async () => {
    expect(await tic(programador)).toEqual({ ejecutadas: 1, omitidas: 0, ocupado: false, errores: 0 });

    // The account with no verified address is left out.
    expect(buzon.map((b) => b.para).sort()).toEqual(["beto@osefi.net", "cliente@fuera.com", "jefa@osefi.net"]);
    expect(buzon.every((b) => b.adjunto?.endsWith(".xlsx"))).toBe(true);
    // Only the outside address is offered the way out.
    expect(buzon.filter((b) => /baja-informe#t=/.test(b.texto)).map((b) => b.para)).toEqual(["cliente@fuera.com"]);

    const e = await fila(`SELECT estado, enviados, no_enviados, manual, filas, bytes IS NOT NULL AS con_bytes, terminada_at IS NOT NULL AS cerrada FROM reporte_ejecuciones WHERE id_programacion = 1`);
    expect(e).toEqual({ estado: "enviado", enviados: 3, no_enviados: 0, manual: false, filas: 2, con_bytes: true, cerrada: true });

    const p = await fila(`SELECT activa, fallos_seguidos, proxima_ejecucion > now() AS futura, to_char(proxima_ejecucion AT TIME ZONE 'America/La_Paz', 'HH24:MI') AS hora FROM reporte_programaciones WHERE id = 1`);
    expect(p).toEqual({ activa: true, fallos_seguidos: 0, futura: true, hora: "07:20" });
    expect(await reales.enviadosHoy()).toBe(3);

    // Who it was for, copied as it read at that moment: an account by name and
    // never by address, an outside address by itself.
    const entregas = await filas<{ tipo: string; id_usuario: number | null; correo: string | null; nombre: string; resultado: string }>(
      `SELECT tipo, id_usuario, correo, nombre, resultado FROM reporte_ejecucion_entregas ORDER BY id`,
    );
    expect(entregas).toEqual([
      { tipo: "usuario", id_usuario: 2, correo: null, nombre: "Nombre2 Apellido2", resultado: "entregado" },
      { tipo: "externo", id_usuario: null, correo: "cliente@fuera.com", nombre: "cliente@fuera.com", resultado: "entregado" },
      { tipo: "usuario", id_usuario: 4, correo: null, nombre: "Nombre4 Apellido4", resultado: "entregado" },
    ]);
    expect(JSON.stringify(entregas)).not.toMatch(/@osefi\.net/);
  });

  it("finds nothing due right after", async () => {
    vaciar();
    expect(await tic(programador)).toEqual({ ejecutadas: 0, omitidas: 0, ocupado: false, errores: 0 });
    expect(buzon).toHaveLength(0);
  });

  it("does not send a run twice: the same moment again is already claimed, and the schedule still moves on", async () => {
    const { programada_para } = await fila<{ programada_para: Date }>(`SELECT programada_para FROM reporte_ejecuciones WHERE id_programacion = 1`);
    await sequelize.query(`UPDATE reporte_programaciones SET proxima_ejecucion = :t WHERE id = 1`, { replacements: { t: programada_para } });

    expect(await tic(programador)).toEqual({ ejecutadas: 0, omitidas: 0, ocupado: false, errores: 0 });
    expect(buzon).toHaveLength(0);
    expect((await fila<{ futura: boolean }>(`SELECT proxima_ejecucion > now() AS futura FROM reporte_programaciones WHERE id = 1`)).futura).toBe(true);
    expect((await fila<{ n: number }>(`SELECT count(*)::int AS n FROM reporte_ejecuciones WHERE id_programacion = 1`)).n).toBe(1);
  });

  it("stops writing to an address after it was refused enough times in a row", async () => {
    respuesta = (para) => (para === "cliente@fuera.com" ? { ok: false, motivo: "destinatario" } : { ok: true });
    for (let i = 0; i < RECHAZOS_PARA_DEJAR; i++) {
      await vencer(1, i + 1);
      await tic(programador);
    }
    expect((await fila<{ rechazos_seguidos: number }>(`SELECT rechazos_seguidos FROM reporte_programacion_destinatarios WHERE id = 3`)).rechazos_seguidos).toBe(RECHAZOS_PARA_DEJAR);

    respuesta = () => ({ ok: true });
    vaciar();
    await vencer(1, 9);
    await tic(programador);
    expect(buzon.map((b) => b.para).sort()).toEqual(["beto@osefi.net", "jefa@osefi.net"]);
  });

  it("records a run that is more than a day late as skipped, and sends nothing", async () => {
    await sql(`UPDATE reporte_programaciones SET proxima_ejecucion = now() - interval '25 hours' WHERE id = 1`);
    vaciar();
    expect(await tic(programador)).toEqual({ ejecutadas: 0, omitidas: 1, ocupado: false, errores: 0 });
    expect(buzon).toHaveLength(0);
    expect((await fila<{ estado: string }>(`SELECT estado FROM reporte_ejecuciones WHERE id_programacion = 1 ORDER BY programada_para ASC LIMIT 1`)).estado).toBe("omitido");
    expect((await fila<{ futura: boolean }>(`SELECT proxima_ejecucion > now() AS futura FROM reporte_programaciones WHERE id = 1`)).futura).toBe(true);
  });

  it("closes a run that was claimed and never finished", async () => {
    await sql(`INSERT INTO reporte_ejecuciones (id_programacion, programada_para, estado, iniciada_at) VALUES (1, now() - interval '3 hours', 'en_curso', now() - interval '2 hours')`);
    await tic(programador);
    const e = await fila(`SELECT estado, terminada_at IS NOT NULL AS cerrada FROM reporte_ejecuciones WHERE programada_para < now() - interval '2 hours' AND programada_para > now() - interval '4 hours'`);
    expect(e).toEqual({ estado: "fallido", cerrada: true });
  });

  it("pauses a schedule whose report cannot be built, on the third failure, telling its owner each time", async () => {
    await programar(2, 2);
    await sql(`INSERT INTO reporte_programacion_destinatarios (id, id_programacion, id_usuario) VALUES (10, 2, 2)`);
    vaciar();
    for (let i = 0; i < 3; i++) {
      await tic(programador);
      await sql(`UPDATE reporte_programaciones SET proxima_ejecucion = now() - interval '${i + 1} seconds' WHERE id = 2 AND activa`);
    }
    // The table's CHECK holds: paused, and so with no next run.
    expect(await fila(`SELECT activa, motivo_pausa, fallos_seguidos, proxima_ejecucion FROM reporte_programaciones WHERE id = 2`))
      .toEqual({ activa: false, motivo_pausa: "fallos", fallos_seguidos: 3, proxima_ejecucion: null });
    expect(buzon.map((b) => b.para)).toEqual(["ana@osefi.net", "ana@osefi.net", "ana@osefi.net"]);
    expect(buzon.at(-1)?.texto).toMatch(/queda en pausa/);
    expect((await fila<{ n: number }>(`SELECT count(*)::int AS n FROM reporte_ejecuciones WHERE id_programacion = 2 AND estado = 'fallido'`)).n).toBe(3);
  });

  it("gives an outside address one stable link, and stops writing to it once it is used", async () => {
    await programar(3, 1);
    await sql(`INSERT INTO reporte_programacion_destinatarios (id, id_programacion, id_usuario, email) VALUES (20, 3, 2, NULL), (21, 3, NULL, 'baja@fuera.com')`);
    vaciar();
    await tic(programador);

    const enlace = buzon.find((b) => b.para === "baja@fuera.com")?.texto.match(/https?:\/\/\S+baja-informe#t=[A-Za-z0-9_-]{43}/)?.[0];
    expect(enlace).toBeTruthy();
    expect(buzon.find((b) => b.para === "beto@osefi.net")?.texto).not.toMatch(/baja-informe/);
    expect(await enlaceDeBaja(21)).toBe(enlace);
    expect(await enlaceDeBaja(20)).toBeNull();

    const token = (enlace as string).split("#t=")[1];
    expect(await consultarBaja(token)).toEqual({ informe: "Ciudades <b>de prueba</b>", programadoPor: "Nombre1 Apellido1", deBaja: false });
    expect([await consultarBaja("B".repeat(43)), await darDeBaja("B".repeat(43))]).toEqual([null, false]);
    expect(await darDeBaja(token)).toBe(true);
    expect(await darDeBaja(token)).toBe(true);
    expect((await consultarBaja(token))?.deBaja).toBe(true);

    await vencer(3);
    vaciar();
    await tic(programador);
    expect(buzon.map((b) => b.para)).toEqual(["beto@osefi.net"]);
  });

  it("pauses a schedule whose report was archived, without sending", async () => {
    await sql(`UPDATE reporte_vistas SET "deletedAt" = now() WHERE id = 1`);
    await vencer(1);
    await sql(`UPDATE reporte_programaciones SET activa = false, proxima_ejecucion = NULL WHERE id = 3`);
    vaciar();
    await tic(programador);
    expect(await fila(`SELECT activa, motivo_pausa, proxima_ejecucion FROM reporte_programaciones WHERE id = 1`))
      .toEqual({ activa: false, motivo_pausa: "informe_archivado", proxima_ejecucion: null });
    expect(buzon).toHaveLength(0);
  });

  it("pauses a schedule whose owner lost the permission", async () => {
    await sql(`UPDATE reporte_vistas SET "deletedAt" = NULL WHERE id = 1`);
    await sql(`UPDATE reporte_programaciones SET activa = true, motivo_pausa = NULL, proxima_ejecucion = now() - interval '1 second' WHERE id = 1`);
    await sql(`UPDATE permisos SET permitido = false WHERE id_rol = 1 AND modulo = 'generador' AND accion = 'programar'`);
    invalidatePermissions();
    await tic(programador);
    expect(await fila(`SELECT activa, motivo_pausa FROM reporte_programaciones WHERE id = 1`)).toEqual({ activa: false, motivo_pausa: "sin_permiso" });
  });

  describe("the record of who each run was sent to", () => {
    it("goes with its run when the run is deleted", async () => {
      await sql(`INSERT INTO reporte_ejecuciones (id, id_programacion, programada_para, estado) VALUES (9001, 1, now() - interval '9 days', 'en_curso')`);
      await sql(`INSERT INTO reporte_ejecucion_entregas (id_ejecucion, tipo, id_usuario, nombre, resultado) VALUES (9001, 'usuario', 2, 'Nombre2 Apellido2', 'entregado')`);
      await reales.liberar(9001);
      expect((await fila<{ n: number }>(`SELECT count(*)::int AS n FROM reporte_ejecucion_entregas WHERE id_ejecucion = 9001`)).n).toBe(0);
    });

    it("gives a run that died half way the counts its rows say, when it is closed", async () => {
      await sql(`INSERT INTO reporte_ejecuciones (id, id_programacion, programada_para, estado, iniciada_at) VALUES (9003, 1, now() - interval '7 days', 'en_curso', now() - interval '7 days')`);
      await sql(
        `INSERT INTO reporte_ejecucion_entregas (id_ejecucion, tipo, id_usuario, nombre, resultado) VALUES
           (9003, 'usuario', 2, 'Nombre2 Apellido2', 'entregado'),
           (9003, 'usuario', 4, 'Nombre4 Apellido4', 'entregado'),
           (9003, 'usuario', 2, 'Nombre2 Apellido2', 'rechazado'),
           (9003, 'usuario', 4, 'Nombre4 Apellido4', 'sin_cupo')`,
      );
      await programador.cerrarAbandonadas(new Date());
      expect(await fila(`SELECT estado, enviados, no_enviados, detalle FROM reporte_ejecuciones WHERE id = 9003`))
        .toEqual({ estado: "fallido", enviados: 2, no_enviados: 2, detalle: "Interrumpida: el servidor se detuvo mientras se enviaba." });
    });

    it("leaves a dead run that recorded nobody at 0 of 0", async () => {
      await sql(`INSERT INTO reporte_ejecuciones (id, id_programacion, programada_para, estado, iniciada_at) VALUES (9004, 1, now() - interval '6 days', 'en_curso', now() - interval '6 days')`);
      await programador.cerrarAbandonadas(new Date());
      expect(await fila(`SELECT estado, enviados, no_enviados FROM reporte_ejecuciones WHERE id = 9004`))
        .toEqual({ estado: "fallido", enviados: 0, no_enviados: 0 });
    });

    it("outlives an account that is removed, and still reads: the kind decides what it is, not the emptied column", async () => {
      await usuarioSinHistorial(9);
      await sql(`INSERT INTO reporte_ejecuciones (id, id_programacion, programada_para, estado) VALUES (9002, 1, now() - interval '8 days', 'enviado')`);
      await sql(`INSERT INTO reporte_ejecucion_entregas (id_ejecucion, tipo, id_usuario, nombre, resultado) VALUES (9002, 'usuario', 9, 'Nombre9 Apellido9', 'rechazado')`);
      await sql(`DELETE FROM usuarios WHERE id = 9`);
      expect(await fila(`SELECT tipo, id_usuario, correo, nombre, resultado FROM reporte_ejecucion_entregas WHERE id_ejecucion = 9002`))
        .toEqual({ tipo: "usuario", id_usuario: null, correo: null, nombre: "Nombre9 Apellido9", resultado: "rechazado" });
    });

    it("refuses a row that mixes the kinds, and a word outside the vocabulary", async () => {
      const insertar = (valores: string) =>
        sql(`INSERT INTO reporte_ejecucion_entregas (id_ejecucion, tipo, id_usuario, correo, nombre, resultado) VALUES (9002, ${valores})`);
      await expect(insertar(`'externo', 2, 'a@fuera.com', 'a@fuera.com', 'entregado'`)).rejects.toThrow();
      await expect(insertar(`'externo', NULL, NULL, 'a@fuera.com', 'quizá'`)).rejects.toThrow();
      await expect(insertar(`'usuario', 2, 'a@fuera.com', 'Nombre2', 'entregado'`)).rejects.toThrow();
      await expect(insertar(`'otro', NULL, NULL, 'x', 'entregado'`)).rejects.toThrow();
    });
  });
});
