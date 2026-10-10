// When a schedule runs next. Pure calendar arithmetic in the report's zone,
// which is why it is tested with plain instants and no clock.

import { describe, it, expect } from "vitest";
import { REPORT_TIME_ZONE } from "../reportBuilder/catalog.js";
import { proximaEjecucion, problemasDeHorario, ZONA_DESFASE_MINUTOS, type Horario } from "./nextRun.js";

/** An instant written as La Paz wall-clock time. */
const laPaz = (texto: string) => new Date(`${texto}:00-04:00`);
/** The same instant read back as La Paz wall-clock time, with its weekday. */
const enLaPaz = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: REPORT_TIME_ZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);

const diaria = (hora: number): Horario => ({ frecuencia: "diaria", hora, dia_semana: null, dia_mes: null });
const semanal = (dia_semana: number, hora: number): Horario => ({ frecuencia: "semanal", hora, dia_semana, dia_mes: null });
const mensual = (dia_mes: number, hora: number): Horario => ({ frecuencia: "mensual", hora, dia_semana: null, dia_mes });

describe("the zone the arithmetic assumes", () => {
  it("is still four hours behind UTC on every month of the year", () => {
    // The offset is a constant here, not a lookup, because La Paz has had no
    // daylight saving since 1932. If that ever changes this fails, and the
    // constant has to become a calculation.
    for (let mes = 0; mes < 12; mes++) {
      const mediodiaUtc = new Date(Date.UTC(2026, mes, 15, 12, 0));
      expect(enLaPaz(mediodiaUtc), `mes ${mes + 1}`).toBe(`2026-${String(mes + 1).padStart(2, "0")}-15 08:00`);
    }
    expect(ZONA_DESFASE_MINUTOS).toBe(-240);
  });
});

describe("proximaEjecucion — daily", () => {
  it("is today when the hour has not come yet", () => {
    expect(enLaPaz(proximaEjecucion(diaria(7), laPaz("2026-03-11T06:59")))).toBe("2026-03-11 07:00");
  });

  it("is tomorrow when the hour has passed", () => {
    expect(enLaPaz(proximaEjecucion(diaria(7), laPaz("2026-03-11T07:01")))).toBe("2026-03-12 07:00");
  });

  it("is tomorrow at the very instant it is due: strictly after, or a run would schedule itself again", () => {
    expect(enLaPaz(proximaEjecucion(diaria(7), laPaz("2026-03-11T07:00")))).toBe("2026-03-12 07:00");
  });

  it("reads the day in La Paz: at 02:00 UTC it is still the evening before there", () => {
    // 1 March 02:00 UTC is 28 February 22:00 in La Paz.
    const siguiente = proximaEjecucion(diaria(23), new Date("2026-03-01T02:00:00Z"));
    expect(enLaPaz(siguiente)).toBe("2026-02-28 23:00");
  });

  it("handles midnight and the last hour of the day", () => {
    expect(enLaPaz(proximaEjecucion(diaria(0), laPaz("2026-03-11T12:00")))).toBe("2026-03-12 00:00");
    expect(enLaPaz(proximaEjecucion(diaria(23), laPaz("2026-12-31T23:30")))).toBe("2027-01-01 23:00");
  });
});

