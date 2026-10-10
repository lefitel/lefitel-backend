// The tick, with a fake store and a fake run.

import { describe, it, expect, vi, afterEach } from "vitest";
import { EJECUCION_ABANDONADA_MS, RETRASO_MAXIMO_MS } from "./limits.js";
import type { Programacion, ResultadoDelTurno } from "./run.js";
import { iniciarProgramador, tic, type DependenciasDelProgramador, type Vencida } from "./scheduler.js";

const AHORA = new Date("2026-03-16T11:00:30Z"); // Monday, 07:00:30 in La Paz.

const programacion = (id: number): Programacion => ({
  id,
  id_reporte: 1,
  id_usuario: 1,
  frecuencia: "diaria",
  dia_semana: null,
  dia_mes: null,
  hora: 7,
  formato: "excel",
  con_fotos: false,
  fallos_seguidos: 0,
});

const vencida = (id: number, haceMs = 30_000): Vencida => ({
  programacion: programacion(id),
  turno: new Date(AHORA.getTime() - haceMs),
});

const HECHO: ResultadoDelTurno = { tipo: "ejecutado", estado: "enviado", enviados: 1, no_enviados: 0 };

function falsas(over: Partial<DependenciasDelProgramador> = {}) {
  return {
    ahora: () => AHORA,
    vencidas: vi.fn(async () => [] as Vencida[]),
    ejecutar: vi.fn(async () => HECHO),
    omitir: vi.fn(async () => undefined),
    cerrarAbandonadas: vi.fn(async () => 0),
    registrar: vi.fn(),
    ...over,
  } satisfies DependenciasDelProgramador;
}

afterEach(() => vi.useRealTimers());

