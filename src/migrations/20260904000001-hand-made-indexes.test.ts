// The nine hand-made indexes, brought into a migration.
//
// There is no database in this suite — the configured one is a copy of
// production — so nothing here can watch an index get built. What it can do is
// far more useful, because the dangerous mistakes in this migration are all
// mistakes of *spelling*, and spelling is exactly what a string can be read for.
//
// Two of them would do real damage and neither shows up as a failure anywhere:
//
//   - **A capital letter in an index name.** `idx_postes_ciudada` and
//     `idx_postes_ciudadb` are lower case in the database, because they were
//     created with the name unquoted and Postgres folds that. Written here as
//     `idx_postes_ciudadA` and quoted — which is the natural thing to write, and
//     what `queryInterface.addIndex` does on its own — `IF NOT EXISTS` finds no
//     such name and builds a **second index over the same column**. Production
//     ends with four indexes on `postes` where it has two, and every write to
//     the pole register pays for the two useless ones for good. Nothing fails.
//     Nothing logs. The suite stays green.
//   - **A missing pair of quotes on a camelCase identifier.** `"eventoObs"`,
//     `"deletedAt"`, `"id_ciudadA"`, `"id_ciudadB"` — unquoted, Postgres folds
//     them too and the statement dies with "relation does not exist". Loud, but
//     only at deploy time, and only on the one environment that runs it.
//
// So the assertions below are rules over the generated SQL rather than nine
// strings compared to nine strings. That comparison would be a copy of the
// implementation: any mistake gets copied to both sides at once and the test
// only notices an accidental edit to one of them.
//
// The exception is the last block, which is not about spelling: it feeds the
// migration a database that answers with the wrong columns and demands that it
// refuse. That is the hole `IF NOT EXISTS` leaves — it matches names and never
// definitions — and the check inside `up()` is the only thing covering it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { up, down, INDICES, sentenciaDe } from "./20260904000001-hand-made-indexes.js";

/**
 * A queryInterface that records, and answers the verification query with
 * whatever the test wants the database to look like.
 */
function fakeQueryInterface(columnasReales?: Map<string, string>) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const query = (...args: unknown[]) => {
    calls.push({ fn: "query", args });
    const sql = String(args[0]);
    if (!sql.includes("pg_index")) return Promise.resolve([]);
    const filas = INDICES.map((i) => ({
      nombre: i.nombre,
      columnas: columnasReales?.get(i.nombre) ?? i.columnas.join(","),
    })).filter((f) => f.columnas !== "AUSENTE");
    return Promise.resolve(filas);
  };
  return {
    calls,
    addIndex: (...args: unknown[]) => { calls.push({ fn: "addIndex", args }); return Promise.resolve(); },
    sequelize: {
      query,
      transaction: (cb: (t: unknown) => Promise<void>) => cb({ id: "t" }),
    },
  };
}

const ran = async (fn: typeof up, columnasReales?: Map<string, string>) => {
  const qi = fakeQueryInterface(columnasReales);
  await fn({ context: qi as never });
  return qi;
};

/** The `CREATE INDEX` statements, without the preamble or the verification. */
const creaciones = (qi: { calls: { fn: string; args: unknown[] }[] }) =>
  qi.calls
    .filter((c) => c.fn === "query")
    .map((c) => String(c.args[0]))
    .filter((s) => s.startsWith("CREATE INDEX"));

