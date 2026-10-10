// The rules of one scheduled run, with everything outside it faked. No
// database, no exporter, no mail: `store.ts` is tested on its own.

import { describe, it, expect, vi } from "vitest";
import { MAIL_ADJUNTOS_MAX_BYTES } from "../config/security.js";
import type { CorreoAEnviar, ResultadoDeCorreo } from "../auth/mailer.js";
import type { ExportOutput } from "../reportBuilder/export/index.js";
import type { ReportConfig } from "../reportBuilder/types.js";
import { FALLOS_PARA_PAUSAR, MAX_CORREOS_DE_INFORMES_AL_DIA, RECHAZOS_PARA_DEJAR } from "./limits.js";
import {
  ejecutarTurno,
  type CierreDeEjecucion,
  type Contexto,
  type Dependencias,
  type Destinatario,
  type Programacion,
} from "./run.js";

const TURNO = new Date("2026-03-16T11:00:00Z"); // Monday 16 March, 07:00 in La Paz.
const AHORA = new Date("2026-03-16T11:00:30Z");

const PROGRAMACION: Programacion = {
  id: 7,
  id_reporte: 3,
  id_usuario: 1,
  frecuencia: "semanal",
  dia_semana: 1,
  dia_mes: null,
  hora: 7,
  formato: "excel",
  con_fotos: false,
  fallos_seguidos: 0,
};

const CONFIG = { root: "evento", columns: [{ path: "description" }] } as ReportConfig;

const dest = (over: Partial<Destinatario> & { id: number; email: string }): Destinatario => ({
  externo: false,
  staff: false,
  rechazos_seguidos: 0,
  deBaja: false,
  ...over,
});

const fichero = (rows = 12, bytes = 2048): ExportOutput => ({
  filename: "Informe semanal.xlsx",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: Buffer.alloc(bytes),
  rows,
  photos: null,
});

function contexto(over: Partial<Contexto> = {}): Contexto {
  return {
    informe: { nombre: "Informe semanal", config: CONFIG },
    dueno: { nombre: "Ana Pérez", email: "ana@osefi.net", role: 1, staff: true, puedeProgramar: true },
    destinatarios: [dest({ id: 1, email: "beto@osefi.net" })],
    ...over,
  };
}

/** Fake dependencies that record everything, with the pieces a test wants replaced. */
function falsas(over: Partial<Dependencias> & { ctx?: Contexto } = {}) {
  const { ctx = contexto(), ...resto } = over;
  const enviados: { correo: CorreoAEnviar; plazo_ms: number }[] = [];
  const cierres: { id: number; cierre: CierreDeEjecucion }[] = [];
  const deps = {
    ahora: () => AHORA,
    cargarContexto: vi.fn(async () => ctx),
    podar: vi.fn((config: ReportConfig) => config),
    exportadorOcupado: vi.fn(() => false),
    exportar: vi.fn(async () => fichero()),
    reclamar: vi.fn(async () => 100 as number | null),
    liberar: vi.fn(async () => undefined),
    cerrar: vi.fn(async (id: number, cierre: CierreDeEjecucion) => {
      cierres.push({ id, cierre });
    }),
    enviadosHoy: vi.fn(async () => 0),
    enviar: vi.fn(async (correo: CorreoAEnviar, o: { plazo_ms: number }): Promise<ResultadoDeCorreo> => {
      enviados.push({ correo, plazo_ms: o.plazo_ms });
      return { ok: true, proveedor: "resend", id: "x" };
    }),
    anotarEntrega: vi.fn(async () => undefined),
    enlaceDeBaja: vi.fn(async (id: number) => `https://www.osefi.net/baja/token-${id}`),
    reprogramar: vi.fn(async () => undefined),
    registrar: vi.fn(),
    ...resto,
  } satisfies Dependencias;
  return { deps, enviados, cierres };
}

