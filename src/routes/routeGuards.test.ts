// Which routes are gated by a role, and which are open to any logged-in account.
//
// `requirePermission.test.ts` proves the middleware decides correctly when it
// runs. It says nothing about whether a route actually mounts it — and that is
// where the gap used to live: `authenticateToken` is on every router, so the API
// knew *who* was calling, but on most of them it never asked *whether they may*.
// A Cliente could not see the Roles screen in the interface, and could still
// call `DELETE /api/rol/:id` from the browser console.
//
// This walks the app as Express assembled it, so it sees gates wherever they
// were put: inside the router, or at the mount in app.ts (which is how
// /api/files is protected).

import { describe, it, expect } from "vitest";
import app from "../app.js";

/** Express layers carry no public types; this is the shape we read. */
interface Layer {
  name: string;
  regexp: RegExp & { fast_slash?: boolean };
  handle: { name: string; stack?: Layer[] };
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: { name: string; permission?: string } }[];
  };
}

interface MountedRoute {
  method: string;
  path: string;
  /** Every middleware name in the chain, mount-level first. */
  chain: string[];
  /**
   * The permissions the gates on this route ask for, as "modulo.accion".
   *
   * The chain of names says a gate is *there*. It cannot say it is the right
   * one: `requirePermission("generador", "ver")` and `("generador",
   * "archivar")` are both called `requirePermissionGate`, so a route gated by
   * the wrong pair — the likeliest mistake of all — passed unnoticed.
   */
  permissions: string[];
}

/**
 * Recover "/api/usuario" from the regexp Express compiled for it.
 *
 * Express 4 keeps no copy of the mount path, only `^\/api\/usuario\/?(?=\/|$)`.
 * The transformation back is mechanical, and the sanity check below fails loudly
 * if a version bump ever changes the shape.
 */
function mountPath(layer: Layer): string {
  if (layer.regexp.fast_slash) return "";
  return layer.regexp.source
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\//g, "/");
}

function mountedRoutes(): MountedRoute[] {
  const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  const routes: MountedRoute[] = [];

  // `app.use(path, a, b, router)` produces one layer per argument, all sharing
  // the same compiled regexp, in the order they were written. So anything seen
  // under a prefix before the router itself is a gate that guards it.
  const beforeRouter = new Map<string, string[]>();

  for (const layer of stack) {
    const key = layer.regexp.source;
    // A route declared straight on the app — `app.post("/api/x", handler)` —
    // has no `handle.stack`, so it used to fall through to the else and be
    // filed away as the name of a middleware: invisible to both assertions
    // below. Nothing in this codebase is written that way today, and that is
    // exactly the shape someone in a hurry reaches for, which is the shape this
    // file exists to catch.
    if (layer.route) {
      const chain = [
        ...(beforeRouter.get(key) ?? []),
        ...layer.route.stack.map((s) => s.handle.name),
      ];
      const permissions = layer.route.stack
        .map((s) => s.handle.permission)
        .filter((p): p is string => typeof p === "string");
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method: method.toUpperCase(), path: layer.route.path, chain, permissions,
        });
      }
      continue;
    }
    if (layer.handle.stack) {
      const prefix = mountPath(layer);
      // A router can also gate itself with `router.use(requireRole(...))` — the
      // report builder does. Those are pathless layers inside the router's own
      // stack, and they cover every route declared after them.
      const routerWide: string[] = [];
      for (const inner of layer.handle.stack) {
        if (!inner.route) {
          if (inner.regexp.fast_slash) routerWide.push(inner.handle.name);
          continue;
        }
        const chain = [
          ...(beforeRouter.get(key) ?? []),
          ...routerWide,
          ...inner.route.stack.map((s) => s.handle.name),
        ];
        const permissions = inner.route.stack
          .map((s) => s.handle.permission)
          .filter((p): p is string => typeof p === "string");
        for (const method of Object.keys(inner.route.methods)) {
          routes.push({
            method: method.toUpperCase(), path: prefix + inner.route.path, chain, permissions,
          });
        }
      }
    } else {
      beforeRouter.set(key, [...(beforeRouter.get(key) ?? []), layer.handle.name]);
    }
  }
  return routes;
}

const GATES = ["requirePermissionGate", "requireSelfOrPermissionGate"];
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

const routes = mountedRoutes();

