// Which routes are gated by a role, and which are open to any logged-in account.
//
// `requirePermission.test.ts` proves the middleware decides correctly when it
// runs. It says nothing about whether a route actually mounts it — and that is
// where the gap used to live: `authenticate` is on every router, so the API
// knew *who* was calling, but on most of them it never asked *whether they may*.
// A Cliente could not see the Roles screen in the interface, and could still
// call `DELETE /api/rol/:id` from the browser console.
//
// This walks the app as Express assembled it, so it sees gates wherever they
// were put: inside the router, or at the mount in app.ts (which is how
// /api/files is protected).

import { describe, it, expect } from "vitest";
import express from "express";

/**
 * Where each router was mounted, taken down as the app declared it.
 *
 * This used to be read back out of Express's internals: a mount compiled to
 * `^\/api\/usuario\/?(?=\/|$)` and `mountPath()` un-escaped the regexp to
 * recover "/api/usuario". Express 5 stores no regexp — a `Layer` turns its path
 * straight into `matchers`, closures over a pattern nothing exposes, and
 * `layer.path` is populated only while a request is being matched. There is
 * nothing left to read the mount back out of.
 *
 * So it is recorded at the moment it is declared instead, by wrapping
 * `app.use` for the duration of the import. That is less clever than the regexp
 * and better in two ways: it reads what `app.ts` *said* rather than what
 * Express compiled, and it does not care which major version compiled it.
 *
 * The wrap has to be installed before `app.js` is imported — the mounts all run
 * at module scope — which is why the import below is dynamic and the restore
 * comes immediately after.
 *
 * **A queue per handler, not one path per handler.** `authenticate` is one
 * function object mounted on twenty different prefixes, so a plain map keeps
 * only the last of them and every other router loses its gate — the whole suite
 * then reports the API as wide open, which is a false alarm indistinguishable
 * from the real thing this file exists to raise. Express appends one layer per
 * handler in the order `use` was called, so the paths are read back in that same
 * order below. Pathless mounts record `null` rather than being skipped, because
 * skipping one would slide every later entry onto the wrong layer.
 */
const declaredMounts = new Map<unknown, (string | null)[]>();
const realUse = express.application.use;
(express.application as unknown as { use: unknown }).use = function (this: unknown, ...args: unknown[]) {
  const path = typeof args[0] === "string" ? (args[0] as string) : null;
  for (const handler of path === null ? args : args.slice(1)) {
    const queue = declaredMounts.get(handler) ?? [];
    queue.push(path);
    declaredMounts.set(handler, queue);
  }
  return (realUse as unknown as (...a: unknown[]) => unknown).apply(this, args);
};
const app = (await import("../app.js")).default;
(express.application as unknown as { use: unknown }).use = realUse;

/** The next path this handler was mounted on, in declaration order. */
const taken = new Map<unknown, number>();
function nextMount(handler: unknown): string | undefined {
  const queue = declaredMounts.get(handler);
  if (!queue) return undefined;
  const at = taken.get(handler) ?? 0;
  taken.set(handler, at + 1);
  return queue[at] ?? undefined;
}