describe("a run that goes well", () => {
  it("sends the file to the recipient, closes the run as sent and schedules the next one", async () => {
    const { deps, enviados, cierres } = falsas();
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toEqual({ tipo: "ejecutado", estado: "enviado", enviados: 1, no_enviados: 0 });
    expect(deps.reclamar).toHaveBeenCalledWith(7, TURNO, false);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].correo).toMatchObject({
      para: "beto@osefi.net",
      flujo: "informe/programado",
      adjuntos: [{ nombre: "Informe semanal.xlsx" }],
    });
    expect(cierres).toEqual([
      { id: 100, cierre: { estado: "enviado", filas: 12, bytes: 2048, enviados: 1, no_enviados: 0, detalle: null } },
    ]);
    // Next Monday, 07:00 in La Paz.
    expect(deps.reprogramar).toHaveBeenCalledWith(7, {
      proxima_ejecucion: new Date("2026-03-23T11:00:00Z"),
      fallos_seguidos: 0,
      activa: true,
      motivo_pausa: null,
    });
    expect(deps.anotarEntrega).toHaveBeenCalledWith(1, "entregado");
  });

  it("asks the exporter for the saved report under its own name, format and photo choice", async () => {
    const { deps } = falsas();
    await ejecutarTurno(deps, { ...PROGRAMACION, formato: "pdf", con_fotos: true }, TURNO);
    expect(deps.exportar).toHaveBeenCalledWith(
      expect.objectContaining({ format: "pdf", title: "Informe semanal", photos: true, config: CONFIG }),
    );
  });

  it("clears a count of earlier failures", async () => {
    const { deps } = falsas();
    await ejecutarTurno(deps, { ...PROGRAMACION, fallos_seguidos: 2 }, TURNO);
    expect(deps.reprogramar).toHaveBeenCalledWith(7, expect.objectContaining({ fallos_seguidos: 0, activa: true }));
  });
});

describe("a report with nothing to attach", () => {
  it("sends a short notice without a file when the report has no rows", async () => {
    const { deps, enviados, cierres } = falsas({ exportar: vi.fn(async () => fichero(0, 900)) });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toMatchObject({ estado: "vacio", enviados: 1 });
    expect(enviados[0].correo.adjuntos).toBeUndefined();
    expect(enviados[0].correo.texto).toMatch(/no tiene resultados/);
    expect(cierres[0].cierre).toMatchObject({ estado: "vacio", filas: 0, bytes: null });
  });

  it("sends a notice without the file when it is over what a message can carry", async () => {
    const { deps, enviados, cierres } = falsas({
      exportar: vi.fn(async () => fichero(5000, MAIL_ADJUNTOS_MAX_BYTES + 1)),
    });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toMatchObject({ estado: "demasiado_grande", enviados: 1 });
    expect(enviados[0].correo.adjuntos).toBeUndefined();
    expect(enviados[0].correo.texto).toMatch(/pesa más de lo que cabe/);
    expect(cierres[0].cierre).toMatchObject({ estado: "demasiado_grande", filas: 5000 });
  });

  it("attaches a file that is exactly at the ceiling", async () => {
    const { deps, enviados } = falsas({ exportar: vi.fn(async () => fichero(10, MAIL_ADJUNTOS_MAX_BYTES)) });
    await ejecutarTurno(deps, PROGRAMACION, TURNO);
    expect(enviados[0].correo.adjuntos).toHaveLength(1);
  });

  it("treats the exporter's own two size refusals the same way, and is not a failure", async () => {
    for (const [name, extra, filas] of [
      ["ExportTooLargeError", { rows: 30000 }, 30000],
      ["ExportTooHeavyError", { bytes: 40_000_000 }, null],
    ] as const) {
      const { deps, enviados, cierres } = falsas({
        exportar: vi.fn(async () => {
          throw Object.assign(new Error("demasiado"), { name, ...extra });
        }),
      });
      const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);
      expect(r, name).toMatchObject({ estado: "demasiado_grande", enviados: 1 });
      expect(enviados[0].correo.adjuntos).toBeUndefined();
      expect(cierres[0].cierre.filas).toBe(filas);
      expect(deps.reprogramar).toHaveBeenCalledWith(7, expect.objectContaining({ fallos_seguidos: 0 }));
    }
  });
});

