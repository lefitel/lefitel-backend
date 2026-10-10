// The scheduled reports' three tables. What is checked here is what a reader
// of the migration cannot see by reading it once: the order things are created
// and dropped in, that every statement rides the one transaction, and that the
// vocabularies written into the CHECKs are the ones the models use. That the
// SQL itself is accepted by Postgres was checked by running it against a
// throwaway PostgreSQL 17 — see the design document, §3.3.

import { describe, it, expect } from "vitest";
import {
  up,
  down,
  RESTRICCIONES,
  FRECUENCIAS,
  FORMATOS,
  ESTADOS_DE_EJECUCION,
} from "./20261010000001-create-reporte-programaciones.js";

function fakeQueryInterface() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve();
  };
  return {
    calls,
    createTable: record("createTable"),
    dropTable: record("dropTable"),
    addIndex: record("addIndex"),
    sequelize: {
      literal: (sql: string) => ({ literal: sql }),
      query: (...args: unknown[]) => {
        calls.push({ fn: "query", args });
        return Promise.resolve(undefined);
      },
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const transactionOf = (call: { args: unknown[] }) =>
  (call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction;

const sqlOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0]).replace(/\s+/g, " "));

describe("create-reporte-programaciones", () => {
  it("creates the schedule first, then the two tables that hang off it", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    expect(qi.calls.filter((c) => c.fn === "createTable").map((c) => c.args[0])).toEqual([
      "reporte_programaciones",
      "reporte_programacion_destinatarios",
      "reporte_ejecuciones",
    ]);
  });

  it("drops them children first, so the rollback does not trip on its own foreign keys", async () => {
    const qi = fakeQueryInterface();
    await down({ context: qi as never });

    expect(qi.calls.filter((c) => c.fn === "dropTable").map((c) => c.args[0])).toEqual([
      "reporte_ejecuciones",
      "reporte_programacion_destinatarios",
      "reporte_programaciones",
    ]);
  });

  it("runs every statement inside the one transaction, in both directions", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });

      expect(qi.calls.length).toBeGreaterThan(3);
      for (const call of qi.calls) {
        expect(transactionOf(call), `${call.fn} ${String(call.args[0]).slice(0, 60)}`).toEqual({ id: "t" });
      }
    }
  });

  it("sets the lock timeout before touching anything", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });
      expect(qi.calls[0].fn).toBe("query");
      expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
    }
  });

  it("adds every CHECK it declares, by name", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);

    const declaradas = Object.entries(RESTRICCIONES).flatMap(([tabla, r]) =>
      Object.entries(r).map(([nombre, condicion]) => ({ tabla, nombre, condicion })),
    );
    expect(declaradas.length).toBe(10);
    for (const { tabla, nombre, condicion } of declaradas) {
      expect(sql, nombre).toContain(`ALTER TABLE ${tabla} ADD CONSTRAINT ${nombre} CHECK (${condicion})`);
    }
  });

  it("makes the pair (schedule, moment it was due) unique — the lock against sending twice", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });

    const turno = qi.calls.find(
      (c) => c.fn === "addIndex" && (c.args[1] as { name?: string }).name === "reporte_ejecuciones_turno_uq",
    );
    expect(turno?.args[0]).toBe("reporte_ejecuciones");
    expect(turno?.args[1]).toMatchObject({ fields: ["id_programacion", "programada_para"], unique: true });
  });

  it("lets nobody be on one schedule twice, as a user or as an address", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);

    expect(sql.some((s) => /UNIQUE INDEX reporte_destinatarios_usuario_uq .*\(id_programacion, id_usuario\) WHERE id_usuario IS NOT NULL/.test(s))).toBe(true);
    expect(sql.some((s) => /UNIQUE INDEX reporte_destinatarios_email_uq .*\(id_programacion, email\) WHERE email IS NOT NULL/.test(s))).toBe(true);
  });

  it("refers to users and saved reports without cascading a delete into them or out of them", async () => {
    // Deleting a schedule takes its recipients and its history with it;
    // nothing here may take a user or a saved report along, and a user who
    // owns a schedule cannot be hard-deleted from under it.
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    type Columnas = Record<string, { references?: { model: string }; onDelete?: string }>;
    const tablas = Object.fromEntries(
      qi.calls.filter((c) => c.fn === "createTable").map((c) => [c.args[0] as string, c.args[1] as Columnas]),
    );

    expect(tablas.reporte_programaciones.id_reporte).toMatchObject({ references: { model: "reporte_vistas" }, onDelete: "RESTRICT" });
    expect(tablas.reporte_programaciones.id_usuario).toMatchObject({ references: { model: "usuarios" }, onDelete: "RESTRICT" });
    expect(tablas.reporte_programacion_destinatarios.id_usuario).toMatchObject({ references: { model: "usuarios" }, onDelete: "RESTRICT" });
    expect(tablas.reporte_programacion_destinatarios.id_programacion.onDelete).toBe("CASCADE");
    expect(tablas.reporte_ejecuciones.id_programacion.onDelete).toBe("CASCADE");
  });
});