describe("proximaEjecucion — to the minute", () => {
  const a = (hora: number, minuto: number): Horario => ({ ...diaria(hora), minuto });

  it("is today while the minute has not come, and tomorrow from the minute itself", () => {
    expect(enLaPaz(proximaEjecucion(a(7, 20), laPaz("2026-03-11T07:19")))).toBe("2026-03-11 07:20");
    expect(enLaPaz(proximaEjecucion(a(7, 20), laPaz("2026-03-11T07:20")))).toBe("2026-03-12 07:20");
  });

  it("is on the dot when no minute is given: what every schedule meant before it had one", () => {
    expect(enLaPaz(proximaEjecucion({ ...diaria(7), minuto: null }, laPaz("2026-03-11T06:00")))).toBe("2026-03-11 07:00");
    expect(enLaPaz(proximaEjecucion(diaria(7), laPaz("2026-03-11T06:00")))).toBe("2026-03-11 07:00");
  });

  it("carries the minute into a weekly and a monthly schedule, across the year's end", () => {
    expect(enLaPaz(proximaEjecucion({ ...semanal(1, 7), minuto: 45 }, laPaz("2026-03-16T07:44")))).toBe("2026-03-16 07:45");
    expect(enLaPaz(proximaEjecucion({ ...semanal(1, 7), minuto: 45 }, laPaz("2026-03-16T07:45")))).toBe("2026-03-23 07:45");
    expect(enLaPaz(proximaEjecucion({ ...mensual(1, 23), minuto: 59 }, laPaz("2026-12-31T23:59")))).toBe("2027-01-01 23:59");
  });

  it("refuses a minute out of range or a fraction, and says which field", () => {
    for (const minuto of [60, -1, 7.5, "20" as never]) {
      expect(problemasDeHorario(a(7, minuto))).toEqual(["Los minutos deben ser un número entero entre 0 y 59."]);
    }
    expect(problemasDeHorario(a(7, 0))).toEqual([]);
    expect(problemasDeHorario(a(7, 59))).toEqual([]);
  });
});

describe("proximaEjecucion — weekly", () => {
  // 11 March 2026 is a Wednesday (ISO weekday 3).
  it("is later this week when the day is still ahead", () => {
    expect(enLaPaz(proximaEjecucion(semanal(5, 7), laPaz("2026-03-11T09:00")))).toBe("2026-03-13 07:00");
  });

  it("is next week when the day has passed", () => {
    expect(enLaPaz(proximaEjecucion(semanal(1, 7), laPaz("2026-03-11T09:00")))).toBe("2026-03-16 07:00");
  });

  it("is today when it is the day and the hour is still ahead, and next week when it is not", () => {
    expect(enLaPaz(proximaEjecucion(semanal(3, 10), laPaz("2026-03-11T09:00")))).toBe("2026-03-11 10:00");
    expect(enLaPaz(proximaEjecucion(semanal(3, 8), laPaz("2026-03-11T09:00")))).toBe("2026-03-18 08:00");
  });

  it("counts Monday as 1 and Sunday as 7", () => {
    expect(enLaPaz(proximaEjecucion(semanal(7, 7), laPaz("2026-03-11T09:00")))).toBe("2026-03-15 07:00");
    expect(proximaEjecucion(semanal(7, 7), laPaz("2026-03-11T09:00")).getUTCDay()).toBe(0);
    expect(proximaEjecucion(semanal(1, 7), laPaz("2026-03-11T09:00")).getUTCDay()).toBe(1);
  });
});

describe("proximaEjecucion — monthly", () => {
  it("is this month when the day is still ahead", () => {
    expect(enLaPaz(proximaEjecucion(mensual(15, 7), laPaz("2026-03-11T09:00")))).toBe("2026-03-15 07:00");
  });

  it("is next month when the day has passed, across the end of the year too", () => {
    expect(enLaPaz(proximaEjecucion(mensual(1, 7), laPaz("2026-03-11T09:00")))).toBe("2026-04-01 07:00");
    expect(enLaPaz(proximaEjecucion(mensual(5, 7), laPaz("2026-12-20T09:00")))).toBe("2027-01-05 07:00");
  });

  it("lands on the 28th in February like in any other month", () => {
    expect(enLaPaz(proximaEjecucion(mensual(28, 7), laPaz("2026-02-10T09:00")))).toBe("2026-02-28 07:00");
    expect(enLaPaz(proximaEjecucion(mensual(28, 7), laPaz("2026-02-28T07:00")))).toBe("2026-03-28 07:00");
  });
});

