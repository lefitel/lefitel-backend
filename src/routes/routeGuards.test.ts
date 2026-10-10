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
const {
  consultaLimiter,
  rutaLimiter,
  conteoLimiter,
  exportLimiter,
  writeLimiter,
} = await import("../middleware/limiters.js");
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
  /**
   * The same chain as the functions themselves, in the same order.
   *
   * A budget from `express-rate-limit` is an anonymous function, so `chain`
   * shows it as `""` and cannot tell one from another. Identity can.
   */
  handles: unknown[];
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
  const beforeRouterHandles = new Map<string, unknown[]>();

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
      const handles: unknown[] = [
        ...(key === undefined ? [] : beforeRouterHandles.get(key) ?? []),
        ...layer.route.stack.map((s) => s.handle),
      ];
      const permissions = layer.route.stack
        .map((s) => s.handle.permission)
        .filter((p): p is string => typeof p === "string");
      const stepUp = layer.route.stack.map((s) => s.handle.opciones).find((o) => o !== undefined);
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method: method.toUpperCase(), path: layer.route.path, chain, permissions, stepUp, handles,
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
      const routerWideHandles: unknown[] = [];
      for (const inner of layer.handle.stack) {
        if (!inner.route) {
          if (inner.slash) {
            routerWide.push(inner.handle.name);
            routerWideHandles.push(inner.handle);
          }
          continue;
        }
        const chain = [
          ...(beforeRouter.get(key) ?? []),
          ...routerWide,
          ...inner.route.stack.map((s) => s.handle.name),
        ];
        const handles: unknown[] = [
          ...(beforeRouterHandles.get(key) ?? []),
          ...routerWideHandles,
          ...inner.route.stack.map((s) => s.handle),
        ];
        const permissions = inner.route.stack
          .map((s) => s.handle.permission)
          .filter((p): p is string => typeof p === "string");
        const stepUp = inner.route.stack.map((s) => s.handle.opciones).find((o) => o !== undefined);
        for (const method of Object.keys(inner.route.methods)) {
          routes.push({
            method: method.toUpperCase(), path: prefix + inner.route.path, chain, permissions, stepUp, handles,
          });
        }
      }
    } else if (key !== undefined) {
      beforeRouter.set(key, [...(beforeRouter.get(key) ?? []), layer.handle.name]);
      beforeRouterHandles.set(key, [...(beforeRouterHandles.get(key) ?? []), layer.handle]);
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
  // ── Not a door at all ──────────────────────────────────────────────────
  // What the container's HEALTHCHECK asks, every ten seconds, from inside the
  // container: no cookie to send and nobody behind it. A different case from
  // every other line here — those produce a credential, this one has no use
  // for one. It answers 204 with no body and reads nothing, so there is
  // nothing behind it for a session to protect. See `app.ts`.
  "GET /api/health",

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

  // ── Darse de baja de un informe programado ──────────────────────────────
  // Quien pulsa es una dirección externa: por definición no tiene cuenta, así
  // que no hay sesión que pedirle. Lo que hace las veces de credencial es el
  // token — treinta y dos bytes al azar que solo viajaron en un correo a esa
  // dirección — y va en el cuerpo, nunca en la ruta. Lo único que puede hacer
  // quien lo tenga es que UNA dirección deje de recibir UN informe. Ver
  // `reportSchedule/unsubscribe.ts`.
  "POST /api/unsubscribe/",
  "POST /api/unsubscribe/lookup",

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
  // See files.routes.ts, where the argument lives now: this was
  // `POST /api/upload/` until D1, on a mount of its own.
  "POST /api/files/",

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

  // ── El trazado por carretera ────────────────────────────────────────────
  // Un POST que no escribe nada: recibe coordenadas que quien llama ya tiene y
  // devuelve la línea que siguen las carreteras públicas entre ellas. No hay
  // dato de Osefi que permitir o negar, y no hay casilla en la pantalla de
  // Seguridad que signifique «puede ver carreteras».
  //
  // Y elegir un permiso rompería dos de sus cuatro llamantes: el detalle de
  // poste vive tras `postes.ver`, el de incidencia tras `eventos.ver` y el
  // informe de recorrido tras `reportes.ver`. Un rol al que le falte el elegido
  // se quedaría sin trazado en pantallas que sí puede abrir.
  //
  // Lo que sí acota la llamada es `rutaLimiter`, veinte por minuto y por
  // persona, porque lo escaso aquí no son filas sino la cuota del proveedor.
  "POST /api/ruta/query",

  // ── The way back in ────────────────────────────────────────────────────
  // A permission is something an account holds, and the whole point of these
  // two is that the caller has no account in hand yet. There is nobody to
  // ask "may you?" of. See the note beside them in
  // AUTHENTICATION_NOT_APPLICABLE for what stands in for a gate instead.
  "POST /api/auth/password/forgot",
  "POST /api/auth/password/reset",

  // ── Darse de baja de un informe programado ──────────────────────────────
  // No hay rol al que preguntarle «¿puedes?»: no hay cuenta. Ver la nota en
  // AUTHENTICATION_NOT_APPLICABLE.
  "POST /api/unsubscribe/",
  "POST /api/unsubscribe/lookup",

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
 * difference.** Several of the routes below pass options — which set is
 * `STEP_UP_OPTIONS`'s job, at the bottom of this file, and not a sentence
 * here that would go stale the next time a mount changes. `requireStepUp()`
 * returns the same `stepUpGate` function under a different closure whatever it
 * is given, so what a mount asked for is pinned where it is observable: by
 * that table, off the stamp Express carries, and through real requests in
 * `app.auth.test.ts`. Never pretended at from here.
 *
 * Live here and not in `app.auth.test.ts`, which pins the gate's *behaviour*
 * through real requests: this file already walks the app as Express assembled
 * it, across all three routers at once, and already owns the question "is the
 * right gate on the right route". Splitting the list between two files would
 * mean two half-tables, which is the shape the gap above came in.
 */
const STEP_UP_GATED = [
  // programacion.routes.ts — two. A schedule is a standing instruction to send
  // data out, some of it to outside addresses: creating one and changing one
  // ask for a confirmed identity. Removing one and sending one now do not.
  "POST /api/generator/schedules/",
  "PUT /api/generator/schedules/:id",
  // usuario.routes.ts — nine.
  "POST /api/usuario/",
  "DELETE /api/usuario/:id",
  "PATCH /api/usuario/:id/restore",
  // The one that was outside this list until an audit read its reason again.
  // See the paragraph above, and the rewritten comment beside the route.
  // It used to carry `sinVentana: true` (hallazgo F8, 2026-09-02 closure
  // audit); the decision of 2026-10-10 removed that option. `STEP_UP_OPTIONS`
  // at the bottom of this file is what says what it carries now.
  "PATCH /api/usuario/:id/desbloquear",
  "PUT /api/usuario/:id",
  // The sub-resource that took `id_rol` off the route above it. Gated, and
  // gated on a permission of the *other* module — `ROLES_GATES` holds the pair,
  // for the reason that table gives about managing accounts and handing out
  // authority being different powers.
  "PUT /api/usuario/:id/rol",
  "PUT /api/usuario/username/:id",
  "PUT /api/usuario/userpass/:id",
  // The escape hatch from §8 of the MFA design — an administrator clears
  // somebody else's second factor. `rescatarMfaDeUsuario`'s own comment
  // explains the refusal this route adds on top of the gate: resetting your
  // own factors here would drop what your own session has to answer this gate
  // with, from a proved factor to the password alone. `STEP_UP_OPTIONS` below
  // is where the options it carries are asserted.
  "POST /api/usuario/:id/mfa/reset",
  // rol.routes.ts — four. `GET /` is a read and carries no gate of any kind:
  // every screen that shows a person needs the name of their role.
  "POST /api/rol/",
  "PUT /api/rol/:id",
  "DELETE /api/rol/:id",
  "PATCH /api/rol/:id/restore",
  // permiso.routes.ts — one. The screen that edits who may do what.
  "PUT /api/permiso/:id_rol",
  // auth.routes.ts — one of the two entries with no permission above them.
  // «Step-up. Solo filas propias» in §5 of the design, and until this task
  // only the second half was true: an audit closed every other session of an
  // account from a stolen cookie in `onboarding`, keeping the stolen one
  // alive. The neighbouring session routes stay ungated on purpose — see the
  // comment beside this one in `auth.routes.ts`.
  "DELETE /api/auth/sessions/:id",
  // auth.routes.ts — and one more, which carries `permiteOnboarding` to let a
  // state through that has to reach this screen. A verified address is a factor
  // since plan 4E, so this route registers a credential and takes the window
  // like every gated route (decision of 2026-10-10). The design's step-up list
  // has "cambiar el email propio" on it, and this is the route that does it.
  // The handler used to compare a `pass` of its own on top; that copy is gone,
  // and the gate is the only thing on this route that asks for a password.
  "POST /api/auth/email/send",
  // ── El segundo factor (plan 4B) ─────────────────────────────────────────
  // Qué opciones lleva cada una lo dice `STEP_UP_OPTIONS`, al final de este
  // fichero, y no un número aquí. Todas entran en la ventana de diez minutos
  // (decisión del 2026-10-10): antes algunas pedían la contraseña **siempre**,
  // y un código de recuperación sella la ventana del factor, así que desde esa
  // decisión basta el papel impreso más una cookie para dar de alta un factor
  // nuevo, borrar el de otra cuenta o regenerar los códigos. Coste aceptado,
  // no un límite que la puerta siga garantizando.
  //
  // Las dos de alta (TOTP) llevan además `permiteOnboarding`, y no es una
  // relajación sino lo contrario de una caída: sin ella, quien está en
  // `onboarding` no podría registrar jamás el factor que le saca de
  // `onboarding`. `parcial` sigue rechazado pase lo que pase. Las de
  // `usuario.routes.ts` no la llevan — nunca la llevaron, y siguen sin
  // necesitarla: ninguna es una de las puertas por las que `onboarding` sale
  // de `onboarding`.
  "POST /api/auth/totp/setup",
  "POST /api/auth/totp/confirm",
  "DELETE /api/auth/totp/",
  "POST /api/auth/recovery-codes/",

  // ── Las passkeys (plan 4C) ──────────────────────────────────────────────
  // Las dos con `permiteOnboarding: true`, por la razón que el bloque de
  // arriba ya da para el alta de TOTP.
  //
  // 🔴 **Entran en la ventana, y ése es un coste aceptado.** Con una ventana
  // abierta, una cookie robada da de alta su propia passkey, y desde ese
  // instante `tieneAlgunFactor` le quita al dueño real hasta el respaldo de la
  // contraseña: su siguiente login abre `parcial` y sólo se sale probando la
  // credencial **del atacante**. Es el hallazgo C1, reabierto por la decisión
  // del 2026-10-10; `totp.routes.ts` lleva el mismo aviso escrito.
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
  // probarse la cuenta. Dentro de una ventana, quien tenga la cookie puede
  // quitarle a alguien su segundo factor y quedarse con la cuenta a base de
  // contraseña sola — y con passkeys hay un motivo más, porque borrar la última
  // revoca todas las sesiones, que es una operación sobre la cuenta entera.
  //
  // 🔴 **No encierra a nadie**, que es la pregunta que hay que hacerle a este
  // montaje: una cuenta cuya única llave es la que quiere borrar recibe
  // `sin-factor-reciente` con `metodos: ["passkey", …]`. La ventana sabe
  // ofrecer la huella, la persona la prueba en `/webauthn/login/verify` y
  // pasa. Sin ese campo la ventana habría pintado un hueco de seis dígitos
  // imposible.
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
  // until `GET /api/login/` and `GET /api/permiso/mias` were retired: this
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

  // ── The debt was here, and C5 paid it ───────────────────────────────────
  // Eighteen reads that any logged-in account could call, whatever its role.
  // They now carry the permission §6 of the spec assigns each, and their pairs
  // are written in the tables above — which is the half that matters, because a
  // gate asking for the wrong module is a gate. `GET /api/dashboard/` was the
  // worst of them and was closed first, one arc earlier.
  //
  // What C5 removed is ambient reach, not the data: the dashboard still hands
  // the whole pole register to anyone with `eventos.ver`, and the report
  // generator serves poles, incidents and cities to `generador.ver`, which both
  // non-administrator roles hold. §6 says so rather than claiming a leak
  // closed. What is left below asks for no permission because there is no
  // permission to ask for: each one answers about the caller and nobody else.
  //
  // Cuántos códigos de recuperación te quedan. Un número sobre tu propia
  // cuenta, tomado de `req.user`, y nunca un código. Pedir un permiso para
  // verlo sería fricción sin defensa; enterarte de que te quedan dos el día
  // que hacen falta es tarde.
  "GET /api/auth/recovery-codes/",

  // The container's health probe. It is the one line here that does not answer
  // about the caller, because it does not answer about anything: 204, no body,
  // no read. A permission needs somebody to hold it, and nobody is asking.
  "GET /api/health",
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
  "GET /api/generator/catalog": "generador.ver",
  "POST /api/generator/query": "generador.ver",
  "POST /api/generator/count": "generador.ver",
  "POST /api/generator/export": "generador.ver",
  "GET /api/generator/reportes": "generador.ver",
  "GET /api/generator/reportes/:id": "generador.ver",
  "POST /api/generator/reportes": "generador.crear",
  "PUT /api/generator/reportes/:id": "generador.editar",
  "DELETE /api/generator/reportes/:id": "generador.archivar",
  "POST /api/generator/reportes/:id/duplicate": "generador.crear",
  // Scheduled reports. Reading is the generator's ordinary `ver`; every write
  // is `programar`, a permission of its own — see `programacion.routes.ts`.
  "GET /api/generator/schedules/": "generador.ver",
  "GET /api/generator/schedules/:id/runs": "generador.ver",
  "GET /api/generator/schedules/recipients": "generador.programar",
  "POST /api/generator/schedules/": "generador.programar",
  "PUT /api/generator/schedules/:id": "generador.programar",
  "DELETE /api/generator/schedules/:id": "generador.programar",
  "POST /api/generator/schedules/:id/run": "generador.programar",
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
 * `POST /api/evento/:id/resolve` two files over asked for `editar` for the same
 * kind of act, and every button in the interface asked the browser for `editar`.
 * The interface and the server disagreed, and nothing here noticed.
 */
const EVENTOS_GATES: Record<string, string> = {
  "POST /api/evento/": "eventos.crear",
  "PUT /api/evento/:id": "eventos.editar",
  "POST /api/evento/:id/resolve": "eventos.editar",
  "POST /api/evento/:id/reopen": "eventos.editar",
  "DELETE /api/evento/:id": "eventos.archivar",
  // Missing until A1's audit went looking, while two comments in this file
  // claimed this table named every gated route it had. Unlisted, changing this
  // line to `eventos.ver` would let an account that may only look at incidents
  // unarchive any of them, with the suite green.
  "PATCH /api/evento/:id/restore": "eventos.archivar",
  "POST /api/revision/": "eventos.editar",
  // The one read on this list, and the reason the read test above has an
  // exception list instead of nothing: it hands over every incident and every
  // pole in one response, so `ver` has to mean something here.
  "GET /api/dashboard/": "eventos.ver",
  // Added by B1 and left out of this table by the same commit — while the
  // comment a few lines up said the table named every gated route it had, and
  // one commit after `aa38830` had fixed the same omission for `/desarchivar`.
  // The audit of 3 September caught it: re-gating this line to `seguridad.ver`
  // left 1.421 tests green. Now `MODULOS_TABULADOS` below holds this router to
  // completeness too, so the next one cannot repeat it.
  "GET /api/evento/options": "eventos.ver",
  // The permission §6 assigns to the listing this export is built from, which
  // for poles and incidents is **stricter than the listing itself asks today**:
  // those two `GET /` carry no gate at all and sit in
  // `READ_GATE_NOT_APPLICABLE` below, the list C5 exists to empty. The export
  // is not going to join that list on its way in.
  //
  // Deliberately not an `exportar` action of its own. A file adds a shape over
  // `?limit=all`, not a reach; and a new action costs five coordinated pieces,
  // one of which is a migration that seeds the cell for every role. Miss that
  // one and the endpoint is a 403 for everybody, the administrator included,
  // with no checkbox anywhere to fix it.
  "POST /api/evento/export": "eventos.ver",

  // ── The reads C5 closed ─────────────────────────────────────────────────
  // Six of the eighteen. Three live on other routers — an incident's
  // observations, its inspections and its repair — and they ask about the
  // incident, so they ask what the incident asks. `GET /api/evento/usuario/:id`
  // is the seventh and is **not** here: it asks about a person, so it is in
  // `SEGURIDAD_GATES`.
  "GET /api/evento/": "eventos.ver",
  "GET /api/evento/:id": "eventos.ver",
  "GET /api/poste/:id/eventos": "eventos.ver",
  "GET /api/evento/:id/obs": "eventos.ver",
  "GET /api/evento/:id/revisiones": "eventos.ver",
  "GET /api/evento/:id/solucion": "eventos.ver",
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
  "GET /api/tipo-obs/stats": "parametros.ver",

  // ── Complete since C5, and that is a change of kind ──────────────────────
  // This table used to name the five `/stats` reads and nothing else, and said
  // so: the plain list reads were open and the writes beside them went
  // unwritten because demanding completeness of a partial table asserts the
  // opposite of what it decided. C5 closed the five list reads, so the reason
  // to stay partial is gone, and the five routers join `MODULOS_TABULADOS`
  // below — which means every gated route on them has to be here. Thirty
  // entries for five routers that are the same six lines each; the repetition
  // is the point, because a table generated from a pattern would agree with
  // whatever the routers say.
  "GET /api/adss/": "parametros.ver",
  "POST /api/adss/": "parametros.crear",
  "PUT /api/adss/:id": "parametros.editar",
  "DELETE /api/adss/:id": "parametros.archivar",
  "PATCH /api/adss/:id/restore": "parametros.archivar",

  "GET /api/material/": "parametros.ver",
  "POST /api/material/": "parametros.crear",
  "PUT /api/material/:id": "parametros.editar",
  "DELETE /api/material/:id": "parametros.archivar",
  "PATCH /api/material/:id/restore": "parametros.archivar",

  "GET /api/obs/": "parametros.ver",
  "POST /api/obs/": "parametros.crear",
  "PUT /api/obs/:id": "parametros.editar",
  "DELETE /api/obs/:id": "parametros.archivar",
  "PATCH /api/obs/:id/restore": "parametros.archivar",

  "GET /api/tipo-obs/": "parametros.ver",
  "POST /api/tipo-obs/": "parametros.crear",
  "PUT /api/tipo-obs/:id": "parametros.editar",
  "DELETE /api/tipo-obs/:id": "parametros.archivar",
  "PATCH /api/tipo-obs/:id/restore": "parametros.archivar",

  "GET /api/propietario/": "parametros.ver",
  "POST /api/propietario/": "parametros.crear",
  "PUT /api/propietario/:id": "parametros.editar",
  "DELETE /api/propietario/:id": "parametros.archivar",
  "PATCH /api/propietario/:id/restore": "parametros.archivar",
};

/**
 * The city catalogue, which had no table of its own until C5 gave it two gated
 * reads and a reason to be held to completeness.
 *
 * Its own module rather than a sixth parameter: a city is not a dropdown value,
 * it is one end of a tramo, and every pole in the system is placed by the pair
 * it stands between. The Cliente role holds `ciudades.ver` and no write.
 */
const CIUDADES_GATES: Record<string, string> = {
  "GET /api/ciudad/": "ciudades.ver",
  "GET /api/ciudad/:id": "ciudades.ver",
  "POST /api/ciudad/": "ciudades.crear",
  "PUT /api/ciudad/:id": "ciudades.editar",
  "DELETE /api/ciudad/:id": "ciudades.archivar",
  "PATCH /api/ciudad/:id/restore": "ciudades.archivar",
};

/**
 * What each gated route of the pole register must ask for, exactly.
 *
 * This table did not exist, and the same audit that found the `opciones` entry
 * missing above found why that mattered here: `PUT /api/poste/:id` could be
 * re-gated to `postes.ver` — so an account allowed only to look at poles could
 * rewrite any of them — and nothing in the suite would say a word. The chain of
 * names says a gate is *there*; only a table says which.
 *
 * The two reads on this router that carry no gate at all — `GET /`,
 * `/:id` — are named in `READ_GATE_NOT_APPLICABLE`, which is where an
 * ungated route's reason belongs. `/options` is the one gated read.
 */
const POSTES_GATES: Record<string, string> = {
  "POST /api/poste/": "postes.crear",
  "PUT /api/poste/:id": "postes.editar",
  "DELETE /api/poste/:id": "postes.archivar",
  "PATCH /api/poste/:id/restore": "postes.archivar",
  "GET /api/poste/options": "postes.ver",
  // The permission §6 assigns to the listing this export is built from, which
  // for poles and incidents is **stricter than the listing itself asks today**:
  // those two `GET /` carry no gate at all and sit in
  // `READ_GATE_NOT_APPLICABLE` below, the list C5 exists to empty. The export
  // is not going to join that list on its way in.
  //
  // Deliberately not an `exportar` action of its own. A file adds a shape over
  // `?limit=all`, not a reach; and a new action costs five coordinated pieces,
  // one of which is a migration that seeds the cell for every role. Miss that
  // one and the endpoint is a 403 for everybody, the administrator included,
  // with no checkbox anywhere to fix it.
  "POST /api/poste/export": "postes.ver",

  // ── The reads C5 closed ─────────────────────────────────────────────────
  // The register, one pole of it, and the ADSS hanging off one — the last on
  // its own router, asking what the pole asks because that is what it is about.
  "GET /api/poste/": "postes.ver",
  "GET /api/poste/:id": "postes.ver",
  "GET /api/poste/:id/adss": "postes.ver",
};

/**
 * What each route of the fixed reports must ask for, exactly.
 *
 * `reportes` has one action in the vocabulary — `ver` — so this is the only pair
 * any of these may carry, and the table exists so that a seventh report cannot
 * arrive gated by something else, or by nothing. The six are `PUT` today and
 * move to `GET` in C1 of the API standard; the method changes here with them.
 */
const REPORTES_GATES: Record<string, string> = {
  "GET /api/reporte/options": "reportes.ver",
  "GET /api/reporte/general": "reportes.ver",
  "GET /api/reporte/tramo": "reportes.ver",
  "GET /api/reporte/recorrido": "reportes.ver",
  "GET /api/reporte/estado-red": "reportes.ver",
  "GET /api/reporte/frecuencia-obs": "reportes.ver",
  "GET /api/reporte/resumen-tiempos": "reportes.ver",
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
  "PATCH /api/usuario/:id/restore": "seguridad.archivar",
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
  // The permission §6 assigns to the listing this export is built from, which
  // for poles and incidents is **stricter than the listing itself asks today**:
  // those two `GET /` carry no gate at all and sit in
  // `READ_GATE_NOT_APPLICABLE` below, the list C5 exists to empty. The export
  // is not going to join that list on its way in.
  //
  // Deliberately not an `exportar` action of its own. A file adds a shape over
  // `?limit=all`, not a reach; and a new action costs five coordinated pieces,
  // one of which is a migration that seeds the cell for every role. Miss that
  // one and the endpoint is a 403 for everybody, the administrator included,
  // with no checkbox anywhere to fix it.
  "POST /api/usuario/export": "seguridad.ver",

  // ── The one read of the eighteen that is about a person ──────────────────
  // The incidents of one account, and the only one C5 closed with
  // `requireSelfOrPermission` rather than a plain gate. Two reasons, and both
  // matter.
  //
  // **`seguridad.ver` and not `eventos.ver`**: the Cliente role holds
  // `eventos.ver`, so with the obvious pair it could walk `/usuario/1` …
  // `/usuario/20` and assemble each employee's activity record. That question
  // already answers to `seguridad.ver` elsewhere — the generator refuses to
  // make a person a level of detail without it.
  //
  // **Self-or-permission**: this is what the person's own profile screen calls.
  // A plain gate would take every non-administrator's own history away, and the
  // screen swallows the failure and prints "Eventos atendidos: 0", so nobody
  // would report it.
  //
  // 🔴 This table cannot see the half that breaks. It reads the pair off the
  // mounted chain and never sends a request, so the third argument of
  // `requireSelfOrPermission` — the parameter name — is invisible here, and
  // `listShape.test.ts` mocks every permission to true so it passes either way.
  // `evento.self.test.ts` is the file that measures it.
  //
  // D1 turned that danger around and it is worth saying which way it points
  // now: this route's parameter used to be `:id_usuario`, so the argument had
  // to be passed; today the parameter is `:id` and the default is right, so the
  // mistake is **carrying the old argument across** rather than omitting it.
  // Either way the symptom is the same and it is silent — the ownership branch
  // compares `undefined`, everyone without the module loses their own history,
  // and the profile screen prints "Eventos atendidos: 0".
  "GET /api/usuario/:id/eventos": "seguridad.ver",
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
 * The matrix editor is the sharpest entry. `PUT /api/permiso/:id_rol` writes
 * who may do what for the role it names — `putPermisos` refuses your own role
 * with a 409, so the one thing it cannot do is promote the caller directly. What
 * it can do is grant those cells to some other role, and `roles.editar` is the
 * only thing deciding who may.
 *
 * `GET /api/rol/` was deliberately not here while it carried no gate at all, on
 * the grounds that "every screen that shows a person needs the name of their
 * role". C5 closed it and the grounds did not survive the check: a role's name
 * travels inside the user payload, which is what those screens render. The list
 * itself has two callers, the permissions panel and the role picker in the
 * create/edit user sheet, and both are about handing out authority. The server
 * already demanded `roles.editar` on the other half of that same flow.
 */
const ROLES_GATES: Record<string, string> = {
  "GET /api/rol/": "roles.ver",
  "POST /api/rol/": "roles.crear",
  "PUT /api/rol/:id": "roles.editar",
  "DELETE /api/rol/:id": "roles.archivar",
  "PATCH /api/rol/:id/restore": "roles.archivar",
  "GET /api/permiso/": "roles.ver",
  "PUT /api/permiso/:id_rol": "roles.editar",
  // Under `/api/usuario` and filed here all the same, the way
  // `GET /api/usuario/:id/bitacora` is filed under the audit log: §3.7 files a
  // route by the module that answers its question, not by the router it hangs
  // off. This one is the sharpest case of the separation this table protects —
  // it is the route that moves an account between roles, and writing
  // `seguridad.editar` here would hand that to whoever may edit a telephone
  // number.
  "PUT /api/usuario/:id/rol": "roles.editar",
};

/**
 * What each route of the audit log must ask for, exactly.
 *
 * The module has one action in the vocabulary — `ver` — so every pair below is
 * the same, and the repetition is not the point. The module is. These three
 * routes read the record of everything everybody has done, the report builder's
 * private state included, and the mistake this table exists to catch is one of
 * them coming to ask for something else: re-gated to `seguridad.ver`, a route
 * here would still be gated, this file would still call it protected, and the
 * set of people who can read the audit log would quietly have become a different
 * set.
 *
 * `GET /api/usuario/:id/bitacora` is an ownership route, and it sits here on the
 * same footing as the rest: the pair is what a *stranger* needs. The other half
 * of that gate — "or it is your own row" — is ownership rather than a checkbox,
 * and is asserted in `requirePermission.test.ts`, where a request can actually be
 * aimed at somebody else's id.
 */
const BITACORA_GATES: Record<string, string> = {
  "GET /api/bitacora/": "bitacora.ver",
  "GET /api/bitacora/authors": "bitacora.ver",
  "GET /api/bitacora/vocabulary": "bitacora.ver",
  "GET /api/usuario/:id/bitacora": "bitacora.ver",
};

/**
 * The Archivos screen, and the last router that had gates and nothing reading
 * them.
 *
 * 🔴 **Measured before this table existed:** re-point `GET /orphans` at
 * `bitacora.ver` and downgrade `DELETE /orphans` from `archivos.archivar` to
 * `archivos.ver`, and the whole server suite stays green — 2.655 tests. That
 * second one hands the button that **unlinks every unreferenced photograph from
 * disk** to anybody who can merely look at the screen. `vocabulary.test.ts` does
 * not save it: both pairs exist in the matrix, so both are spellable.
 *
 * It was excused rather than tabulated, and the excuse was the tell — it said
 * *where* the gates live, not that anything checks them. Excuses that describe
 * are how a router leaves this check in one line.
 *
 * The action split is the whole point of the pair and is what the table pins:
 * **reading the folder and emptying it are different permissions.** `POST /` is
 * absent on purpose — it is the one route here with no gate at all, argued in
 * `files.routes.ts` and pinned by address in `GATE_NOT_APPLICABLE`.
 */
const ARCHIVOS_GATES: Record<string, string> = {
  "GET /api/files/orphans": "archivos.ver",
  "DELETE /api/files/orphans": "archivos.archivar",
  "GET /api/files/entity-stats": "archivos.ver",
  "GET /api/files/broken-refs": "archivos.ver",
  "DELETE /api/files/broken-refs": "archivos.archivar",
  "DELETE /api/files/:name": "archivos.archivar",
};

/**
 * The routers whose tables claim to describe every gated route completely.
 *
 * Three for a long while — `usuario`, `rol`, `permisos` — because those were the
 * only tables written as complete descriptions. `poste`, `evento` and `reporte`
 * joined on 3 September, when an audit showed a gated route added to `evento`
 * one commit after this file had promised the table was complete, and nothing
 * here had said so. `bitacora` joined with `/autores`, the route that made it a
 * three-route router: small enough that a fourth would arrive without anybody
 * thinking to look, and pointed at the one table that records what everyone did.
 * `EVENTOS_GATES` also names `POST /api/revision/` and `GET /api/dashboard/`,
 * which live on other routers; the check below is per router prefix, so those
 * two are simply not held to completeness.
 *
 * 🔴 **A name here that no longer names a mount takes its whole router out of
 * the completeness check, in silence.** This is not hypothetical and it is not
 * rare: D1 renamed `/api/permisos` to `/api/permiso` and `/api/tipoObs` to
 * `/api/tipo-obs`, and either would have dropped out of the alternation while
 * the suite stayed green. Worse, it fails in the order that hides it — the
 * per-router tables *do* go red, whoever fixes them is led straight to the half
 * that does not matter, and the list here keeps the old spelling. So the list
 * is a named array now and `every prefix here is really mounted` below is what
 * makes a rename loud. Three names left with D1: `adssposte`, `eventoObs` and
 * `solucion` are not mounts any more.
 */
const TABULADOS = [
  "usuario", "rol", "permiso", "poste", "evento", "reporte", "bitacora",
  "adss", "ciudad", "material", "obs", "propietario", "revision", "tipo-obs",
  "files",
] as const;

const MODULOS_TABULADOS = new RegExp(`^\\/api\\/(${TABULADOS.join("|")})\\b`);

/** The nine tables, kept as a list so they can be counted as well as merged. */
const TABLAS = [
  ["GENERADOR_GATES", GENERADOR_GATES],
  ["EVENTOS_GATES", EVENTOS_GATES],
  ["PARAMETROS_GATES", PARAMETROS_GATES],
  ["CIUDADES_GATES", CIUDADES_GATES],
  ["POSTES_GATES", POSTES_GATES],
  ["REPORTES_GATES", REPORTES_GATES],
  ["SEGURIDAD_GATES", SEGURIDAD_GATES],
  ["ROLES_GATES", ROLES_GATES],
  ["BITACORA_GATES", BITACORA_GATES],
  ["ARCHIVOS_GATES", ARCHIVOS_GATES],
] as const;

const TODAS_LAS_PUERTAS = Object.assign({}, ...TABLAS.map(([, t]) => t)) as Record<string, string>;

describe("which permission each gate asks for", () => {
  it("declares each route in one table only", () => {
    // 🔴 The nine tables are merged with a spread, and a key written in two of
    // them is not an error — the last one silently wins and the other entry
    // asserts nothing for ever. It is not a theoretical risk: D1 moved seven
    // listings between routers, and `GET /api/usuario/:id/bitacora` is exactly
    // the kind of address somebody writes into `SEGURIDAD_GATES` because of its
    // mount and into `BITACORA_GATES` because of its subject, with a different
    // pair each time. `listShape.test.ts` has a "keeps the three groups apart";
    // this file had no equivalent.
    const vistas = new Map<string, string>();
    const repetidas: string[] = [];
    for (const [nombre, tabla] of TABLAS) {
      for (const clave of Object.keys(tabla)) {
        const antes = vistas.get(clave);
        if (antes) repetidas.push(`${clave} → ${antes} y ${nombre}`);
        else vistas.set(clave, nombre);
      }
    }
    expect(repetidas, `rutas declaradas en dos tablas:\n  ${repetidas.join("\n  ")}`).toEqual([]);
    // A second assertion stood here, comparing the size of the merged object
    // against the sum of the nine tables. It was true by construction —
    // `TODAS_LAS_PUERTAS` is built *from* `TABLAS`, so it could only fail when
    // the loop above had already failed — and its comment claimed to catch a
    // table added to the merge and forgotten, which cannot happen when there is
    // one list and no second merge. Removed rather than reworded: an assertion
    // that cannot fail is the thing this file warns about elsewhere.
  });

  it("asks for the one the route is about, not merely for one", () => {
    const wrong: string[] = [];
    for (const [route, expected] of Object.entries(TODAS_LAS_PUERTAS)) {
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

  it("names every gated route of the seven tabulated routers, so a new one cannot join unlisted", () => {
    // The assertion above runs table → code, so it can only catch a pair that
    // changed under a route somebody already wrote down. A route added tomorrow
    // is invisible to it, and on these routers that is the expensive direction:
    // between them they create accounts, archive them, rewrite the permission
    // matrix itself, and serve the record of everything anybody has ever done.
    //
    // Seven routers until C5, and seventeen after it. The eleven that joined
    // are the ones C5 gated, and joining was the point: without completeness a
    // table only catches a pair that changed under a route somebody already
    // wrote down, so eleven of the eighteen new gates would have been asserted
    // to exist and never to be the right one. Concretely, `GET /api/ciudad/`
    // could have asked `bitacora.ver` — a declared pair, so `vocabulary.test.ts`
    // accepts it — with this whole suite green.
    //
    // `PARAMETROS_GATES` stopped being partial to make that possible, which is a
    // decision and not a side effect: it now names the thirty gated routes of its
    // five routers instead of the five `/stats` reads. `GENERADOR_GATES` is the
    // one table that happens to name every gated route of its own today without
    // being held to it.
    // Derived from `TABLAS`, not written out again. It used to be a second
    // hand-kept list of the same tables minus one, which is a shape that goes
    // wrong exactly once: a table added to `TABLAS` and forgotten here reports
    // every route of its router as undeclared, and the obvious reading of that
    // failure — "the table is wrong" — is the wrong one.
    const tabuladas = new Set(TABLAS.flatMap(([, tabla]) => Object.keys(tabla)));
    const alcanzadas = routes.filter((r) => MODULOS_TABULADOS.test(r.path));
    // Anti-vacuity, and the specific vacuity this check is prone to: the filter
    // has no floor, so a router that stops matching the expression leaves the
    // set without any assertion noticing. Every name dropping out at once would
    // otherwise leave `faltan` empty and this test green over nothing.
    expect(
      alcanzadas.length,
      "el filtro de routers tabulados dejó de alcanzar casi nada",
    ).toBeGreaterThan(60);

    const faltan = alcanzadas
      .filter((r) => r.chain.some((name) => GATES.includes(name)))
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !tabuladas.has(r))
      .sort();

    expect(
      faltan,
      `rutas con puerta y sin permiso declarado; añádelas a la tabla de su router:\n  ${faltan.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every prefix it claims to tabulate is really mounted, and every mounted one is claimed", () => {
    // The half that makes the bound above worth having. A renamed mount does not
    // shrink the set to nothing — it removes one router — so a floor alone would
    // not see it. This names each prefix and asks whether anything answers there.
    const huerfanos = TABULADOS.filter(
      (nombre) => !routes.some((r) => r.path.startsWith(`/api/${nombre}/`) || r.path === `/api/${nombre}`),
    );

    expect(
      huerfanos,
      `estos prefijos ya no son montajes, así que su router salió de la comprobación de completitud sin avisar: ${huerfanos.join(", ")}`,
    ).toEqual([]);

    // 🔴 And the direction that was missing, which is the one that costs. With
    // only the check above, deleting two names from `TABULADOS` left twenty-seven
    // routes out of the completeness check and every test in this file green —
    // measured, not imagined: a new `GET /api/usuario/:id/nuevo-listado` gated
    // with the *bitácora* module then passed unnoticed. The floor of sixty did
    // not bite either, because sixty-three remained.
    //
    // So every mounted prefix is either tabulated or excused in writing. The
    // excuses are few and each one is a sentence somebody has to defend.
    const SIN_TABULAR: Record<string, string> = {
      auth: "el módulo de autenticación, que §2 deja fuera de este documento",
      login: "ídem",
      generator: "sus puertas están en GENERADOR_GATES, pero el router no se somete a completitud: es el único cuyo vocabulario de permisos vive en el propio generador",
      dashboard: "una sola ruta, gateada, y §9 la deja anotada como pendiente de acotar",
      files: "sus seis puertas están en el propio fichero y una ruta es excepción declarada (§3.7)",
      ruta: "una sola ruta, sin puerta de permiso a propósito: no devuelve ningún dato de Osefi y sus cuatro llamantes viven en tres módulos distintos — ver ruta.routes.ts y GATE_NOT_APPLICABLE",
      unsubscribe: "la baja de un informe programado: dos rutas públicas sin puerta de permiso porque quien las llama no tiene cuenta — ver AUTHENTICATION_NOT_APPLICABLE",
      health: "la sonda de salud del contenedor: una ruta suelta en app.ts, sin sesión ni permiso porque responde 204 sin cuerpo y no lee nada — ver AUTHENTICATION_NOT_APPLICABLE",
    };
    const montados = [...new Set(routes.map((r) => r.path.split("/")[2]).filter(Boolean))];
    const sinExcusa = montados
      .filter((p) => !(TABULADOS as readonly string[]).includes(p) && !(p in SIN_TABULAR))
      .sort();

    expect(
      sinExcusa,
      `estos montajes no están tabulados ni excusados; una ruta con puerta añadida ahí no la vería nadie:\n  ${sinExcusa.join("\n  ")}`,
    ).toEqual([]);

    // Y las excusas tampoco crecen solas: una que ya no nombre un montaje sobra.
    const excusasMuertas = Object.keys(SIN_TABULAR).filter((p) => !montados.includes(p));
    expect(
      excusasMuertas,
      `excusas de routers que ya no existen: ${excusasMuertas.join(", ")}`,
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
 * Los cubos por persona de `middleware/limiters.ts` — B3.
 *
 * Por identidad de la función, como el bloque de arriba: un limitador de
 * `express-rate-limit` no tiene nombre y `chain` no lo distingue de otro. Aquí
 * se lee `handles`, que es la misma cadena como referencias, y la ruta completa
 * con su verbo — el bloque de arriba lee la ruta relativa al router, y con
 * `exportLimiter` eso serían tres `/export` indistinguibles: mover el cubo de la
 * descarga de usuarios a una ruta nueva `/api/ciudad/export` dejaría esa lista
 * igual.
 */
describe("los cubos por persona de limiters.ts", () => {
  const CUBOS = [consultaLimiter, conteoLimiter, exportLimiter, writeLimiter, rutaLimiter];

  // La única ruta con cubo y sin puerta de permiso. Escrita aquí para que la
  // segunda sea un fallo y no un descuido: el motivo de ésta —no devuelve
  // ningún dato de Osefi— no se hereda por estar en la misma lista.
  const CUBO_SIN_PUERTA = ["POST /api/ruta/query"];
  const rutasCon = (cubo: unknown) =>
    routes.filter((r) => r.handles.includes(cubo)).map((r) => `${r.method} ${r.path}`).sort();

  // Un solo cubo de treinta para las siete rutas que ejecutan una consulta
  // pesada: decisión de Isaias del 2026-09-04, y el motivo está en el fichero
  // del cubo. Exacta en las dos direcciones — que falte un informe es un
  // informe sin tope; que sobre una ruta es una ruta pagando un presupuesto
  // que no es el suyo.
  it("el cubo de consultas cubre /query y los seis informes fijos, y nada más", () => {
    expect(rutasCon(consultaLimiter)).toEqual([
      "GET /api/reporte/estado-red",
      "GET /api/reporte/frecuencia-obs",
      "GET /api/reporte/general",
      "GET /api/reporte/recorrido",
      "GET /api/reporte/resumen-tiempos",
      "GET /api/reporte/tramo",
      "POST /api/generator/query",
    ]);
  });

  it("el cubo de exportación cubre las cuatro descargas y el envío inmediato de un informe programado", () => {
    expect(rutasCon(exportLimiter)).toEqual([
      "POST /api/evento/export",
      "POST /api/generator/export",
      // No descarga nada, pero construye el mismo fichero y ocupa el mismo hueco.
      "POST /api/generator/schedules/:id/run",
      "POST /api/poste/export",
      "POST /api/usuario/export",
    ]);
  });

  it("el de conteo y el de escritura se quedan en el generador", () => {
    expect(rutasCon(conteoLimiter)).toEqual(["POST /api/generator/count"]);
    expect(rutasCon(writeLimiter)).toEqual([
      "DELETE /api/generator/reportes/:id",
      "DELETE /api/generator/schedules/:id",
      "POST /api/generator/reportes",
      "POST /api/generator/reportes/:id/duplicate",
      "POST /api/generator/schedules/",
      "PUT /api/generator/reportes/:id",
      "PUT /api/generator/schedules/:id",
    ]);
  });

  // Estar montado no es estar bien montado: un cubo delante de la puerta de
  // permiso cobra los 403, y las listas de arriba no lo verían.
  // `reporte.contract.test.ts` mide lo mismo por HTTP en los seis informes;
  // esto se lo pide a las dieciséis rutas de una vez.
  it("cada cubo va detrás de la puerta de permiso de su ruta", () => {
    const conCubo = routes.filter((r) => r.handles.some((h) => CUBOS.includes(h as never)));
    expect(conCubo.length, "cambió cuántas rutas llevan cubo").toBe(21);
    for (const r of conCubo) {
      if (CUBO_SIN_PUERTA.includes(`${r.method} ${r.path}`)) continue;
      const puerta = r.chain.indexOf("requirePermissionGate");
      const cubo = r.handles.findIndex((h) => CUBOS.includes(h as never));
      expect(puerta, `${r.method} ${r.path} no tiene puerta de permiso`).toBeGreaterThanOrEqual(0);
      expect(cubo, `${r.method} ${r.path}: ${r.chain.join(" -> ")}`).toBeGreaterThan(puerta);
    }
  });

  // El trazado por carretera, que lleva cubo propio y ninguna puerta. Las dos
  // direcciones: que el cubo esté puesto, y que sea la única ruta con cubo a la
  // que no se le pide permiso. Sin la segunda mitad, cualquier ruta futura que
  // olvidara su puerta se colaría en `CUBO_SIN_PUERTA` sin que nadie lo notara.
  it("el trazado por carretera lleva su propio cubo, y es el único con cubo sin puerta", () => {
    expect(rutasCon(rutaLimiter)).toEqual(["POST /api/ruta/query"]);

    const sinPuerta = routes
      .filter((r) => r.handles.some((h) => CUBOS.includes(h as never)))
      .filter((r) => !r.chain.includes("requirePermissionGate"))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(sinPuerta).toEqual(CUBO_SIN_PUERTA);
  });

  // Dos lecturas caras que se quedan SIN cubo a propósito. `/options` se pide
  // una vez por visita a cada pestaña de informes, y medirla haría que cambiar
  // de pestaña gastara el presupuesto de los informes. El dashboard devuelve el
  // registro entero sin filtro ni límite y es la lectura más pesada sin medir
  // de la API — Isaias lo dejó fuera de B3 el 2026-09-04: meterlo en el cubo
  // de los informes haría fallar la pantalla de inicio por lo que alguien hizo
  // en el generador, y un cubo propio es un número nuevo que merece su propia
  // decisión. Está apuntado en el §9 del spec. Que cambiar esto sea una
  // decisión y no un accidente.
  it("deja fuera, a propósito, /reporte/options y el dashboard", () => {
    for (const ruta of ["GET /api/reporte/options", "GET /api/dashboard/"]) {
      const r = routes.find((x) => `${x.method} ${x.path}` === ruta);
      expect(r, `${ruta} ya no existe`).toBeDefined();
      expect(r?.handles.some((h) => CUBOS.includes(h as never)), `${ruta} lleva un cubo`).toBe(false);
    }
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
 * `requireStepUp()` and `requireStepUp({ permiteOnboarding: true })` both
 * mount a function called `stepUpGate`, so loosening the options on the
 * permission matrix left every test in this file green — the plan's own words
 * for it were "structurally blind to which options reach `requireStepUp()`".
 * The gate now stamps its resolved options on the function Express mounts,
 * the way `requirePermission` stamps `permission`, and this table reads them.
 *
 * Written out rather than derived, and compared **in both directions**, for
 * the reason `STEP_UP_GATED` gives: a new gated route cannot appear without a
 * declared option set, and an entry cannot outlive its route. Compared as a
 * **whole object**, never one field: a per-field check on
 * `permiteOnboarding` would pass if somebody also turned on
 * `toleraFactorIlegible`, which would let the password alone reach that route
 * during a keyring fault.
 */
type OpcionesGate = {
  permiteOnboarding: boolean;
  toleraFactorIlegible: boolean;
};

/**
 * Toda ruta con puerta entra en la ventana: una contraseña correcta —o un
 * factor probado— vale para los diez minutos siguientes (decisión del
 * 2026-10-10, «Todo, sin excepciones»). Sigue sin haber pase libre: una
 * petición fuera de la ventana contesta 403.
 */
const GATE_PLANA: OpcionesGate = {
  permiteOnboarding: false, toleraFactorIlegible: false,
};
const GATE_CON_ONBOARDING: OpcionesGate = {
  permiteOnboarding: true, toleraFactorIlegible: false,
};

const STEP_UP_OPTIONS: Record<string, OpcionesGate> = {
  // ── La puerta plana. Hasta el 2026-10-10 las ocho primeras pedían la
  // contraseña en cada petición, porque lo que hacen sobrevive a que la
  // víctima cambie su contraseña, cierre todas sus sesiones y resetee sus
  // factores (§4.1 de `docs/specs/2026-09-08-ventana-de-reautenticacion-design.md`).
  // Ya no: dentro de una ventana abierta, una sesión secuestrada puede hacer
  // cualquiera de ellas. Coste aceptado y documentado en la «Revisión 4» del
  // diseño; si alguien vuelve a poner una opción aquí, que sea otra decisión.
  "POST /api/usuario/": GATE_PLANA,
  "DELETE /api/usuario/:id": GATE_PLANA,
  "PATCH /api/usuario/:id/desbloquear": GATE_PLANA,
  "PUT /api/usuario/:id/rol": GATE_PLANA,
  // Cambia la contraseña de **otra** persona: ahí el controlador no pide la
  // contraseña vieja, así que dentro de la ventana no se pide ningún secreto.
  "PUT /api/usuario/userpass/:id": GATE_PLANA,
  "POST /api/usuario/:id/mfa/reset": GATE_PLANA,
  "PUT /api/permiso/:id_rol": GATE_PLANA,
  "POST /api/auth/recovery-codes/": GATE_PLANA,
  // Las que ya entraban en la ventana el 2026-09-08. Editar un perfil,
  // renombrarse, deshacer un archivado y mantener la lista de roles.
  "PUT /api/usuario/:id": GATE_PLANA,
  // Scheduled reports: whoever sets up three schedules in a row confirms once,
  // and nothing they do there outlives its own undoing — a schedule can be
  // removed and its recipients are in the bitácora.
  "POST /api/generator/schedules/": GATE_PLANA,
  "PUT /api/generator/schedules/:id": GATE_PLANA,
  "PUT /api/usuario/username/:id": GATE_PLANA,
  "PATCH /api/usuario/:id/restore": GATE_PLANA,
  "POST /api/rol/": GATE_PLANA,
  "PUT /api/rol/:id": GATE_PLANA,
  "DELETE /api/rol/:id": GATE_PLANA,
  "PATCH /api/rol/:id/restore": GATE_PLANA,
  // Cerrar otra sesión propia es una operación sobre la sesión, no sobre la
  // cuenta. Sin `permiteOnboarding` a propósito: ver `auth.routes.ts`.
  "DELETE /api/auth/sessions/:id": GATE_PLANA,
  // ── Credenciales: `onboarding` puede llegar porque son las pantallas a las
  // que tiene que llegar para dejar de estarlo. Una dirección verificada es un
  // factor desde el 4E, así que `email/send` registra uno y cuenta como las de
  // abajo. Su contraseña la comprueba la puerta, no el controlador.
  "POST /api/auth/email/send": GATE_CON_ONBOARDING,
  "POST /api/auth/totp/setup": GATE_CON_ONBOARDING,
  "POST /api/auth/totp/confirm": GATE_CON_ONBOARDING,
  // La única con `toleraFactorIlegible`: deshacer un TOTP que este servidor no
  // puede leer. Ver `requireStepUp.ts` para por qué no se ensancha a nadie más.
  "DELETE /api/auth/totp/": {
    permiteOnboarding: true, toleraFactorIlegible: true,
  },
  "POST /api/auth/webauthn/register/options": GATE_CON_ONBOARDING,
  "POST /api/auth/webauthn/register/verify": GATE_CON_ONBOARDING,
  "DELETE /api/auth/webauthn/credentials/:id": GATE_CON_ONBOARDING,
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

  // 🔴 The assertion D6 is about, as it stands after the decision of 2026-10-10.
  //
  // D6 (plan 4C, 2026-09-02) demanded the caller's password on **every** write
  // to the three routers; the cut of 2026-09-08 left seven of them asking on
  // every request, and the decision of 2026-10-10 ("Todo, sin excepciones")
  // removed those seven. What survives of this test is the half that cannot be
  // given up without a new decision: every administrative write is behind the
  // gate at all, and behind the plain one. A tripwire that gets deleted
  // protects nothing, so it narrows instead of disappearing.
  //
  // Over **every write** on the three routers, not over the routes that
  // already carry the gate: filtered from `gated`, a new administrative write
  // mounted with no gate at all would never enter the set and the loop would
  // never see it — the one direction D6 most needs to be caught in. Filtered
  // from `routes`, it fails here by name. The list of names has to add up to
  // exactly that set for the same reason: a write added later belongs to no
  // list, so it fails here rather than quietly picking up whichever treatment
  // its author happened to type.
  it("puts every administrative write behind the plain gate, and nothing stricter", () => {
    // Its own prefix list, not `MODULOS_TABULADOS`: that one names the routers
    // whose gate tables are complete, and grew to six on 3 September. The claim
    // here is narrower — the three routers that mint accounts, hand out roles
    // and rewrite the matrix.
    //
    // 🔴 **A name here that stops naming a mount takes its router out of this
    // check entirely.** D1 renamed `/api/permisos` to `/api/permiso`: with the
    // old spelling left in place, `PUT /api/permiso/:id_rol` — the write that
    // rewrites the permission matrix of every role — would simply not be in
    // `escrituras`. The partition below does catch that today, but it catches
    // it as a diff between two lists of route names, which reads like a missing
    // route rather than a router that walked out. So the prefixes are named and
    // checked against the mounted table before they are used, and the failure
    // says which router left.
    const PREFIJOS = ["usuario", "rol", "permiso"] as const;
    const sinMontar = PREFIJOS.filter((p) => !routes.some((r) => r.path.startsWith(`/api/${p}/`)));
    expect(
      sinMontar,
      `estos routers salieron de la exigencia de puerta de D6 sin avisar: ${sinMontar.join(", ")}`,
    ).toEqual([]);
    const ADMINISTRATIVOS = new RegExp(`^\\/api\\/(${PREFIJOS.join("|")})\\b`);
    /**
     * The one route on these three routers whose verb is a write and whose
     * effect is not.
     *
     * `POST /api/usuario/export` builds the staff directory as a file and
     * changes nothing. It is a POST because `requireSameOrigin` guards only the
     * writing verbs, so a GET that assembles a spreadsheet is something any
     * page on the internet can make a logged-in employee's browser do, twenty
     * times over, from an `<img>` tag — the verb is buying CSRF protection
     * here, not announcing a mutation. Demanding step-up to download a list
     * would be a prompt on a read, which is not what D6 decided.
     *
     * **Named one at a time, never a pattern.** A rule excusing anything ending
     * in `/export` would wave through a future `POST /api/usuario/export-and-purge`
     * without a word.
     */
    const LECTURAS_CON_VERBO_DE_ESCRITURA = ["POST /api/usuario/export"];
    const escrituras = routes.filter(
      (r) => WRITES.includes(r.method)
        && ADMINISTRATIVOS.test(r.path)
        && !LECTURAS_CON_VERBO_DE_ESCRITURA.includes(nombre(r)),
    );
    /**
     * Las escrituras de los tres routers, una por una. Antes se partían en dos
     * listas —las que pedían la contraseña siempre y las de la ventana—; la
     * partición desapareció con la decisión del 2026-10-10 y queda la unión.
     */
    const ESCRITURAS_ADMINISTRATIVAS = [
      "POST /api/usuario/",
      "DELETE /api/usuario/:id",
      "PATCH /api/usuario/:id/desbloquear",
      "PUT /api/usuario/:id/rol",
      "PUT /api/usuario/userpass/:id",
      "POST /api/usuario/:id/mfa/reset",
      "PUT /api/permiso/:id_rol",
      "PUT /api/usuario/:id",
      "PUT /api/usuario/username/:id",
      "PATCH /api/usuario/:id/restore",
      "POST /api/rol/",
      "PUT /api/rol/:id",
      "DELETE /api/rol/:id",
      "PATCH /api/rol/:id/restore",
    ];
    expect([...ESCRITURAS_ADMINISTRATIVAS].sort()).toEqual(escrituras.map(nombre).sort());
    for (const r of escrituras) {
      expect(r.chain, nombre(r)).toContain("stepUpGate");
      // Whole object, not a field: no route here may carry an option that
      // loosens or tightens the gate without a table edit to go with it.
      expect(r.stepUp, nombre(r)).toEqual(GATE_PLANA);
    }
  });

  it("mantiene la puerta que sostiene la rotación de sesión de `PUT /userpass/:id`", () => {
    /**
     * 🔴 El alambre de una dependencia que no se ve desde el controlador.
     *
     * `updateUserPass` rota la sesión del llamador, y desde el 2026-09-08
     * decide el estado de la sesión nueva como lo decide un login —
     * `estadoInicialDeSesion`— en vez de copiarlo de la vieja. Copiarlo era la
     * manera de sortear el plazo de catorce días: la fila nueva se crea
     * **ahora**, y `estadoEfectivo` exime a una sesión `completa` abierta
     * después del plazo de su cuenta, así que una sesión con el plazo vencido
     * se escribía otra sesión exenta, y otra, hasta el infinito.
     *
     * **Y una excepción, que es lo que esta puerta sostiene.**
     * `estadoInicialDeSesion` contesta `parcial` a **toda** cuenta con factor
     * —correo verificado incluido, que desde el plan 4E es un factor— porque
     * un login todavía no ha probado nada. `authenticate` contesta **401** a
     * `parcial`. Escribirlo tal cual devolvería 200 con cookie nueva y echaría
     * al formulario de login en la petición siguiente, que es justo el fallo
     * que la rotación existe para evitar. Así que el controlador escribe
     * `completa` cuando la cuenta tiene factor, y lo que hace legítimo ese
     * atajo es esta puerta: `requireStepUp` rechaza a una cuenta con factor
     * que no traiga un `mfa_satisfied_at` más fresco que
     * `STEP_UP_WINDOW_MINUTES` (rama `sin-factor-reciente`), así que todo el
     * que llega al handler teniendo factor acaba de probarlo.
     *
     * **Lo que hay que vigilar es que la puerta siga montada**, no qué
     * opciones lleva: esa rama salta en cualquier configuración. Quitar la
     * puerta entera —o mover la ruta a un router sin ella— convierte el atajo
     * del controlador en un regalo: `completa` para una cuenta que no ha
     * probado ningún factor en esta sesión ni en la anterior. Por eso la
     * primera aserción es la de estar en `gated`, y las otras dos solo fijan
     * la forma con la que está montada hoy.
     *
     * `permiteOnboarding: false` va aquí porque es la otra mitad de la misma
     * frase: encendido, una sesión ya estrechada a `onboarding` alcanzaría el
     * handler, y aunque la rama de arriba la seguiría rechazando por no traer
     * prueba fresca, dejaría de ser cierto que el único estado que llega aquí
     * es `completa`.
     */
    const RUTA = "PUT /api/usuario/userpass/:id";
    const ruta = routes.find((r) => nombre(r) === RUTA);
    expect(ruta, `${RUTA} dejó de estar montada`).toBeDefined();
    expect(
      ruta?.chain,
      `${RUTA} perdió su step-up: la rotación de sesión de updateUserPass concede ` +
        "`completa` a una cuenta con factor apoyándose en que esta puerta acaba de exigírselo",
    ).toContain("stepUpGate");
    expect(ruta?.stepUp?.permiteOnboarding, RUTA).toBe(false);
  });
});
