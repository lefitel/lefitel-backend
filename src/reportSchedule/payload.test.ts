// What a client may send to create or change a schedule.

import { describe, it, expect } from "vitest";
import { MAX_DESTINATARIOS } from "./limits.js";
import { leerProgramacion } from "./payload.js";

const BUENA = {
  id_reporte: 3,
  frecuencia: "semanal",
  dia_semana: 1,
  hora: 7,
  formato: "excel",
  con_fotos: true,
  destinatarios: { usuarios: [2, 5], correos: ["Cliente@Fuera.com "] },
};

const problemas = (cuerpo: unknown) => {
  const r = leerProgramacion(cuerpo);
  return r.ok ? [] : r.problemas;
};

describe("leerProgramacion — what it accepts", () => {
  it("reads a complete schedule, normalising the addresses and filling in the defaults", () => {
    expect(leerProgramacion(BUENA)).toEqual({
      ok: true,
      valor: {
        id_reporte: 3,
        frecuencia: "semanal",
        dia_semana: 1,
        dia_mes: null,
        hora: 7,
        minuto: 0,
        formato: "excel",
        con_fotos: true,
        activa: true,
        usuarios: [2, 5],
        correos: ["cliente@fuera.com"],
      },
    });
  });

  it("keeps a schedule that is created paused", () => {
    const r = leerProgramacion({ ...BUENA, activa: false });
    expect(r.ok && r.valor.activa).toBe(false);
  });

  it("drops repeated recipients instead of refusing them", () => {
    const r = leerProgramacion({
      ...BUENA,
      destinatarios: { usuarios: [2, 2, 5], correos: ["a@b.com", "A@B.com", " a@b.com"] },
    });
    expect(r.ok && [r.valor.usuarios, r.valor.correos]).toEqual([[2, 5], ["a@b.com"]]);
  });

  it("accepts only accounts, or only outside addresses", () => {
    expect(leerProgramacion({ ...BUENA, destinatarios: { usuarios: [2] } }).ok).toBe(true);
    expect(leerProgramacion({ ...BUENA, destinatarios: { correos: ["a@b.com"] } }).ok).toBe(true);
  });

  it("never stores photographs for a PDF: the exporter ignores them there", () => {
    const r = leerProgramacion({ ...BUENA, formato: "pdf", con_fotos: true });
    expect(r.ok && r.valor.con_fotos).toBe(false);
  });

  it("accepts exactly the most recipients a schedule may have", () => {
    const usuarios = Array.from({ length: MAX_DESTINATARIOS }, (_, i) => i + 1);
    expect(leerProgramacion({ ...BUENA, destinatarios: { usuarios } }).ok).toBe(true);
  });
});

describe("leerProgramacion — what it refuses, and in whose words", () => {
  it("refuses a body that is not an object at all", () => {
    for (const cuerpo of [null, undefined, "x", 7, []]) {
      expect(problemas(cuerpo), JSON.stringify(cuerpo)).toHaveLength(1);
    }
  });

  it("refuses a missing or invented report", () => {
    for (const id_reporte of [undefined, 0, -1, 1.5, "3"]) {
      expect(problemas({ ...BUENA, id_reporte })).toContain("Falta el informe que se va a enviar.");
    }
  });

  it("refuses a schedule the table would refuse, with the calendar's own sentences", () => {
    expect(problemas({ ...BUENA, hora: 24 })).toEqual(["La hora debe ser un número entero entre 0 y 23."]);
    expect(problemas({ ...BUENA, dia_semana: undefined })[0]).toMatch(/necesita el día de la semana/);
    expect(problemas({ ...BUENA, frecuencia: "anual" })).toEqual(["La frecuencia debe ser diaria, semanal o mensual."]);
    expect(problemas({ ...BUENA, frecuencia: "diaria" })[0]).toMatch(/no lleva día de la semana/);
  });

  it("reads the minute it is given, and refuses one that is not a minute rather than rounding it", () => {
    expect(leerProgramacion({ ...BUENA, minuto: 20 }).valor?.minuto).toBe(20);
    expect(leerProgramacion({ ...BUENA, minuto: null }).valor?.minuto).toBe(0);
    for (const minuto of [60, -1, 7.5, "20"]) {
      expect(problemas({ ...BUENA, minuto })).toEqual(["Los minutos deben ser un número entero entre 0 y 59."]);
    }
  });

  it("refuses a format the exporter does not have", () => {
    expect(problemas({ ...BUENA, formato: "csv" })).toEqual(["El formato debe ser Excel o PDF."]);
    expect(problemas({ ...BUENA, formato: "xlsx" })).toEqual(["El formato debe ser Excel o PDF."]);
  });

  it("refuses a schedule with nobody to send to", () => {
    for (const destinatarios of [undefined, {}, { usuarios: [], correos: [] }, { correos: ["  "] }]) {
      expect(problemas({ ...BUENA, destinatarios })).toEqual(["Añada al menos un destinatario."]);
    }
  });

  it("refuses one recipient too many, counting accounts and addresses together", () => {
    const usuarios = Array.from({ length: MAX_DESTINATARIOS }, (_, i) => i + 1);
    const r = problemas({ ...BUENA, destinatarios: { usuarios, correos: ["a@b.com"] } });
    expect(r).toEqual([`Una programación admite como máximo ${MAX_DESTINATARIOS} destinatarios, y esta tiene ${MAX_DESTINATARIOS + 1}.`]);
  });

  it("refuses what is plainly not one address, and names it", () => {
    for (const malo of ["sin-arroba", "a@b", "a b@c.com", "a@b.com,c@d.com", "a@b.com;c@d.com", "@b.com"]) {
      const r = problemas({ ...BUENA, destinatarios: { correos: [malo] } });
      expect(r, malo).toHaveLength(1);
      expect(r[0], malo).toContain(malo.toLowerCase());
    }
    expect(problemas({ ...BUENA, destinatarios: { correos: [`${"a".repeat(250)}@b.com`] } })).toHaveLength(1);
  });

  it("refuses lists that are not lists, or hold the wrong thing", () => {
    expect(problemas({ ...BUENA, destinatarios: { usuarios: "2" } })).toContain("La lista de usuarios destinatarios no es válida.");
    expect(problemas({ ...BUENA, destinatarios: { usuarios: [2, "5"] } })).toContain("La lista de usuarios destinatarios no es válida.");
    expect(problemas({ ...BUENA, destinatarios: { usuarios: [0] } })).toContain("La lista de usuarios destinatarios no es válida.");
    expect(problemas({ ...BUENA, destinatarios: { correos: [7] } })).toContain("La lista de correos externos no es válida.");
    expect(problemas({ ...BUENA, destinatarios: [] })).toContain("Los destinatarios no tienen la forma esperada.");
  });

  it("refuses a yes-or-no that is neither", () => {
    expect(problemas({ ...BUENA, con_fotos: "sí" })).toEqual(["«Con fotos» debe ser sí o no."]);
    expect(problemas({ ...BUENA, activa: 1 })).toEqual(["«Activa» debe ser sí o no."]);
  });

  it("says everything that is wrong at once, not one thing per attempt", () => {
    const r = problemas({ id_reporte: 0, frecuencia: "diaria", hora: 99, formato: "csv", destinatarios: { correos: ["x"] } });
    expect(r.length).toBeGreaterThanOrEqual(4);
  });
});
