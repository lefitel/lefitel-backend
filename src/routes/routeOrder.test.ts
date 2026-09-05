// No route may be unreachable because an earlier one already matches it.
//
// Express matches layers in the order `router.get` was called and stops at the
// first hit. So `/:id` declared before `/opciones` means `/opciones` never runs:
// the request reaches `searchPoste` with `id = "opciones"`, which looks up a
// pole whose id is a word, finds nothing, and answers 404 — or, worse, answers
// 200 with something. No error is logged anywhere, in either case, and the
// endpoint appears to have been implemented.
//
// §3.2 of the API standard spec calls the ordering a rule and §10 assigns this
// test to B1 rather than to D1, because the options endpoints are the first four
// routes in this API that step on the trap. It is written generically for that
// reason: four assertions about four known paths would pass today and leave the
// trap armed for the next literal anybody adds — `GET /api/bitacora/authors`
// is already in the plan, one router over, with a `/:id_usuario` in front of it.
//
// **Read off the routers as Express compiled them, never off the source text.**
// `router.stack` is the layer list Express will actually walk, in the order it
// will walk it, so this test asserts the thing that decides the outcome. A test
// that grepped `src/routes/*.ts` would be asserting the order lines appear in a
// file, which is only correlated with it — the same distinction §3.4 makes about
// the naming test, and the reason that one is assigned to the mounted table too.
//
// Sibling of `routeGuards.test.ts`, which walks the assembled app to ask *who
// may call* each route. This file asks whether each route can be reached at all,
// and needs no app: shadowing happens between siblings inside one router, and no
// mount prefix in `app.ts` is a prefix of another — `/api/evento` and
// `/api/eventoObs` do not overlap, nor do `/api/adss` and `/api/adssposte`.
//
// **Two limits, written down rather than implied.** Nothing here would notice
// two routers mounted on genuinely overlapping prefixes: `routeGuards.test.ts`
// throws only on a router with no recorded mount at all, so
// `app.use("/api/poste/extra", otro)` would go unremarked by both files. And it
// reads the router modules by directory instead of the assembled table §10 asks
// for, which is a deliberate trade — it covers a router before anybody mounts
// it, and cannot see a route declared straight on the app.
//
// **The rule here is narrower than the sentence in §3.2, on purpose.** That
// sentence says a literal segment is declared before any parametric one at the
// same level, and `usuario.routes.ts` breaks it today: `PUT /:id` comes before
// `PUT /username/:id` and `PUT /userpass/:id`. Those three are all reachable —
// one segment cannot match two — so flagging them would be a false alarm about
// working code. What matters is not the order of the declarations but whether an
// earlier pattern covers a later path *entirely*, and that is what is asserted.
// Anyone tempted to align this file with §3.2's wording will light up those two
// routes; align the wording instead.

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Express layers carry no public types; this is the shape we read. */
interface Capa {
  route?: { path: string; methods: Record<string, boolean> };
  /**
   * True for a pathless `router.use(mw)`. Express 4 spelled it
   * `regexp.fast_slash`; `routeGuards.test.ts` reads the same field.
   */
  slash?: boolean;
}

interface Declarada {
  fichero: string;
  /**
   * The HTTP method, or `_ALL` for a `router.all(...)`.
   *
   * Express stamps `route.methods._all` for those, and it is a real shape to
   * handle rather than a curiosity: a catch-all or a deprecation shim declared
   * above a literal swallows it for every method at once, and reading `_ALL` as
   * just another method name would compare it against nothing.
   */
  method: string;
  path: string;
  /** Position in its own router's stack: the order Express will try them in. */
  orden: number;
}

/** Whether an earlier layer's method can claim a request meant for a later one. */
const solapan = (a: string, b: string) => a === b || a === "_ALL" || b === "_ALL";

/**
 * Middleware mounted on a path inside a router, which this test cannot read.
 *
 * `router.use("/opciones", h)` claims every request under `/opciones` for every
 * method, so it shadows anything declared after it — and Express 5 keeps a
 * layer's path in closures nothing exposes, so there is no path here to compare.
 * A pathless `router.use(mw)` is harmless: it calls `next` and the walk carries
 * on, which is what the report builder's own gate does.
 *
 * Collected and failed on rather than skipped. The shape does not exist in this
 * repository today; the day somebody writes one, this test says so instead of
 * going quietly blind.
 */
const usosConRuta: string[] = [];

/**
 * Every route every router declares, in declaration order.
 *
 * Discovered by directory rather than listed, so a router added tomorrow is
 * covered without anybody remembering to come back here. That is the half of
 * this test that makes it worth writing at all.
 */
