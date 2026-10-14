// The part of `store.ts` that records who a run was sent to, with the models
// spied and no database: how a recipient becomes a row, and what the run is
// told about each recipient when the context is loaded. The statements Postgres
// runs are `store.db.test.ts`'s, which needs a throwaway database.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger.js", () => ({ log: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
const can = vi.fn(async (_rol: number, _modulo: string, _accion: string) => false);
vi.mock("../permissions/store.js", () => ({ can: (...a: [number, string, string]) => can(...a) }));

const { ReporteEntregaModel, ReporteEjecucionModel, ReporteProgramacionDestinatarioModel } = await import(
  "../models/reporteProgramacion.model.js"
);
const { ReporteVistaModel } = await import("../models/reporteVista.model.js");
const { UsuarioModel } = await import("../models/usuario.model.js");
const { dependenciasDelProgramadorReales, dependenciasReales } = await import("./store.js");
import type { Destinatario } from "./run.js";

const crear = vi.spyOn(ReporteEntregaModel, "create");
const reales = dependenciasReales({ enlaceDeBaja: async () => null });

const cuenta: Destinatario = {
  id: 11, nombre: "Beto Mamani", id_usuario: 20, email: "beto@osefi.net",
  externo: false, staff: false, rechazos_seguidos: 0, deBaja: false,
};
const externo: Destinatario = {
  id: 12, nombre: "cliente@fuera.com", email: "cliente@fuera.com",
  externo: true, staff: false, rechazos_seguidos: 0, deBaja: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  crear.mockResolvedValue({} as never);
});

describe("writing a recipient of a run", () => {
  it("keeps an account by its id and its name, and never its address", async () => {
    await reales.anotarEntregaDeEjecucion(100, { destinatario: cuenta, resultado: "entregado" });

    expect(crear).toHaveBeenCalledWith({
      id_ejecucion: 100, tipo: "usuario", id_usuario: 20, correo: null, nombre: "Beto Mamani", resultado: "entregado",
    });
    expect(JSON.stringify(crear.mock.calls[0][0])).not.toContain("beto@osefi.net");
  });

  it("keeps an outside address as the address it was, with no account", async () => {
    await reales.anotarEntregaDeEjecucion(100, { destinatario: externo, resultado: "rechazado" });

    expect(crear).toHaveBeenCalledWith({
      id_ejecucion: 100, tipo: "externo", id_usuario: null, correo: "cliente@fuera.com", nombre: "cliente@fuera.com", resultado: "rechazado",
    });
  });

  it("cuts a name to the column it goes in, so a long one cannot lose the row", async () => {
    await reales.anotarEntregaDeEjecucion(100, { destinatario: { ...cuenta, nombre: "N".repeat(400) }, resultado: "entregado" });
    expect((crear.mock.calls[0][0] as { nombre: string }).nombre).toHaveLength(255);

    crear.mockClear();
    const largo = `${"a".repeat(300)}@fuera.com`;
    await reales.anotarEntregaDeEjecucion(100, { destinatario: { ...externo, nombre: largo, email: largo }, resultado: "entregado" });
    const fila = crear.mock.calls[0][0] as { nombre: string; correo: string };
    expect([fila.nombre.length, fila.correo.length]).toEqual([255, 255]);
  });

  it("lets a failure of the write through: the run is what catches and logs it", async () => {
    crear.mockRejectedValue(new Error("x"));
    await expect(reales.anotarEntregaDeEjecucion(100, { destinatario: cuenta, resultado: "sin_cupo" })).rejects.toThrow("x");
  });
});

describe("giving a run back", () => {
  it("deletes only a run still in progress, and its recipients go with it by the table's own cascade", async () => {
    const destruir = vi.spyOn(ReporteEjecucionModel, "destroy").mockResolvedValue(1 as never);
    await reales.liberar(100);
    // No statement of ours touches the recipient rows: `ON DELETE CASCADE` on
    // `reporte_ejecucion_entregas.id_ejecucion` removes them with the run.
    expect(destruir).toHaveBeenCalledWith({ where: { id: 100, estado: "en_curso" } });
  });
});