describe("who receives staff data", () => {
  const jefa = dest({ id: 1, email: "jefa@osefi.net", staff: true });
  const tecnico = dest({ id: 2, email: "tecnico@osefi.net", staff: false });
  const cliente = dest({ id: 3, email: "cliente@fuera.com", externo: true, staff: true });

  it("builds two variants at most, and gives the full one only to accounts that may see it", async () => {
    const podar = vi.fn((config: ReportConfig, viewer: { staff: boolean }) => ({ ...config, _staff: viewer.staff }) as ReportConfig);
    const exportar = vi.fn(async (p: { viewer: { staff: boolean } }) => ({
      ...fichero(),
      filename: p.viewer.staff ? "completo.xlsx" : "recortado.xlsx",
    }));
    const { deps, enviados } = falsas({
      ctx: contexto({ destinatarios: [jefa, tecnico, cliente, dest({ id: 4, email: "otra@osefi.net", staff: true })] }),
      podar,
      exportar,
    });
    await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(exportar).toHaveBeenCalledTimes(2);
    expect(exportar.mock.calls.map((c) => c[0].viewer.staff).sort()).toEqual([false, true]);
    // Each variant was built from a configuration cut down for its reader.
    for (const [peticion] of exportar.mock.calls) {
      expect((peticion as unknown as { config: { _staff: boolean } }).config._staff).toBe(peticion.viewer.staff);
    }
    const recibido = Object.fromEntries(enviados.map((e) => [e.correo.para, e.correo.adjuntos?.[0].nombre]));
    expect(recibido).toEqual({
      "jefa@osefi.net": "completo.xlsx",
      "otra@osefi.net": "completo.xlsx",
      "tecnico@osefi.net": "recortado.xlsx",
      // An outside address never gets it, whatever its row says.
      "cliente@fuera.com": "recortado.xlsx",
    });
  });

  it("gives nobody the full variant when the owner may not see staff data either", async () => {
    const exportar = vi.fn(async (_p: { viewer: { role: number; staff: boolean } }) => fichero());
    const { deps } = falsas({
      ctx: contexto({
        dueno: { nombre: "Coordinador", email: null, role: 2, staff: false, puedeProgramar: true },
        destinatarios: [jefa, tecnico],
      }),
      exportar,
    });
    await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(exportar).toHaveBeenCalledTimes(1);
    expect(exportar.mock.calls[0][0].viewer).toEqual({ role: 2, staff: false });
  });

  it("builds a single variant when every reader is of one kind", async () => {
    const exportar = vi.fn(async () => fichero());
    const { deps } = falsas({ ctx: contexto({ destinatarios: [tecnico, cliente] }), exportar });
    await ejecutarTurno(deps, PROGRAMACION, TURNO);
    expect(exportar).toHaveBeenCalledTimes(1);
  });

  it("gives an outside address an unsubscribe link and an account none", async () => {
    const { deps, enviados } = falsas({ ctx: contexto({ destinatarios: [tecnico, cliente] }) });
    await ejecutarTurno(deps, PROGRAMACION, TURNO);

    const de = (para: string) => enviados.find((e) => e.correo.para === para)!.correo;
    expect(de("cliente@fuera.com").texto).toContain("https://www.osefi.net/baja/token-3");
    expect(de("cliente@fuera.com").html).toContain("https://www.osefi.net/baja/token-3");
    expect(de("tecnico@osefi.net").texto).not.toMatch(/dejar de recibirlo/);
    expect(deps.enlaceDeBaja).toHaveBeenCalledTimes(1);
    // …and both say who set the schedule up.
    expect(de("tecnico@osefi.net").texto).toContain("Ana Pérez");
  });
});

describe("which recipients are written to at all", () => {
  it("skips one that unsubscribed and one refused too many times in a row", async () => {
    const { deps, enviados } = falsas({
      ctx: contexto({
        destinatarios: [
          dest({ id: 1, email: "bien@osefi.net" }),
          dest({ id: 2, email: "baja@fuera.com", externo: true, deBaja: true }),
          dest({ id: 3, email: "rebota@fuera.com", externo: true, rechazos_seguidos: RECHAZOS_PARA_DEJAR }),
          dest({ id: 4, email: "casi@fuera.com", externo: true, rechazos_seguidos: RECHAZOS_PARA_DEJAR - 1 }),
        ],
      }),
    });
    await ejecutarTurno(deps, PROGRAMACION, TURNO);
    expect(enviados.map((e) => e.correo.para).sort()).toEqual(["bien@osefi.net", "casi@fuera.com"]);
  });

  it("counts a refused address against that address, and nothing else against anybody", async () => {
    const respuestas: Record<string, ResultadoDeCorreo> = {
      "rebota@fuera.com": { ok: false, motivo: "destinatario", proveedor: "resend" },
      "sin-suerte@osefi.net": { ok: false, motivo: "sin-proveedor" },
    };
    const { deps, cierres } = falsas({
      ctx: contexto({
        destinatarios: [
          dest({ id: 1, email: "bien@osefi.net" }),
          dest({ id: 2, email: "rebota@fuera.com", externo: true }),
          dest({ id: 3, email: "sin-suerte@osefi.net" }),
        ],
      }),
      enviar: vi.fn(async (c: CorreoAEnviar) => respuestas[c.para] ?? { ok: true }),
    });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toMatchObject({ estado: "enviado", enviados: 1, no_enviados: 2 });
    expect(vi.mocked(deps.anotarEntrega).mock.calls).toEqual([
      [1, "entregado"],
      [2, "rechazado"],
    ]);
    expect(cierres[0].cierre).toMatchObject({ enviados: 1, no_enviados: 2 });
  });
});

