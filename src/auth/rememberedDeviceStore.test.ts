// The `dispositivo_recordado` table: what the sweep deletes, and what
// archiving an account cuts off.
//
// Every rule below is checked against an in-memory table that really evaluates
// the `where` it is handed, and not against a mock that returns a number
// without looking at its argument. The difference is the whole point: such a
// mock makes "deletes the expired ones" pass for a query that deletes the live
// ones instead, and even a careful shape assertion — "the clause mentions
// `expires_at`" — cannot tell `Op.lt` from `Op.gt`, which here is the
// difference between sweeping the dead devices and sweeping every device still
// in use.
//
// So what each test names is which rows survive the call, which is the only
// thing the rest of the system will ever notice.
//
// The transaction is pinned here *and* in `usuario.controller.test.ts`, the
// same way `revokeAllSessionsOf` is covered from both sides
// (`sessionStore.test.ts`). Neither side is enough alone: the controller test
// only sees the argument this module is handed, so deleting the `transaction:`
// line inside the query leaves it green, and this one only sees the forwarding,
// not whether the controller ever opens a transaction to forward.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op } from "sequelize";

const destroy = vi.fn();
const update = vi.fn();

vi.mock("../models/dispositivoRecordado.model.js", () => ({
  DispositivoRecordadoModel: {
    destroy: (...a: unknown[]) => destroy(...a),
    update: (...a: unknown[]) => update(...a),
  },
}));

const { purgeExpiredRememberedDevices, revokeAllRememberedDevicesOf } = await import(
  "./rememberedDeviceStore.js"
);
const { REMEMBERED_DEVICE_REVOKED_MAX_AGE_DAYS } = await import("../config/security.js");

type Fila = Record<string, unknown>;

/**
 * Decides whether one row satisfies a Sequelize `where`.
 *
 * Operators are read by **meaning**, not by identity. `Op.ne` and `Op.not`
 * compile to the same SQL, so rewriting one as the other — a correct refactor —
 * leaves these tests green, while swapping `Op.lt` for `Op.gt` flips which rows
 * survive and turns them red. A test that asserts the shape of the clause gets
 * this exactly backwards: red at the harmless rewrite, green at the harmful
 * one.
 *
 * Anything it does not understand throws instead of quietly matching. A fake
 * that shrugs at an operator it has never seen is a fake that stops testing
 * anything the day the query grows a condition.
 */
function matches(row: Fila, where: Fila): boolean {
  for (const combinador of Object.getOwnPropertySymbols(where)) {
    const ramas = (where as Record<symbol, unknown>)[combinador] as Fila[];
    if (combinador === Op.or) {
      if (!ramas.some((rama) => matches(row, rama))) return false;
    } else if (combinador === Op.and) {
      if (!ramas.every((rama) => matches(row, rama))) return false;
    } else {
      throw new Error(`the fake table does not understand the combinator ${String(combinador)}`);
    }
  }

  return Object.entries(where).every(([columna, clausula]) => {
    const valor = row[columna];
    if (clausula === null || clausula instanceof Date || typeof clausula !== "object") {
      return valor === clausula;
    }
    return Object.getOwnPropertySymbols(clausula).every((op) => {
      const limite = (clausula as Record<symbol, unknown>)[op];
      if (op === Op.eq) return valor === limite;
      if (op === Op.ne || op === Op.not) return valor !== limite;
      if (op === Op.lt) return valor instanceof Date && limite instanceof Date && valor < limite;
      if (op === Op.lte) return valor instanceof Date && limite instanceof Date && valor <= limite;
      if (op === Op.gt) return valor instanceof Date && limite instanceof Date && valor > limite;
      if (op === Op.gte) return valor instanceof Date && limite instanceof Date && valor >= limite;
      throw new Error(`the fake table does not understand the operator ${String(op)}`);
    });
  });
}

const DIA_MS = 86_400_000;
const hace = (dias: number) => new Date(Date.now() - dias * DIA_MS);
const dentroDe = (dias: number) => new Date(Date.now() + dias * DIA_MS);

const DUENO = 7;
const AJENO = 99;

/**
 * One fixture per state a row of this table can be in, named after the state
 * and not after what any one test expects of it — every test below reads the
 * same five rows and disagrees only about which of them survive.
 */
const FIXTURES: Fila[] = [
  { id: "vivo", id_usuario: DUENO, expires_at: dentroDe(10), revoked_at: null },
  { id: "caducado", id_usuario: DUENO, expires_at: hace(1), revoked_at: null },
  { id: "revocado-hoy", id_usuario: DUENO, expires_at: dentroDe(10), revoked_at: hace(1) },
  {
    id: "revocado-hace-mucho",
    id_usuario: DUENO,
    expires_at: dentroDe(10),
    revoked_at: hace(REMEMBERED_DEVICE_REVOKED_MAX_AGE_DAYS + 1),
  },
  { id: "de-otra-cuenta", id_usuario: AJENO, expires_at: dentroDe(10), revoked_at: null },
];