describe("tic", () => {
  it("runs each schedule that is due, in the order they were due", async () => {
    const deps = falsas({ vencidas: vi.fn(async () => [vencida(1, 90_000), vencida(2, 30_000)]) });
    const r = await tic(deps);

    expect(r).toEqual({ ejecutadas: 2, omitidas: 0, ocupado: false, errores: 0 });
    expect(vi.mocked(deps.ejecutar).mock.calls.map((c) => c[0].id)).toEqual([1, 2]);
    expect(deps.vencidas).toHaveBeenCalledWith(AHORA);
  });

  it("does nothing when nothing is due", async () => {
    const deps = falsas();
    expect(await tic(deps)).toEqual({ ejecutadas: 0, omitidas: 0, ocupado: false, errores: 0 });
    expect(deps.ejecutar).not.toHaveBeenCalled();
  });

  it("stops at the first schedule that finds the exporter busy: the rest would find the same", async () => {
    const ejecutar = vi
      .fn<DependenciasDelProgramador["ejecutar"]>()
      .mockResolvedValueOnce(HECHO)
      .mockResolvedValueOnce({ tipo: "ocupado" })
      .mockResolvedValue(HECHO);
    const deps = falsas({ vencidas: vi.fn(async () => [vencida(1), vencida(2), vencida(3)]), ejecutar });
    const r = await tic(deps);

    expect(r).toMatchObject({ ejecutadas: 1, ocupado: true });
    expect(ejecutar).toHaveBeenCalledTimes(2);
  });

  it("does not count a paused or an already-claimed schedule as a run", async () => {
    const ejecutar = vi
      .fn<DependenciasDelProgramador["ejecutar"]>()
      .mockResolvedValueOnce({ tipo: "pausada", motivo: "sin_permiso" })
      .mockResolvedValueOnce({ tipo: "ya_reclamado" });
    const deps = falsas({ vencidas: vi.fn(async () => [vencida(1), vencida(2)]), ejecutar });
    expect(await tic(deps)).toMatchObject({ ejecutadas: 0, ocupado: false, errores: 0 });
  });

  it("records a run that is too late as skipped, with the next run after now, and does not send it", async () => {
    const tarde = vencida(1, RETRASO_MAXIMO_MS + 60_000);
    const deps = falsas({ vencidas: vi.fn(async () => [tarde, vencida(2)]) });
    const r = await tic(deps);

    expect(r).toMatchObject({ ejecutadas: 1, omitidas: 1 });
    // Daily at 07:00 in La Paz; it is 07:00:30 on the 16th, so tomorrow.
    expect(deps.omitir).toHaveBeenCalledWith(tarde.programacion, tarde.turno, new Date("2026-03-17T11:00:00Z"));
    expect(vi.mocked(deps.ejecutar).mock.calls.map((c) => c[0].id)).toEqual([2]);
  });

  it("still sends a run that is late but inside what is recovered, to the last millisecond", async () => {
    const justo = vencida(1, RETRASO_MAXIMO_MS);
    const deps = falsas({ vencidas: vi.fn(async () => [justo]) });
    expect(await tic(deps)).toMatchObject({ ejecutadas: 1, omitidas: 0 });
    expect(deps.omitir).not.toHaveBeenCalled();
  });

  it("goes on to the next schedule when one throws", async () => {
    const ejecutar = vi
      .fn<DependenciasDelProgramador["ejecutar"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(HECHO);
    const deps = falsas({ vencidas: vi.fn(async () => [vencida(1), vencida(2)]), ejecutar });
    const r = await tic(deps);

    expect(r).toMatchObject({ ejecutadas: 1, errores: 1 });
    expect(deps.registrar).toHaveBeenCalledWith("error", expect.objectContaining({ id_programacion: 1 }), expect.any(String));
  });

  it("resolves, with the error counted, when the store cannot say what is due", async () => {
    const deps = falsas({
      vencidas: vi.fn(async () => {
        throw new Error("la base no responde");
      }),
    });
    await expect(tic(deps)).resolves.toMatchObject({ ejecutadas: 0, errores: 1 });
  });

  it("closes abandoned runs first, with the cut-off an hour back, and carries on if that fails", async () => {
    const deps = falsas({ cerrarAbandonadas: vi.fn(async () => 2), vencidas: vi.fn(async () => [vencida(1)]) });
    await tic(deps);
    expect(deps.cerrarAbandonadas).toHaveBeenCalledWith(new Date(AHORA.getTime() - EJECUCION_ABANDONADA_MS));
    expect(deps.registrar).toHaveBeenCalledWith("warn", { cerradas: 2 }, expect.any(String));

    const roto = falsas({
      cerrarAbandonadas: vi.fn(async () => {
        throw new Error("boom");
      }),
      vencidas: vi.fn(async () => [vencida(1)]),
    });
    expect(await tic(roto)).toMatchObject({ ejecutadas: 1, errores: 1 });
  });
});

describe("iniciarProgramador", () => {
  it("runs a pass at once and then one per interval", async () => {
    vi.useFakeTimers();
    const deps = falsas();
    const parar = iniciarProgramador(deps, 60_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.vencidas).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.vencidas).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.vencidas).toHaveBeenCalledTimes(4);
    parar();
  });

  it("never starts a pass while the previous one is still working", async () => {
    vi.useFakeTimers();
    let soltar: () => void = () => undefined;
    const ejecutar = vi.fn<DependenciasDelProgramador["ejecutar"]>(
      () => new Promise((resolve) => (soltar = () => resolve(HECHO))),
    );
    const deps = falsas({ vencidas: vi.fn(async () => [vencida(1)]), ejecutar });
    const parar = iniciarProgramador(deps, 60_000);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(deps.vencidas).toHaveBeenCalledTimes(1);

    soltar();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.vencidas).toHaveBeenCalledTimes(2);
    parar();
  });

  it("stops when asked", async () => {
    vi.useFakeTimers();
    const deps = falsas();
    const parar = iniciarProgramador(deps, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    parar();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.vencidas).toHaveBeenCalledTimes(1);
  });
});