describe("the vocabularies, in the migration and in the models", () => {
  // Written twice on purpose — a migration must not change when the code
  // does — so something has to notice when only one of them is edited.
  it("are the same words", async () => {
    const modelo = await import("../models/reporteProgramacion.model.js");

    expect([...modelo.FRECUENCIAS]).toEqual([...FRECUENCIAS]);
    expect([...modelo.FORMATOS_PROGRAMABLES]).toEqual([...FORMATOS]);
    expect([...modelo.ESTADOS_DE_EJECUCION]).toEqual([...ESTADOS_DE_EJECUCION]);
  });

  it("name the three tables the migration creates", async () => {
    const modelo = await import("../models/reporteProgramacion.model.js");
    const nombre = (m: unknown) => String((m as { getTableName(): string }).getTableName());

    expect(nombre(modelo.ReporteProgramacionModel)).toBe("reporte_programaciones");
    expect(nombre(modelo.ReporteProgramacionDestinatarioModel)).toBe("reporte_programacion_destinatarios");
    expect(nombre(modelo.ReporteEjecucionModel)).toBe("reporte_ejecuciones");
  });

  it("declare, column for column, what the migration creates", async () => {
    // A column in the model that the table lacks is a 500 on the first read;
    // one in the table that the model lacks is data nothing can reach.
    const modelo = await import("../models/reporteProgramacion.model.js");
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const creadas = Object.fromEntries(
      qi.calls
        .filter((c) => c.fn === "createTable")
        .map((c) => [c.args[0] as string, Object.keys(c.args[1] as object).sort()]),
    );
    const columnas = (m: unknown) =>
      Object.values((m as { getAttributes(): Record<string, { field?: string }> }).getAttributes())
        .map((a) => a.field as string)
        .sort();

    // `minuto` is not this migration's: `20261010000004` adds it. Named here,
    // one by one, so that a column the model gains without a migration behind
    // it still fails this test.
    const anadidasDespues = ["minuto"];
    expect(columnas(modelo.ReporteProgramacionModel)).toEqual(
      [...creadas.reporte_programaciones, ...anadidasDespues].sort(),
    );
    expect(columnas(modelo.ReporteProgramacionDestinatarioModel)).toEqual(creadas.reporte_programacion_destinatarios);
    expect(columnas(modelo.ReporteEjecucionModel)).toEqual(creadas.reporte_ejecuciones);
  });
});

describe("a recipient's address", () => {
  it("is stored trimmed and in lower case, which is what the table's CHECK demands", async () => {
    const { ReporteProgramacionDestinatarioModel } = await import("../models/reporteProgramacion.model.js");
    const fila = ReporteProgramacionDestinatarioModel.build({ id_programacion: 1, email: "  Ana@Cliente.COM " } as never);
    expect(fila.dataValues.email).toBe("ana@cliente.com");
  });

  it("never serialises the unsubscribe token", async () => {
    const { ReporteProgramacionDestinatarioModel } = await import("../models/reporteProgramacion.model.js");
    const fila = ReporteProgramacionDestinatarioModel.build({
      id_programacion: 1,
      email: "ana@cliente.com",
      baja_token: "a".repeat(43),
    } as never);
    expect(JSON.stringify(fila)).not.toContain("a".repeat(43));
  });
});
