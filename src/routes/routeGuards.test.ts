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
const {
  webauthnCeremonyLimiter,
  passwordlessOptionsLimiter,
  passwordlessVerifyLimiter,
  loginRateLimit,
} = await import("../middleware/loginLimiters.js");
const { puedeAlcanzar } = await import("../auth/sessionState.js");
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
    stack: { handle: { name: string; permission?: string; opciones?: OpcionesGate } }[];
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
  /** The options the step-up gate on this route was mounted with, if any. */
  stepUp?: OpcionesGate;
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
      const stepUp = layer.route.stack.map((s) => s.handle.opciones).find((o) => o !== undefined);
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method: method.toUpperCase(), path: layer.route.path, chain, permissions, stepUp,
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
        const stepUp = inner.route.stack.map((s) => s.handle.opciones).find((o) => o !== undefined);
        for (const method of Object.keys(inner.route.methods)) {
          routes.push({
            method: method.toUpperCase(), path: prefix + inner.route.path, chain, permissions, stepUp,
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

  // ── Entrar con una passkey, sin contraseña (plan 4C, fase 2) ───────────
  // Las dos son lo que produce la credencial para quien no tiene ninguna,
  // igual que el login: pedirles una sesión sería pedir a quien viene a abrir
  // una que ya la tenga. Lo que hace de guardia en su lugar, y por qué basta,
  // está en `webauthnPasswordless.routes.ts`: `requireVerifiedOrigin` en la
  // montura (las dos barreras CSRF sin la excepción de «no hay cookie»), un
  // cubo por dirección en cada una, la lectura paranoid de la cuenta y el
  // reto de un solo uso — y la firma, que es la credencial entera.
  "POST /api/auth/webauthn/passwordless/options",
  "POST /api/auth/webauthn/passwordless/verify",
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

  // ── El código por correo (plan 4E) ──────────────────────────────────────
  // Envía un código a la dirección verificada de la propia cuenta de quien
  // llama, y a ninguna otra: la dirección sale de `req.user.id`, nunca del
  // cuerpo. Sin permiso que pedir por el mismo argumento que `/mfa/verify`
  // — es la puerta, no lo que hay detrás — y sin `requireStepUp` por
  // construcción: es un medio para satisfacerlo. Sus topes viven en la base,
  // por cuenta (`auth/emailCodeStore.ts`), no en un cubo.
  "POST /api/auth/mfa/email-code",

  // ── El segundo factor (plan 4B) ─────────────────────────────────────────
  // Los cinco que escriben, y el argumento es el mismo de los endpoints de
  // sesión de arriba: cada uno actúa sobre la propia cuenta de quien llama y
  // sobre ninguna otra. El factor se busca por `req.user.id`, la sesión que
  // ascienden es `req.user.id_sesion`, y los códigos se cuentan y se gastan
  // con `id_usuario` en el mismo `where` — nunca con nada del cuerpo.
  //
  // No hay ningún rol que pueda o no pueda tener un segundo factor, así que no
  // hay casilla que pedir. Lo que sí piden cuatro de los cinco es la
  // contraseña, y eso es la lista `STEP_UP_GATED`, no ésta: son ejes
  // distintos — «¿de quién es este dato?» contra «¿con qué te acreditas?».
  //
  // `POST /api/auth/mfa/verify` es el único de los cinco que **no** puede
  // llevar puerta de step-up, y por construcción: lo llama una sesión
  // `parcial`, que por definición aún no ha probado nada. Es la puerta, no lo
  // que está detrás de ella.
  "POST /api/auth/mfa/verify",
  "POST /api/auth/stepup",
  "POST /api/auth/totp/setup",
  "POST /api/auth/totp/confirm",
  "DELETE /api/auth/totp/",
  "POST /api/auth/recovery-codes/",

  // ── Las passkeys (plan 4C) ──────────────────────────────────────────────
  // Mismo argumento, palabra por palabra, que los cinco de arriba: las dos
  // actúan sobre la cuenta de quien llama y sobre ninguna otra. La credencial
  // se crea con `req.user.id`, la sesión que asciende es `req.user.id_sesion`,
  // y el reto se canjea con ese mismo `id_sesion` dentro del `WHERE` — nunca
  // con nada que venga del cuerpo. No hay rol que pueda o no pueda tener una
  // passkey, así que no hay casilla que pedir.
  //
  // 🔴 Y hay una comprobación más que el camino del TOTP no necesita, porque
  // allí no hay reto: `registerVerify` compara el dueño del reto consumido con
  // `req.user.id` antes de escribir nada. Sin ella, una ceremonia empezada por
  // una cuenta podría terminarse contra otra.
  //
  // Las dos sí piden contraseña, y eso está en `STEP_UP_GATED` — el otro eje.
  "POST /api/auth/webauthn/register/options",
  "POST /api/auth/webauthn/register/verify",
  // Y las dos de probar una passkey ya registrada. Mismo argumento que las de
  // arriba en cuanto al permiso —actúan sobre la propia cuenta—, pero éstas
  // **tampoco** llevan puerta de step-up, y eso no es un olvido: las llama una
  // sesión `parcial`, que por definición aún no ha probado nada.
  // `requireStepUp` rechaza `parcial` de plano, así que montarla aquí cerraría
  // la única salida de ese estado. Es exactamente el caso de
  // `POST /api/auth/mfa/verify`, unas líneas más arriba.
  "POST /api/auth/webauthn/login/options",
  "POST /api/auth/webauthn/login/verify",
  // Y borrar una llave propia, por el mismo motivo que registrarla: el `WHERE`
  // lleva `id_usuario: req.user.id` junto al `:id` de la URL, así que la ruta
  // no puede tocar la credencial de otra persona haya el rol que haya. No hay
  // permiso que pedir porque no hay nadie más a quien afectar.
  //
  // Sí lleva step-up **con contraseña**, y eso está en `STEP_UP_GATED`.
  "DELETE /api/auth/webauthn/credentials/:id",
  // Y las dos de entrar sin contraseña (fase 2). Un permiso es algo que tiene
  // una cuenta, y aquí no hay cuenta en la mano hasta que la firma verifica:
  // no hay nadie a quien preguntarle «¿puedes?». Tampoco pueden llevar
  // `requireStepUp`, que rechaza de plano a quien no tiene sesión — sería un
  // 403 para todo el mundo. Lo que las guarda está junto a ellas en
  // `AUTHENTICATION_NOT_APPLICABLE`.
  "POST /api/auth/webauthn/passwordless/options",
  "POST /api/auth/webauthn/passwordless/verify",
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
 * caller's own password supplied. `STEP_UP_GATED` below is the list: creating, editing and
 * unlocking accounts, resetting somebody else's second factor, everything that
 * touches roles or the permission matrix, closing one of your own other
 * sessions, and registering the address your password can be reset through.
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
 * deleted from that route with the whole suite still green. Mounts held
 * up by side effects of tests about something else is how one of them goes
 * missing without anybody noticing.
 *
 * **Written out rather than derived**, for the same reason `GENERADOR_GATES`
 * below is: a list computed from the routers would only assert that the code
 * agrees with itself. This list is the intent, and the comparison runs both
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
 * right gate on the right route". Splitting the list between two files would
 * mean two half-tables, which is the shape the gap above came in.
 */
const STEP_UP_GATED = [
  // usuario.routes.ts — eight.
  "POST /api/usuario/",
  "DELETE /api/usuario/:id",
  "PATCH /api/usuario/:id/desarchivar",
  // The one that was outside this list until an audit read its reason again.
  // See the paragraph above, and the rewritten comment beside the route.
  // Also one of the two mounts below carrying `exigeContrasena: true` since
  // hallazgo F8 (2026-09-02 closure audit) — see the "cuatro, y dos más
  // arriba" note near the bottom of this array for why.
  "PATCH /api/usuario/:id/desbloquear",
  "PUT /api/usuario/:id",
  "PUT /api/usuario/username/:id",
  "PUT /api/usuario/userpass/:id",
  // The escape hatch from §8 of the MFA design — an administrator clears
  // somebody else's second factor. `rescatarMfaDeUsuario`'s own comment
  // explains the refusal this route adds on top of the gate: resetting your
  // own factors here would leave your own session past `requireStepUp` on
  // nothing but the cookie, since an account with no factors is exactly what
  // this gate lets through unchallenged. The other of the two mounts with
  // `exigeContrasena: true` — hallazgo F8, same note below.
  "POST /api/usuario/:id/mfa/reset",
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
  // auth.routes.ts — and one more that also passes an option, `permiteOnboarding`
  // and not `exigeContrasena` — the two `usuario.routes.ts` mounts above that
  // pass an option ask for the password instead; this one asks to let
  // `onboarding` through. The design's step-up list has "cambiar el email
  // propio" on it, and this is the route that does it. The handler's own
  // `pass` check is not the same thing: it goes on accepting a password
  // after plan 4B registers a factor, which is precisely what the gate's
  // second branch exists to stop.
  "POST /api/auth/email/send",
  // ── El segundo factor (plan 4B) — cuatro, y dos más arriba ──────────────
  // Cuántas llevan `exigeContrasena: true` lo dice `STEP_UP_OPTIONS`, al final
  // de este fichero, y no un número aquí: éste decía «seis, no cuatro» cuando
  // ya eran nueve, y desde la decisión D6 del plan 4C son veinte. En esta puerta
  // la opción significa que piden la contraseña **siempre**, también a
  // quien acaba de probar su factor. Para las cuatro de aquí abajo, no es
  // celo: un código de recuperación sella esa misma ventana, así que sin el
  // «siempre» bastaría el papel impreso para dar de alta un factor nuevo —
  // que es justo el límite que el plan dice que no se puede cruzar. Para las
  // dos de `usuario.routes.ts` la razón es más simple: con ninguna cuenta
  // de las nueve con un factor, la contraseña de quien llama es la única
  // prueba que le queda pedir a la puerta antes de borrar el segundo factor
  // de otra cuenta o de levantarle su bloqueo de inicio de sesión.
  //
  // Las dos de alta (TOTP) llevan además `permiteOnboarding`, y no es una
  // relajación sino lo contrario de una caída: sin ella, quien está en
  // `onboarding` no podría registrar jamás el factor que le saca de
  // `onboarding`. `parcial` sigue rechazado pase lo que pase. Las dos de
  // `usuario.routes.ts` no la llevan — nunca la llevaron, y siguen sin
  // necesitarla: ninguna de las dos es una de las puertas por las que
  // `onboarding` sale de `onboarding`.
  "POST /api/auth/totp/setup",
  "POST /api/auth/totp/confirm",
  "DELETE /api/auth/totp/",
  "POST /api/auth/recovery-codes/",

  // ── Las passkeys (plan 4C) ──────────────────────────────────────────────
  // Las dos con `exigeContrasena: true` y `permiteOnboarding: true`, por las
  // dos razones que el bloque de arriba ya da para el alta de TOTP, y ninguna
  // de las dos es nueva:
  //
  // 🔴 **La contraseña, siempre.** Sin ella, una cookie robada da de alta su
  // propia passkey, y desde ese instante `tieneAlgunFactor` le quita al dueño
  // real hasta el respaldo de la contraseña: su siguiente login abre `parcial`
  // y sólo se sale probando la credencial **del atacante**. Cambiar la
  // contraseña no sirve y `logout-all` revoca sesiones, no credenciales. Es el
  // hallazgo C1, y `totp.routes.ts` lleva el mismo aviso escrito.
  //
  // Y con passkeys hay un motivo añadido que el TOTP no tenía: la credencial
  // se sincroniza con la cuenta de Apple o de Google de cada persona, así que
  // la contraseña pasa a ser lo único que **no** vive ahí.
  //
  // **`permiteOnboarding`, que no es una relajación sino lo contrario de una
  // caída**: es la pantalla a la que alguien en `onboarding` tiene que llegar
  // para dejar de estar en `onboarding`. `parcial` sigue rechazado pase lo que
  // pase — y eso importa aquí más que en el TOTP, porque `PARCIAL` sí abre
  // `/api/auth/webauthn/login`: la puerta que **prueba** una passkey, nunca la
  // que la **crea**.
  "POST /api/auth/webauthn/register/options",
  "POST /api/auth/webauthn/register/verify",
  // Y el borrado, que es el espejo exacto del registro: cambia con qué puede
  // probarse la cuenta. Sin contraseña, quien tenga la cookie puede quitarle a
  // alguien su segundo factor y quedarse con la cuenta a base de contraseña
  // sola — y con passkeys hay un motivo más, porque borrar la última revoca
  // todas las sesiones, que es una operación sobre la cuenta entera.
  //
  // 🔴 **No encierra a nadie**, que es la pregunta que hay que hacerle a este
  // montaje: una cuenta cuya única llave es la que quiere borrar recibe
  // `sin-factor-reciente` con `exigeContrasena` y, desde la Tarea 8, con
  // `metodos: ["passkey", …]`. La ventana sabe ofrecer la huella, la persona
  // la prueba en `/webauthn/login/verify`, teclea la contraseña y pasa. Sin
  // ese campo la ventana habría pintado un hueco de seis dígitos imposible.
  "DELETE /api/auth/webauthn/credentials/:id",
];

describe("which writes also demand a recently proved factor", () => {
  const gated = routes
    .filter((r) => r.chain.includes("stepUpGate"))
    .map((r) => `${r.method} ${r.path}`)
    .sort();

  // The name used to say "those nineteen routes", and the number went stale the
  // first time a plan added one — which is the same failure this file already
  // warns about beside `GATE_NOT_APPLICABLE` ("the count said two while the
  // list held six"). The list is the count; a number written out beside it is
  // a second copy that nothing keeps honest.
  it("mounts requireStepUp on exactly the routes in that list and on no others", () => {
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
  // Las llaves *tuyas*. Mismo argumento que la línea de arriba: el `where`
  // toma el id de `req.user`, así que no hay lista de otra persona que esto
  // pueda devolver. Y no lleva step-up a propósito: es la pantalla que te
  // enseña **con qué** puedes probarte, así que ponerle una ceremonia delante
  // sería pedirte que demuestres algo antes de dejarte ver qué tienes.
  "GET /api/auth/webauthn/credentials",

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
  // Cuántos códigos de recuperación te quedan. Un número sobre tu propia
  // cuenta, tomado de `req.user`, y nunca un código. Pedir un permiso para
  // verlo sería fricción sin defensa; enterarte de que te quedan dos el día
  // que hacen falta es tarde.
  "GET /api/auth/recovery-codes/",
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
  // Missing until A1's audit went looking, while two comments in this file
  // claimed this table named every gated route it had. Unlisted, changing this
  // line to `eventos.ver` would let an account that may only look at incidents
  // unarchive any of them, with the suite green.
  "PATCH /api/evento/:id/desarchivar": "eventos.archivar",
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
  // Same pair as `/desbloquear` just above, and the same reasoning: this is
  // the other way an administrator undoes a state that leaves an account
  // unable to log in.
  "POST /api/usuario/:id/mfa/reset": "seguridad.editar",
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

/**
 * El presupuesto de la ceremonia de passkey — plan 4C, Tarea 8.
 *
 * 🔴 Se comprueba por **identidad de la función**, no por su nombre.
 * `express-rate-limit` devuelve una función anónima (`fn.name === ""`), así
 * que la maquinaria de nombres que usa el resto de este fichero no puede ver
 * ni un limitador ni la diferencia entre dos. Comparar la referencia es lo
 * único que distingue «está montado el bucket correcto» de «hay algo ahí».
 */
describe("el presupuesto de las ceremonias de passkey", () => {
  /** Cada ruta del árbol entero donde aparece ese manejador exacto. */
  function rutasCon(handler: unknown): string[] {
    const encontradas: string[] = [];
    const recorrer = (capas: Layer[] | undefined): void => {
      for (const capa of capas ?? []) {
        if (capa.route) {
          const suyo = (capa.route.stack as unknown as { handle: unknown }[]).some(
            (s) => s.handle === handler,
          );
          if (suyo) encontradas.push(capa.route.path);
        }
        recorrer(capa.handle.stack);
      }
    };
    const held = app as unknown as { router?: { stack: Layer[] }; _router?: { stack: Layer[] } };
    recorrer((held.router ?? held._router)?.stack);
    return encontradas;
  }

  // Sin este bucket, las dos rutas son un INSERT gratis e ilimitado en la
  // bitácora para quien tenga una cookie robada: un fallo de firma no carga
  // nada contra el bloqueo de la cuenta —decisión D7— y a cambio escribe una
  // línea. Y la tabla no la poda nadie.
  it("cuenta las dos ceremonias de login, y sólo esas dos", () => {
    expect(rutasCon(webauthnCeremonyLimiter).sort()).toEqual([
      "/login/options",
      "/login/verify",
    ]);
  });

  // La comprobación de arriba sólo vale si el recorrido encuentra algo: un
  // walker roto devolvería [] y ninguna de las dos afirmaciones se enteraría.
  it("el recorrido del árbol encuentra rutas de verdad", () => {
    expect(rutasCon(webauthnCeremonyLimiter).length).toBeGreaterThan(0);
  });

  // Fase 2: cada ruta anónima con su cubo, y sólo el suyo. Intercambiarlos
  // dejaría `options` reembolsando el éxito —que es la escritura que acota— y
  // `verify` cobrando los logins que salieron bien.
  it("pone a cada ruta sin contraseña su propio cubo por dirección", () => {
    expect(rutasCon(passwordlessOptionsLimiter)).toEqual(["/options"]);
    expect(rutasCon(passwordlessVerifyLimiter)).toEqual(["/verify"]);
  });

  // Y ni el cubo del login con contraseña ni el de las ceremonias con sesión
  // llegan a ellas: el primero degrada a un segundo cubo por dirección de diez
  // para todo el edificio cuando el cuerpo no trae `user`, y el segundo se
  // llama por sesión, que aquí no existe. `rutasCon` lee la ruta relativa al
  // router, así que `/login` es la de `auth.routes.ts`.
  it("no monta el cubo del login con contraseña en las rutas sin contraseña", () => {
    expect(rutasCon(loginRateLimit)).toEqual(["/login"]);
  });
});

/**
 * La puerta de origen de las dos rutas anónimas — fase 2, y la única
 * comprobación CSRF que tienen. `requireSameOrigin`, la global, deja pasar
 * cualquier escritura sin cookie porque `authenticate` la rechaza después; en
 * estas dos no hay `authenticate`, y su respuesta es un `Set-Cookie`. La
 * puerta se monta en `app.ts` con la misma lista de orígenes que `cors()`, y
 * el recorrido la lee como middleware de la montura.
 */
describe("la puerta de origen de las rutas sin contraseña", () => {
  const conPuerta = routes
    .filter((r) => r.chain.includes("verifiedOriginGate"))
    .map((r) => `${r.method} ${r.path}`)
    .sort();

  it("guarda exactamente las dos rutas anónimas, y ninguna otra", () => {
    expect(conPuerta).toEqual([
      "POST /api/auth/webauthn/passwordless/options",
      "POST /api/auth/webauthn/passwordless/verify",
    ]);
  });

  // Que vaya **antes** del cubo y del manejador: una petición cross-site
  // rechazada no debe gastar el presupuesto del edificio.
  it("va delante del cubo y del manejador", () => {
    for (const r of routes.filter((r) => r.path.startsWith("/api/auth/webauthn/passwordless"))) {
      expect(r.chain[0], `${r.method} ${r.path}: ${r.chain.join(" -> ")}`).toBe("verifiedOriginGate");
    }
  });
});

/**
 * Que cada ruta de passkey caiga dentro del prefijo que le reservó
 * `sessionState.ts` — y que NO caiga dentro de los otros.
 *
 * 🔴 **Es el hueco que el propio plan 4C llama «los tests que se quedan
 * obsoletos en silencio».** `sessionState.test.ts` prueba la **tabla** de
 * prefijos; no prueba que las rutas montadas encajen en ella. Nombrar una ruta
 * `/webauthn/register-options` con guion en vez de barra no da ningún error:
 * `coincide` deja de casarla, la sesión en `onboarding` recibe 403
 * `FACTOR_PENDIENTE`, el cliente enseña un aviso que apunta a la pantalla en la
 * que ya está, y no hay puerta que abra. Un bucle, no un fallo.
 *
 * Y en el sentido contrario es peor: ensanchar la entrada de `PARCIAL` a todo
 * `/api/auth/webauthn` —la «simplificación» obvia— abriría el **registro** a
 * quien sólo ha dado una contraseña, que es como alguien se registra su propia
 * llave en la cuenta de otro.
 *
 * Se comprueba con `puedeAlcanzar` de verdad, no con una copia de la tabla, y
 * sobre rutas concretas (con el `:id` sustituido) porque es lo que
 * `authenticate` recibe en producción.
 */
describe("las rutas de passkey caen donde su prefijo dice", () => {
  const ESPERADO: Record<string, { parcial: boolean; onboarding: boolean }> = {
    // Probar una llave que ya existe: la salida de `parcial`, así que abierta
    // en los tres estados.
    "/api/auth/webauthn/login/options": { parcial: true, onboarding: true },
    "/api/auth/webauthn/login/verify": { parcial: true, onboarding: true },
    // Crear una llave: cerrada a `parcial` —quien sólo tiene la contraseña no
    // se registra un factor— y abierta a `onboarding`, que es quien tiene que
    // llegar para dejar de estarlo.
    "/api/auth/webauthn/register/options": { parcial: false, onboarding: true },
    "/api/auth/webauthn/register/verify": { parcial: false, onboarding: true },
    // Gestionarlas: lo mismo. Ver la lista es inofensivo para quien ya está
    // dentro de su cuenta, y enumerable por una contraseña sola no debe ser.
    "/api/auth/webauthn/credentials": { parcial: false, onboarding: true },
    "/api/auth/webauthn/credentials/7": { parcial: false, onboarding: true },
    // Entrar sin contraseña (fase 2): fuera de **todas** las listas, y no es
    // eso lo que las protege. Las dos van sin `authenticate`, así que ninguna
    // sesión consulta la tabla para llegar a ellas; el `false/false` dice que
    // un estado de sesión no abre ahí nada que no abra ya la ausencia de
    // sesión. Lo que sí afirma esta entrada, en las dos direcciones: que no
    // cuelgan de `/login`, que `PARCIAL` abre entero, y que si alguien las
    // moviera allí «arreglando» esta tabla, la de arriba se pondría roja.
    "/api/auth/webauthn/passwordless/options": { parcial: false, onboarding: false },
    "/api/auth/webauthn/passwordless/verify": { parcial: false, onboarding: false },
  };

  const montadas = routes
    .filter((r) => r.path.startsWith("/api/auth/webauthn"))
    .map((r) => r.path.replace(":id", "7"));

  it("cubre todas las rutas de passkey que hay montadas, sin sobrar ninguna", () => {
    // Las dos direcciones, como el resto de este fichero: una ruta nueva sin
    // entrada aquí no se comprueba, y una entrada que ya no corresponde a
    // ninguna ruta afirma sobre algo que no existe.
    expect([...new Set(montadas)].sort()).toEqual(Object.keys(ESPERADO).sort());
  });

  it("abre a `parcial` lo que prueba una llave, y sólo eso", () => {
    for (const [ruta, esperado] of Object.entries(ESPERADO)) {
      expect(puedeAlcanzar("parcial", ruta), ruta).toBe(esperado.parcial);
    }
  });

  it("abre a `onboarding` todo lo que hace falta para dejar de estarlo", () => {
    for (const [ruta, esperado] of Object.entries(ESPERADO)) {
      expect(puedeAlcanzar("onboarding", ruta), ruta).toBe(esperado.onboarding);
    }
  });

  it("no le cierra ninguna a una sesión completa", () => {
    for (const ruta of Object.keys(ESPERADO)) {
      expect(puedeAlcanzar("completa", ruta), ruta).toBe(true);
    }
  });
});

/**
 * Which options each step-up gate was mounted with — Task 10 of plan 4C.
 *
 * 🔴 `STEP_UP_GATED` above says a gate is *there*; it cannot say which one.
 * `requireStepUp()` and `requireStepUp({ exigeContrasena: true })` both mount
 * a function called `stepUpGate`, so turning the password off on the
 * permission matrix left every test in this file green — the plan's own words
 * for it were "structurally blind to which options reach `requireStepUp()`".
 * The gate now stamps its resolved options on the function Express mounts,
 * the way `requirePermission` stamps `permission`, and this table reads them.
 *
 * Written out rather than derived, and compared **in both directions**, for
 * the reason `STEP_UP_GATED` gives: a new gated route cannot appear without a
 * declared option set, and an entry cannot outlive its route. Compared as a
 * **whole object**, never one field: a per-field check on `exigeContrasena`
 * would pass if somebody also turned on `toleraFactorIlegible`, which is legal
 * at mount time once the password is on and would let the password alone
 * reach the permission matrix during a keyring fault.
 */
type OpcionesGate = {
  permiteOnboarding: boolean;
  exigeContrasena: boolean;
  toleraFactorIlegible: boolean;
};

const SOLO_FACTOR: OpcionesGate = {
  permiteOnboarding: false, exigeContrasena: false, toleraFactorIlegible: false,
};
const FACTOR_Y_CONTRASENA: OpcionesGate = {
  permiteOnboarding: false, exigeContrasena: true, toleraFactorIlegible: false,
};
const CONTRASENA_Y_ONBOARDING: OpcionesGate = {
  permiteOnboarding: true, exigeContrasena: true, toleraFactorIlegible: false,
};

const STEP_UP_OPTIONS: Record<string, OpcionesGate> = {
  // ── Decisión D6 (plan 4C): permisos, roles y usuarios piden la contraseña
  // siempre, se haya entrado como se haya entrado. Once monturas.
  "POST /api/usuario/": FACTOR_Y_CONTRASENA,
  "DELETE /api/usuario/:id": FACTOR_Y_CONTRASENA,
  "PATCH /api/usuario/:id/desarchivar": FACTOR_Y_CONTRASENA,
  "PATCH /api/usuario/:id/desbloquear": FACTOR_Y_CONTRASENA,
  "PUT /api/usuario/:id": FACTOR_Y_CONTRASENA,
  "PUT /api/usuario/username/:id": FACTOR_Y_CONTRASENA,
  "PUT /api/usuario/userpass/:id": FACTOR_Y_CONTRASENA,
  "POST /api/usuario/:id/mfa/reset": FACTOR_Y_CONTRASENA,
  "POST /api/rol/": FACTOR_Y_CONTRASENA,
  "PUT /api/rol/:id": FACTOR_Y_CONTRASENA,
  "DELETE /api/rol/:id": FACTOR_Y_CONTRASENA,
  "PATCH /api/rol/:id/desarchivar": FACTOR_Y_CONTRASENA,
  "PUT /api/permisos/:id_rol": FACTOR_Y_CONTRASENA,
  // ── Las dos que se quedan sólo con el factor, y por qué. Cerrar otra sesión
  // propia es una operación sobre la sesión, no sobre la cuenta; y el correo
  // es la puerta por la que `onboarding` sale de `onboarding`.
  "DELETE /api/auth/sessions/:id": SOLO_FACTOR,
  "POST /api/auth/email/send": {
    permiteOnboarding: true, exigeContrasena: false, toleraFactorIlegible: false,
  },
  // ── Credenciales: contraseña siempre, y `onboarding` puede llegar porque es
  // la pantalla a la que tiene que llegar para dejar de estarlo.
  "POST /api/auth/totp/setup": CONTRASENA_Y_ONBOARDING,
  "POST /api/auth/totp/confirm": CONTRASENA_Y_ONBOARDING,
  // La única con `toleraFactorIlegible`: deshacer un TOTP que este servidor no
  // puede leer. Ver `requireStepUp.ts` para por qué no se ensancha a nadie más.
  "DELETE /api/auth/totp/": {
    permiteOnboarding: true, exigeContrasena: true, toleraFactorIlegible: true,
  },
  "POST /api/auth/recovery-codes/": FACTOR_Y_CONTRASENA,
  "POST /api/auth/webauthn/register/options": CONTRASENA_Y_ONBOARDING,
  "POST /api/auth/webauthn/register/verify": CONTRASENA_Y_ONBOARDING,
  "DELETE /api/auth/webauthn/credentials/:id": CONTRASENA_Y_ONBOARDING,
};

describe("which options each step-up gate was mounted with", () => {
  const gated = routes.filter((r) => r.chain.includes("stepUpGate"));
  const nombre = (r: MountedRoute) => `${r.method} ${r.path}`;

  // The stamp is what everything below reads. If it stops arriving, every
  // comparison below would fail loudly — unless somebody "fixes" that with a
  // default. Pinned explicitly so that the failure names its own cause.
  it("reads the options off every gate it finds", () => {
    expect(gated.filter((r) => r.stepUp === undefined).map(nombre)).toEqual([]);
    expect(gated.length).toBeGreaterThan(20);
  });

  it("declares an option set for exactly the gated routes, in both directions", () => {
    expect(Object.keys(STEP_UP_OPTIONS).sort()).toEqual(gated.map(nombre).sort());
  });

  it("mounts every gate with exactly the options the table says — whole object", () => {
    for (const r of gated) {
      expect(r.stepUp, nombre(r)).toEqual(STEP_UP_OPTIONS[nombre(r)]);
    }
  });

  // 🔴 The assertion D6 is about. Stated on its own so that a revert of the
  // decision — "let's drop the password from the permission matrix, it is
  // annoying" — fails with this sentence and not with a table diff.
  //
  // Over **every write** on the three routers, not over the routes that
  // already carry the gate: filtered from `gated`, a new administrative write
  // mounted with no gate at all would never enter the set and the loop would
  // never see it — the one direction D6 most needs to be caught in. Filtered
  // from `routes`, it fails here by name.
  it("demands the password on every write to permissions, roles and accounts", () => {
    const escrituras = routes.filter(
      (r) => WRITES.includes(r.method) && MODULOS_TABULADOS.test(r.path),
    );
    expect(escrituras.length).toBeGreaterThan(10);
    for (const r of escrituras) {
      expect(r.chain, nombre(r)).toContain("stepUpGate");
      expect(r.stepUp?.exigeContrasena, nombre(r)).toBe(true);
    }
  });
});
