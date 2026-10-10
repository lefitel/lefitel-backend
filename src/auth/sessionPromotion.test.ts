// Promoting the session that proved a factor, and sealing onto it what it
// proved.
//
// Both models are mocked exactly the way `sessionStore.test.ts` mocks
// `SesionModel`: nothing here reaches `osefi_local`, and Task 15's shared
// harness is not needed because this module is exercised directly, never
// through `app.auth.test.ts`'s route-level mocks.
//
// 🔴 **`UsuarioModel` is still mocked although the module no longer imports
// it, and that is the point.** Until 2026-09-08 this file's `apagarLaMecha`
// cleared `usuarios.mfa_grace_until` when a factor was registered, which made
// the fourteen-day deadline renewable at will — register a factor, delete it,
// log in, collect a fresh `MFA_GRACE_DAYS`. The mock is what turns a write to
// `usuarios` reappearing in this module into a red test rather than a silent
// return of that loop; see the last describe in this file.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const sesionUpdate = vi.fn();
const usuarioUpdate = vi.fn();

vi.mock("../models/sesion.model.js", () => ({
  SesionModel: { update: (...a: unknown[]) => sesionUpdate(...a) },
}));
vi.mock("../models/usuario.model.js", () => ({
  UsuarioModel: { update: (...a: unknown[]) => usuarioUpdate(...a) },
}));

const modulo = await import("./sessionPromotion.js");
const { promoverSesion, sellarPruebaDeFactor, sellarContrasena } = modulo;
const { STEP_UP_WINDOW_MINUTES } = await import("../config/security.js");

/** The bound of a `{ [Op.x]: value }` clause, read past the Symbol key. */
const boundOf = (clause: unknown, op: symbol) => (clause as Record<symbol, unknown>)[op];
/** The operators actually present on a `{ [Op.x]: value }` clause. */
const opsOf = (clause: unknown) => Object.getOwnPropertySymbols(clause as object);

beforeEach(() => {
  vi.clearAllMocks();
  sesionUpdate.mockResolvedValue([1]);
  usuarioUpdate.mockResolvedValue([1]);
});

describe("promoverSesion", () => {
  it("promotes a partial session to complete", async () => {
    sesionUpdate.mockResolvedValue([1]);
    expect(await promoverSesion("s1", "totp")).toBe(true);

    const [values] = sesionUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(values.estado).toBe("completa");
    expect(values.mfa_satisfied_at).toBeInstanceOf(Date);
    expect(values.mfa_source).toBe("totp");
  });

  it("promotes an onboarding session to complete", async () => {
    // Decision 8's actual point, and the one detail hallazgo C15's own table
    // gets wrong (it names only 'parcial'): `estadoInicialDeSesion` can open
    // a session in *either* state, so the WHERE has to reach both. Narrowing
    // this back to `['parcial']` would compile, pass the test above, and
    // silently strand every `onboarding` session at the fourteen-day cliff
    // even after it proves its factor — which is exactly hallazgo D2.
    await promoverSesion("s1", "totp");

    const [, options] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    const clause = options.where.estado;
    expect(opsOf(clause)).toContain(Op.in);
    expect(boundOf(clause, Op.in)).toEqual(expect.arrayContaining(["parcial", "onboarding"]));
  });

  it("refuses to promote a session that is not the caller's own", async () => {
    // There is no id_usuario parameter to cross-check against here — the
    // only thing standing between this function and promoting a stranger's
    // session is that the WHERE names *exactly* the id it was given, nothing
    // wider. `toEqual` on the whole where, not `toMatchObject`, so an
    // implementation that drops `id` and filters on `estado` alone — which
    // would promote *every* parcial/onboarding row in the table, "the
    // caller's own" included only by accident — fails this test even though
    // it would still pass the two tests above.
    await promoverSesion("mine", "totp");
    const [, first] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(Object.keys(first.where).sort()).toEqual(["estado", "id"]);
    expect(first.where.id).toBe("mine");

    // And the WHERE is rebuilt from this call's own argument every time,
    // never cached, defaulted, or left over from a previous caller's session.
    sesionUpdate.mockClear();
    await promoverSesion("someone-elses", "codigo");
    const [, second] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(second.where.id).toBe("someone-elses");
    expect(second.where.id).not.toBe("mine");
  });

  it("leaves an already complete session alone", async () => {
    // estado IN (...) excludes 'completa', so a session already promoted
    // matches nothing — this is what makes calling this twice idempotent
    // instead of re-stamping mfa_satisfied_at over a session that was
    // already satisfied.
    sesionUpdate.mockResolvedValue([0]);
    expect(await promoverSesion("s1", "totp")).toBe(false);
  });
});