describe("proximaEjecucion — walking forward", () => {
  it("never returns the instant it was given, nor an earlier one, for any schedule", () => {
    const horarios = [diaria(0), diaria(23), semanal(1, 0), semanal(7, 23), mensual(1, 0), mensual(28, 23)];
    for (const h of horarios) {
      let t = laPaz("2026-01-01T00:00");
      for (let i = 0; i < 40; i++) {
        const siguiente = proximaEjecucion(h, t);
        expect(siguiente.getTime(), JSON.stringify(h)).toBeGreaterThan(t.getTime());
        t = siguiente;
      }
    }
  });

  it("gives a weekly schedule exactly seven days between runs, and a daily one exactly one", () => {
    let t = proximaEjecucion(semanal(2, 6), laPaz("2026-01-01T00:00"));
    for (let i = 0; i < 10; i++) {
      const siguiente = proximaEjecucion(semanal(2, 6), t);
      expect(siguiente.getTime() - t.getTime()).toBe(7 * 24 * 3600_000);
      t = siguiente;
    }
    const d1 = proximaEjecucion(diaria(6), laPaz("2026-01-01T00:00"));
    expect(proximaEjecucion(diaria(6), d1).getTime() - d1.getTime()).toBe(24 * 3600_000);
  });
});

describe("problemasDeHorario — what the table's CHECKs say, said before the insert", () => {
  it("accepts the three shapes", () => {
    expect(problemasDeHorario(diaria(7))).toEqual([]);
    expect(problemasDeHorario(semanal(1, 0))).toEqual([]);
    expect(problemasDeHorario(mensual(28, 23))).toEqual([]);
  });

  it("refuses an hour, a weekday or a day of the month out of range, and fractions", () => {
    expect(problemasDeHorario(diaria(24))).toHaveLength(1);
    expect(problemasDeHorario(diaria(-1))).toHaveLength(1);
    expect(problemasDeHorario(diaria(7.5))).toHaveLength(1);
    expect(problemasDeHorario(semanal(0, 7))).toHaveLength(1);
    expect(problemasDeHorario(semanal(8, 7))).toHaveLength(1);
    expect(problemasDeHorario(mensual(29, 7))).toHaveLength(1);
    expect(problemasDeHorario(mensual(0, 7))).toHaveLength(1);
  });

  it("refuses a day that belongs to another frequency, or a missing one", () => {
    expect(problemasDeHorario({ frecuencia: "diaria", hora: 7, dia_semana: 1, dia_mes: null })).toHaveLength(1);
    expect(problemasDeHorario({ frecuencia: "semanal", hora: 7, dia_semana: null, dia_mes: null })).toHaveLength(1);
    expect(problemasDeHorario({ frecuencia: "semanal", hora: 7, dia_semana: 1, dia_mes: 5 })).toHaveLength(1);
    expect(problemasDeHorario({ frecuencia: "mensual", hora: 7, dia_semana: null, dia_mes: null })).toHaveLength(1);
  });

  it("refuses a frequency it does not know", () => {
    expect(problemasDeHorario({ frecuencia: "anual" as never, hora: 7, dia_semana: null, dia_mes: null })).toHaveLength(1);
  });

  it("throws rather than computing a date from a schedule it would refuse", () => {
    expect(() => proximaEjecucion(semanal(9, 7), laPaz("2026-03-11T09:00"))).toThrow();
  });
});

describe("proximaEjecucion — weekly, asked on a Sunday", () => {
  // 15 March 2026 is a Sunday: the one day JavaScript numbers 0 and ISO 7.
  it("finds every weekday of the coming week, and Sunday itself", () => {
    const domingo = new Date("2026-03-15T09:00:00-04:00");
    const fecha = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: REPORT_TIME_ZONE, dateStyle: "short" }).format(d);
    expect(fecha(proximaEjecucion({ frecuencia: "semanal", hora: 10, dia_semana: 7, dia_mes: null }, domingo))).toBe("2026-03-15");
    expect(fecha(proximaEjecucion({ frecuencia: "semanal", hora: 8, dia_semana: 7, dia_mes: null }, domingo))).toBe("2026-03-22");
    expect(fecha(proximaEjecucion({ frecuencia: "semanal", hora: 8, dia_semana: 1, dia_mes: null }, domingo))).toBe("2026-03-16");
    expect(fecha(proximaEjecucion({ frecuencia: "semanal", hora: 8, dia_semana: 6, dia_mes: null }, domingo))).toBe("2026-03-21");
  });
});