describe("the day's ceiling on report messages", () => {
  const tres = [1, 2, 3].map((id) => dest({ id, email: `d${id}@osefi.net` }));

  it("sends only what is left of it and says how many were held back", async () => {
    const { deps, enviados, cierres } = falsas({
      ctx: contexto({ destinatarios: tres }),
      enviadosHoy: vi.fn(async () => MAX_CORREOS_DE_INFORMES_AL_DIA - 2),
    });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(enviados).toHaveLength(2);
    expect(r).toMatchObject({ estado: "enviado", enviados: 2, no_enviados: 1 });
    expect(cierres[0].cierre.detalle).toMatch(/1 sin enviar por el tope diario/);
  });

  it("is a failed run, with the reason, when nothing is left", async () => {
    const { deps, enviados, cierres } = falsas({
      ctx: contexto({ destinatarios: tres }),
      enviadosHoy: vi.fn(async () => MAX_CORREOS_DE_INFORMES_AL_DIA),
    });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    // Only the notice to the owner goes out; no recipient gets anything.
    expect(enviados.map((e) => e.correo.para)).toEqual(["ana@osefi.net"]);
    expect(r).toMatchObject({ estado: "fallido", enviados: 0, no_enviados: 3 });
    expect(cierres[0].cierre.detalle).toMatch(/tope diario/);
  });
});

describe("a run that fails", () => {
  const roto = () =>
    vi.fn(async () => {
      throw new Error("canceling statement due to statement timeout");
    });

  it("sends the report to nobody, tells the owner, counts the failure and keeps the schedule alive", async () => {
    const { deps, enviados, cierres } = falsas({ exportar: roto() });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toEqual({ tipo: "ejecutado", estado: "fallido", enviados: 0, no_enviados: 0 });
    expect(cierres[0].cierre).toMatchObject({ estado: "fallido", enviados: 0 });
    expect(cierres[0].cierre.detalle).toMatch(/statement timeout/);
    expect(enviados.map((e) => e.correo.para)).toEqual(["ana@osefi.net"]);
    expect(enviados[0].correo.texto).toMatch(/Se volverá a intentar/);
    expect(deps.reprogramar).toHaveBeenCalledWith(7, {
      proxima_ejecucion: new Date("2026-03-23T11:00:00Z"),
      fallos_seguidos: 1,
      activa: true,
      motivo_pausa: null,
    });
  });

  it("builds every variant before sending any: one that fails means nobody receives the other", async () => {
    let llamadas = 0;
    const { deps, enviados } = falsas({
      ctx: contexto({
        destinatarios: [dest({ id: 1, email: "jefa@osefi.net", staff: true }), dest({ id: 2, email: "tecnico@osefi.net" })],
      }),
      exportar: vi.fn(async () => {
        llamadas += 1;
        if (llamadas === 2) throw new Error("boom");
        return fichero();
      }),
    });
    await ejecutarTurno(deps, PROGRAMACION, TURNO);
    expect(enviados.map((e) => e.correo.para)).toEqual(["ana@osefi.net"]);
  });

  it("pauses the schedule on the failure that reaches the limit, and tells the owner it is paused", async () => {
    const { deps, enviados } = falsas({ exportar: roto() });
    await ejecutarTurno(deps, { ...PROGRAMACION, fallos_seguidos: FALLOS_PARA_PAUSAR - 1 }, TURNO);

    expect(deps.reprogramar).toHaveBeenCalledWith(7, {
      proxima_ejecucion: null,
      fallos_seguidos: FALLOS_PARA_PAUSAR,
      activa: false,
      motivo_pausa: "fallos",
    });
    expect(enviados[0].correo.texto).toMatch(/queda en pausa/);
  });

  it("is a failure when the file was built and no recipient could be reached", async () => {
    const { deps, cierres } = falsas({ enviar: vi.fn(async () => ({ ok: false, motivo: "sin-proveedor" }) as ResultadoDeCorreo) });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);
    expect(r).toMatchObject({ estado: "fallido", enviados: 0, no_enviados: 1 });
    expect(cierres[0].cierre.detalle).toMatch(/ningún destinatario/);
  });

  it("closes the run even when something throws in the middle of sending", async () => {
    // A run left `en_curso` reads as "still sending" for ever.
    const { deps, cierres } = falsas({
      anotarEntrega: vi.fn(async () => {
        throw new Error("la base se fue");
      }),
    });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);
    expect(r).toMatchObject({ tipo: "ejecutado", estado: "fallido" });
    expect(cierres).toHaveLength(1);
    // The one message that did leave is still counted.
    expect(cierres[0].cierre.enviados).toBe(1);
  });

  it("does not fail when the owner has no address to be told at", async () => {
    const { deps, enviados } = falsas({
      ctx: contexto({ dueno: { nombre: "Ana", email: null, role: 1, staff: true, puedeProgramar: true } }),
      exportar: roto(),
    });
    await expect(ejecutarTurno(deps, PROGRAMACION, TURNO)).resolves.toMatchObject({ estado: "fallido" });
    expect(enviados).toHaveLength(0);
  });
});