describe("the route table we are actually asserting about", () => {
  it("was read off the app, not guessed", () => {
    expect(routes.length).toBeGreaterThan(40);
    // If a future Express changes how mount paths compile, every path turns to
    // rubbish and the assertions below would pass while checking nothing.
    const bad = routes.filter((r) => !r.path.startsWith("/api/"));
    expect(bad, `rutas con prefijo ilegible: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it("puts authentication in front of everything except logging in", () => {
    const open = routes
      .filter((r) => !r.path.startsWith("/api/login"))
      .filter((r) => !r.chain.includes("authenticateToken"));
    expect(open, `rutas sin authenticateToken: ${JSON.stringify(open)}`).toEqual([]);
  });
});

/**
 * Write routes that deliberately ask for no permission.
 *
 * Two, and each has a reason written next to it in its own router. Anything else
 * that appears here without a gate fails the test below, which is the point:
 * a new endpoint has to decide who may call it instead of inheriting the gap.
 */
const GATE_NOT_APPLICABLE = [
  // Logging in cannot require a permission: it is what produces one.
  "POST /api/login/",
  // Serves three screens at once, one of which is your own profile photograph.
  // See upload.routes.ts.
  "POST /api/upload/",
];

describe("who may change data", () => {
  const ungated = routes
    .filter((r) => WRITES.includes(r.method))
    .filter((r) => !r.chain.some((name) => GATES.includes(name)))
    .map((r) => `${r.method} ${r.path}`)
    .sort();

  it("gates every route that writes behind a permission", () => {
    const known = new Set(GATE_NOT_APPLICABLE);
    const unexpected = ungated.filter((r) => !known.has(r));

    expect(
      unexpected,
      `rutas de escritura sin decidir quién puede llamarlas:\n  ${unexpected.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the exception list honest", () => {
    // A line here for a route that is in fact gated hides the exception behind a
    // name nobody will question later.
    const stillOpen = new Set(ungated);
    const stale = GATE_NOT_APPLICABLE.filter((r) => !stillOpen.has(r));

    expect(stale, `ya están protegidas; bórralas de GATE_NOT_APPLICABLE:\n  ${stale.join("\n  ")}`)
      .toEqual([]);
  });
});

/**
 * What each route of the report builder must ask for, exactly.
 *
 * Written out rather than derived, because deriving it from the same source the
 * code uses would assert that the code agrees with itself. The pairs here are
 * the intent: running a report is `ver`, saving a new one is `crear`, editing
 * one is `editar`, archiving is `archivar` — and a copy is a new report, so
 * duplicating is `crear` and not `editar`.
 */
const GENERADOR_GATES: Record<string, string> = {
  "GET /api/generador/catalogo": "generador.ver",
  "POST /api/generador/consulta": "generador.ver",
  "POST /api/generador/exportar": "generador.ver",
  "GET /api/generador/reportes": "generador.ver",
  "GET /api/generador/reportes/:id": "generador.ver",
  "POST /api/generador/reportes": "generador.crear",
  "PUT /api/generador/reportes/:id": "generador.editar",
  "DELETE /api/generador/reportes/:id": "generador.archivar",
  "POST /api/generador/reportes/:id/duplicar": "generador.crear",
};

describe("which permission each gate asks for", () => {
  it("asks for the one the route is about, not merely for one", () => {
    const wrong: string[] = [];
    for (const [route, expected] of Object.entries(GENERADOR_GATES)) {
      const [method, path] = route.split(" ");
      const found = routes.find((r) => r.method === method && r.path === path);
      if (!found) {
        wrong.push(`${route} → no está montada`);
        continue;
      }
      if (!found.permissions.includes(expected)) {
        wrong.push(`${route} → pide ${JSON.stringify(found.permissions)}, esperaba ${expected}`);
      }
    }
    expect(wrong, `puertas que piden otra cosa: ${wrong.join(" | ")}`).toEqual([]);
  });

  it("reads a permission off every gate it finds", () => {
    // The assertion above is only as good as the stamp: if the metadata ever
    // stops arriving, every `includes` turns into a comparison against an empty
    // list and this file would go quiet about the whole question.
    const gated = routes.filter((r) => r.chain.some((name) => GATES.includes(name)));
    const mute = gated.filter((r) => r.permissions.length === 0);

    expect(gated.length).toBeGreaterThan(20);
    expect(mute.map((r) => `${r.method} ${r.path}`), "puertas sin permiso legible").toEqual([]);
  });
});