/** Express layers carry no public types; this is the shape we read. */
interface Layer {
  name: string;
  /**
   * True for a pathless `router.use(mw)`, which therefore covers every route
   * declared after it. Express 4 spelled this `regexp.fast_slash`.
   */
  slash?: boolean;
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

function mountedRoutes(): MountedRoute[] {
  const held = app as unknown as { router?: { stack: Layer[] }; _router?: { stack: Layer[] } };
  const stack = (held.router ?? held._router)?.stack;
  // Asserted, not defaulted. An empty stack would make every check below pass
  // over nothing at all, which is the one way a test like this can lie — and
  // reading the router is exactly what the last major version bump broke.
  if (!stack?.length) throw new Error("no se pudo leer el router de express: cambió la forma interna");
  const routes: MountedRoute[] = [];

  // `app.use(path, a, b, router)` produces one layer per argument, all recorded
  // above under the same path, in the order they were written. So anything seen
  // under a prefix before the router itself is a gate that guards it.
  const beforeRouter = new Map<string, string[]>();

  for (const layer of stack) {
    // `undefined` for a layer that was not mounted on a path: the global
    // middleware — helmet, cors, the body parser — and the terminal error
    // handler. Those guard nothing in particular and are deliberately left out
    // of every chain, which is what keying on the compiled regexp used to
    // achieve by accident.
    const key = nextMount(layer.handle);
    // A route declared straight on the app — `app.post("/api/x", handler)` —
    // has no `handle.stack`, so it used to fall through to the else and be
    // filed away as the name of a middleware: invisible to both assertions
    // below. Nothing in this codebase is written that way today, and that is
    // exactly the shape someone in a hurry reaches for, which is the shape this
    // file exists to catch.
    if (layer.route) {
      const chain = [
        ...(key === undefined ? [] : beforeRouter.get(key) ?? []),
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
      // A router that reached here without a recorded mount is a router this
      // walk cannot place, and a route it cannot place is a route it cannot
      // check. Loudly, rather than under an empty prefix.
      if (key === undefined) throw new Error(`router montado sin ruta declarada: ${layer.name}`);
      const prefix = key;
      // A router can also gate itself with `router.use(requireRole(...))` — the
      // report builder does. Those are pathless layers inside the router's own
      // stack, and they cover every route declared after them.
      const routerWide: string[] = [];
      for (const inner of layer.handle.stack) {
        if (!inner.route) {
          if (inner.slash) routerWide.push(inner.handle.name);
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
    } else if (key !== undefined) {
      beforeRouter.set(key, [...(beforeRouter.get(key) ?? []), layer.handle.name]);
    }
  }
  return routes;
}

const GATES = ["requirePermissionGate", "requireSelfOrPermissionGate"];
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

const routes = mountedRoutes();

/**
 * The only routes that may run without `authenticate` in front of them.
 *
 * Named one by one rather than by prefix, which is what this used to do: the
 * filter was `!r.path.startsWith("/api/login")`, so every route ever added
 * under that prefix would have been exempt without anybody deciding it was.
 * A list of exact routes cannot grow by accident, and the honesty check below
 * makes it shrink when a route stops needing to be here.
 *
 * Both are the same case: they are what a credential is produced by, so they
 * cannot ask for one. There was a third — `GET /api/login/`, the JWT verifier
 * the app used to ask on every reload — and it was exempt for a different
 * reason: it checked the token itself, so going through `authenticate` would
 * have meant answering 401 instead of answering the question. It is retired, and
 * `app.auth.test.ts` pins its address at 404.
 */
const AUTHENTICATION_NOT_APPLICABLE = [
  // The old door. Hands out a session cookie; it used to hand out a JWT too.
  "POST /api/login/",
  // The new door. Same reason as the first: it is what produces the session.
  "POST /api/auth/login",

  // ── The way back in ────────────────────────────────────────────────────
  // These two are the only routes in the application that exist *for* the
  // person who cannot authenticate. Asking them for a session would be
  // asking somebody who forgot their password to log in first.
  //
  // What stands in for `authenticate` here is not nothing, and it is worth
  // naming so the next reader does not mistake this for a gap: `/forgot`
  // acts only on an address that already has a verified account and answers
  // identically when it does not, and `/reset` takes a single-use token whose
  // row carries the account — `token_uso_unico.id_usuario` — so neither can
  // be aimed at a chosen victim. See `password.controller.ts`.
  "POST /api/auth/password/forgot",
  "POST /api/auth/password/reset",
];

describe("the route table we are actually asserting about", () => {
  it("was read off the app, not guessed", () => {
    expect(routes.length).toBeGreaterThan(40);
    // If a future Express changes how mount paths compile, every path turns to
    // rubbish and the assertions below would pass while checking nothing.
    const bad = routes.filter((r) => !r.path.startsWith("/api/"));
    expect(bad, `rutas con prefijo ilegible: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it("puts authentication in front of everything except logging in", () => {
    const known = new Set(AUTHENTICATION_NOT_APPLICABLE);
    const open = routes
      .filter((r) => !r.chain.includes("authenticate"))
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !known.has(r))
      .sort();

    expect(open, `rutas sin authenticate:\n  ${open.join("\n  ")}`).toEqual([]);
  });

  it("keeps the unauthenticated list honest", () => {
    // The same trap the two exception lists below guard against: a line here for
    // a route that does authenticate turns the list into a place where an
    // exemption can hide behind a name nobody questions later.
    const stillOpen = new Set(
      routes.filter((r) => !r.chain.includes("authenticate")).map((r) => `${r.method} ${r.path}`),
    );
    const stale = AUTHENTICATION_NOT_APPLICABLE.filter((r) => !stillOpen.has(r));

    expect(
      stale,
      `ya autentican; bórralas de AUTHENTICATION_NOT_APPLICABLE:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});

/**
 * Write routes that deliberately ask for no permission.
 *
 * Each has a reason written next to it, and the same reason again in its own
 * router. Deliberately not counted in this sentence: the count said "two" while
 * the list held six, which is what a number in a comment does the moment
 * anything is added below it. Anything that appears here without a gate fails
 * the test below, which is the point: a new endpoint has to decide who may call
 * it instead of inheriting the gap.
 */
const GATE_NOT_APPLICABLE = [
  // Logging in cannot require a permission: it is what produces one.
  "POST /api/login/",
  // Serves three screens at once, one of which is your own profile photograph.
  // See upload.routes.ts.
  "POST /api/upload/",

  // ── The session endpoints ───────────────────────────────────────────────
  // Same reason for all four, and it is not "we did not get round to it":
  // every one of them acts on the caller's own session and on nothing else.
  // There is no role that may or may not log itself out, so there is no
  // checkbox to ask for — the same argument `requireSelfOrPermission` makes
  // for the profile routes, except that here there is not even another
  // person's record these could be pointed at.
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/logout-all",
  // The one that is not merely "your own" by construction: the id comes from
  // the URL. What keeps it to your own rows is `revokeSessionOf`, which puts
  // `id_usuario` in the same `where` as the id — not a permission. See
  // `auth.controller.ts`, and `app.auth.test.ts` for the assertion that the
  // filter is really in the query.
  "DELETE /api/auth/sessions/:id",

  // ── Your own recovery address ───────────────────────────────────────────
  // The same argument as the session endpoints above, and it is worth
  // spelling out because these two *write* to a `usuarios` row, which is
  // normally exactly what a permission gates.
  //
  // What they write is the caller's own recovery address, and the account is
  // taken from `req.user`, never from the request body — see
  // `email.controller.ts`. So there is no other person's record these could
  // be pointed at, and no role that may or may not be allowed to hold an
  // email of its own: gating them would mean an administrator could lock
  // somebody out of their own way back in.
  //
  // `/verify` takes only a token. The account it verifies comes out of the
  // token's row, so a caller cannot aim it at anyone — that is the property
  // `token_uso_unico.id_usuario` exists for, and it is asserted in
  // `email.controller.test.ts`, not here.
  "POST /api/auth/email/send",
  "POST /api/auth/email/verify",

  // ── The way back in ────────────────────────────────────────────────────
  // A permission is something an account holds, and the whole point of these
  // two is that the caller has no account in hand yet. There is nobody to
  // ask "may you?" of. See the note beside them in
  // AUTHENTICATION_NOT_APPLICABLE for what stands in for a gate instead.
  "POST /api/auth/password/forgot",
  "POST /api/auth/password/reset",
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
 * The writes a live session is not, on its own, enough for.
 *
 * `requireStepUp` (`middleware/requireStepUp.ts`) asks a second question after
 * the permission has already said yes: was a factor proved in the last ten
 * minutes — or, while the account has no factor to prove at all, is the
 * caller's own password supplied. Fourteen routes ask it: creating, editing and
 * unlocking accounts, everything that touches roles or the permission matrix,
 * closing one of your own other sessions, and registering the address your
 * password can be reset through.
 *
 * **Two of them have no permission in front of them, and the order test below
 * says which may not.** `DELETE /api/auth/sessions/:id` and `POST
 * /api/auth/email/send` are held to the caller's own account by `req.user`
 * rather than by the matrix — there is no role that may or may not close its
 * own sessions or hold an address of its own — so both carry step-up with no
 * `requirePermissionGate` above them. What keeps that from becoming a hole
 * anybody can widen is that the exemption is not a second list: it is
 * `GATE_NOT_APPLICABLE` above, which "gates every route that writes behind a
 * permission" already forces every ungated write into and "keeps the exception
 * list honest" already empties of anything that turned out to be gated.
 *
 * **Why this list exists at all.** Whether a route *mounts* the gate is
 * invisible to every request-shaped test of the gate's own rules, because a
 * route with no gate answers exactly what a satisfied gate answers. That is
 * not hypothetical here: three tests used to cover `DELETE /api/usuario/:id`'s
 * mount as a side effect, a fix round moved them to `DELETE /api/rol/:id` for
 * an unrelated and correct reason, and from then on `requireStepUp()` could be
 * deleted from that route with the whole suite still green. Eleven mounts held
 * up by side effects of tests about something else is how one of them goes
 * missing without anybody noticing.
 *
 * **Written out rather than derived**, for the same reason `GENERADOR_GATES`
 * below is: a list computed from the routers would only assert that the code
 * agrees with itself. These fourteen are the intent, and the comparison runs both
 * ways — a mount that disappears fails, and so does one that appears.
 *
 * **The second direction is load-bearing, not symmetry for its own sake, and
 * `PATCH /api/usuario/:id/desbloquear` is the entry that proves it.** It was
 * deliberately *outside* this list, with the reason written in three places:
 * lifting a lockout is what an administrator does because somebody cannot get
 * in, and whoever holds `seguridad.editar` can already do worse through the
 * routes beside it. An audit found the second half of that sentence has an
 * expiry date on it — plan 4B makes those neighbouring routes refuse a session
 * with no proved factor, and this one would have gone on answering 200 while
 * clearing the login lockout — the only brake against password guessing that
 * survives a restart of the API, the rate limiters being in-memory. The
 * decision was reversed here, in the table, which is where reversing it is
 * visible; a list that only checked for missing mounts would have let it be
 * reversed back in silence.
 *
 * **Mounted with an option is still mounted, and this table cannot see the
 * difference.** `POST /api/auth/email/send` carries
 * `requireStepUp({ permiteOnboarding: true })`, which returns the same
 * `stepUpGate` function under a different closure, so the option is pinned
 * where it is observable — through a request, in `app.auth.test.ts` — and not
 * pretended at from here.
 *
 * Live here and not in `app.auth.test.ts`, which pins the gate's *behaviour*
 * through real requests: this file already walks the app as Express assembled
 * it, across all three routers at once, and already owns the question "is the
 * right gate on the right route". Splitting the fourteen between two files would
 * mean two half-tables, which is the shape the gap above came in.
 */
const STEP_UP_GATED = [
  // usuario.routes.ts — seven.
  "POST /api/usuario/",
  "DELETE /api/usuario/:id",
  "PATCH /api/usuario/:id/desarchivar",
  // The one that was outside this list until an audit read its reason again.
  // See the paragraph above, and the rewritten comment beside the route.
  "PATCH /api/usuario/:id/desbloquear",
  "PUT /api/usuario/:id",
  "PUT /api/usuario/username/:id",
  "PUT /api/usuario/userpass/:id",
  // rol.routes.ts — four. `GET /` is a read and carries no gate of any kind:
  // every screen that shows a person needs the name of their role.
  "POST /api/rol/",
  "PUT /api/rol/:id",
  "DELETE /api/rol/:id",
  "PATCH /api/rol/:id/desarchivar",
  // permiso.routes.ts — one. The screen that edits who may do what.
  "PUT /api/permisos/:id_rol",
  // auth.routes.ts — one of the two entries with no permission above them.
  // «Step-up. Solo filas propias» in §5 of the design, and until this task
  // only the second half was true: an audit closed every other session of an
  // account from a stolen cookie in `onboarding`, keeping the stolen one
  // alive. The neighbouring session routes stay ungated on purpose — see the
  // comment beside this one in `auth.routes.ts`.
  "DELETE /api/auth/sessions/:id",
  // auth.routes.ts — and one more, the only mount that passes an option.
  // The design's step-up list has "cambiar el email propio" on it, and this
  // is the route that does it. The handler's own `pass` check is not the same
  // thing: it goes on accepting a password after plan 4B registers a factor,
  // which is precisely what the gate's second branch exists to stop.
  "POST /api/auth/email/send",
];

describe("which writes also demand a recently proved factor", () => {
  const gated = routes
    .filter((r) => r.chain.includes("stepUpGate"))
    .map((r) => `${r.method} ${r.path}`)
    .sort();

  it("mounts requireStepUp on exactly those fourteen routes and on no others", () => {
    // `stepUpGate` is the name `requireStepUp()` gives the function it returns,
    // for exactly this — see the comment above the `return` in
    // `requireStepUp.ts`. An anonymous handler there would make this assertion
    // unwritable.
    expect(gated).toEqual([...STEP_UP_GATED].sort());
  });

  it("runs the permission check first on every one of them, never the gate", () => {
    // The order the routers were written in, asserted rather than trusted:
    // somebody without the permission must be refused by the permission —
    // spending no bcrypt comparison, and learning nothing about the route
    // existing — instead of being asked to prove a factor first.
    //
    // The two routes with no permission at all are allowed through this check
    // rather than exempted from the file: `sinPermiso` is `GATE_NOT_APPLICABLE`
    // itself, so a gated route can only be missing its permission here if the
    // same file already says, with a reason written next to it, that it asks
    // for none — and "keeps the exception list honest" above deletes that line
    // the day the route grows one.
    const sinPermiso = new Set(GATE_NOT_APPLICABLE);
    const mal: string[] = [];
    for (const nombre of STEP_UP_GATED) {
      const [method, path] = nombre.split(" ");
      const ruta = routes.find((r) => r.method === method && r.path === path);
      if (!ruta) {
        mal.push(`${nombre} → no está montada`);
        continue;
      }
      const permiso = ruta.chain.findIndex((name) => GATES.includes(name));
      const step = ruta.chain.indexOf("stepUpGate");
      // Both looked up before either is compared. Without these two lines the
      // comparison below passes for a chain missing either name, because
      // `indexOf` answers -1 and -1 is less than everything — the exact shape
      // of assertion this file exists to stop.
      if (step === -1) {
        mal.push(`${nombre} → sin stepUpGate: ${ruta.chain.join(" -> ")}`);
        continue;
      }
      if (permiso === -1) {
        if (!sinPermiso.has(nombre)) {
          mal.push(`${nombre} → sin permiso: ${ruta.chain.join(" -> ")}`);
        }
        continue;
      }
      if (permiso > step) mal.push(`${nombre} → ${ruta.chain.join(" -> ")}`);
    }

    expect(mal, `el orden permiso→step-up no se cumple en:\n  ${mal.join("\n  ")}`).toEqual([]);
  });
});

/**
 * Read routes that deliberately ask for no permission.
 *
 * The write test above has always been the whole of this file's ambition, and
 * that was the gap: `WRITES` excludes GET, so no read has ever been asserted
 * about. Every route below is a read that any logged-in account may call today,
 * whatever its role — which means the `ver` column of the permission matrix
 * decides which buttons the browser draws and nothing more.
 *
 * This list is a snapshot of that debt, not an endorsement of it. It exists so
 * that a *new* ungated read fails the test instead of joining the pile
 * unnoticed, and so the pile is countable. Shortening it is its own piece of
 * work: gating a read that a screen depends on turns that screen into an error
 * state, so each line needs its own decision about what the caller sees.
 */
const READ_GATE_NOT_APPLICABLE = [
  // Two that genuinely cannot ask for a permission, each for the same reason:
  // they are what the answer to "may I?" is built from.
  //
  // Who you are and what you may do. Gating this would need a permission to
  // learn which permissions you hold, and it is what the frontend asks on every
  // reload before it knows what the account may do. Three lines stood here
  // until `GET /api/login/` and `GET /api/permisos/mias` were retired: this
  // endpoint replaced both of them, answering in one round trip what they
  // answered in two.
  "GET /api/auth/me",
  // The devices *you* are logged in on. `listSessionsOf` takes the id from
  // `req.user`, never from the request, so there is no other person's list this
  // could return.
  "GET /api/auth/sessions",

  // ── Everything below is the debt ────────────────────────────────────────
  // Reads that any logged-in account may call, whatever its role. The count is
  // deliberately not written here any more: it was «twenty», and A1 deleted
  // `GET /api/solucion/` out from under it. A number in a comment ages in
  // silence; the test below is what keeps this list honest.
  // `GET /api/dashboard/` used to be one of these and the worst of them — no
  // `where`, no `limit`, the whole asset register in one response — which is why
  // it was gated first.
  "GET /api/adss/",
  "GET /api/adssposte/:id_poste",
  "GET /api/ciudad/",
  "GET /api/ciudad/:id",
  "GET /api/evento/",
  "GET /api/evento/:id",
  "GET /api/evento/poste/:id_poste",
  "GET /api/evento/usuario/:id_usuario",
  "GET /api/eventoObs/:id_evento",
  "GET /api/material/",
  "GET /api/obs/",
  "GET /api/poste/",
  "GET /api/poste/:id",
  "GET /api/poste/tramos",
  "GET /api/propietario/",
  "GET /api/revision/:id_evento",
  "GET /api/rol/",
  "GET /api/solucion/evento/:id_evento",
  "GET /api/tipoObs/",
];

describe("who may read data", () => {
  const ungated = routes
    .filter((r) => r.method === "GET")
    .filter((r) => !r.chain.some((name) => GATES.includes(name)))
    .map((r) => `${r.method} ${r.path}`)
    .sort();

  it("gates every route that reads behind a permission", () => {
    const known = new Set(READ_GATE_NOT_APPLICABLE);
    const unexpected = ungated.filter((r) => !known.has(r));

    expect(
      unexpected,
      `lecturas sin decidir quién puede llamarlas:\n  ${unexpected.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the read exception list honest", () => {
    const stillOpen = new Set(ungated);
    const stale = READ_GATE_NOT_APPLICABLE.filter((r) => !stillOpen.has(r));

    expect(
      stale,
      `ya están protegidas; bórralas de READ_GATE_NOT_APPLICABLE:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
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
  "POST /api/generador/conteo": "generador.ver",
  "POST /api/generador/exportar": "generador.ver",
  "GET /api/generador/reportes": "generador.ver",
  "GET /api/generador/reportes/:id": "generador.ver",
  "POST /api/generador/reportes": "generador.crear",
  "PUT /api/generador/reportes/:id": "generador.editar",
  "DELETE /api/generador/reportes/:id": "generador.archivar",
  "POST /api/generador/reportes/:id/duplicar": "generador.crear",
};

/**
 * What the incident routes must ask for, exactly.
 *
 * There is no `revisiones` module and no `soluciones` module: a revision and a
 * resolution are both work recorded against an incident that already exists, so
 * within `eventos` the line is drawn at whether a new incident comes into being.
 * `crear` is opening one. Everything done to one afterwards — resolving it,
 * reopening it, recording an inspection — is `editar`.
 *
 * That line matters because of the role it makes expressible: a field account
 * that records inspections but may not open incidents is `ver` + `editar`
 * without `crear`. If a revision asked for `crear`, that role could not exist.
 * The opposite role — may open incidents, may not record inspections — is not a
 * job anybody has.
 *
 * `POST /api/revision/` asked for `crear` until this list was written, while
 * `POST /api/evento/:id/resolver` two files over asked for `editar` for the same
 * kind of act, and every button in the interface asked the browser for `editar`.
 * The interface and the server disagreed, and nothing here noticed.
 */
const EVENTOS_GATES: Record<string, string> = {
  "POST /api/evento/": "eventos.crear",
  "PUT /api/evento/:id": "eventos.editar",
  "POST /api/evento/:id/resolver": "eventos.editar",
  "POST /api/evento/:id/reabrir": "eventos.editar",
  "DELETE /api/evento/:id": "eventos.archivar",
  "POST /api/revision/": "eventos.editar",
  // The one read on this list, and the reason the read test above has an
  // exception list instead of nothing: it hands over every incident and every
  // pole in one response, so `ver` has to mean something here.
  "GET /api/dashboard/": "eventos.ver",
};

/**
 * The five summary reads, which are not the harmless counters they look like.
 *
 * Every one of them is rendered by a section of the Parámetros screen and
 * nowhere else, and every write on those same five routers already asks for
 * `parametros`. Only the reads were left out, and one of them matters a great
 * deal more than the rest: `GET /api/propietario/stats` returns the **name** of
 * the owner company with the most poles and the **name** of the one with the
 * largest pending backlog, with both counts. Osefi maintains poles for several
 * companies at once, so that is one client being told which of the others is in
 * the worst shape — by name — and role 3, the one called Cliente, holds
 * `parametros: NADA` yet could call it.
 *
 * `parametros.ver` is therefore the pair, matching the writes beside them and
 * the screen that draws them. Deliberately narrow: the plain list reads on the
 * same routers stay open, because the pole and incident forms need the
 * catalogues and the Cliente's own report screen reads four of them. Those need
 * a decision about what a client may see, which is a different piece of work.
 */
const PARAMETROS_GATES: Record<string, string> = {
  "GET /api/propietario/stats": "parametros.ver",
  "GET /api/adss/stats": "parametros.ver",
  "GET /api/material/stats": "parametros.ver",
  "GET /api/obs/stats": "parametros.ver",
  "GET /api/tipoObs/stats": "parametros.ver",
};

/**
 * What each route of the Seguridad module must ask for, exactly.
 *
 * This is the table the file was missing, and its absence was measurable rather
 * than theoretical: `DELETE /api/usuario/:id` was re-gated from
 * `seguridad.archivar` to `seguridad.ver` — so that an account allowed only to
 * *look* at the security screen could archive anybody's account — and the whole
 * suite stayed green. Nothing anywhere read the pair. The chain of names says a
 * gate is there; `requirePermission("seguridad", "ver")` and `("seguridad",
 * "archivar")` are both called `requirePermissionGate`, so "there" was all that
 * was ever asserted about the module that hands out and takes away accounts.
 *
 * Written out rather than derived, for the same reason `GENERADOR_GATES` above
 * is: a list computed from the routers would assert only that the code agrees
 * with itself.
 *
 * **The four `requireSelfOrPermission` routes are here on the same footing as
 * the rest, and the pair means the same thing.** That middleware stamps the
 * pair it would ask the matrix for — see `label` in `requirePermission.ts` — so
 * what this table pins is the permission a *stranger* needs. The other half of
 * that gate, "or it is your own row", is ownership rather than a checkbox and is
 * asserted in `requirePermission.test.ts`, where a request can actually be
 * aimed at somebody else's id.
 *
 * `GET /api/usuario/:id` is a read and still belongs here: gated reads are not
 * covered by `READ_GATE_NOT_APPLICABLE`, which by construction only ever names
 * the ungated ones.
 */
const SEGURIDAD_GATES: Record<string, string> = {
  // Creating an account and reading one are not the same permission even though
  // they live behind the same screen.
  "POST /api/usuario/": "seguridad.crear",
  "DELETE /api/usuario/:id": "seguridad.archivar",
  "PATCH /api/usuario/:id/desarchivar": "seguridad.archivar",
  // `editar` and not `archivar`, and the reason is written beside the route:
  // lifting a lockout is the same kind of act as resetting a password, which is
  // the other way out of one. It is the one pair on this table that a reader
  // could plausibly talk themselves into changing.
  "PATCH /api/usuario/:id/desbloquear": "seguridad.editar",
  "GET /api/usuario/": "seguridad.ver",
  "GET /api/usuario/user/:user": "seguridad.ver",
  // The four that a person may also call for their own row.
  "GET /api/usuario/:id": "seguridad.ver",
  "PUT /api/usuario/:id": "seguridad.editar",
  "PUT /api/usuario/username/:id": "seguridad.editar",
  "PUT /api/usuario/userpass/:id": "seguridad.editar",
};

/**
 * What each route of the Roles module must ask for, exactly.
 *
 * `roles` is its own module and not part of `seguridad`, because managing
 * accounts and handing out authority are different powers: whoever may edit a
 * user must not thereby be able to promote themselves. That separation is the
 * thing this table protects — a single mistyped module name here would quietly
 * merge the two, and every other test in the repository would go on passing.
 *
 * The matrix editor is the sharpest entry. `PUT /api/permisos/:id_rol` writes
 * who may do what for the role it names — `putPermisos` refuses your own role
 * with a 409, so the one thing it cannot do is promote the caller directly. What
 * it can do is grant those cells to some other role, and `roles.editar` is the
 * only thing deciding who may.
 *
 * `GET /api/rol/` is deliberately not here: it carries no gate at all, because
 * every screen that shows a person needs the name of their role. It is named in
 * `READ_GATE_NOT_APPLICABLE` above, which is where an ungated route's reason
 * belongs.
 */
const ROLES_GATES: Record<string, string> = {
  "POST /api/rol/": "roles.crear",
  "PUT /api/rol/:id": "roles.editar",
  "DELETE /api/rol/:id": "roles.archivar",
  "PATCH /api/rol/:id/desarchivar": "roles.archivar",
  "GET /api/permisos/": "roles.ver",
  "PUT /api/permisos/:id_rol": "roles.editar",
};

/** The three routers the two tables above claim to describe completely. */
const MODULOS_TABULADOS = /^\/api\/(usuario|rol|permisos)\b/;

describe("which permission each gate asks for", () => {
  it("asks for the one the route is about, not merely for one", () => {
    const wrong: string[] = [];
    for (const [route, expected] of Object.entries({
      ...GENERADOR_GATES,
      ...EVENTOS_GATES,
      ...PARAMETROS_GATES,
      ...SEGURIDAD_GATES,
      ...ROLES_GATES,
    })) {
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

  it("names every gated route of usuario, rol and permisos, so a new one cannot join unlisted", () => {
    // The assertion above runs table → code, so it can only catch a pair that
    // changed under a route somebody already wrote down. A route added
    // tomorrow is invisible to it, and on these three routers that is the
    // expensive direction: they are the ones that create accounts, archive
    // them, and rewrite the permission matrix itself.
    //
    // Only these three routers, and not every router in the file, because the
    // two tables above are the only ones written as complete descriptions.
    // `PARAMETROS_GATES` is deliberately partial and says so: it names the five
    // `/stats` reads and none of the `parametros.crear`, `editar` and
    // `archivar` writes sitting beside them on those same five routers, so
    // demanding completeness of it would assert the opposite of what its own
    // comment decided. `GENERADOR_GATES` and `EVENTOS_GATES` do happen to name
    // every gated route of theirs today, and nothing here holds them to it.
    const tabuladas = new Set([...Object.keys(SEGURIDAD_GATES), ...Object.keys(ROLES_GATES)]);
    const faltan = routes
      .filter((r) => MODULOS_TABULADOS.test(r.path))
      .filter((r) => r.chain.some((name) => GATES.includes(name)))
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !tabuladas.has(r))
      .sort();

    expect(
      faltan,
      `rutas con puerta y sin permiso declarado; añádelas a SEGURIDAD_GATES o ROLES_GATES:\n  ${faltan.join("\n  ")}`,
    ).toEqual([]);
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
