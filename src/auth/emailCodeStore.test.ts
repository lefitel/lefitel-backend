// `emailCodeStore` — minting, charging, spending, purging the login code by
// email. The fake table below holds rows and reads the `where` it is handed,
// the way `recoveryCodeStore.test.ts` and `factorInventory.test.ts` do, so a
// query that forgets a clause counts a row it should not. The one thing a
// fake cannot exercise is the atomicity of `cobrarIntento`: that lives in a
// single SQL statement, and the test pins the statement — one `UPDATE …
// RETURNING`, no SELECT before it — which is the property the design's S2
// finding depends on.
//
// bcrypt is mocked: nothing here compares, and a real hash at cost 12 is a
// quarter of a second per mint for no assertion.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Op, QueryTypes } from "sequelize";

type Fila = Record<string, unknown>;

/** Rows of the fake `codigo_correo` table. */
let filas: Fila[] = [];
let siguienteId = 1;

/** The same operator-by-meaning matcher the sibling fakes use. */
function coincide(fila: Fila, where: Fila): boolean {
  return Object.entries(where).every(([columna, clausula]) => {
    const valor = fila[columna];
    if (clausula === null || clausula instanceof Date || typeof clausula !== "object") {
      return valor === clausula;
    }
    return Object.getOwnPropertySymbols(clausula).every((op) => {
      const limite = (clausula as Record<symbol, unknown>)[op];
      const v = valor instanceof Date ? valor.getTime() : (valor as number);
      const l = limite instanceof Date ? limite.getTime() : (limite as number);
      if (op === Op.gt) return v > l;
      if (op === Op.lt) return v < l;
      if (op === Op.ne || op === Op.not) return valor !== limite;
      if (op === Op.eq || op === Op.is) return valor === limite;
      throw new Error(`the fake table does not understand ${String(op)}`);
    });
  });
}

const findAll = vi.fn(async (opciones: { where: Fila; order?: [string, string][] }) => {
  let r = filas.filter((f) => coincide(f, opciones.where));
  if (opciones.order?.[0]?.[0] === "created_at" && opciones.order[0][1] === "DESC") {
    r = [...r].sort((a, b) => (b.created_at as Date).getTime() - (a.created_at as Date).getTime());
  }
  return r.map((f) => ({ dataValues: { ...f } }));
});
const update = vi.fn(async (valores: Fila, opciones: { where: Fila; transaction?: unknown }) => {
  let n = 0;
  for (const f of filas) {
    if (coincide(f, opciones.where)) {
      Object.assign(f, valores);
      n += 1;
    }
  }
  return [n];
});
/** The partial unique index, enforced by the fake: a second pending row for one account is a 23505. */
const create = vi.fn(async (valores: Fila, _opciones?: { transaction?: unknown }) => {
  if (filas.some((f) => f.id_usuario === valores.id_usuario && f.used_at === null)) {
    throw Object.assign(new Error("duplicate key"), {
      name: "SequelizeUniqueConstraintError",
      parent: { constraint: "codigo_correo_pendiente_idx" },
    });
  }
  const fila = { id: siguienteId++, ...valores };
  filas.push(fila);
  return { dataValues: fila };
});
const destroy = vi.fn(async (opciones: { where: Fila }) => {
  const antes = filas.length;
  filas = filas.filter((f) => !coincide(f, opciones.where));
  return antes - filas.length;
});
vi.mock("../models/codigoCorreo.model.js", () => ({
  CodigoCorreoModel: {
    findAll: (...a: unknown[]) => findAll(...(a as [never])),
    update: (...a: unknown[]) => update(...(a as [never, never])),
    create: (...a: unknown[]) => create(...(a as [never])),
    destroy: (...a: unknown[]) => destroy(...(a as [never])),
  },
}));

const TX = { id: "una-transaccion" };
const query = vi.fn();
vi.mock("../database/sequelize.js", () => ({
  sequelize: {
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb(TX),
    query: (...a: unknown[]) => query(...a),
  },
}));

