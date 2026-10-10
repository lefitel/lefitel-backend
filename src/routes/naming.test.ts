// What every address in this API is allowed to be called — §3.4 of the API
// standard, made into a ledger.
//
// **The rule, in one sentence:** business nouns of this network go in Spanish,
// and every verb, operation and word that belongs to the API rather than to the
// network goes in English. `/api/evento/5/reopen`, `/api/poste/5/restore`,
// `/api/generator/query`.
//
// **Why this file reads the mounted table and not `src/routes/*.ts`.** The
// tempting version of this test walks the router source files looking for bad
// segments. It would have passed on the day D1 started and would have kept
// passing if D1 had never been done: the only two segments in the whole API with
// a capital letter — `eventoObs` and `tipoObs` — were **mount prefixes in
// `app.ts`**, which no router file contains. A test that certifies a rename it
// cannot see is worse than no test, so this one imports the app and reads the
// addresses Express really answers on.
//
// **Both directions, and that is the whole design.** Every literal segment the
// application mounts is in exactly one of the two lists below, and every segment
// in those lists is mounted. A new route with an unlisted word fails; a word
// left behind after its route is deleted fails too. Neither can be satisfied by
// copying the code it watches, because the lists say *which language a word is
// in* — a judgement the code does not contain.
//
// Nothing here reaches Postgres. It sends no requests at all: it reads the route
// table and nothing else, and in this environment the configured database is a
// copy of production.

import { describe, it, expect, vi } from "vitest";
import type { Application } from "express";

vi.mock("../permissions/store.js", () => ({
  permissionsFor: async () => ({}),
  can: async () => true,
  invalidatePermissions: vi.fn(),
}));

/**
 * The mounts, captured the way `listShape.test.ts` and `statusCodes.test.ts`
 * capture them: as `app.use` receives them, during the import of `app.js`.
 * Express 5 compiles a path into closures over a pattern nothing exposes, so
 * after the fact the prefix is unreadable.
 */
const montajes: { prefijo: string; router: unknown }[] = [];
const express = (await import("express")).default;
const useOriginal = express.application.use;
express.application.use = function (this: Application, ...args: unknown[]) {
  if (typeof args[0] === "string") {
    for (const handler of args.slice(1)) {
      if (typeof handler === "function") montajes.push({ prefijo: args[0], router: handler });
    }
  }
  return (useOriginal as (...a: unknown[]) => Application).apply(this, args);
} as typeof express.application.use;

// Imported for its side effect and nothing else: the mounts are recorded by the
// wrapper above while `app.ts` runs its `app.use` calls, and this file never
// sends a request, so the application itself is not needed afterwards.
await import("../app.js");
express.application.use = useOriginal;

interface Capa {
  route?: { path: string; stack: { method?: string }[] };
}

/** Every address the application answers, prefix and route path joined. */
const direccionesMontadas = (): string[] => {
  const rutas = new Set<string>();
  for (const { prefijo, router } of montajes) {
    for (const capa of (router as { stack?: Capa[] }).stack ?? []) {
      if (!capa.route) continue;
      rutas.add(`${prefijo}${capa.route.path === "/" ? "/" : capa.route.path}`);
    }
  }
  return [...rutas];
};

/** The literal segments of an address: no `api`, no `:parametros`. */
const segmentosDe = (ruta: string) =>
  ruta.split("/").filter((s) => s !== "" && s !== "api" && !s.startsWith(":"));

/**
 * Business nouns of this network, in Spanish, and deliberately so.
 *
 * Their translations are worse: a «tramo» is not a *span* — it is the segment
 * between two cities, with two foreign keys and no order between them — a
 * «bitácora» is not a *log* but a record of actions with severity, entity and
 * author, and ADSS is a fibre-cable acronym that translates to nothing. §3.4
 * carries the argument.
 *
 * `obs` is on this list as a conscious abbreviation. The client says
 * «observación»; the models and the column names say `obs`, and unpicking that
 * crosses the line §2 draws around the database.
 *
 * `reportes` and `revisiones` keep the number the client uses when speaking
 * about them, which is §3.4's rule for a business noun — not the singular an
 * operation takes.
 */