describe("sellarPruebaDeFactor", () => {
  // Hallazgo F2/B-1: `estadoInicialDeSesion` can open a brand-new session as
  // `completa` for an account with no factor still inside its grace period.
  // When that account registers its first factor, `promoverSesion`'s WHERE
  // matches nothing — the row was never `parcial`/`onboarding` — so it never
  // seals `mfa_satisfied_at`, and `requireStepUp` refuses that session
  // step-up for the rest of its life. This function is the other half of
  // that write, for the one case `promoverSesion` was never meant to cover.
  it("seals mfa_satisfied_at and mfa_source unconditionally, whatever the row's own estado is", async () => {
    sesionUpdate.mockResolvedValue([1]);
    await sellarPruebaDeFactor("s1", "totp");

    const [values, options] = sesionUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(values.mfa_satisfied_at).toBeInstanceOf(Date);
    expect(values.mfa_source).toBe("totp");
    // No `estado` clause in the WHERE at all — unlike `promoverSesion`, this
    // writes the caller's own session id and nothing else.
    expect(options.where).toEqual({ id: "s1" });
  });

  // 🔴 The return value exists for one caller and it is load-bearing there:
  // the recovery-code path spends one of ten printed codes in the same
  // transaction, and has to unwind that if there turned out to be no session.
  // With `void` that was inexpressible, and the branch instead rolled back a
  // perfectly valid code every time the row was stored `completa`.
  it("says whether a row was actually sealed", async () => {
    sesionUpdate.mockResolvedValue([1]);
    expect(await sellarPruebaDeFactor("s1", "totp")).toBe(true);

    sesionUpdate.mockResolvedValue([0]);
    expect(await sellarPruebaDeFactor("s1", "totp")).toBe(false);
  });

  it("does not write estado — the row is already completa by the time this is ever called", async () => {
    await sellarPruebaDeFactor("s1", "totp");
    const [values] = sesionUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(values.estado).toBeUndefined();
    expect(Object.keys(values).sort()).toEqual(["mfa_satisfied_at", "mfa_source"]);
  });

  it("refuses to touch a session that is not the caller's own — the WHERE names exactly the id it was given", async () => {
    await sellarPruebaDeFactor("mine", "totp");
    const [, first] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(Object.keys(first.where)).toEqual(["id"]);
    expect(first.where.id).toBe("mine");
  });

  it("joins a transaction it is handed", async () => {
    const t = { LOCK: "fake" } as never;
    await sellarPruebaDeFactor("s1", "totp", { transaction: t });
    expect(sesionUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transaction: t }),
    );
  });

  it("works with no transaction at all", async () => {
    await sellarPruebaDeFactor("s1", "totp");
    expect(sesionUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transaction: undefined }),
    );
  });
});

