// Every way the six reports' filter can be wrong, and what each one is told.
//
// This is the half of task C1 that is not about the method. The six handlers
// checked that two fields were present and nothing else, so `fechaInicial=ayer`
// became `Invalid Date`, went into an `Op.between`, and came back as the neutral
// 500 that §3.5 reserves for faults nobody expected. A date typed wrong is not
// a fault; it is something the person can fix, and they cannot fix what they are
// not told.
//
// **The case worth reading twice is `excludeOld`.** In a JSON body it was a
// boolean. As a query parameter — which is what C1 makes it — `false` arrives as
// the string `"false"`, and `if (excludeOld)` is true for that. Every other
// defect here produces an error; this one produces a *plausible report with the
// wrong rows in it*, from a switch the person can see is off. It is the only one
// nobody would ever report as a bug.

import { describe, it, expect } from "vitest";
import { leerFiltro, leerFiltroSinRango } from "./reporteFiltro.js";

/** A valid period, so each test can vary one thing and only one. */
const RANGO = { fechaInicial: "2026-01-01", fechaFinal: "2026-03-31" };

/** The sentence a refusal carries, or null when it was not refused. */
const falla = (r: unknown) => (typeof r === "string" ? r : null);

describe("the period", () => {
  it("reads a valid one", () => {
    const r = leerFiltro({ ...RANGO });

    expect(typeof r).not.toBe("string");
    if (typeof r === "string") return;
    expect(r.fechaInicial.toISOString()).toContain("2026-01-01");
    expect(r.fechaFinal.toISOString()).toContain("2026-03-31");
  });

  it("refuses a date that is not one, instead of letting Postgres refuse it", () => {
    // The 500 this file exists to turn into a 400. `new Date("ayer")` is an
    // `Invalid Date` — which *is* a Date, so an `instanceof` check passes it.
    expect(falla(leerFiltro({ ...RANGO, fechaInicial: "ayer" }))).toMatch(/no son válidas/);
  });

  it("refuses a missing half of it, and does not offer to omit both", () => {
    // The sentence matters. "o ninguna" is true of `estado-red` and of nothing
    // else: told that here, somebody clears both dates and gets the same 400.
    // The first version of this file used one message for both and the test
    // matched on the half they share, so it could not see the difference.
    for (const q of [{ fechaInicial: "2026-01-01" }, { fechaFinal: "2026-03-31" }, {}]) {
      expect(falla(leerFiltro(q))).toBe("Indique la fecha inicial y la final del período.");
    }
  });

  it("refuses an empty parameter, which is what a cleared field sends", () => {
    // `?fechaInicial=` reaches Express as `""`. Sent-and-unreadable rather than
    // absent: a parameter that is in the URL should be readable, and treating
    // the two alike is what makes a filter silently wider elsewhere.
    expect(falla(leerFiltro({ ...RANGO, fechaInicial: "" }))).toMatch(/no son válidas/);
  });

  it("refuses a repeated parameter instead of quietly picking one", () => {
    // Express turns `?fechaInicial=a&fechaInicial=b` into an array.
    expect(falla(leerFiltro({ ...RANGO, fechaInicial: ["2026-01-01", "2026-02-01"] })))
      .toMatch(/no son válidas/);
  });

  it("refuses a period that runs backwards", () => {
    // The screens already check this before calling, so it is defence in depth —
    // and the reports answer an empty set for it, which reads as "no incidents"
    // rather than as "you asked for nothing".
    expect(falla(leerFiltro({ fechaInicial: "2026-03-31", fechaFinal: "2026-01-01" })))
      .toMatch(/anterior a la final/);
  });

  it("accepts the two ends being the same day", () => {
    const r = leerFiltro({ fechaInicial: "2026-01-01", fechaFinal: "2026-01-01" });
    expect(typeof r).not.toBe("string");
  });
});