describe("how the nine are spelled", () => {
  it("never puts a capital letter in an index name", async () => {
    // The assertion that stops production growing a duplicate index. Read off
    // the generated SQL rather than off the constant, so that a future switch to
    // `queryInterface.addIndex` — which quotes the name itself — is caught too.
    const nombres = creaciones(await ran(up)).map((s) => s.match(/EXISTS "([^"]+)"/)?.[1] ?? "");

    expect(nombres).toHaveLength(INDICES.length);
    expect(nombres.filter((n) => n !== n.toLowerCase()), "un nombre con mayúsculas crea un índice duplicado")
      .toEqual([]);
  });

  it("quotes every identifier that is not already lower case", async () => {
    // The opposite mistake, and the loud one: `eventoObs`, `deletedAt`,
    // `id_ciudadA` and `id_ciudadB` unquoted become `eventoobs`, `deletedat`…
    // and the statement dies. Derived from the data rather than listed, so a
    // tenth index with a camelCase column is covered on the day it is added.
    const sql = creaciones(await ran(up)).join("\n");
    const camel = [
      ...INDICES.map((i) => i.tabla),
      ...INDICES.flatMap((i) => [...i.columnas]),
    ].filter((id) => id !== id.toLowerCase());

    expect(camel.length, "el fixture ya no cubre ningún identificador camelCase").toBeGreaterThan(3);
    for (const id of camel) {
      expect(sql, `${id} va sin comillas`).toContain(`"${id}"`);
    }
  });

  it("keeps the misspelling the database actually has", async () => {
    // `revicions` is the table; the index says `reviciones`. Two different
    // typos, so the index does not name its table and the tidy-minded correction
    // — to `idx_revicions_id_evento`, which is the convention the authorship
    // migration set — creates a duplicate rather than fixing anything.
    const nombres = INDICES.map((i) => i.nombre);

    expect(nombres).toContain("idx_reviciones_id_evento");
    expect(nombres, "corregir la errata duplica el índice, no lo renombra")
      .not.toContain("idx_revicions_id_evento");
  });

  it("names the tables the models name", async () => {
    // Catches the day somebody gives a model a `tableName` and forgets this
    // file. `eventoObs` is the one that matters: Sequelize leaves words ending
    // in `s` alone when pluralising, so the table really is camelCase.
    const [evento, poste, revision, eventoObs, bitacora] = await Promise.all([
      import("../models/evento.model.js"),
      import("../models/poste.model.js"),
      import("../models/revision.model.js"),
      import("../models/eventoObs.model.js"),
      import("../models/bitacora.model.js"),
    ]);
    const reales = new Set([
      evento.EventoModel, poste.PosteModel, revision.RevisionModel,
      eventoObs.EventoObsModel, bitacora.BitacoraModel,
    ].map((m) => String((m as unknown as { getTableName(): string }).getTableName())));

    for (const tabla of new Set(INDICES.map((i) => i.tabla))) {
      expect(reales, `ningún modelo se llama ${tabla}`).toContain(tabla);
    }
  });

  it("lists exactly the nine the architecture document lists", async () => {
    // The one assertion here that is not about this file agreeing with itself.
    // That document is the record of what was typed into the server by hand, and
    // it is the only one; tying the two together means editing either alone
    // turns this red. It is the first test in the repository to read a `.md`,
    // and it is worth the precedent for that reason — a migration that claims to
    // reproduce a documented list should fail when the list changes.
    const doc = readFileSync(new URL("../../docs/ARCHITECTURE.md", import.meta.url), "utf-8");
    // The fenced block, not the first mention of the words: the warning above it
    // now tells the reader to `grep` for `CREATE INDEX`, and a search from the
    // top of the file lands in that sentence. Found by taking every ```sql block
    // and keeping the one that declares indexes.
    // `\r?` because this file is CRLF in the working tree and the pattern is
    // matched against what is on disk, not against what git stores.
    const bloque = [...doc.matchAll(/```sql\r?\n([\s\S]*?)```/g)]
      .map((m) => m[1])
      .find((b) => b.includes("CREATE INDEX")) ?? "";
    const documentados = [...bloque.matchAll(/CREATE INDEX (\w+)/g)].map((m) => m[1].toLowerCase());

    expect(documentados, "el bloque SQL del documento cambió de forma").toHaveLength(9);
    expect([...INDICES.map((i) => i.nombre)].sort()).toEqual([...documentados].sort());
  });
});

describe("how it runs", () => {
  it("tolerates every one of them already existing", async () => {
    // The inverse of the assertion in `20260903000002-index-bitacora-author`,
    // and the difference is the whole reason both exist. That one creates an
    // index that never existed, so a name collision means something is wrong and
    // the deploy should stop. These nine are known to be there: failing on them
    // is failing every single time.
    for (const sql of creaciones(await ran(up))) {
      expect(sql).toContain("IF NOT EXISTS");
    }
  });

  it("refuses when a name is taken by an index over different columns", async () => {
    // What `IF NOT EXISTS` cannot see, and the reason the check exists. Somebody
    // created `idx_eventos_deleted` by hand over the wrong column; the migration
    // skips it, reports success, and the Archivados tab goes on scanning while
    // this repository says the index is there.
    const mentira = new Map([["idx_eventos_deleted", "id_poste"]]);

    await expect(ran(up, mentira)).rejects.toThrow(/idx_eventos_deleted/);
  });

  it("refuses when one of them is missing after being created", async () => {
    // The other half: a statement that ran without error and left nothing.
    const ausente = new Map([["idx_bitacora_created", "AUSENTE"]]);

    await expect(ran(up, ausente)).rejects.toThrow(/no existe/);
  });

  it("bounds both the wait for the lock and the work under it", async () => {
    // `CREATE INDEX IF NOT EXISTS` is not free when the index is already there:
    // it takes a ShareLock on the table before looking the name up and holds it
    // until commit. Nine of those means writes to five tables are held at once —
    // and one of them is `bitacoras`, which gains a row on every login.
    const qi = await ran(up);
    const preamble = qi.calls
      .filter((c) => c.fn === "query")
      .map((c) => String(c.args[0]))
      .filter((s) => s.startsWith("SET LOCAL"));

    expect(preamble).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL statement_timeout = '60s'",
    ]);
  });

  it("does everything inside the transaction", async () => {
    const qi = await ran(up);
    const fuera = qi.calls.filter(
      (c) => (c.args.at(-1) as { transaction?: unknown } | undefined)?.transaction === undefined,
    );

    expect(fuera, "llamadas fuera de la transacción").toEqual([]);
  });

  it("drops nothing on the way back", async () => {
    // Not an omission. These nine existed before this migration ran, so a
    // rollback that dropped them would destroy indexes it never created, during
    // a rollback, on a live database. And `IF NOT EXISTS` reports nothing, so
    // `down()` could not tell which ones it owns even if it wanted to.
    const qi = await ran(down as unknown as typeof up);

    expect(qi.calls, "down() tocó la base de datos").toEqual([]);
  });
});

describe("the statement builder", () => {
  it("puts the columns in the order the index has them", () => {
    // The composite is the only one where order is a correctness question rather
    // than a style one: `(id_poste, state, "deletedAt")` serves the pending count
    // and `("deletedAt", state, id_poste)` does not serve anything.
    const compuesto = INDICES.find((i) => i.nombre === "idx_eventos_poste_state_deleted");

    expect(sentenciaDe(compuesto!)).toContain(`("id_poste", "state", "deletedAt")`);
  });
});
