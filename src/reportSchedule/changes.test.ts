// The two things an edit does not simply overwrite.

import { describe, it, expect } from "vitest";
import { estadoTrasEditar, reconciliarDestinatarios, type EstadoDeProgramacion } from "./changes.js";

describe("reconciliarDestinatarios", () => {
  const cuenta = (id: number, id_usuario: number) => ({ id, id_usuario, email: null, baja_at: null });
  const externo = (id: number, email: string, baja = false) => ({ id, id_usuario: null, email, baja_at: baja ? new Date() : null });

  it("changes nothing when the same recipients are asked for again", () => {
    const existentes = [cuenta(1, 20), externo(2, "a@b.com")];
    expect(reconciliarDestinatarios(existentes, { usuarios: [20], correos: ["a@b.com"] })).toEqual({ borrar: [], crear: [] });
  });

  it("adds who is new and removes who is no longer asked for, leaving the rest alone", () => {
    const existentes = [cuenta(1, 20), cuenta(2, 21), externo(3, "a@b.com"), externo(4, "c@d.com")];
    expect(reconciliarDestinatarios(existentes, { usuarios: [21, 22], correos: ["c@d.com", "e@f.com"] })).toEqual({
      borrar: [1, 3],
      crear: [{ id_usuario: 22 }, { email: "e@f.com" }],
    });
  });

  it("never deletes an address that unsubscribed, even when it is taken off the list", () => {
    const existentes = [externo(1, "baja@fuera.com", true), externo(2, "sigue@fuera.com")];
    expect(reconciliarDestinatarios(existentes, { usuarios: [], correos: [] })).toEqual({ borrar: [2], crear: [] });
  });

  it("never adds again an address that unsubscribed: asking for it creates nothing", () => {
    const existentes = [externo(1, "baja@fuera.com", true)];
    expect(reconciliarDestinatarios(existentes, { usuarios: [], correos: ["baja@fuera.com"] })).toEqual({ borrar: [], crear: [] });
  });

  it("does not confuse an account with an address that happens to share nothing but the list", () => {
    const existentes = [cuenta(1, 20)];
    expect(reconciliarDestinatarios(existentes, { usuarios: [], correos: ["a@b.com"] })).toEqual({
      borrar: [1],
      crear: [{ email: "a@b.com" }],
    });
  });

  it("starts from nothing", () => {
    expect(reconciliarDestinatarios([], { usuarios: [5], correos: ["a@b.com"] })).toEqual({
      borrar: [],
      crear: [{ id_usuario: 5 }, { email: "a@b.com" }],
    });
  });
});

describe("estadoTrasEditar", () => {
  // Monday 16 March 2026, 06:59 in La Paz.
  const AHORA = new Date("2026-03-16T10:59:00Z");
  const PROXIMA = new Date("2026-03-16T11:00:00Z");
  const actual = (over: Partial<EstadoDeProgramacion> = {}): EstadoDeProgramacion => ({
    frecuencia: "semanal",
    dia_semana: 1,
    dia_mes: null,
    hora: 7,
    activa: true,
    proxima_ejecucion: PROXIMA,
    motivo_pausa: null,
    fallos_seguidos: 1,
    ...over,
  });
  const igual = { frecuencia: "semanal" as const, dia_semana: 1, dia_mes: null, hora: 7, activa: true };

  it("leaves the next run exactly where it was when the timing did not change", () => {
    // Somebody adds a recipient a minute before the report is due.
    expect(estadoTrasEditar(actual(), igual, AHORA)).toEqual({
      proxima_ejecucion: PROXIMA,
      motivo_pausa: null,
      fallos_seguidos: 1,
    });
  });

  it("does not move it either when saved just after it was due, while the tick may still be on it", () => {
    const pasada = new Date("2026-03-16T11:00:30Z");
    expect(estadoTrasEditar(actual(), igual, pasada).proxima_ejecucion).toEqual(PROXIMA);
  });

  it.each([
    ["the hour", { ...igual, hora: 9 }, "2026-03-16T13:00:00Z"],
    ["the weekday", { ...igual, dia_semana: 3 }, "2026-03-18T11:00:00Z"],
    ["the frequency", { frecuencia: "diaria" as const, dia_semana: null, dia_mes: null, hora: 7, activa: true }, "2026-03-16T11:00:00Z"],
    ["to monthly", { frecuencia: "mensual" as const, dia_semana: null, dia_mes: 20, hora: 7, activa: true }, "2026-03-20T11:00:00Z"],
  ])("recomputes it when %s changes", (_que, pedida, esperada) => {
    expect(estadoTrasEditar(actual(), pedida, AHORA).proxima_ejecucion).toEqual(new Date(esperada));
  });

  it("clears the next run and says it was by hand when an active schedule is paused", () => {
    expect(estadoTrasEditar(actual(), { ...igual, activa: false }, AHORA)).toEqual({
      proxima_ejecucion: null,
      motivo_pausa: "manual",
      fallos_seguidos: 1,
    });
  });

  it("keeps the reason of a schedule that had paused itself when it is saved still paused", () => {
    const pausada = actual({ activa: false, proxima_ejecucion: null, motivo_pausa: "fallos", fallos_seguidos: 3 });
    expect(estadoTrasEditar(pausada, { ...igual, activa: false }, AHORA)).toEqual({
      proxima_ejecucion: null,
      motivo_pausa: "fallos",
      fallos_seguidos: 3,
    });
  });

  it("gives a schedule that comes back from a pause a next run, no reason and no failures", () => {
    const pausada = actual({ activa: false, proxima_ejecucion: null, motivo_pausa: "fallos", fallos_seguidos: 3 });
    expect(estadoTrasEditar(pausada, igual, AHORA)).toEqual({
      proxima_ejecucion: PROXIMA,
      motivo_pausa: null,
      fallos_seguidos: 0,
    });
  });

  it("never leaves an active schedule without a next run — the table would refuse the row", () => {
    const rota = actual({ proxima_ejecucion: null });
    expect(estadoTrasEditar(rota, igual, AHORA).proxima_ejecucion).toEqual(PROXIMA);
  });

  it("keeps active and next-run in step in every combination", () => {
    for (const eraActiva of [true, false]) {
      for (const seraActiva of [true, false]) {
        const r = estadoTrasEditar(
          actual({ activa: eraActiva, proxima_ejecucion: eraActiva ? PROXIMA : null }),
          { ...igual, activa: seraActiva },
          AHORA,
        );
        expect(r.proxima_ejecucion !== null, `${eraActiva} -> ${seraActiva}`).toBe(seraActiva);
        expect(r.motivo_pausa === null, `${eraActiva} -> ${seraActiva}`).toBe(seraActiva);
      }
    }
  });
});
