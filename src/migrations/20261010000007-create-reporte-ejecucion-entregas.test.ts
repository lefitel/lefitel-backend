// The table that records who each run was sent to. Tested at the level the
// sibling migrations are: what it asks of the queryInterface, the order and
// the transaction, the vocabularies held together with the model's copies, and
// the one non-obvious rule — what `ON DELETE SET NULL` does to the CHECK.
// That Postgres accepts the SQL is `reportSchedule/store.db.test.ts`'s, which
// runs it against a throwaway database.

import { describe, it, expect } from "vitest";
import {
  up,
  down,
  RESTRICCIONES,
  RESULTADOS_DE_ENTREGA,
  TIPOS_DE_DESTINATARIO,
} from "./20261010000007-create-reporte-ejecucion-entregas.js";

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

const sqlOf = (qi: ReturnType<typeof fakeQueryInterface>) =>
  qi.calls.filter((c) => c.fn === "query").map((c) => String(c.args[0]).replace(/\s+/g, " "));

type Columnas = Record<string, { allowNull?: boolean; references?: { model: string }; onDelete?: string }>;
const columnasCreadas = async () => {
  const qi = fakeQueryInterface();
  await up({ context: qi as never });
  const creacion = qi.calls.find((c) => c.fn === "createTable");
  return { qi, nombre: creacion?.args[0], columnas: creacion?.args[1] as Columnas };
};

describe("create-reporte-ejecucion-entregas", () => {
  it("creates the one table, after the executions it hangs off", async () => {
    const { qi, nombre } = await columnasCreadas();
    expect(nombre).toBe("reporte_ejecucion_entregas");
    expect(qi.calls.filter((c) => c.fn === "createTable")).toHaveLength(1);
  });

  it("goes with its execution when the execution goes, and outlives an account that is removed", async () => {
    const { columnas } = await columnasCreadas();
    expect(columnas.id_ejecucion).toMatchObject({ allowNull: false, references: { model: "reporte_ejecuciones" }, onDelete: "CASCADE" });
    expect(columnas.id_usuario).toMatchObject({ allowNull: true, references: { model: "usuarios" }, onDelete: "SET NULL" });
  });

  it("keeps what the row has to say after the account or the address is gone: kind, name and result are never null", async () => {
    const { columnas } = await columnasCreadas();
    expect(Object.keys(columnas).sort()).toEqual(
      ["correo", "created_at", "id", "id_ejecucion", "id_usuario", "nombre", "resultado", "tipo"].sort(),
    );
    for (const c of ["tipo", "nombre", "resultado", "id_ejecucion"]) expect(columnas[c].allowNull, c).toBe(false);
    expect(columnas.correo.allowNull).toBe(true);
  });

  it("adds every CHECK it declares, by name", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const sql = sqlOf(qi);
    const declaradas = Object.entries(RESTRICCIONES);
    expect(declaradas.map(([n]) => n).sort()).toEqual([
      "reporte_entregas_destino_chk",
      "reporte_entregas_resultado_chk",
      "reporte_entregas_tipo_chk",
    ]);
    for (const [nombre, condicion] of declaradas) {
      expect(sql, nombre).toContain(`ALTER TABLE reporte_ejecucion_entregas ADD CONSTRAINT ${nombre} CHECK (${condicion})`);
    }
  });

  it("states the vocabularies in the CHECKs", () => {
    expect(RESTRICCIONES.reporte_entregas_resultado_chk).toBe(
      "resultado IN ('entregado', 'rechazado', 'no_enviado', 'sin_cupo')",
    );
    expect(RESTRICCIONES.reporte_entregas_tipo_chk).toBe("tipo IN ('usuario', 'externo')");
  });

  it("decides account or outside address by the kind, not by id_usuario, which SET NULL will empty", () => {
    const destino = RESTRICCIONES.reporte_entregas_destino_chk;
    // An outside address has its address and no account; an account has no address.
    expect(destino).toContain("(tipo = 'externo') = (correo IS NOT NULL)");
    expect(destino).toContain("tipo = 'usuario' OR id_usuario IS NULL");
    // The rule must still hold on a row whose account was removed: kind
    // 'usuario', no id_usuario, no correo. Spelled out so a later edit that
    // reads `id_usuario IS NOT NULL` for accounts cannot pass unnoticed.
    expect(destino).not.toMatch(/id_usuario IS NOT NULL/);
  });

  it("indexes the execution, which is how every read of it asks", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    const indice = qi.calls.find((c) => c.fn === "addIndex");
    expect(indice?.args[0]).toBe("reporte_ejecucion_entregas");
    expect(indice?.args[1]).toMatchObject({ fields: ["id_ejecucion"] });
  });

  it("runs every statement inside the one transaction, lock timeout first, in both directions", async () => {
    for (const direccion of [up, down]) {
      const qi = fakeQueryInterface();
      await direccion({ context: qi as never });
      expect(String(qi.calls[0].args[0])).toContain("lock_timeout");
      for (const call of qi.calls) {
        expect((call.args.at(-1) as { transaction?: unknown } | undefined)?.transaction, call.fn).toEqual({ id: "t" });
      }
    }
  });

  it("is purely additive, and goes back by dropping the table", async () => {
    const qi = fakeQueryInterface();
    await up({ context: qi as never });
    expect(qi.calls.some((c) => c.fn === "dropTable")).toBe(false);
    expect(sqlOf(qi).some((s) => /ALTER TABLE (?!reporte_ejecucion_entregas)/.test(s))).toBe(false);

    const atras = fakeQueryInterface();
    await down({ context: atras as never });
    expect(atras.calls.filter((c) => c.fn === "dropTable").map((c) => c.args[0])).toEqual(["reporte_ejecucion_entregas"]);
  });
});

describe("the vocabulary, in the migration and in the model", () => {
  it("is the same words", async () => {
    const modelo = await import("../models/reporteProgramacion.model.js");
    expect([...modelo.RESULTADOS_DE_ENTREGA]).toEqual([...RESULTADOS_DE_ENTREGA]);
    expect([...modelo.TIPOS_DE_DESTINATARIO]).toEqual([...TIPOS_DE_DESTINATARIO]);
  });

  it("and the run's own type names exactly them", async () => {
    // `ResultadoDeEntrega` in `run.ts` is a type, so it cannot be compared at
    // run time; this assigns every word of the list to it, which the compiler checks.
    const delRun: import("../reportSchedule/run.js").ResultadoDeEntrega[] = [...RESULTADOS_DE_ENTREGA];
    expect(delRun).toHaveLength(4);
  });

  it("names the table the migration creates, and declares its columns one for one", async () => {
    const modelo = await import("../models/reporteProgramacion.model.js");
    const { columnas } = await columnasCreadas();
    expect(String((modelo.ReporteEntregaModel as unknown as { getTableName(): string }).getTableName())).toBe(
      "reporte_ejecucion_entregas",
    );
    const delModelo = Object.values(
      (modelo.ReporteEntregaModel as unknown as { getAttributes(): Record<string, { field?: string }> }).getAttributes(),
    )
      .map((a) => a.field as string)
      .sort();
    expect(delModelo).toEqual(Object.keys(columnas).sort());
  });

  it("hangs off the execution in the model as well", async () => {
    const modelo = await import("../models/reporteProgramacion.model.js");
    expect(Object.keys(modelo.ReporteEjecucionModel.associations)).toContain("entregas");
    expect(Object.keys(modelo.ReporteEntregaModel.associations)).toContain("reporteEjecucion");
  });
});