const NEGOCIO_EN_ESPANOL = [
  "adss",
  "bitacora",
  "ciudad",
  "evento",
  "eventos",
  "material",
  "obs",
  "permiso",
  "poste",
  "propietario",
  "reporte",
  "reportes",
  "revision",
  "revisiones",
  "rol",
  // Spanish and not English, and it is the judgement §3.4 asks for rather than
  // an obvious case. `ruta` is what the trazado between two ciudades is called
  // on the screens and by whoever walks it, so it is the network's word. The
  // tempting English alternative — `routing` — names the technique, not the
  // thing, which is exactly the distinction that kept `dashboard` in English
  // and `recorrido` in Spanish.
  "ruta",
  "solucion",
  "tipo-obs",
  "usuario",
];

/**
 * Everything else: verbs, operations, and the words that belong to the API
 * rather than to the electrical network.
 *
 * `dashboard` is the case worth explaining, because the second version of the
 * spec translated it to `/inicio` and this one does not. It is vocabulary of the
 * application, not of the network — nobody in the field calls a section of a
 * substation a dashboard — so by §3.4 it stays in English, and the tie-breaker
 * that argued otherwise was removed the day it was found to contradict the very
 * table it belonged to.
 */
const EN_INGLES = [
  "authors",
  "broken-refs",
  "catalog",
  "count",
  "dashboard",
  "duplicate",
  "entity-stats",
  "export",
  "files",
  "generator",
  "lookup",
  "mfa",
  "options",
  "orphans",
  "query",
  // Scheduled reports. A schedule, its recipients and its runs are words of
  // the application, not of the network — the `dashboard` case again.
  "recipients",
  "reopen",
  "reset",
  "resolve",
  "restore",
  "run",
  "runs",
  "schedules",
  "stats",
  "unsubscribe",
  "user",
  "vocabulary",
];

/**
 * The report addresses, which are Spanish and stay Spanish.
 *
 * `general`, `tramo` and `recorrido` are the network's own words. `estado-red`,
 * `frecuencia-obs` and `resumen-tiempos` are Spanish compounds whose word order
 * D1 corrected — «resumen de tiempos», not «tiempos resumen» — and translating
 * them would mean translating what the reports are called on screen, which is
 * not what §3.4 decided.
 */
const INFORMES_EN_ESPANOL = [
  "estado-red",
  "frecuencia-obs",
  "general",
  "recorrido",
  "resumen-tiempos",
  "tramo",
];

/**
 * Verbs and operations in Spanish. None of these may name a segment.
 *
 * A closed list of words is the weak half of this file and it is worth saying
 * why it is kept anyway: it names the words that were actually in the API
 * before D1, so a revert of any of them fails by name rather than by rule.
 */
const VERBOS_EN_ESPANOL = [
  "desarchivar", "archivar", "reabrir", "resolver", "exportar", "consulta",
  "conteo", "duplicar", "catalogo", "opciones", "autores", "buscar", "crear",
  "editar", "borrar", "subir", "descargar", "listar",
];

/**
 * The strong half: any Spanish infinitive, whether or not anybody listed it.
 *
 * 🔴 **The closed list above can be walked around in one line**, and that was
 * measured rather than imagined: rename a route to `/:id/restaurar`, add
 * `"restaurar"` to the business-noun list, and every assertion in this file goes
 * green — `restaurar` is not among the eighteen words, and nothing else asks
 * what kind of word it is. Every Spanish verb outside that list works the same:
 * `guardar`, `enviar`, `asignar`, `aprobar`, `cancelar`.
 *
 * Spanish infinitives end in `-ar`, `-er` or `-ir`, so the rule is a rule and
 * not an enumeration: a segment ending that way is a verb unless it is one of
 * the English words below that happen to share the ending. That list is short,
 * every entry is a real word, and adding to it is a decision somebody has to
 * write down — which is the whole difference from adding a line to a bucket.
 */
const TERMINA_COMO_INFINITIVO = /(ar|er|ir)$/;
// Only `user` today — `GET /api/usuario/user/:user`, the search by account
// name. The reverse check below is what trimmed this list: it was written
// with five more English words that end the same way and none of them names
// a segment this API actually mounts.
const NO_ES_INFINITIVO = ["user"];