describe("a schedule that may no longer run", () => {
  it.each([
    ["informe_archivado", { informe: null }],
    ["dueno_inactivo", { dueno: null }],
    ["sin_permiso", { dueno: { nombre: "Ana", email: null, role: 3, staff: false, puedeProgramar: false } }],
    ["sin_destinatarios", { destinatarios: [] }],
    ["sin_destinatarios", { destinatarios: [dest({ id: 1, email: "x@fuera.com", externo: true, deBaja: true })] }],
  ] as const)("pauses with %s and touches nothing else", async (motivo, over) => {
    const { deps, enviados } = falsas({ ctx: contexto(over as Partial<Contexto>) });
    const r = await ejecutarTurno(deps, { ...PROGRAMACION, fallos_seguidos: 1 }, TURNO);

    expect(r).toEqual({ tipo: "pausada", motivo });
    expect(deps.reprogramar).toHaveBeenCalledWith(7, {
      proxima_ejecucion: null,
      fallos_seguidos: 1,
      activa: false,
      motivo_pausa: motivo,
    });
    expect(deps.reclamar).not.toHaveBeenCalled();
    expect(deps.exportar).not.toHaveBeenCalled();
    expect(enviados).toHaveLength(0);
  });
});

describe("the one export slot, and the claim", () => {
  it("waits for the next tick when the exporter is busy, without claiming or changing anything", async () => {
    const { deps } = falsas({ exportadorOcupado: vi.fn(() => true) });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toEqual({ tipo: "ocupado" });
    expect(deps.reclamar).not.toHaveBeenCalled();
    expect(deps.reprogramar).not.toHaveBeenCalled();
  });

  it("gives the claim back when the slot is taken between the check and the export", async () => {
    const { deps } = falsas({
      exportar: vi.fn(async () => {
        throw Object.assign(new Error("ocupado"), { name: "ExportBusyError" });
      }),
    });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toEqual({ tipo: "ocupado" });
    expect(deps.liberar).toHaveBeenCalledWith(100);
    expect(deps.cerrar).not.toHaveBeenCalled();
    expect(deps.reprogramar).not.toHaveBeenCalled();
  });

  it("does nothing but move the schedule on when the run is already claimed", async () => {
    // Claimed by another process, or by one that died: either way this
    // schedule must not be found due again on the next tick, for ever.
    const { deps, enviados } = falsas({ reclamar: vi.fn(async () => null) });
    const r = await ejecutarTurno(deps, PROGRAMACION, TURNO);

    expect(r).toEqual({ tipo: "ya_reclamado" });
    expect(deps.exportar).not.toHaveBeenCalled();
    expect(enviados).toHaveLength(0);
    expect(deps.reprogramar).toHaveBeenCalledWith(7, expect.objectContaining({
      proxima_ejecucion: new Date("2026-03-23T11:00:00Z"),
      activa: true,
    }));
  });
});

describe("\"send it now\"", () => {
  it("is recorded as manual and leaves the schedule's own state alone, whether it works or fails", async () => {
    const bien = falsas();
    expect(await ejecutarTurno(bien.deps, PROGRAMACION, TURNO, { manual: true })).toMatchObject({ estado: "enviado" });
    expect(bien.deps.reclamar).toHaveBeenCalledWith(7, TURNO, true);
    expect(bien.deps.reprogramar).not.toHaveBeenCalled();

    const mal = falsas({
      exportar: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(await ejecutarTurno(mal.deps, PROGRAMACION, TURNO, { manual: true })).toMatchObject({ estado: "fallido" });
    expect(mal.deps.reprogramar).not.toHaveBeenCalled();
    // The person who pressed the button reads the result on screen; no notice.
    expect(mal.enviados).toHaveLength(0);
    expect(mal.cierres).toHaveLength(1);
  });
});