vi.mock("bcryptjs", () => ({
  default: { hash: async (texto: string) => `hash(${texto})` },
}));

const randomInt = vi.fn((..._a: unknown[]) => 123456);
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt: (...a: unknown[]) => randomInt(...(a as [never])),
}));

const { emitirCodigo, cobrarIntento, liquidarCodigo, purgarCodigosCaducados, generarCodigo } =
  await import("./emailCodeStore.js");
const {
  EMAIL_CODE_TTL_MS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_RESEND_SECONDS,
  EMAIL_CODE_HOURLY_LIMIT,
  EMAIL_CODE_DAILY_LIMIT,
} = await import("../config/security.js");

const YO = 7;
const OTRO = 9;
const AHORA = new Date("2026-09-03T10:00:00.000Z");
const seg = (n: number) => n * 1000;
const min = (n: number) => seg(60 * n);

/** A row minted `hace` ms before AHORA, spent or not. */
function codigo(hace: number, extra: Fila = {}): Fila {
  return {
    id: siguienteId++,
    id_usuario: YO,
    email_destino: "yo@osefi.net",
    codigo_hash: "hash(000000)",
    intentos: 0,
    expires_at: new Date(AHORA.getTime() - hace + EMAIL_CODE_TTL_MS),
    used_at: new Date(AHORA.getTime() - hace + 1000),
    created_at: new Date(AHORA.getTime() - hace),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  filas = [];
  siguienteId = 1;
  randomInt.mockReturnValue(123456);
  query.mockResolvedValue([[], 0]);
});

describe("generarCodigo", () => {
  it("is six digits, zero-padded, drawn with randomInt over the whole million", () => {
    randomInt.mockReturnValue(7);
    expect(generarCodigo()).toBe("000007");
    expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
  });
});