async function declaradas(): Promise<Declarada[]> {
  const ficheros = readdirSync(here)
    .filter((f) => f.endsWith(".routes.ts"))
    .sort();

  const todas: Declarada[] = [];
  for (const fichero of ficheros) {
    const modulo = await import(join(here, fichero).replace(/\.ts$/, ".js"));
    const router = modulo.default as { stack?: Capa[] } | undefined;
    // Asserted, not skipped. A router this cannot read is a router whose order
    // is unchecked, and skipping it silently is how a test like this ends up
    // passing over nothing — the failure mode every source-level test in this
    // repository carries a guard against.
    if (!router?.stack?.length) {
      throw new Error(`${fichero}: no exporta un router legible (¿cambió la forma interna de express?)`);
    }
    router.stack.forEach((capa, orden) => {
      if (!capa.route) {
        if (!capa.slash) usosConRuta.push(`${fichero}, capa ${orden}`);
        return;
      }
      for (const method of Object.keys(capa.route.methods)) {
        todas.push({ fichero, method: method.toUpperCase(), path: capa.route.path, orden });
      }
    });
  }
  return todas;
}

/**
 * What a declared path matches, as a pattern over whole segments.
 *
 * `:id` becomes "one segment, anything in it", which is what Express does with
 * it. Everything else is matched literally, escaped, so a path containing a dot
 * cannot become a wildcard by accident.
 *
 * No route in this API uses Express 5's `*splat` or optional `{/:x}` syntax
 * today. The guard below fails if one appears, rather than this quietly treating
 * the asterisk as a literal and reporting the router as clean.
 *
 * Case-insensitive, because an express Router is: `caseSensitive` defaults to
 * false, so a route declared `/stats` already answers a request for `/STATS`,
 * and a `/STATS` declared afterwards never runs. Nothing in this repository
 * spells a segment two ways — a comparison that could not see it would be
 * claiming more than it checks.
 */
function patron(path: string): RegExp {
  const partes = path.split("/").map((seg) =>
    seg.startsWith(":")
      ? "[^/]+"
      : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`^${partes.join("/")}$`, "i");
}

const rutas = await declaradas();

describe("every route can actually be reached", () => {
  // A walk that found nothing passes every assertion below. Lower bounds, so
  // adding routers and routes can only ever help — and deliberately without the
  // day's figures written beside them: the first version of this comment quoted
  // two, and both were wrong within the hour, one of them because this very diff
  // moved it. §9 of the spec is about exactly that. The number lives in the
  // expectation.
  it("read the routers at all", () => {
    const ficheros = new Set(rutas.map((r) => r.fichero));
    expect(ficheros.size, "no se leyó ningún router").toBeGreaterThan(15);
    expect(rutas.length, "no se leyó ninguna ruta").toBeGreaterThan(80);
  });

  it("has both shapes to compare, so the rule is not vacuous", () => {
    // With no parametric route there is nothing that could shadow anything, and
    // with no literal there is nothing to be shadowed: either way the assertion
    // below would pass without exercising the rule.
    const parametricas = rutas.filter((r) => r.path.includes(":"));
    const literales = rutas.filter((r) => !r.path.includes(":") && r.path !== "/");
    expect(parametricas.length, "ninguna ruta paramétrica").toBeGreaterThan(20);
    expect(literales.length, "ninguna ruta literal").toBeGreaterThan(10);
  });

  it("uses no path syntax this test cannot read", () => {
    const raras = rutas
      .filter((r) => /[*{}()?+]/.test(r.path))
      .map((r) => `${r.fichero}: ${r.method} ${r.path}`);
    expect(
      raras,
      "rutas con sintaxis de express 5 que este test no interpreta; " +
        `amplía patron() antes de añadirlas:\n  ${raras.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has no middleware mounted on a path inside a router", () => {
    // `router.use("/algo", h)` claims every request under that prefix for every
    // method, and Express 5 keeps the prefix in closures nothing exposes — so a
    // route declared after one is unreachable and this test cannot see why.
    // Loud rather than silent: the shape does not exist here today, and the day
    // it does, the walk above stops being complete.
    expect(
      usosConRuta,
      "este test no puede leer la ruta de un router.use; comprueba a mano que no " +
        `tapa nada declarado después: ${usosConRuta.join(" · ")}`,
    ).toEqual([]);
  });

  it("declares no route that an earlier one already swallows", () => {
    const tapadas: string[] = [];

    for (const ruta of rutas) {
      const antes = rutas.filter(
        (otra) =>
          otra.fichero === ruta.fichero &&
          solapan(otra.method, ruta.method) &&
          otra.orden < ruta.orden,
      );
      for (const previa of antes) {
        if (!patron(previa.path).test(ruta.path)) continue;
        tapadas.push(
          `${ruta.fichero}: ${ruta.method} ${ruta.path} nunca se ejecuta, ` +
            `porque ${previa.path} se declara antes y ya la casa`,
        );
      }
    }

    expect(
      tapadas,
      `rutas inalcanzables; declara el literal antes del paramétrico:\n  ${tapadas.join("\n  ")}`,
    ).toEqual([]);
  });
});