describe("sellarContrasena", () => {
  it("stamps password_confirmed_at and nothing else", async () => {
    // 🔴 And **not** `mfa_satisfied_at`. That column means "a factor was
    // proved here", and `estadoEfectivo` reads it to decide an account has
    // nothing left to set up: a password written there would let an account
    // with no factor at all read as `completa` past its fourteen-day
    // deadline — the outage `mfa_grace_until` exists to prevent. Four
    // auditors found that independently.
    await sellarContrasena("s1");
    const [values] = sesionUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(values)).toEqual(["password_confirmed_at"]);
    expect(values.password_confirmed_at).toBeInstanceOf(Date);
  });

  it("no re-sella dentro de la ventana: el WHERE lleva la antigüedad", async () => {
    // 🔴 La promesa es «diez minutos fijos, sin renovarse». Sin esta
    // cláusula, cada confirmación mueve la fecha y la ventana se sostiene
    // sola indefinidamente en cuanto alguien trabaja seguido sobre una ruta
    // con `sinVentana`, que pide la contraseña en cada petición.
    const antes = Date.now();
    await sellarContrasena("s1");
    const despues = Date.now();

    const [, options] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    const alternativas = (options.where as Record<symbol, unknown>)[Op.or] as Record<
      string,
      unknown
    >[];
    expect(alternativas).toHaveLength(2);
    // O nunca se confirmó...
    expect(alternativas[0]).toEqual({ password_confirmed_at: null });
    // ...o lo que hay es más viejo que la ventana entera.
    const cota = boundOf(alternativas[1].password_confirmed_at, Op.lt) as Date;
    expect(opsOf(alternativas[1].password_confirmed_at)).toEqual([Op.lt]);
    const ventana = STEP_UP_WINDOW_MINUTES * 60_000;
    expect(cota.getTime()).toBeGreaterThanOrEqual(antes - ventana);
    expect(cota.getTime()).toBeLessThanOrEqual(despues - ventana);
  });

  it("nombra exactamente la sesión que le dan, y sólo si sigue viva", async () => {
    // `id` solo bastaría para la fila correcta; `revoked_at` es lo que impide
    // que una sesión ya cerrada salga de aquí con una ventana abierta. Se
    // comprueban las claves enteras, no `toMatchObject`, porque lo que hay
    // que descartar es un WHERE *más ancho* del que se lee aquí.
    await sellarContrasena("mia");
    const [, options] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(Object.keys(options.where).sort()).toEqual(["id", "revoked_at"]);
    expect(options.where.id).toBe("mia");
    expect(options.where.revoked_at).toBeNull();

    // Y el WHERE se construye con el argumento de cada llamada, nunca con el
    // de la anterior.
    sesionUpdate.mockClear();
    await sellarContrasena("ajena");
    const [, segunda] = sesionUpdate.mock.calls[0] as [unknown, { where: Record<string, unknown> }];
    expect(segunda.where.id).toBe("ajena");
  });

  it("dice si movió una fila", async () => {
    sesionUpdate.mockResolvedValue([1]);
    expect(await sellarContrasena("s1")).toBe(true);

    // Cero es lo que devuelve tanto «no hay tal sesión viva» como «esta
    // sesión ya está dentro de su ventana», que es el caso normal.
    sesionUpdate.mockResolvedValue([0]);
    expect(await sellarContrasena("s1")).toBe(false);
  });
});

describe("la transacción del llamador", () => {
  it("joins a transaction it is handed, so a spent code and its seal commit together", async () => {
    // Spending a recovery code and sealing the session it just proved must
    // commit or fail as one: a code consumed without a seal costs somebody one
    // of ten and leaves no trace of why. `gastarCodigo` already takes a
    // transaction for this; without the same parameter here the pair cannot be
    // closed at all.
    const t = { LOCK: "fake" } as never;
    sesionUpdate.mockResolvedValue([1]);

    await promoverSesion("s-1", "codigo", { transaction: t });

    expect(sesionUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transaction: t }),
    );
  });

  it("works with no transaction at all, which is the TOTP path", async () => {
    // The other direction: one statement composed with nothing needs no
    // transaction, and making the parameter required would have forced every
    // caller to invent one.
    sesionUpdate.mockResolvedValue([1]);

    await promoverSesion("s-1", "totp");

    expect(sesionUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transaction: undefined }),
    );
  });
});

describe("nada de este módulo escribe en `usuarios`", () => {
  it("no toca el plazo de gracia por mucho que se pruebe un factor", async () => {
    /**
     * El bucle que se cerró el 2026-09-08, convertido en alambre.
     *
     * `apagarLaMecha` vivía aquí y ponía `usuarios.mfa_grace_until` a NULL al
     * registrar un factor. NULL lo lee `estadoInicialDeSesion` como «el reloj
     * no ha empezado nunca», así que el siguiente login estampaba catorce días
     * nuevos: registrar un factor y borrarlo renovaba el plazo tantas veces
     * como se quisiera, y con una passkey ni siquiera hace falta buzón.
     *
     * Este test no comprueba lo que el módulo hace, sino lo que ya no puede
     * hacer: se ejercitan sus tres escrituras y ninguna puede haber pasado por
     * `UsuarioModel`. Si alguien vuelve a añadir aquí un write a `usuarios`,
     * el mock lo recoge y esto se pone rojo — que es toda su razón de ser.
     */
    await promoverSesion("s1", "totp");
    await sellarPruebaDeFactor("s1", "totp");
    await sellarContrasena("s1");

    expect(usuarioUpdate).not.toHaveBeenCalled();
    // Y ninguna exportación de este módulo puede volver a llamarse así: el
    // nombre es lo que buscaría quien reintrodujese la función.
    expect(modulo).not.toHaveProperty("apagarLaMecha");
  });
});
