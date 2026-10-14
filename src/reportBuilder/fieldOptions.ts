// The values a filter can choose from, for the fields that have a closed list.
//
// A filter compares strings exactly — `= 'Tigo'` — so `tigo`, or a trailing
// space, matches nothing, and the screen cannot tell a misspelled filter from a
// filter that legitimately found no rows: both come back as an empty report.
// Handing over the list is what removes the question.
//
// Only the catalogue entities qualify, and they are marked one by one in
// `catalog.ts` with `optionList`. Everything here is driven off those marks —
// `catalogFieldOptions.test.ts` refuses a mark with no reader and a reader with
// no mark, so the two cannot drift apart.

import { CiudadModel } from "../models/ciudad.model.js";
import { DepartamentoModel } from "../models/departamento.model.js";
import { MaterialModel } from "../models/material.model.js";
import { ObsModel } from "../models/obs.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { RolModel } from "../models/rol.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { log } from "../utils/logger.js";

/**
 * Above this, the list does not travel and the field keeps the free text box it
 * had before.
 *
 * The largest of the six is 94 cities (measured on the local database after
 * the cities were merged and tidied), so there is five times the room. It is
 * not there for today's data: these tables are administered by hand from
 * Parámetros and none of them grows with use, but the day somebody loads a real
 * register of towns the generator has to degrade to what it does now instead of
 * putting a five-figure list in every catalog response.
 */
export const MAX_OPTION_VALUES = 500;

/** How long a loaded set is reused. The lists change when somebody edits
 * Parámetros, which is rare; a minute matches the permission matrix beside it
 * and is short enough that nobody notices the wait after adding an owner. */
const TTL_MS = 60_000;

/** Any of the catalogue models, as far as this file is concerned. */
type Catalogo = { findAll(opciones: object): Promise<unknown[]> };

/**
 * Which model answers each key, keyed exactly as `catalogView` builds it:
 * the catalog's entity key, a dot, and the field name.
 *
 * All the models but `departamento` are `paranoid: true` — `rols` gained
 * `deletedAt` in 20260826000001 — so an archived row is excluded without
 * asking; `departamentos` has no `deletedAt` and nothing archives a department. That matters
 * more here than in a report: a filter offering an owner nobody can have any
 * more is a choice that returns nothing.
 */
const SOURCE: Record<string, Catalogo> = {
  "ciudad.name": CiudadModel,
  "material.name": MaterialModel,
  "propietario.name": PropietarioModel,
  "tipoObs.name": TipoObsModel,
  "obs.name": ObsModel,
  "rol.name": RolModel,
  // Calculated fields (`optionList` on a `CalculatedDef`): the department of a
  // tramo, and of a pole's tramo. One table answers both keys, because the
  // catalogue keys a list by the entity it was reached on.
  "tramo.departamento": DepartamentoModel,
  "poste.departamento": DepartamentoModel,
};

export type OptionLists = Record<string, string[]>;

let cache: { at: number; lists: OptionLists } | null = null;

/** Only for tests, which need a cold start. */
export function resetOptionCache(): void {
  cache = null;
}

async function readOne(model: Catalogo): Promise<string[]> {
  const rows = (await model.findAll({
    attributes: ["name"],
    raw: true,
  })) as unknown as { name: string | null }[];

  // Deduplicated, because the list is of *values* and the filter compares
  // values: before the duplicate cities were merged, 98 cities carried 95
  // distinct names — Millares, Olivos and Pailas each named more than one city —
  // and offering the same word three times reads as a bug while behaving
  // identically. Today the 94 live cities carry 94 distinct names, so this only
  // matters for a catalogue edited by hand later (and for the other five).
  // What it does not do is make the filter more precise: the condition is on
  // the name and not on the city.
  //
  // **Exactly as stored, spaces and all.** This tidied the values at first, and
  // that was the very failure this feature exists to remove, handed back with
  // the screen's own authority behind it: 17 of the 98 cities used to be stored
  // with a trailing space — `Yacuiba ` carried 121 poles, `Palos Blancos ` 103 —
  // and a filter compares exactly, so the tidy `Yacuiba` matched none of them.
  // A value nobody can reach by typing it is bad; a value the screen *offers*
  // and that then finds nothing is worse. The city migration has since
  // normalised those names (none of the 94 live ones has a trailing space),
  // but the other five catalogues are not covered by it, and the rule is cheaper
  // to keep than to re-derive.
  const seen = new Set<string>();
  for (const row of rows) {
    // Only what cannot be picked at all: a blank row in a list is not a choice.
    if (row.name !== null && row.name.trim() !== "") seen.add(row.name);
  }
  // Alphabetical, and not the `id DESC` the dropdown endpoints use: those feed
  // exporters that build one column per row and therefore care about order,
  // while this feeds a list somebody reads and searches.
  return [...seen].sort((a, b) => a.localeCompare(b, "es"));
}

/**
 * Loads every list, then hands back the ones asked for.
 *
 * **A failure here is not a failure of the catalog.** The generator worked
 * without these lists the day before they existed, so a database that will not
 * answer costs the filter box its dropdown and nothing else — the alternative
 * is a screen that will not open because a convenience could not load.
 */
export async function loadOptionLists(keys: Iterable<string>): Promise<OptionLists> {
  const wanted = [...new Set(keys)].filter((key) => key in SOURCE);
  if (wanted.length === 0) return {};

  if (cache === null || Date.now() - cache.at > TTL_MS) {
    try {
      const entries = Object.entries(SOURCE);
      const values = await Promise.all(entries.map(([, model]) => readOne(model)));
      const lists: OptionLists = {};
      entries.forEach(([key], i) => {
        // Over the cap the key is simply absent, which is the same thing the
        // client sees when this whole read fails: no list, so a text box.
        if (values[i].length <= MAX_OPTION_VALUES) lists[key] = values[i];
        else log("generador").warn(
          { lista: key, valores: values[i].length, tope: MAX_OPTION_VALUES },
          `la lista ${key} tiene ${values[i].length} valores y no viaja`,
        );
      });
      cache = { at: Date.now(), lists };
    } catch (error) {
      log("generador").warn({ err: error }, "no se pudieron leer las listas de valores del filtro");
      return {};
    }
  }

  const out: OptionLists = {};
  for (const key of wanted) {
    const list = cache.lists[key];
    if (list) out[key] = list;
  }
  return out;
}

/** The keys this module can answer, for the test that pairs them with the catalog. */
export const OPTION_SOURCES = Object.keys(SOURCE);