describe("closing the runs a dead process left behind", () => {
  it("counts who they were delivered to from the rows written as it went, and keeps what it always did", async () => {
    const actualizar = vi.spyOn(ReporteEjecucionModel, "update").mockResolvedValue([2] as never);
    const antes = new Date("2026-10-12T10:00:00Z");

    const cuantas = await dependenciasDelProgramadorReales(reales).cerrarAbandonadas(antes);

    expect(cuantas).toBe(2);
    const [valores, opciones] = actualizar.mock.calls[0] as unknown as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(valores).toMatchObject({ estado: "fallido", detalle: "Interrumpida: el servidor se detuvo mientras se enviaba." });
    expect(valores.terminada_at).toBeInstanceOf(Date);
    // Delivered counts as delivered; the other three results as not.
    const entregados = String((valores.enviados as { val: string }).val).replace(/\s+/g, " ");
    const noEntregados = String((valores.no_enviados as { val: string }).val).replace(/\s+/g, " ");
    expect(entregados).toContain("FROM reporte_ejecucion_entregas");
    expect(entregados).toContain("resultado = 'entregado'");
    expect(entregados).toContain("id_ejecucion = reporte_ejecuciones.id");
    expect(noEntregados).toContain("resultado <> 'entregado'");
    expect(opciones.where).toMatchObject({ estado: "en_curso" });
  });
});

describe("loading the recipients of a run", () => {
  it("gives an account its name and surname and an outside address its address", async () => {
    vi.spyOn(ReporteVistaModel, "findByPk").mockResolvedValue({ dataValues: { name: "Informe", config: {} } } as never);
    vi.spyOn(UsuarioModel, "findByPk").mockResolvedValue({
      dataValues: { name: "Ana", lastname: "Pérez", user: "ana", email: "ana@osefi.net", email_verified_at: new Date(), id_rol: 1 },
    } as never);
    vi.spyOn(ReporteProgramacionDestinatarioModel, "findAll").mockResolvedValue([
      { dataValues: { id: 1, id_programacion: 7, id_usuario: 20, email: null, rechazos_seguidos: 0, baja_at: null } },
      { dataValues: { id: 2, id_programacion: 7, id_usuario: null, email: "cliente@fuera.com", rechazos_seguidos: 0, baja_at: null } },
    ] as never);
    const findCuentas = vi.spyOn(UsuarioModel, "findAll").mockResolvedValue([
      { dataValues: { id: 20, name: "Beto", lastname: "Mamani", user: "beto", email: "beto@osefi.net", email_verified_at: new Date(), id_rol: 3 } },
    ] as never);

    const { cargarContexto } = reales;
    const ctx = await cargarContexto({
      id: 7, id_reporte: 3, id_usuario: 1, frecuencia: "diaria", dia_semana: null, dia_mes: null, hora: 7, minuto: 0,
      formato: "excel", con_fotos: false, fallos_seguidos: 0,
    });

    expect(ctx.destinatarios.map((d) => [d.id, d.nombre, d.id_usuario ?? null, d.externo])).toEqual([
      [1, "Beto Mamani", 20, false],
      [2, "cliente@fuera.com", null, true],
    ]);
    // The names are read; nothing about this reads more of the account than the run needs.
    expect(findCuentas.mock.calls[0][0]!.attributes).toEqual(["id", "name", "lastname", "email", "email_verified_at", "id_rol"]);
  });

  it("never calls an account by its login name, which may be an address: a nameless one gets the generic label", async () => {
    vi.spyOn(ReporteVistaModel, "findByPk").mockResolvedValue({ dataValues: { name: "Informe", config: {} } } as never);
    vi.spyOn(UsuarioModel, "findByPk").mockResolvedValue({
      dataValues: { name: "Ana", lastname: "Pérez", user: "ana", email: "ana@osefi.net", email_verified_at: new Date(), id_rol: 1 },
    } as never);
    vi.spyOn(ReporteProgramacionDestinatarioModel, "findAll").mockResolvedValue([
      { dataValues: { id: 1, id_programacion: 7, id_usuario: 20, email: null, rechazos_seguidos: 0, baja_at: null } },
    ] as never);
    // The login name is an address, and the account has no name or surname.
    vi.spyOn(UsuarioModel, "findAll").mockResolvedValue([
      { dataValues: { id: 20, name: "", lastname: "", user: "beto@secreto.com", email: "beto@osefi.net", email_verified_at: new Date(), id_rol: 3 } },
    ] as never);

    const ctx = await reales.cargarContexto({
      id: 7, id_reporte: 3, id_usuario: 1, frecuencia: "diaria", dia_semana: null, dia_mes: null, hora: 7, minuto: 0,
      formato: "excel", con_fotos: false, fallos_seguidos: 0,
    });
    expect(ctx.destinatarios[0].nombre).toBe("un usuario de Osefi");

    await reales.anotarEntregaDeEjecucion(100, { destinatario: ctx.destinatarios[0], resultado: "entregado" });
    expect(JSON.stringify(crear.mock.calls[0][0])).not.toContain("@");
  });
});