const CONOCIDOS = new Set([...NEGOCIO_EN_ESPANOL, ...EN_INGLES, ...INFORMES_EN_ESPANOL]);

/**
 * The addresses §2 puts outside this document, named one by one.
 *
 * §2 lists fourteen routes as the authentication module's: ten under
 * `/api/auth`, `POST /api/login/`, and the three below, which live on the
 * `usuario` router for reasons it gives — password recovery reaches `userpass`
 * directly, renaming an account is the operation the reauthentication window
 * was designed around, and unlocking an account is the way back from a lockout
 * the same plan owns. So
 * `desbloquear` stays in Spanish and that is a decision, not an oversight.
 *
 * Named one by one rather than skipped by a pattern, because a pattern would
 * also excuse whatever gets added next to them.
 *
 * **The `/api/auth` prefix is excluded in bulk below, and that is wider than
 * §2's ten.** The MFA and passkey plans have mounted around twenty-six routes
 * under it since that list was written, and they are the same session's. What
 * is *not* excused by any of this is `POST /api/usuario/:id/mfa/reset`, which
 * §2 never listed: its segments are English already (`mfa` is an acronym,
 * `reset` a verb), so it passes the rules below on its own rather than by
 * exemption. A first draft of this file put it in the list here, which widened
 * the blind spot using a justification that did not cover it.
 */
const FUERA_DE_ALCANCE = [
  "/api/usuario/username/:id",
  "/api/usuario/userpass/:id",
  "/api/usuario/:id/desbloquear",
];