describe("emitirCodigo", () => {
  it("mints a code, stores its bcrypt, and hands the plaintext back once", async () => {
    const r = await emitirCodigo(YO, "yo@osefi.net", AHORA);
    expect(r).toEqual({ codigo: "123456" });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id_usuario: YO,
      email_destino: "yo@osefi.net",
      codigo_hash: "hash(123456)",
      used_at: null,
      created_at: AHORA,
      expires_at: new Date(AHORA.getTime() + EMAIL_CODE_TTL_MS),
    });
    expect(JSON.stringify(filas)).not.toContain('"123456"');
  });

  it("burns the pending code before inserting the new one, inside one transaction", async () => {
    filas = [codigo(min(2), { used_at: null })];
    const r = await emitirCodigo(YO, "yo@osefi.net", AHORA);
    expect(r).toEqual({ codigo: "123456" });
    expect(filas[0].used_at).toEqual(AHORA);
    expect(update).toHaveBeenCalledWith({ used_at: AHORA }, { where: { id_usuario: YO, used_at: null }, transaction: TX });
    expect(create.mock.calls[0][1]).toEqual({ transaction: TX });
  });

  it("refuses inside the cooldown, saying how many seconds are left", async () => {
    filas = [codigo(seg(EMAIL_CODE_RESEND_SECONDS - 1))];
    expect(await emitirCodigo(YO, "yo@osefi.net", AHORA)).toEqual({ rechazado: "cooldown", reintento_en_s: 1 });
    expect(create).not.toHaveBeenCalled();
  });

  it("lets the next one through the second the cooldown is over", async () => {
    filas = [codigo(seg(EMAIL_CODE_RESEND_SECONDS))];
    expect(await emitirCodigo(YO, "yo@osefi.net", AHORA)).toEqual({ codigo: "123456" });
  });

  it("refuses the code past the hourly cap, until the oldest of the hour leaves the window", async () => {
    // Five in the last hour, the oldest 50 minutes ago: the window frees in 10.
    filas = [codigo(min(50)), codigo(min(40)), codigo(min(30)), codigo(min(20)), codigo(min(5))];
    expect(filas).toHaveLength(EMAIL_CODE_HOURLY_LIMIT);
    expect(await emitirCodigo(YO, "yo@osefi.net", AHORA)).toEqual({ rechazado: "tope-hora", reintento_en_s: 10 * 60 });
  });

  it("does not count another account's codes, nor codes older than a day", async () => {
    filas = [
      ...Array.from({ length: EMAIL_CODE_HOURLY_LIMIT }, (_, i) => codigo(min(5 + i), { id_usuario: OTRO })),
      codigo(min(25 * 60)),
    ];
    expect(await emitirCodigo(YO, "yo@osefi.net", AHORA)).toEqual({ codigo: "123456" });
    expect(findAll.mock.calls[0][0].where).toEqual({
      id_usuario: YO,
      created_at: { [Op.gt]: new Date(AHORA.getTime() - 24 * 60 * 60 * 1000) },
    });
  });

  it("refuses the code past the daily cap even when the last hour is quiet", async () => {
    // Twelve spread over the day, none in the last hour, the oldest 23 h ago.
    filas = Array.from({ length: EMAIL_CODE_DAILY_LIMIT }, (_, i) => codigo(min(70 + i * 110)));
    const r = await emitirCodigo(YO, "yo@osefi.net", AHORA);
    expect(r).toMatchObject({ rechazado: "tope-dia" });
    // The oldest is 70 + 11*110 = 1280 minutes ago; it leaves the day in 1440 − 1280 = 160.
    expect((r as { reintento_en_s: number }).reintento_en_s).toBe(160 * 60);
  });

  it("answers a lost mint race as a cooldown: the other request's code is in the mail", async () => {
    // The fake enforces the partial unique index: a pending row that the
    // burn did not see (another transaction's insert) makes `create` throw.
    update.mockResolvedValueOnce([0]);
    filas = [codigo(seg(0), { used_at: null, id_usuario: YO })];
    // Bypass the cooldown by dating the visible rows far enough back.
    filas[0].created_at = new Date(AHORA.getTime() - min(5));
    const r = await emitirCodigo(YO, "yo@osefi.net", AHORA);
    expect(r).toEqual({ rechazado: "cooldown", reintento_en_s: EMAIL_CODE_RESEND_SECONDS });
  });

  it("rethrows anything that is not the unique violation", async () => {
    create.mockRejectedValueOnce(new Error("pool agotado"));
    await expect(emitirCodigo(YO, "yo@osefi.net", AHORA)).rejects.toThrow("pool agotado");
  });

  it("rethrows a unique violation on any other index — a primary-key collision is a 500, not a cooldown", async () => {
    create.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), {
        name: "SequelizeUniqueConstraintError",
        parent: { constraint: "codigo_correo_pkey" },
      }),
    );
    await expect(emitirCodigo(YO, "yo@osefi.net", AHORA)).rejects.toThrow("duplicate key");
  });
});