describe("excludeOld", () => {
  it("is false when nobody sent it", () => {
    const r = leerFiltro({ ...RANGO });
    expect(typeof r !== "string" && r.excludeOld).toBe(false);
  });

  it("reads the string false as false", () => {
    // The assertion this whole file is for. `if (excludeOld)` on the raw query
    // value is **true** for `"false"`, so the switch would be stuck on: the
    // report drops the carried-over incidents while the screen says it keeps
    // them, and the numbers are merely wrong rather than missing.
    const r = leerFiltro({ ...RANGO, excludeOld: "false" });

    expect(typeof r).not.toBe("string");
    expect(typeof r !== "string" && r.excludeOld).toBe(false);
  });

  it("reads the string true as true", () => {
    const r = leerFiltro({ ...RANGO, excludeOld: "true" });
    expect(typeof r !== "string" && r.excludeOld).toBe(true);
  });

  it("refuses a repeated parameter instead of switching itself off", () => {
    // The audit's finding, and the worst shape of it. Read as absent — which is
    // what the first version did with an array — `?excludeOld=true&excludeOld=true`
    // makes the switch **false** while the URL says twice that it is true. No
    // error, no log, a plausible report with the wrong rows.
    expect(falla(leerFiltro({ ...RANGO, excludeOld: ["true", "true"] }))).toMatch(/true o false/);
  });

  it("refuses anything else rather than guessing", () => {
    // `excludeOld=1` is a reasonable thing for somebody to type and an
    // unreasonable thing to interpret. Refusing says which of the two it is.
    for (const valor of ["1", "0", "sí", "TRUE", "yes"]) {
      expect(falla(leerFiltro({ ...RANGO, excludeOld: valor })), valor).toMatch(/true o false/);
    }
  });
});

describe("the stretch of line", () => {
  it("reads the tramo as one id", () => {
    expect(leerFiltro({ ...RANGO, tramo: "14" })).toMatchObject({ tramo: 14 });
    expect(leerFiltro({ ...RANGO })).toMatchObject({ tramo: null });
  });

  it("refuses a tramo it cannot read", () => {
    for (const tramo of ["abc", "1.5", "-3", ["1", "2"], "", "  "]) {
      expect(leerFiltro({ ...RANGO, tramo } as never)).toBe("El tramo indicado no es válido.");
    }
  });

  it("refuses an id larger than the column can hold", () => {
    expect(leerFiltro({ ...RANGO, tramo: "99999999999" })).toBe("El tramo indicado no es válido.");
    expect(leerFiltro({ ...RANGO, tramo: "2147483647" })).toMatchObject({ tramo: 2147483647 });
  });

  it("asks for the tramo by name on the report that cannot answer without one", () => {
    expect(leerFiltro({ ...RANGO }, { tramo: "obligatorio" })).toBe("Indique el tramo.");
  });

  it("refuses the two-city filter of the previous client, on every report", () => {
    const viejo = { ...RANGO, TramoInicial: "3", TramoFinal: "7" };
    expect(leerFiltro(viejo)).toMatch(/dos ciudades/);
    expect(leerFiltroSinRango({ TramoInicial: "3" })).toMatch(/dos ciudades/);
  });
});

describe("estado-red, which may be asked without a period", () => {
  it("accepts no period at all", () => {
    const r = leerFiltroSinRango({});

    expect(typeof r).not.toBe("string");
    expect(typeof r !== "string" && r.fechaInicial).toBeNull();
  });

  it("accepts a whole one", () => {
    const r = leerFiltroSinRango({ ...RANGO });
    expect(typeof r !== "string" && r.fechaInicial).toBeInstanceOf(Date);
  });

  it("refuses half a one, and here the sentence does offer to omit both", () => {
    // The old handler read `if (fechaInicial && fechaFinal)`, so one date alone
    // was silently the same as none: the report covered all of history while the
    // screen showed a start date. This is the one report where "o ninguna" is
    // true, which is why it is the one that says it.
    expect(falla(leerFiltroSinRango({ fechaInicial: "2026-01-01" })))
      .toBe("Indique las dos fechas del período, o ninguna.");
  });

  it("still refuses a date that is not one", () => {
    expect(falla(leerFiltroSinRango({ fechaInicial: "ayer", fechaFinal: "2026-03-31" })))
      .toMatch(/no son válidas/);
  });

  it("applies the same rules to the rest of the filter", () => {
    // Shared with the five above rather than written twice, and asserted so that
    // it stays shared.
    expect(falla(leerFiltroSinRango({ excludeOld: "1" }))).toMatch(/true o false/);
    expect(falla(leerFiltroSinRango({ tramo: "abc" }))).toMatch(/tramo/);
  });
});