describe("what every address is called", () => {
  const rutas = direccionesMontadas();
  // The authentication module is outside this document — §2 stops at it — and
  // its routes are another session's. Excluded here rather than silently, so
  // that the exclusion is a line somebody can argue with.
  const propias = rutas.filter(
    (r) => !r.startsWith("/api/auth") && r !== "/api/login/" && !FUERA_DE_ALCANCE.includes(r),
  );
  const segmentos = [...new Set(propias.flatMap(segmentosDe))].sort();

  it("read the real route table, and not an empty one", () => {
    // The failure this whole file exists to avoid: a capture that comes back
    // empty certifies every rule below over nothing. `listShape.test.ts` has
    // been fooled by exactly that once.
    expect(rutas.length, "la tabla de rutas montadas vino casi vacía").toBeGreaterThan(90);
    expect(propias.length).toBeGreaterThan(70);
    expect(segmentos.length).toBeGreaterThan(25);
  });

  it("excludes only addresses that exist", () => {
    // The other direction of the exclusion list. An entry left behind after its
    // route is renamed would quietly widen what this file stops looking at.
    const fantasmas = FUERA_DE_ALCANCE.filter((r) => !rutas.includes(r));
    expect(fantasmas, `exenciones que ya no son rutas: ${fantasmas.join(", ")}`).toEqual([]);
  });

  it("classifies every mounted segment, and every classified segment is mounted", () => {
    const sinClasificar = segmentos.filter((s) => !CONOCIDOS.has(s));
    expect(
      sinClasificar,
      `estos segmentos no están en ninguna lista; decida en qué idioma van:\n  ${sinClasificar.join("\n  ")}`,
    ).toEqual([]);

    const montados = new Set(segmentos);
    const sobran = [...CONOCIDOS].filter((s) => !montados.has(s)).sort();
    expect(
      sobran,
      `estos segmentos están clasificados y ya no existen:\n  ${sobran.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has no verb or operation in Spanish anywhere in an address", () => {
    // The assertion D1 is for, and the one that cannot be satisfied by copying
    // the code: it says what these words *are*, which no route table knows.
    const malos = propias.filter((r) =>
      segmentosDe(r).some((s) => VERBOS_EN_ESPANOL.includes(s)),
    );
    expect(malos, `verbos en español en la superficie HTTP:\n  ${malos.join("\n  ")}`).toEqual([]);
    // 🔴 And none of the **three** buckets may hold one. Only `EN_INGLES` was
    // locked at first, so the way around the rule was to file a Spanish verb as
    // a business noun — one line, and the whole file went green.
    for (const [nombre, lista] of [
      ["EN_INGLES", EN_INGLES],
      ["NEGOCIO_EN_ESPANOL", NEGOCIO_EN_ESPANOL],
      ["INFORMES_EN_ESPANOL", INFORMES_EN_ESPANOL],
    ] as const) {
      expect(
        lista.filter((s) => VERBOS_EN_ESPANOL.includes(s)),
        `${nombre} contiene un verbo en español`,
      ).toEqual([]);
    }
  });

  it("has no Spanish infinitive anywhere, listed or not", () => {
    // The half that is a rule rather than an enumeration. Every segment that
    // ends like an infinitive is a verb unless it is a written exception, so a
    // word nobody thought of — `restaurar`, `guardar`, `asignar` — is caught by
    // the shape of the word and not by somebody having predicted it.
    const sospechosos = segmentos.filter(
      (s) => TERMINA_COMO_INFINITIVO.test(s) && !NO_ES_INFINITIVO.includes(s),
    );
    expect(
      sospechosos,
      `estos segmentos parecen un infinitivo en español; si no lo son, dígalo en NO_ES_INFINITIVO:\n  ${sospechosos.join("\n  ")}`,
    ).toEqual([]);

    // And the exception list cannot grow quietly either: every entry has to be
    // a segment that really exists, so one added "just in case" fails here.
    const inventadas = NO_ES_INFINITIVO.filter((s) => !segmentos.includes(s));
    expect(
      inventadas,
      `excepciones al infinitivo que no nombran ningún segmento montado: ${inventadas.join(", ")}`,
    ).toEqual([]);
  });

  it("writes every segment in lower-case kebab, parameters included", () => {
    // `eventoObs` and `tipoObs` were the two that failed this, and both lived in
    // `app.ts` as mount prefixes — which is why this reads the mounted table.
    const malos: string[] = [];
    for (const ruta of propias) {
      for (const trozo of ruta.split("/").filter(Boolean)) {
        const nombre = trozo.startsWith(":") ? trozo.slice(1) : trozo;
        // A parameter may hold an underscore — `:id_rol` names a column — but a
        // literal segment may not, and neither may carry a capital.
        if (/[A-Z]/.test(nombre)) malos.push(`${ruta} → ${trozo} (mayúscula)`);
        if (!trozo.startsWith(":") && /_/.test(nombre)) malos.push(`${ruta} → ${trozo} (guion bajo)`);
      }
    }
    expect(malos, `segmentos mal escritos:\n  ${malos.join("\n  ")}`).toEqual([]);
  });

  it("never changes subject before naming the row it is about", () => {
    // §3.2 as a shape, rather than as a list of seven addresses.
    //
    // The defect it describes is an address that leads with one resource and
    // then names a *different* mounted resource before its own parameter:
    // `GET /api/evento/poste/:id_poste` reads as an incident and identifies a
    // pole, and `GET /api/solucion/evento/:id_evento` reads as a repair and
    // identifies an incident. In both, the id belongs to a table the address did
    // not lead with — which is exactly why `GET /api/revision/5` returned the
    // inspections of incident 5 rather than inspection 5.
    //
    // 🔴 The order matters and a coarser rule gets it backwards. After the
    // parameter, another resource's name is the *correct* shape —
    // `/api/usuario/:id/bitacora` is the address D1 created — so the check is
    // "a mount name appearing before the first parameter", not "a mount name
    // appearing at all". Written the coarse way this flagged the four addresses
    // the task had just made right.
    const raices = new Set(montajes.map((m) => m.prefijo.replace("/api/", "")));
    const malos = propias.filter((r) => {
      const trozos = r.split("/").filter(Boolean).slice(1);
      const primerParametro = trozos.findIndex((t) => t.startsWith(":"));
      const hasta = primerParametro === -1 ? trozos.length : primerParametro;
      return trozos.slice(1, hasta).some((t) => raices.has(t));
    });
    expect(
      malos,
      `estas direcciones cambian de sujeto antes de identificar su fila:\n  ${malos.join("\n  ")}`,
    ).toEqual([]);
  });
});