describe("cobrarIntento — one statement, charged before the compare", () => {
  it("issues a single UPDATE … RETURNING with the cap, the liveness clauses and the verified-address subquery", async () => {
    query.mockResolvedValue([[{ id: 3, codigo_hash: "hash(123456)", agotado: false }], 1]);
    const r = await cobrarIntento(YO, AHORA);
    expect(r).toEqual({ id: 3, codigo_hash: "hash(123456)", agotado: false });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, opciones] = query.mock.calls[0] as [string, { replacements: Fila; type: unknown }];
    expect(sql).toMatch(/^UPDATE codigo_correo /);
    expect(sql).toContain("SET intentos = intentos + 1");
    expect(sql).toContain("used_at = CASE WHEN intentos + 1 >= :max THEN now() ELSE used_at END");
    // The app's clock, not the database's: the same clock that wrote the row.
    expect(sql).toContain("WHERE id_usuario = :id AND used_at IS NULL AND expires_at > :ahora");
    expect(sql).toContain("email_destino = (SELECT email FROM usuarios WHERE id = :id AND email_verified_at IS NOT NULL AND \"deletedAt\" IS NULL)");
    expect(sql).toMatch(/RETURNING id, codigo_hash, \(used_at IS NOT NULL\) AS agotado$/);
    expect(opciones.replacements).toEqual({ id: YO, max: EMAIL_CODE_MAX_ATTEMPTS, ahora: AHORA });
    expect(opciones.type).toBe(QueryTypes.UPDATE);
    // No transaction: the bcrypt that follows must not hold a connection.
    expect(opciones).not.toHaveProperty("transaction");
  });

  // The plan's required test: the fake below implements the statement's own
  // semantics on one row — increment while unspent and live, burn at the
  // cap, return the row as updated — so what is observed is the contract the
  // controller relies on, not the SQL text.
  it("hands the hash back five times, burning on the fifth, and null from the sixth on — under concurrent calls", async () => {
    const fila = { id: 3, codigo_hash: "hash(123456)", intentos: 0, used_at: null as Date | null };
    query.mockImplementation(async (_sql: string, o: { replacements: { max: number } }) => {
      if (fila.used_at !== null) return [[], 0];
      fila.intentos += 1;
      if (fila.intentos >= o.replacements.max) fila.used_at = new Date();
      return [[{ id: fila.id, codigo_hash: fila.codigo_hash, agotado: fila.used_at !== null }], 1];
    });
    const r = await Promise.all(Array.from({ length: EMAIL_CODE_MAX_ATTEMPTS + 1 }, () => cobrarIntento(YO)));
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS - 1; i++) {
      expect(r[i], `intento ${i + 1}`).toEqual({ id: 3, codigo_hash: "hash(123456)", agotado: false });
    }
    expect(r[EMAIL_CODE_MAX_ATTEMPTS - 1]).toEqual({ id: 3, codigo_hash: "hash(123456)", agotado: true });
    expect(r[EMAIL_CODE_MAX_ATTEMPTS]).toBeNull();
    expect(fila.intentos).toBe(EMAIL_CODE_MAX_ATTEMPTS);
  });

  it("answers null when no live code matched, whatever the reason", async () => {
    query.mockResolvedValue([[], 0]);
    expect(await cobrarIntento(YO)).toBeNull();
  });

  it("never reads the row first: the charge and the read are the same statement", async () => {
    await cobrarIntento(YO);
    expect(findAll).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("liquidarCodigo", () => {
  it("spends the row by id only while it is still unspent, on the caller's transaction", async () => {
    filas = [codigo(0, { id: 11, used_at: null })];
    expect(await liquidarCodigo(11, { transaction: TX as never })).toBe(true);
    expect(update).toHaveBeenCalledWith(
      { used_at: expect.any(Date) },
      { where: { id: 11, used_at: null }, transaction: TX },
    );
  });

  it("answers false for a row somebody else already spent", async () => {
    filas = [codigo(0, { id: 12 })];
    expect(await liquidarCodigo(12)).toBe(false);
  });
});

describe("purgarCodigosCaducados", () => {
  it("sweeps only the rows older than a day, spent or not", async () => {
    filas = [
      codigo(min(25 * 60), { id: 1 }),
      codigo(min(23 * 60), { id: 2 }),
      codigo(min(25 * 60), { id: 3, used_at: null }),
      codigo(0, { id: 4, used_at: null }),
    ];
    expect(await purgarCodigosCaducados(AHORA)).toBe(2);
    expect(filas.map((f) => f.id)).toEqual([2, 4]);
    expect(destroy.mock.calls[0][0].where).toEqual({
      created_at: { [Op.lt]: new Date(AHORA.getTime() - 24 * 60 * 60 * 1000) },
    });
  });

  // 🔴 The audit's finding on the first draft: a sweep of "spent or expired"
  // rows deleted, on every mint, the rows the caps are counted from.
  it("leaves the caps standing: five spent codes in the last hour still refuse the sixth after a sweep", async () => {
    filas = [codigo(min(50)), codigo(min(40)), codigo(min(30)), codigo(min(20)), codigo(min(5))];
    expect(await purgarCodigosCaducados(AHORA)).toBe(0);
    expect(await emitirCodigo(YO, "yo@osefi.net", AHORA)).toMatchObject({ rechazado: "tope-hora" });
  });
});