let tabla: Fila[] = [];
const idsRestantes = () => tabla.map((f) => f.id);
const fila = (id: string) => tabla.find((f) => f.id === id) as Fila;

beforeEach(() => {
  vi.clearAllMocks();
  tabla = FIXTURES.map((f) => ({ ...f }));

  destroy.mockImplementation(async ({ where }: { where: Fila }) => {
    const sobreviven = tabla.filter((f) => !matches(f, where));
    const borradas = tabla.length - sobreviven.length;
    tabla = sobreviven;
    return borradas;
  });

  update.mockImplementation(async (valores: Fila, { where }: { where: Fila }) => {
    const tocadas = tabla.filter((f) => matches(f, where));
    for (const f of tocadas) Object.assign(f, valores);
    return [tocadas.length];
  });
});

describe("purgeExpiredRememberedDevices", () => {
  it("deletes a device whose expiry has already passed", async () => {
    await purgeExpiredRememberedDevices();
    expect(idsRestantes()).not.toContain("caducado");
  });

  it("keeps a device that has neither expired nor been revoked", async () => {
    // The rule an inverted operator breaks. `Op.gt` where `Op.lt` belongs reads
    // as "expires in the future", which deletes every device still in use and
    // keeps every dead one — the exact opposite of the sweep, and a change no
    // assertion about the *shape* of the clause can see.
    await purgeExpiredRememberedDevices();
    expect(idsRestantes()).toContain("vivo");
  });

  it("deletes a device revoked longer ago than the retention window", async () => {
    await purgeExpiredRememberedDevices();
    expect(idsRestantes()).not.toContain("revocado-hace-mucho");
  });

  it("keeps a device revoked recently, so the revocation is still on the record", async () => {
    // Deleting a revocation the instant it happens erases the answer to "was
    // that laptop cut off, and when" — the question asked right after a device
    // is lost or somebody leaves the company.
    await purgeExpiredRememberedDevices();
    expect(idsRestantes()).toContain("revocado-hoy");
  });

  it("returns how many rows it actually deleted", async () => {
    expect(await purgeExpiredRememberedDevices()).toBe(2);
  });
});

describe("revokeAllRememberedDevicesOf", () => {
  it("stamps revoked_at on every live device of that account", async () => {
    await revokeAllRememberedDevicesOf(DUENO);
    expect(fila("vivo").revoked_at).toBeInstanceOf(Date);
  });

  it("leaves another account's devices alone", async () => {
    // `id_usuario` is this table's whole security property — see the model.
    // Without it in the WHERE, archiving one leaver cuts off everybody who has
    // ever ticked "remember me".
    await revokeAllRememberedDevicesOf(DUENO);
    expect(fila("de-otra-cuenta").revoked_at).toBeNull();
  });

  it("does not rewrite the stamp of a device already revoked", async () => {
    // Overwriting it moves the record of when the device was really cut off to
    // whenever the last unrelated revocation ran, and restarts that row's
    // retention clock every time.
    const antes = fila("revocado-hoy").revoked_at;
    await revokeAllRememberedDevicesOf(DUENO);
    expect(fila("revocado-hoy").revoked_at).toBe(antes);
  });

  it("returns how many devices it revoked", async () => {
    expect(await revokeAllRememberedDevicesOf(DUENO)).toBe(2);
  });

  it("runs inside the caller's transaction when it is given one", async () => {
    // `deleteUsuario` archives an account, ends its sessions and cuts off its
    // remembered devices, and any one of the three on its own is worse than
    // none. Without the option reaching the query, this revocation commits by
    // itself: an archive that then rolls back leaves an account that looks
    // perfectly fine and whose devices have already been cut off.
    //
    // This is the half `usuario.controller.test.ts` cannot see. That file
    // asserts the argument this module is *handed*; delete the `transaction:`
    // line inside the query here and it stays green while the write escapes the
    // transaction entirely. Same two-sided cover `revokeAllSessionsOf` has.
    const transaction = { id: "una-transaccion" } as unknown as Parameters<
      typeof revokeAllRememberedDevicesOf
    >[1]["transaction"];
    await revokeAllRememberedDevicesOf(DUENO, { transaction });
    const [, options] = update.mock.calls[0] as [unknown, { transaction?: unknown }];
    expect(options.transaction).toBe(transaction);
  });
});
