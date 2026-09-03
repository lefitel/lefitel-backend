// The session endpoints through the real Express stack.
//
// The controller tests build a `req` by hand, which is fast and blind in one
// specific way: they trust that the fake object looks like what the middleware
// chain actually produces. It does not always. In the previous task a test just
// like this one was the only thing that caught a 500 on *every* protected route
// — `cookie-parser` runs its own `JSONCookies` step and turns a value like `j:1`
// into the number `1` before anything downstream sees it, which no hand-built
// `req.cookies` ever does.
//
// So this file goes in through `supertest`: real cookie-parser, real
// `express.json`, real helmet, real `authenticate`, real `sessionStore`, real
// controllers. The only thing replaced is the handful of query methods on the
// two models, which means no Postgres and no fixture data — and, more to the
// point, it means the `where` clause the store hands the model is readable from
// here.
//
// That last part is what makes this the strongest test of the IDOR: `DELETE
// /api/auth/sessions/:id` is asserted not by trusting a mocked store's answer,
// but by reading the actual query and checking the caller's own `id_usuario` is
// in it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { Model } from "sequelize";

const permisos = { seguridad: { ver: true, crear: false } };
/**
 * What `can` answers. False for everything in this file — the caller is an
 * ordinary account reaching its own records — and read through a variable
 * rather than hard-coded so the one test that needs a permission holder can
 * flip it and put it back.
 */
let puede = false;
vi.mock("./permissions/store.js", () => ({
  permissionsFor: async () => permisos,
  can: async () => puede,
  invalidatePermissions: vi.fn(),
}));
vi.mock("./utils/logAction.js", () => ({ logAction: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true), hash: vi.fn().mockResolvedValue("hashed") },
}));

const app = (await import("./app.js")).default;
const { SESSION_COOKIE_NAME } = await import("./auth/sessionCookie.js");
const { allowedOrigins, CSRF_CLIENT_HEADER, LOCKOUT_AFTER_FAILURES, PASSWORD_CONFIRM_LIMIT, PASSWORD_MIN_LENGTH, SESSION_ABSOLUTE_DAYS, SESSION_IDLE_DAYS, SESSION_TOUCH_THROTTLE_MINUTES } =
  await import("./config/security.js");
/**
 * The two sentences the credential gates answer with, imported rather than
 * retyped.
 *
 * Both routes below answer more than one 4xx, and this project has been caught
 * four times by a test that read only the number: a 401 is also what
 * `authenticate` says, and a 400 is what a username that is not a string gets.
 * Pinning the sentence is what makes those tests fail for the right reason —
 * and importing it, rather than writing the Spanish out, is deliberate here for
 * the opposite reason to `CABECERA_ROL` below: this is a message shown to a
 * person, not a wire format two repositories have to agree on byte for byte.
 */
const { CURRENT_PASSWORD_REQUIRED_MESSAGE, CURRENT_PASSWORD_WRONG_MESSAGE } = await import(
  "./controllers/usuario.controller.js"
);
/**
 * The `/api/usuario` router itself, for the one assertion that is about the
 * mounted middleware chain rather than about a response. See "mounts the
 * permission guard before the budget on both routes".
 */
const usuarioRouter = (await import("./routes/usuario.routes.js")).default;
const { CODIGO_STEP_UP } = await import("./middleware/requireStepUp.js");
/**
 * The sentence an `onboarding` session gets when it reaches for the ERP.
 *
 * Imported for the same reason as the two credential messages above, and it
 * matters more here than anywhere else in this file: 403 is *also* what the
 * permission gates answer, so a test that read only the number would pass
 * against a refusal that had nothing to do with the grace period. The
 * sentence is what makes it fail for the right reason.
 */
const { MENSAJE_FACTOR_PENDIENTE, CODIGO_FACTOR_PENDIENTE } = await import("./auth/sessionState.js");

/**
 * The two response header names the frontend hard-codes, written out here.
 *
 * Not `ROLE_HEADER` and `SESSION_EXPIRES_HEADER` imported from the config, and
 * that is deliberate — see the same literals and the longer reasoning in
 * `app.security.test.ts`. In short: an expectation built from the constant it
 * is checking moves with a rename, so it can only ever catch a deletion, and
 * renaming `ROLE_HEADER` used to leave every test in both repositories green
 * while the browser silently stopped noticing role changes.
 */
const CABECERA_ROL = "x-osefi-role";
const CABECERA_VENCIMIENTO = "x-osefi-session-expires";
const { hashSessionToken } = await import("./auth/sessionToken.js");
const { loginIpLimiter, loginAccountIpLimiter, passwordConfirmLimiter } = await import(
  "./middleware/loginLimiters.js"
);
const { UsuarioModel } = await import("./models/usuario.model.js");
const { logAction } = await import("./utils/logAction.js");
const { SesionModel } = await import("./models/sesion.model.js");
const { sequelize } = await import("./database/sequelize.js");
const { RolModel } = await import("./models/rol.model.js");
const { TokenUsoUnicoModel } = await import("./models/tokenUsoUnico.model.js");
const { CredencialWebauthnModel } = await import("./models/credencialWebauthn.model.js");
const { FactorTotpModel } = await import("./models/factorTotp.model.js");
const { CodigoRecuperacionModel } = await import("./models/codigoRecuperacion.model.js");
const { DispositivoRecordadoModel } = await import("./models/dispositivoRecordado.model.js");

/**
 * The models are real, and only their query methods are replaced.
 *
 * `vi.mock` on a model module cannot be used here, and finding out why is worth
 * a note: six other model modules declare `UsuarioModel.hasMany(...)` and
 * `PosteModel.belongsTo(UsuarioModel, ...)` while being imported, `app.ts`
 * imports every router so all of them run, and Sequelize checks its argument —
 * "poste.belongsTo called with something that's not a subclass of
 * Sequelize.Model". Spying on the real classes keeps every association intact
 * and still means no query ever leaves for Postgres.
 *
 * `tokenUsoUnicoDestroy` joined this list once `login` started sweeping
 * `token_uso_unico` opportunistically on every successful login (see
 * `tokenStore.ts`). Without it, every "logging in, through the real stack"
 * test below would reach the real `TokenUsoUnicoModel.destroy` and fire a
 * genuine DELETE against whichever database this process is configured
 * with — the exact failure global-constraints.md #11 warns about, and the
 * reason this whole file exists to be checked for it.
 */
const sesionFindOne = vi.spyOn(SesionModel, "findOne");
const sesionFindAll = vi.spyOn(SesionModel, "findAll");
const sesionUpdate = vi.spyOn(SesionModel, "update");
const sesionCreate = vi.spyOn(SesionModel, "create");
const usuarioFindByPk = vi.spyOn(UsuarioModel, "findByPk");
const usuarioFindOne = vi.spyOn(UsuarioModel, "findOne");
/**
 * Two more, for the DELETE tests near the bottom of this file — spied rather
 * than left real for the same reason as everything else here, and chosen
 * over `UsuarioModel.destroy` specifically: `deleteUsuario` opens a real
 * `sequelize.transaction()`, which reaches for a real connection before its
 * callback runs a single (mocked) query inside it — so spying only the model
 * calls inside that transaction still leaves the transaction itself hitting
 * the configured database, which in this environment is a copy of
 * production. `deleteRol` opens no transaction at all, so spying its two
 * calls is what actually keeps this file's promise.
 */
const usuarioCount = vi.spyOn(UsuarioModel, "count");
const rolFindOne = vi.spyOn(RolModel, "findOne");
const tokenUsoUnicoDestroy = vi.spyOn(TokenUsoUnicoModel, "destroy");
/**
 * Two more spies, added for Task 4's routes specifically — nothing already
 * exercised in this file reached either method for real.
 *
 * `usuarioUpdate` is `verifyEmail`'s own write (`email_verified_at = now()`).
 * `tokenUsoUnicoUpdate` is what `consumirToken` calls underneath —
 * `/email/verify` never wraps it in a transaction (see
 * `email.controller.ts`'s own comment on why), so exercising it here through
 * the real `tokenStore.js` never opens one and stays safe under this file's
 * "spy on the model methods, never mock `database/sequelize.js`" rule (that
 * mock would break `sequelize.define(...)` for every model `app.ts` loads).
 *
 * Deliberately not extended to `/email/send`'s happy path: that handler opens
 * a real `sequelize.transaction()` on its very first write, and `crearToken`
 * opens a second one of its own — neither is reachable here without a real
 * database connection, which this file's models-only spying cannot prevent.
 * That path is covered instead by `email.controller.test.ts`, which mocks
 * `database/sequelize.js` directly and does not import `app.js` at all.
 */
const usuarioUpdate = vi.spyOn(UsuarioModel, "update");
const tokenUsoUnicoUpdate = vi.spyOn(TokenUsoUnicoModel, "update");
/**
 * Three more, added for Task 6's `requireStepUp`. The shared session below
 * has `mfa_satisfied_at: null` — the real, shipped value — so any test that
 * reaches a `requireStepUp`-gated route calls the real `tieneAlgunFactor`,
 * which reads these three. They have to be spied rather than left real:
 * `tieneAlgunFactor` is a genuine query with no fixture data behind it here,
 * and a route that reached it unmocked would fail on a live connection this
 * file's own header promises none of its tests need. Left at their default
 * (no factor registered), `tieneAlgunFactor` answers `false` and the gated
 * routes fall to `requireStepUp`'s branch 3 — no password sent, nothing to
 * prove, let through — which is what most of the tests below that touch
 * those routes actually rely on, whether they say so or not.
 */
/**
 * The transaction, spied — which is what finally lets this file exercise a
 * happy path that opens one.
 *
 * The rule this file keeps is "spy on the model methods, never `vi.mock` the
 * `database/sequelize.js` module", because that mock breaks `sequelize.define`
 * for every model `app.ts` loads. Spying one method on the already-constructed
 * instance is not that: the models are defined long before this line runs, and
 * this is the same kind of replacement as the model spies above.
 *
 * **The default throws on purpose.** Until now no test here reached a real
 * transaction, and the file relied on that by arrangement rather than by
 * enforcement — `deleteUsuario`'s tests spy `usuarioCount` instead of
 * `UsuarioModel.destroy` precisely to stay away from one. A handler that opens
 * a transaction reaches for a real connection *before* running any of the
 * mocked queries inside it, so a test that wandered into one would hit the
 * configured database, which in this environment is a copy of production. That
 * used to be a silent hazard; it is now a loud failure, and a test that means
 * to open one says so by giving the spy an implementation.
 */
const transaction = vi.spyOn(sequelize, "transaction");
/**
 * The other gateway every Sequelize operation — static or instance, read or
 * write — eventually funnels through, spied for the same reason and given
 * the same default as `transaction` above.
 *
 * **Hallazgo D5/F17's sharpest concrete example.** `totpStore.ts`'s
 * `guardarSecretoSinConfirmar` runs
 * `SELECT nextval(pg_get_serial_sequence('factor_totp', 'id'))` through
 * `sequelize.query` **directly**, before it ever opens the transaction
 * `transaction` above already guards. Every model-level spy in this file
 * replaces the method outright, so none of them ever reach this far down —
 * this is the one spy that would have caught a test reaching `POST
 * /api/auth/totp/setup` with the rest of this harness still green, and the
 * one the audit found missing. `reportBuilder/execute.ts` is the only other
 * production caller in this codebase, and it is not reachable through any
 * route this file exercises.
 */
const sequelizeQuery = vi.spyOn(sequelize, "query");
const passkeyCount = vi.spyOn(CredencialWebauthnModel, "count");
const totpCount = vi.spyOn(FactorTotpModel, "count");
const codigoCount = vi.spyOn(CodigoRecuperacionModel, "count");
/**
 * `find*` for the same four factor models, alongside their `count` above —
 * the other concrete gap hallazgo D5/F17 named. `count` alone was safe only
 * because nothing exercised here used to reach a `findOne`/`findAll` on
 * these four; plan 4B's own code already does:
 *
 * - `comprobarDispositivo` (`rememberedDeviceIssue.ts`, called from `login`
 *   whenever the request carries a remembered-device cookie) runs a real
 *   `findOne` against `DispositivoRecordadoModel`.
 * - `gastarCodigo` (`recoveryCodeStore.ts`, reachable from the recovery-code
 *   branch of `POST /api/auth/mfa/verify`) runs a real `findAll` against
 *   `CodigoRecuperacionModel`.
 *
 * Both go straight to `osefi_local` today, and no test in this file
 * exercises either route yet to have noticed.
 *
 * `totpStore.ts`, `mfa.controller.ts` and `totp.controller.ts` all call
 * `FactorTotpModel.unscoped().findOne(...)` rather than the bare static
 * method — spying the base `findOne` here still covers that: `unscoped()`
 * (`Model.scope()` underneath) returns `class extends FactorTotpModel {}`,
 * a fresh subclass that never redefines `findOne` itself, so the call
 * inherits this exact spy through the prototype chain (verified against
 * this project's installed Sequelize version, not assumed).
 */
const passkeyFindOne = vi.spyOn(CredencialWebauthnModel, "findOne");
const totpFindOne = vi.spyOn(FactorTotpModel, "findOne");
const codigoFindAll = vi.spyOn(CodigoRecuperacionModel, "findAll");
const dispositivoFindOne = vi.spyOn(DispositivoRecordadoModel, "findOne");
/**
 * One more, for the remembered-device revocation `updateUserPass` gained
 * alongside its rotation (see that handler's own comment). Left real, this
 * hits the actual `DispositivoRecordadoModel.update`, which reaches for the
 * configured connection the same way every other unspied model call here
 * would — this file's whole premise is that none of them get the chance.
 */
const dispositivoUpdate = vi.spyOn(DispositivoRecordadoModel, "update");

/**
 * Task 15 (hallazgo D4): closing this hole for every model instead of
 * growing a fixed list by hand.
 *
 * Until this task, the named spies above were this file's entire promise —
 * a fixed roster, and of the four factor models only `count`. That was safe
 * only because nothing had ever written to `credencial_webauthn`,
 * `factor_totp`, `codigo_recuperacion` or `dispositivo_recordado` through
 * this file; plan 4B is the first one that does, and a fixed list is exactly
 * the kind of thing the next plan forgets to widen. It has already happened
 * once with a model that *is* on the list above: see the note near the
 * bottom of "the login rate limit" describing a test that reached the real,
 * unspied `UsuarioModel.increment` and sent a genuine UPDATE to whatever
 * `.env` pointed at.
 *
 * So instead of another name added to a list, this reads `sequelize.models`
 * — every model Sequelize has ever `define`d, which by this point in the
 * file is every model this project has, because `app.js` above imports
 * every router and every router pulls in the models its controllers use —
 * and gives every write method on every one of them a spy, unless a spy
 * declared above already covers it. A model added next month needs no edit
 * here to be covered; neither does a factor model gaining a write path
 * nobody has thought about yet.
 */

/**
 * The write surface of a Sequelize model, reasoned from the actual static
 * methods `Model` exposes in this project's installed `sequelize` version —
 * not "everything that is not a `find*`", which is exactly the shortcut
 * that drops one silently instead of naming which:
 *
 * - `create`, `bulkCreate`, `findOrCreate` and `findCreateFind` can all
 *   insert a row (the last two only when their search comes up empty, which
 *   is still a real INSERT the day it does).
 * - `upsert` inserts or updates — its own line rather than folded into
 *   either list, because it is both.
 * - `update`, `increment` and `decrement` all mutate rows that already
 *   exist.
 * - `destroy` and `restore` remove and bring back rows; `truncate` does
 *   both to the entire table at once.
 *
 * Left out on purpose: the read-only finders (`findAll`, `findOne`,
 * `findByPk`, `count`, `aggregate`, `max`, `min`, `sum`, `describe`);
 * `build`, `bulkBuild` and `findOrBuild`, which hand back an unsaved
 * instance and touch nothing until something later calls `.save()` on the
 * result; the `before*`/`after*` hook registrars, which attach a callback
 * and run no query themselves; association wiring (`belongsTo`, `hasMany`,
 * ...); and schema/introspection methods (`sync`, `drop`, `getTableName`,
 * `scope`, ...) — none of these write a row.
 */
const WRITE_METHODS = [
  "create",
  "bulkCreate",
  "findOrCreate",
  "findCreateFind",
  "upsert",
  "update",
  "increment",
  "decrement",
  "destroy",
  "restore",
  "truncate",
] as const;

type WriteMethod = (typeof WRITE_METHODS)[number];

/** A registered Sequelize model, as far as this harness needs to see it: a
 * name for the failure message, and an index signature to read its static
 * write methods off by name. Typed as functions (not `unknown`) so that
 * `vi.spyOn` below knows what it is replacing and `.mockImplementation`
 * type-checks against it. */
type SpyableModel = { name: string } & Record<WriteMethod, (...args: unknown[]) => unknown>;

const registeredModels = (): SpyableModel[] => Object.values(sequelize.models) as never;

/**
 * Every `[model, method]` pair whose write method exists on that model and
 * is not currently a vitest mock — i.e. is still the real Sequelize
 * implementation, which reaches the configured database for real the moment
 * a test calls it.
 */
const unspiedWriteMethods = (): Array<[SpyableModel, WriteMethod]> => {
  const found: Array<[SpyableModel, WriteMethod]> = [];
  for (const model of registeredModels()) {
    for (const method of WRITE_METHODS) {
      const candidate = model[method];
      if (typeof candidate === "function" && !vi.isMockFunction(candidate)) {
        found.push([model, method]);
      }
    }
  }
  return found;
};

// The fix: give every write method the pass above finds a spy that throws
// unless a test gives it its own implementation. A spy with no
// `mockImplementation` still calls through to the real method by default —
// that is what makes an *unconfigured* spy just as dangerous as no spy at
// all — so this default is not silence, it is a loud refusal, exactly like
// the `transaction` spy above and for the same reason.
for (const [model, method] of unspiedWriteMethods()) {
  vi.spyOn(model, method).mockImplementation(() => {
    throw new Error(
      `${model.name}.${method} was called with no spy configured in ` +
        `app.auth.test.ts. Give it one (vi.spyOn + mockResolvedValue) before the ` +
        `request that reaches it — otherwise this write lands on osefi_local for real.`,
    );
  });
}

/**
 * The instance half of the same promise — hallazgo D5/F17's second concrete
 * gap.
 *
 * Every static method above is called on the model *class*
 * (`FactorTotpModel.destroy(...)`); a row a controller already has in hand
 * writes through the *instance* methods instead — `.save()`, `.destroy()`,
 * `.update()`, `.increment()`, `.decrement()`, `.restore()` — which live on
 * `Model.prototype` (imported straight from `"sequelize"` above, not from
 * any of this project's own model files), not on any one entry of
 * `sequelize.models`. Eight controllers in this codebase call one of these
 * on a row they just read.
 *
 * **Reachable today only by accident.** Every fixture in this file standing
 * in for a found row is a plain object (`{ dataValues: {...} }`), which has
 * none of these methods, so a controller that called `.save()` on one would
 * already throw a *visible* `TypeError` rather than write anywhere. That
 * accident is not a guarantee: a fixture built with `Model.build(...)`, or
 * any mock that resolves a real instance instead of a plain literal, would
 * hand back an object with these methods live and reaching for
 * `osefi_local`. This closes for these six methods the exact gap the
 * `transaction` spy above already closed for transactions specifically.
 *
 * **One spy per method, not one per model.** Every model this project
 * defines inherits these six from the same `Model.prototype` — none
 * overrides them (verified: no `models/*.model.ts` file assigns to
 * `.prototype.save`/`.destroy`/`.update`/`.increment`/`.decrement`/
 * `.restore`, and a direct check against the installed Sequelize confirms
 * every defined model's prototype method is `===` `Model.prototype`'s) — so
 * patching the base class here protects every instance of every model,
 * current and future, the same way the loop above protects every
 * registered model's static methods without naming one. And this cannot
 * leak into another test file: each `*.test.ts` file gets its own fresh
 * module graph, `"sequelize"`'s own module included (verified directly —
 * patching `Model.prototype.save` in one file left it untouched in
 * another run alongside it).
 */
const INSTANCE_WRITE_METHODS = ["save", "destroy", "update", "increment", "decrement", "restore"] as const;
for (const method of INSTANCE_WRITE_METHODS) {
  vi.spyOn(Model.prototype as unknown as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(
    () => {
      throw new Error(
        `Model.prototype.${method} was called on a real instance with no spy configured in ` +
          `app.auth.test.ts. Give that row's fixture its own ${method}(), or spy this call ` +
          `directly — otherwise this write lands on osefi_local for real.`,
      );
    },
  );
}

/**
 * The independent half of hallazgo D5/F17's fix to the self-test below.
 *
 * `unspiedWriteMethods()` above answers "which pairs in `WRITE_METHODS` are
 * not yet spied" — which is exactly why checking *that* used to be
 * tautological: the loop that installs the spies and the assertion that
 * verified them both walked the same array, so shrinking `WRITE_METHODS`
 * shrank the thing being verified along with the thing doing the verifying.
 * Measured on the file as audited: adding `"aggregate"` — a real Sequelize
 * method, just not a write — to `WRITE_METHODS` left 77/77 green, which is
 * only possible if the assertion never actually depended on which names
 * were in the list.
 *
 * The fix is not a better list to share; it is to stop sharing one. Nothing
 * below reads `WRITE_METHODS`. It reflects Sequelize's actual `Model` base
 * class at the moment the test runs and reasons about *that* — so deleting
 * a name from `WRITE_METHODS` (which only starves the install loop above)
 * no longer starves the check that follows: the check still expects the
 * real method to be spied, on every model, and says so by name.
 */
function modelStaticMethodNames(): string[] {
  const names = new Set<string>();
  // Walked rather than read off one model, because these are inherited —
  // not own — on every model this project defines (see the comment above
  // `registeredModels`). `Model` itself is where they are all own.
  let target: unknown = Model;
  while (typeof target === "function" && target !== Function.prototype) {
    for (const name of Object.getOwnPropertyNames(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor && typeof descriptor.value === "function") names.add(name);
    }
    target = Object.getPrototypeOf(target);
  }
  return [...names];
}

/**
 * Every category of static `Model` method that is not a write, reasoned the
 * same way the comment on `WRITE_METHODS` below already does — restated as
 * code, independently, so `trueStaticWriteMethods` can act on it without
 * consulting `WRITE_METHODS` itself. Whatever this does not clear is
 * presumed dangerous and has to be spied.
 *
 * Verified once, directly against this project's installed Sequelize
 * version (not assumed): reflecting `Model`'s real static surface and
 * filtering out everything this function clears reproduces `WRITE_METHODS`
 * below exactly, name for name.
 */
function isKnownSafeStaticMethod(name: string): boolean {
  if (name.startsWith("_")) return true; // Sequelize's own "do not call this" marker.
  // Hook registration/inspection and the lifecycle callbacks themselves:
  // attach or query a function, run no query of their own. The write a hook
  // *observes* is covered by the operation that fires it (create, update,
  // destroy, ...), already in WRITE_METHODS.
  if (/^(before|after)[A-Z]/.test(name)) return true;
  if (
    ["addHook", "removeHook", "hasHook", "hasHooks", "runHooks", "validationFailed", "addScope"].includes(name)
  )
    return true;
  // Association wiring: declares a relationship between two already-defined
  // models. Sends no query of its own.
  if (
    [
      "belongsTo", "belongsToMany", "hasMany", "hasOne",
      "getAssociationForAlias", "getAssociations", "hasAlias",
    ].includes(name)
  )
    return true;
  // Schema/introspection/config: describe or reshape the model definition
  // itself, never a row.
  if (
    [
      "init", "sync", "schema", "unscoped", "scope", "drop", "dropSchema",
      "getTableName", "getAttributes", "refreshAttributes", "removeAttribute",
      "warnOnInvalidOptions",
    ].includes(name)
  )
    return true;
  // Read-only finders/aggregates, and the three that hand back an unsaved,
  // untouched instance (`build`, `bulkBuild`, `findOrBuild`) — see
  // WRITE_METHODS's own comment for why those three are not writes either.
  if (
    [
      "findAll", "findOne", "findByPk", "findAndCountAll", "count", "aggregate",
      "max", "min", "sum", "describe", "build", "bulkBuild", "findOrBuild",
    ].includes(name)
  )
    return true;
  return false;
}

/**
 * The real static write surface, independent of `WRITE_METHODS` — see the
 * header comment above `modelStaticMethodNames`.
 */
const trueStaticWriteMethods = (): string[] =>
  modelStaticMethodNames().filter((name) => !isKnownSafeStaticMethod(name));

describe("the write-method spy harness itself (task 15, hallazgo D4; and D5/F17's fix to it)", () => {
  it("has an active spy on every write method WRITE_METHODS names", () => {
    // Read fresh rather than trusting the pass above ran: this is what turns
    // red the day a model gains a write method the fix above does not reach.
    // Kept for the value it always had — proving the install loop actually
    // ran — but see the next test for why this one, on its own, used to
    // prove nothing about whether `WRITE_METHODS` itself was complete.
    const missing = unspiedWriteMethods().map(([model, method]) => `${model.name}.${method}`);
    expect(
      missing,
      "these write methods would reach osefi_local for real because nothing spies them",
    ).toEqual([]);
  });

  it("is not fooled by an incomplete WRITE_METHODS the way the previous test is (hallazgo D5/F17)", () => {
    // The bug this test exists to catch: `unspiedWriteMethods()` only ever
    // looks at pairs it is told about, so shrinking `WRITE_METHODS` by one
    // real name makes the test above stop checking that name at all — it
    // does not go red, it goes silent.
    //
    // `trueStaticWriteMethods()` never reads `WRITE_METHODS` — it reflects
    // Sequelize's real `Model` class and reasons about the result on its
    // own (see its comment). So this assertion keeps expecting "destroy" to
    // be spied on every model even in a version of this file where
    // "destroy" has been quietly deleted from `WRITE_METHODS` above, which
    // is exactly the scenario the previous test cannot detect — and this
    // one names it.
    const groundTruth = trueStaticWriteMethods();
    const missing: string[] = [];
    for (const model of registeredModels()) {
      for (const method of groundTruth) {
        const candidate = (model as unknown as Record<string, unknown>)[method];
        if (typeof candidate === "function" && !vi.isMockFunction(candidate)) {
          missing.push(`${model.name}.${method}`);
        }
      }
    }
    expect(
      missing,
      "these write methods would reach osefi_local for real, independently of what WRITE_METHODS says",
    ).toEqual([]);
  });

  it("keeps WRITE_METHODS itself honest against the same ground truth", () => {
    // Not a safety check on its own — the test above no longer needs
    // `WRITE_METHODS` to be right. This one exists so a drift between the
    // hand-typed list and reality is caught by name, immediately, instead
    // of surfacing later as an unexplained difference in behaviour between
    // the two tests above.
    expect([...WRITE_METHODS].sort()).toEqual(trueStaticWriteMethods().sort());
  });
});

const YO = 7;
const MI_ROL = 2;
const TOKEN = "un-token-opaco-de-treinta-y-dos-bytes";
const MI_SESION = "aaaaaaaa-11cd-4111-8111-aaaaaaaaaaaa";
const AJENA = "ffffffff-99ab-4999-8999-ffffffffffff";
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;

/**
 * What the browser sends alongside the cookie, and what these requests would be
 * refused for lacking.
 *
 * `requireSameOrigin` turns a write that arrives with a session cookie and
 * cannot show it came from our own frontend into a 403 before it reaches any
 * controller, so every cookie-carrying write below has to look like the request
 * a browser actually makes: an `Origin` this API knows, and a header no
 * cross-site form can attach. Read off `allowedOrigins` rather than written out,
 * so the value is the one the app is really configured with, whatever
 * CORS_ORIGIN says in this environment.
 */
const DEL_FRONTEND = {
  Origin: allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV)[0],
  [CSRF_CLIENT_HEADER]: "web",
};
/**
 * `DEL_FRONTEND.Origin` typed as definitely present: this suite's `.env`
 * always configures `CORS_ORIGIN` (see `app.auth.test.ts`'s sibling
 * `csrf.test.ts` for the same note), so the list is never empty here.
 */
const ORIGIN_NUESTRO = DEL_FRONTEND.Origin as string;

/**
 * The live session's own `expires_at`, captured rather than inlined so a test
 * can assert `GET /api/auth/me` answers with this exact value — the one the
 * row actually has — and not a date some handler computed on its own.
 */
let SESION_EXPIRA_FILA: Date;
/**
 * When the session was opened, which is what the absolute ceiling is measured
 * from. Recent on purpose: `authenticate` now reports the *effective* expiry —
 * the row's own, never later than `created_at` plus `SESSION_ABSOLUTE_DAYS` —
 * so a session created moments ago is the case where the two coincide and
 * `SESION_EXPIRA_FILA` is the answer. The tests that need them to differ move
 * this back themselves.
 */
let SESION_CREADA: Date;
const DIA_MS = 86_400_000;
/**
 * When this account's password last changed, for every fixture below.
 *
 * A year back, and deliberately older than the oldest session any test here
 * builds — one of them opens a session twenty-nine days ago to exercise the
 * absolute ceiling. `authenticate` refuses a session opened before this stamp,
 * so a value nearer than that would turn unrelated tests into 401s about a
 * password nobody in them changed.
 *
 * It is supplied at all because a mutation test showed what its absence
 * costs: with the column missing the rule compares against `NaN`, passes
 * everything, and the whole integration surface silently stops covering it.
 */
const PASS_CAMBIADA = new Date(Date.now() - 365 * 86_400_000);

beforeEach(() => {
  vi.clearAllMocks();
  SESION_EXPIRA_FILA = new Date(Date.now() + DIA_MS);
  SESION_CREADA = new Date();
  // A live session belonging to YO. `last_used_at` is now on purpose: the touch
  // is throttled, so a fresh timestamp keeps `touchSession` from firing and
  // adding an UPDATE that the assertions below would read as theirs.
  //
  // `mfa_satisfied_at` is `null` because that is what every session in
  // production actually has today — nothing writes this column yet. A
  // fix-round review caught an earlier version of this fixture claiming
  // "just now" instead, which made every `/username/:id` and
  // `/userpass/:id` test below pass only because `requireStepUp`'s window
  // check short-circuited around the gate entirely — a state that does not
  // exist outside this test file. With the real value restored, those tests
  // supply what the gate actually asks for: a `stepup_password` field on the
  // request, alongside whatever `oldPass` each was already testing.
  //
  // `mfa_source: null` for the same reason, and it used to be missing
  // altogether. `findLiveSession` returns the column on every row, so a
  // fixture without it is a shape production never produces — and 66 tests in
  // this file read this one object. It is harmless today only because
  // `estadoEfectivo` compares it with `!= null`, under which an absent column
  // and a null one mean the same thing; written strictly, the absent column
  // would read as "a factor was proved here" and switch the deadline rule off
  // across this entire file at once. The rule itself is pinned against a row
  // that really is a field short in `auth/sessionState.test.ts`, which is
  // where that belongs — a shared fixture's job is to be the real shape.
  sesionFindOne.mockResolvedValue({
    dataValues: {
      id: MI_SESION,
      id_usuario: YO,
      created_at: SESION_CREADA,
      expires_at: SESION_EXPIRA_FILA,
      last_used_at: new Date(),
      estado: "completa",
      mfa_satisfied_at: null,
      mfa_source: null,
    },
  } as never);
  sesionFindAll.mockResolvedValue([] as never);
  sesionUpdate.mockResolvedValue([1] as never);
  sesionCreate.mockResolvedValue({ dataValues: {} } as never);
  transaction.mockImplementation((() => {
    throw new Error(
      "este test alcanzó una transacción real; si es a propósito, dale una implementación al spy",
    );
  }) as never);
  // Same default, same reason, for the gateway underneath `transaction`
  // itself — see this spy's own comment near its declaration.
  sequelizeQuery.mockImplementation((() => {
    throw new Error(
      "este test alcanzó sequelize.query real; si es a propósito, dale una implementación al spy",
    );
  }) as never);
  usuarioFindByPk.mockResolvedValue({
    dataValues: { id: YO, id_rol: MI_ROL, user: "isaias", name: "Isaias", lastname: "Salas", image: null, pass_changed_at: PASS_CAMBIADA },
  } as never);
  usuarioFindOne.mockResolvedValue({
    dataValues: {
      id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
      name: "Isaias", lastname: "Salas", image: null, failed_attempts: 0, locked_until: null,
    },
  } as never);
  tokenUsoUnicoDestroy.mockResolvedValue(0);
  usuarioUpdate.mockResolvedValue([1] as never);
  // No role in use, and a role that exists and can be archived — the
  // deleteRol success path the DELETE tests below exercise.
  usuarioCount.mockResolvedValue(0 as never);
  rolFindOne.mockResolvedValue({ dataValues: { id: 99, name: "Sobrante" }, destroy: vi.fn().mockResolvedValue(undefined) } as never);
  tokenUsoUnicoUpdate.mockResolvedValue([0, []] as never);
  // No factor registered, by default — matching every other fixture in this
  // file, which models an ordinary account under plan 4A.
  passkeyCount.mockResolvedValue(0);
  totpCount.mockResolvedValue(0);
  codigoCount.mockResolvedValue(0);
  // Same default for the find* spies alongside them: nothing found, so
  // `comprobarDispositivo` sees no remembered device and `gastarCodigo` sees
  // no candidate recovery code, matching the "no factor, ordinary account"
  // shape every other fixture in this file already assumes.
  passkeyFindOne.mockResolvedValue(null as never);
  totpFindOne.mockResolvedValue(null as never);
  codigoFindAll.mockResolvedValue([] as never);
  dispositivoFindOne.mockResolvedValue(null as never);
  // No remembered devices to revoke, by default — matching every other
  // fixture in this file, which models an ordinary account under plan 4A.
  dispositivoUpdate.mockResolvedValue([0] as never);
});

/** The `where` of the nth UPDATE the store sent to the sessions table. */
const updateWhere = (n = 0) =>
  (sesionUpdate.mock.calls[n]?.[1] as { where: Record<string, unknown> } | undefined)?.where;

describe("the six session routes are really mounted", () => {
  it("answers every one of them, and none of them with a 500", async () => {
    // A mount path typed wrong gives 404 on all six at once, and a middleware
    // missing gives 500 on all six at once. Both are one-line mistakes that no
    // unit test with a hand-built `req` can see, because there is no mount in a
    // unit test.
    const calls: [string, number][] = [
      ["POST /api/auth/login", (await request(app).post("/api/auth/login").send({})).status],
      ["GET /api/auth/me", (await request(app).get("/api/auth/me")).status],
      ["POST /api/auth/logout", (await request(app).post("/api/auth/logout")).status],
      ["POST /api/auth/logout-all", (await request(app).post("/api/auth/logout-all")).status],
      ["GET /api/auth/sessions", (await request(app).get("/api/auth/sessions")).status],
      [
        "DELETE /api/auth/sessions/:id",
        (await request(app).delete(`/api/auth/sessions/${MI_SESION}`)).status,
      ],
    ];

    for (const [route, status] of calls) {
      expect(status, route).not.toBe(404);
      expect(status, route).not.toBe(500);
    }
    // Logging in is the only one that does not need a credential; the other five
    // refuse without one.
    expect(calls[0][1]).toBe(400);
    for (const [route, status] of calls.slice(1)) {
      expect(status, route).toBe(401);
    }
  });
});

describe("logging in, through the real stack", () => {
  it("sets an httpOnly cookie and puts no token in the body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(res.status).toBe(200);
    const setCookie = (res.headers["set-cookie"] as unknown as string[])?.join("; ") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    // The attributes a browser will actually enforce, read off the wire rather
    // than off the call site.
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    // And the thing this endpoint exists for: nothing usable in the body.
    expect(res.body.usuario).not.toHaveProperty("token");
    expect(JSON.stringify(res.body)).not.toContain("token");
    expect(res.body.permisos).toEqual(permisos);
  });

  it("sweeps token_uso_unico through the real model, not just the mocked store", async () => {
    // The only assertion in this file that would have caught the risk this
    // task's own wiring introduced: `auth.controller.test.ts` and
    // `login.session.test.ts` replace `tokenStore.js` wholesale, which proves
    // the controller calls it but not that the real module underneath still
    // reaches Postgres correctly. This request goes through the real
    // `tokenStore.js` and the real `TokenUsoUnicoModel` — only `destroy`
    // itself is spied — so a broken import path or a renamed model would
    // show up here even though the other two files stay green.
    await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(tokenUsoUnicoDestroy).toHaveBeenCalledOnce();
  });

  it("hands out no credential in the body on the old address either", async () => {
    /**
     * The address the current frontend posts to, through the mount that
     * actually serves it — and the test this task exists for.
     *
     * `POST /api/login` used to answer with a signed seven-day JWT nested
     * inside `usuario`. That token had no session row behind it, so nothing
     * could revoke it: neither a password change nor "cerrar todas mis
     * sesiones" reached it, and it stayed a working credential until it
     * expired. It also sat where any script on the page could read it. Both
     * facts are why `jwt.sign` is gone from the repository.
     *
     * Asserted through `supertest` rather than by calling the handler,
     * because the handler is no longer the thing that could go wrong: it is
     * shared with `POST /api/auth/login` and pinned by the test above. What
     * this address can still get wrong is its **wiring** — `login.routes.ts`
     * pointing back at a handler that signs, or a well-meant "compatibility"
     * shim putting the field back for a frontend that has not needed it in
     * two plans. Only a request through the real mount sees that.
     *
     * The two bodies are compared field for field rather than each being
     * checked for the absence of a token. "No token here" is the assertion
     * this project has repeatedly watched pass against broken code; "the same
     * answer, whichever address you use" is the property actually meant, and
     * it fails for a shim that adds anything at all.
     */
    const vieja = await request(app)
      .post("/api/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(vieja.status).toBe(200);
    // The cookie is the credential, on this address as much as the other.
    const setCookie = (vieja.headers["set-cookie"] as unknown as string[])?.join("; ") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toMatch(/HttpOnly/i);

    expect(vieja.body.usuario).not.toHaveProperty("token");
    expect(Object.keys(vieja.body).sort()).toEqual(["message", "permisos", "usuario"]);
    for (const palabra of ["token", "jwt", "bearer"]) {
      expect(JSON.stringify(vieja.body).toLowerCase(), palabra).not.toContain(palabra);
    }
    // And it really did log somebody in, rather than passing every line above
    // by answering an empty object.
    expect(vieja.body.usuario).toMatchObject({ id: YO, id_rol: MI_ROL, user: "isaias" });
    expect(vieja.body.permisos).toEqual(permisos);

    const nueva = await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(nueva.status).toBe(vieja.status);
    expect(nueva.body).toEqual(vieja.body);
  });
});

describe("who the cookie says I am", () => {
  it("hashes the cookie it was sent and looks the session up by the hash", async () => {
    // The token never reaches the database. This is where that stops being a
    // claim in a comment: the value on the wire and the value in the query are
    // compared here.
    await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    const where = (sesionFindOne.mock.calls[0][0] as { where: { token_hash: string } }).where;
    expect(where.token_hash).toBe(hashSessionToken(TOKEN));
    expect(where.token_hash).not.toBe(TOKEN);
  });

  it("answers with the role and the permissions read from the database", async () => {
    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.usuario).toMatchObject({ id: YO, id_rol: MI_ROL, user: "isaias" });
    expect(res.body.permisos).toEqual(permisos);
    // Through the real stack, not the hand-built req/res of
    // auth.controller.test.ts: this is what proves authenticate really hands
    // this session's own expires_at to req.user, over the real middleware
    // chain, and that `me` really forwards it rather than the wiring silently
    // dropping it somewhere in between.
    expect(res.body.expires_at).toBe(SESION_EXPIRA_FILA.toISOString());
    // Same proof for the role header: set by authenticate, and only readable
    // by the browser because app.ts's exposedHeaders names it — a unit test
    // with a fake `res.setHeader` cannot see either half of that. The name is
    // the hand-written literal, not the constant: see its comment at the top.
    expect(res.headers[CABECERA_ROL]).toBe(String(MI_ROL));
    // And the expiry, on the header as well as in the body, in the format the
    // other repository parses with `new Date(...)`.
    expect(res.headers[CABECERA_VENCIMIENTO]).toBe(SESION_EXPIRA_FILA.toISOString());
  });

  it("puts the expiry on an answer that has no body to carry it", async () => {
    // The reason this is a header at all. The server slides a session on any
    // authenticated request, not only on the ones that answer 200 with JSON a
    // client can read — so a client that learns the deadline from `/auth/me`
    // alone spends the rest of the day counting down to an instant that has
    // already moved. `authenticate` is middleware, so this rides on whatever
    // the route underneath answers: here a 404 from a path with no route.
    //
    // Not a path under `/api/auth`, and the difference is the point of picking
    // this one: that router mounts no `authenticate` of its own — `POST
    // /auth/login` cannot ask for a credential it is there to produce — so each
    // of its routes declares the middleware itself and a path that matches none
    // of them never authenticates at all. `/api/permisos` is mounted the
    // ordinary way, with `authenticate` in front of the whole router, which is
    // how every other router in this app is mounted and therefore what this has
    // to be true of.
    const res = await request(app).get("/api/permisos/no-existe").set("Cookie", COOKIE);

    expect(res.status).toBe(404);
    expect(res.headers[CABECERA_VENCIMIENTO]).toBe(SESION_EXPIRA_FILA.toISOString());
  });

  it("never promises a day past the thirty-day ceiling the query enforces", async () => {
    // The production case, measured. `touchSession` used to write a bare
    // `now + SESSION_IDLE_DAYS` with no ceiling, so from day twenty-three of a
    // session used every day the row's `expires_at` runs ahead of the day
    // `findLiveSession` starts refusing it — by up to a week. Somebody who
    // uses the ERP daily and never logs out then loses the session mid-morning
    // on day thirty with **no five-minute warning at all**, because the page
    // believed it had days left, and whatever form was open goes with it.
    //
    // A row in exactly that state: opened twenty-nine days ago, claiming five
    // more days, used a moment ago so nothing is touched. The ceiling is
    // tomorrow, and tomorrow is what the client has to be told.
    const creada = new Date(Date.now() - 29 * DIA_MS);
    const techo = new Date(creada.getTime() + SESSION_ABSOLUTE_DAYS * DIA_MS);
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION,
        id_usuario: YO,
        created_at: creada,
        expires_at: new Date(Date.now() + 5 * DIA_MS),
        last_used_at: new Date(),
        estado: "completa",
        mfa_satisfied_at: null,
      },
    } as never);

    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(res.headers[CABECERA_VENCIMIENTO]).toBe(techo.toISOString());
    expect(res.body.expires_at).toBe(techo.toISOString());
  });

  it("reports the window this request just opened, not the one it found", async () => {
    // The other half of the same defect, and the one that throws somebody out
    // of a live session. `authenticate` used to copy the `expires_at`
    // `findLiveSession` had read — the value from *before* the touch this very
    // request performs. Somebody who used the ERP last Monday and opens it the
    // next Monday with ten minutes left on the row is given another seven days
    // by the server and told "ten minutes" by it: five minutes later the
    // warning fires, five after that the timer logs them out, and the session
    // was alive the whole time. The error is not bounded by the throttle — it
    // is bounded by how long the person stayed away.
    const creada = new Date(Date.now() - 7 * DIA_MS);
    const usadaHaceMucho = new Date(Date.now() - (SESSION_TOUCH_THROTTLE_MINUTES + 1) * 60_000);
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION,
        id_usuario: YO,
        created_at: creada,
        expires_at: new Date(Date.now() + 10 * 60_000),
        last_used_at: usadaHaceMucho,
        estado: "completa",
        mfa_satisfied_at: null,
      },
    } as never);

    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    // Seven days from now, give or take the milliseconds this request took.
    const prometido = new Date(res.headers[CABECERA_VENCIMIENTO] as string).getTime();
    const esperado = Date.now() + SESSION_IDLE_DAYS * DIA_MS;
    expect(Math.abs(prometido - esperado)).toBeLessThan(5_000);
    // One value, four destinations: the header, the body, the row that was just
    // written, and the cookie the browser is handed back. Computed separately
    // they drift the day one of them is edited.
    expect(res.body.expires_at).toBe(new Date(prometido).toISOString());
    const escrito = (sesionUpdate.mock.calls[0]?.[0] as { expires_at?: Date }).expires_at;
    expect(escrito?.toISOString()).toBe(new Date(prometido).toISOString());
    const setCookie = (res.headers["set-cookie"] as unknown as string[]).join("; ");
    expect(setCookie).toContain(new Date(prometido).toUTCString());
  });

  it("refuses, rather than 500s, a cookie cookie-parser has parsed as JSON", async () => {
    // The defect a unit test could not see, kept here on the new routes too:
    // `osefi_session=j:1` arrives as the number 1, not a string.
    const res = await request(app).get("/api/auth/me").set("Cookie", `${SESSION_COOKIE_NAME}=j:1`);
    expect(res.status).toBe(401);
  });
});

describe("the credential that is no longer one", () => {
  /**
   * The tripwire for the whole plan, through the whole stack.
   *
   * Until this task `authenticate` had a second door: no cookie and an
   * `Authorization: Bearer` header meant "verify this JWT and let the account
   * in". A token verified that way has no session row behind it, so nothing
   * could revoke it — not `logout`, not `logout-all`, not a password change,
   * not archiving the account. Every other task in this arc built the row;
   * closing that door is what makes the row the only way in, and these two
   * tests are what fail if it is ever reopened.
   *
   * **The token is signed for real, with this app's own configured key.** That
   * is the difference between a test and a decoration. `Bearer no-es-un-jwt`
   * answers 401 too — for being malformed — and would go on answering 401 with
   * the old path fully restored, which is exactly the Plan 1 trap where a UUID
   * of nothing but digits made the lower-casing step untestable. `JWT_SECRET`
   * is read from the environment rather than written out here, so it is the
   * same string a re-added `jwt.verify(token, process.env.JWT_SECRET)` would
   * check the signature against. The mocked `UsuarioModel.findByPk` answers
   * with account 7, so a restored path would find the account, set the role
   * header and answer 200.
   */
  const firmado = () => {
    const secret = process.env.JWT_SECRET as string;
    // Not a formality: with no `.env` this would be `undefined`, `jwt.sign`
    // would throw, and the two tests below would fail for a reason that has
    // nothing to do with what they are about.
    expect(secret, "JWT_SECRET tiene que estar configurado para que este test pruebe algo").toBeTruthy();
    const token = jwt.sign({ id: YO, id_rol: MI_ROL }, secret);
    expect(jwt.verify(token, secret)).toMatchObject({ id: YO });
    return token;
  };

  it("opens nothing at GET /api/auth/me", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${firmado()}`);

    expect(res.status).toBe(401);
    // No role header and no expiry header: both are set by `authenticate` on a
    // request it let through, so their absence is the same fact as the 401 seen
    // from the browser's side, and a restored bearer path would set both.
    expect(res.headers[CABECERA_ROL]).toBeUndefined();
    expect(res.headers[CABECERA_VENCIMIENTO]).toBeUndefined();
    // Nothing was even looked up. This is what separates "no credential was
    // read" from "a credential was read and refused", and it is what the old
    // path could not have satisfied: it queried the account named in the token.
    expect(usuarioFindByPk).not.toHaveBeenCalled();
    expect(sesionFindOne).not.toHaveBeenCalled();

    // The premise, measured rather than assumed: the same address answers 200
    // to the credential that still works, so the 401 above is about the header
    // and not about this endpoint being broken.
    const conCookie = await request(app).get("/api/auth/me").set("Cookie", COOKIE);
    expect(conCookie.status).toBe(200);
  });

  it("opens nothing at POST /api/auth/logout-all, the endpoint this arc exists for", async () => {
    // The sharpest version of the same test. `logout-all` revokes by user id, so
    // the old path could reach it: a request on a bearer token really did close
    // every session row of that account — while its own credential went on
    // working, which is the hole this plan documents. It cannot reach it now.
    //
    // A write, so it also passes through `requireSameOrigin` with no cookie and
    // no `Origin`: 401 and not 403 says the CSRF guard stayed out of the way and
    // `authenticate` is what refused this, which is the correct division of
    // labour for a request that carries no cookie at all.
    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${firmado()}`);

    expect(res.status).toBe(401);
    // And the thing that matters more than the status: no session of anybody's
    // was touched. A revocation reached by an unrevocable credential is the
    // exact shape of the defect.
    expect(sesionUpdate).not.toHaveBeenCalled();
  });
});

describe("closing sessions, through the real stack", () => {
  it("revokes exactly this session on logout and takes the cookie back", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(200);
    // `id_usuario` in a logout too. It is not needed there — the caller's own
    // session id came from their own cookie — but there is one way to revoke a
    // session in this codebase and the owner is not optional in it.
    expect(updateWhere()).toEqual({ id: MI_SESION, id_usuario: YO, revoked_at: null });
    const setCookie = (res.headers["set-cookie"] as unknown as string[])?.join("; ") ?? "";
    // Cleared by being set to nothing with an expiry in the past — which is the
    // only way to remove a cookie — so the name must be there with an empty
    // value.
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it("puts the caller's own id_usuario in the DELETE, not only the id from the URL", async () => {
    // The IDOR assertion, read off the real query. Written any other way — a
    // mocked store, or checking only the status — removing `id_usuario` from
    // `revokeSessionOf`'s `where` would leave this file green while any account
    // with a session could close anybody else's.
    const res = await request(app)
      .delete(`/api/auth/sessions/${AJENA}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(200);
    expect(updateWhere()).toEqual({ id: AJENA, id_usuario: YO, revoked_at: null });
  });

  it("answers 404, not 403 and not 500, when the row was somebody else's", async () => {
    sesionUpdate.mockResolvedValue([0] as never);
    const res = await request(app)
      .delete(`/api/auth/sessions/${AJENA}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(404);
    // The filter still went to the database — the 404 is the query finding
    // nothing, not a check that skipped it.
    expect(updateWhere()).toMatchObject({ id_usuario: YO });
  });

  it("never sends a malformed id to a UUID column", async () => {
    // `WHERE id = 'pepito'` on a `uuid` column is not "no rows", it is Postgres
    // error 22P02. Without the shape check this would be a 500 with a stack
    // trace in the log, produced on demand by any account with a session.
    const res = await request(app)
      .delete("/api/auth/sessions/pepito")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(404);
    expect(sesionUpdate).not.toHaveBeenCalled();
  });

  it("revokes everything the caller has on logout-all", async () => {
    sesionUpdate.mockResolvedValue([3] as never);
    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(200);
    expect(res.body.cerradas).toBe(3);
    // By user, and with nothing spared: this is the one that has to be all of
    // them.
    expect(updateWhere()).toEqual({ id_usuario: YO, revoked_at: null });
  });
});

describe("logging in twice from the same browser", () => {
  it("closes the row the browser was already holding before opening the next", async () => {
    // Through the real stack, so the cookie really travels and the real
    // `findLiveSession` really hashes it. Without this rotation, every login
    // that was not preceded by somebody pressing the logout button — closing
    // the tab, or a logout request that failed and was left on screen for
    // somebody to retry — leaves one more live row for a week, all with the
    // same user_agent and IP, which is what would make `GET /auth/sessions`
    // useless as a screen.
    const res = await request(app)
      .post("/api/auth/login")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(res.status).toBe(200);
    // The previous row, revoked, by id and owner.
    expect(updateWhere()).toEqual({ id: MI_SESION, id_usuario: YO, revoked_at: null });
    // And a new row written all the same.
    expect(sesionCreate).toHaveBeenCalledTimes(1);
  });

  it("opens the session without any revocation when the browser had no cookie", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });

    expect(res.status).toBe(200);
    expect(sesionUpdate).not.toHaveBeenCalled();
    expect(sesionCreate).toHaveBeenCalledTimes(1);
  });
});

/**
 * What Task 8's own live verification could not check by itself.
 *
 * That verification ran `curl -i` against a booted server for exactly the
 * login → me → logout and logout-all cycle below, and `curl` sends whatever
 * headers it is told and prints whatever comes back — it does not decide
 * anything from them. A real browser does: `Access-Control-Allow-Credentials`
 * and `Access-Control-Allow-Origin` are what it reads to decide whether to
 * keep a cross-origin `Set-Cookie` at all and whether to let the page's own
 * script see the response. A `curl` transcript showing 200 and a cookie
 * cannot tell that story apart from one a browser would have discarded on the
 * spot — only reading these two headers, through the real CORS middleware,
 * can.
 */
describe("what curl could not check live: whether a browser would keep the credential", () => {
  it("carries both CORS-credential headers at every step of the cycle this task verifies live", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .set(DEL_FRONTEND)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    const me = await request(app).get("/api/auth/me").set("Cookie", COOKIE).set(DEL_FRONTEND);
    const logout = await request(app).post("/api/auth/logout").set("Cookie", COOKIE).set(DEL_FRONTEND);
    const logoutAll = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    for (const [route, res] of [
      ["POST /api/auth/login", login],
      ["GET /api/auth/me", me],
      ["POST /api/auth/logout", logout],
      ["POST /api/auth/logout-all", logoutAll],
    ] as const) {
      expect(res.headers["access-control-allow-credentials"], route).toBe("true");
      expect(res.headers["access-control-allow-origin"], route).toBe(ORIGIN_NUESTRO);
    }
  });

  it("withholds the matching allow-origin from an origin that is not ours, on the very endpoint that revokes every session", async () => {
    // `logout-all` is the endpoint this whole plan exists to make possible —
    // revocation the old JWT never had. If a hostile origin could read its
    // response, it could confirm a stolen cookie had just killed every one of
    // the victim's live sessions.
    //
    // `cors()` here is configured with a bare `credentials: true` — a single
    // boolean, not a function of the origin — so it stamps
    // `Access-Control-Allow-Credentials: true` on *every* response, this one
    // included, whatever `Origin` asked. That header alone changes nothing:
    // per the Fetch spec, a credentialed cross-origin response is only
    // readable when `Access-Control-Allow-Origin` also names the exact
    // requesting origin, and a wildcard does not count. `allowedOrigins`
    // never puts `evil-osefi.net` in that list, so `cors()` sends no
    // `Access-Control-Allow-Origin` at all for it — and that absence, on its
    // own, is what makes a browser hide the response from the page that
    // asked, whatever status code Express sent underneath.
    const res = await request(app)
      .post("/api/auth/logout-all")
      .set("Cookie", COOKIE)
      .set("Origin", "https://evil-osefi.net")
      .set(CSRF_CLIENT_HEADER, "web");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("the session list", () => {
  it("asks only for the caller's own rows and marks the current one", async () => {
    sesionFindAll.mockResolvedValue([
      {
        dataValues: {
          id: MI_SESION, id_usuario: YO, user_agent: "Chrome", ip_address: "1.2.3.4",
          created_at: new Date(), last_used_at: new Date(),
          expires_at: new Date(Date.now() + 86_400_000), revoked_at: null,
        },
      },
    ] as never);
    const res = await request(app).get("/api/auth/sessions").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    const where = (sesionFindAll.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ id_usuario: YO, revoked_at: null });
    expect(res.body.sesiones[0]).toMatchObject({ id: MI_SESION, actual: true });
    expect(JSON.stringify(res.body)).not.toContain("token_hash");
  });
});

/**
 * Renaming your own account and changing your own password are both gated on
 * your password, they pay out of one bucket, and the bucket charges for exactly
 * one answer: the 401 that says the password was not theirs.
 *
 * Every part of that is a one-line mistake no unit test can see, because none
 * of it is in a handler. The gates themselves are pinned in
 * `usuario.controller.test.ts`; what is pinned here is the mount — that each
 * route really runs behind the budget, that it is one budget and not one each,
 * and which answers cost something.
 *
 * **Why they need a budget at all.** Both handlers compare a password, and a
 * wrong one deliberately does not move `failed_attempts` — so that mistyping
 * while renaming or re-passwording yourself cannot shut you out of the ERP.
 * Without these mounts the routes would compare an unlimited number of
 * passwords for whoever already holds a stolen session.
 *
 * `PUT /usuario/userpass/:id` is the older sin of the two: it has compared
 * `oldPass` since long before this plan, with no bucket anywhere, and its
 * oracle is the cleaner one — a guess sent with a new password that fails the
 * policy comes back 401 when the guess is wrong and 400 when it is right.
 *
 * **And that 400 is why the refund exists.** It is also what somebody is told
 * for typing a new password of eight characters, which is not a guess at
 * anything — the comparison already said yes — so charging for it meant the
 * legitimate work of changing your own password was what emptied the budget,
 * and emptied the rename's with it. See `confirmCostsNothing`.
 */
describe("changing your own credentials spends the budget for a wrong password, and for nothing else", () => {
  const CLAVE_RENOMBRE = `pc:${YO}`;
  const DEMASIADO_CORTA = `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;

  /**
   * express-rate-limit hands a refund back from the response's own `finish`
   * handler, which is asynchronous: supertest resolves before it runs, so
   * without one turn of the event loop every assertion below reads the charge
   * that is about to be given back.
   */
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const gastado = async () =>
    ((await passwordConfirmLimiter.getKey(CLAVE_RENOMBRE)) as { totalHits?: number } | undefined)
      ?.totalHits;

  /**
   * The account row with its password hash on it, which the shared fixture
   * deliberately leaves off.
   *
   * `beforeEach` builds the row `authenticate` asks for — two columns — and both
   * handlers here compare against `dataValues.pass`. Left as it is, every
   * comparison below would run against `undefined` while `bcryptjs.compare` is
   * mocked to say yes, which is the exact family of mistake this file exists to
   * catch.
   */
  const conHash = (extra: Record<string, unknown> = {}) => ({
    dataValues: {
      id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
      name: "Isaias", lastname: "Salas", image: null,
      failed_attempts: 0, locked_until: null, pass_changed_at: PASS_CAMBIADA, ...extra,
    },
  });

  /**
   * The same row, writable the way a Sequelize instance is.
   *
   * Needed only by the tests that assert a change actually went through. The
   * plain object above has no `set`, so a handler that reaches the write answers
   * 500 — which is why the two administrator tests below assert by exclusion
   * instead.
   */
  const escribible = (extra: Record<string, unknown> = {}) => {
    const row = conHash(extra);
    return {
      dataValues: row.dataValues,
      set: (patch: Record<string, unknown>) => Object.assign(row.dataValues, patch),
      save: async () => undefined,
      toJSON: () => ({ ...row.dataValues }),
    };
  };

  /**
   * A `bcryptjs.compare` that says yes to everything except one specific
   * plaintext — the "wrong" one a test is deliberately sending.
   *
   * Needed since the fix round that put `mfa_satisfied_at` back at its real,
   * shipped value (`null`): `requireStepUp`'s own password fallback and
   * `updateUserName`/`updateUserPass`'s own `oldPass` check both end up
   * calling this same globally mocked function, and several tests below need
   * the gate's `stepup_password` to succeed while a *different* string sent
   * as `oldPass` fails. A blanket `mockResolvedValue(false)` cannot express
   * that — it would fail the gate's own check too, and the request would
   * never reach the handler these tests are actually about.
   */
  const soloRechaza = (mala: string) => (plain: unknown) => Promise.resolve(plain !== mala);

  /** `stepup_password`'s value everywhere below it needs to be *correct*
   *  — anything other than whatever a given test names as the wrong one. */
  const STEP_UP_OK = "la-de-verdad";

  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(CLAVE_RENOMBRE);
    await passwordConfirmLimiter.resetKey("pc:99");
    usuarioFindByPk.mockResolvedValue(conHash() as never);
  });

  it("charges the caller's account for a rename whose current password was wrong", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    try {
      const res = await request(app)
        .put(`/api/usuario/username/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas", oldPass: "no-es-la-mia", stepup_password: STEP_UP_OK });
      await settled();

      // Not 404 — the route exists. Not 403 — `requireSelfOrPermission` let an
      // owner through. Not 500 — nothing in the chain threw.
      expect(res.status).toBe(401);
      // The sentence and not the number, imported rather than retyped: 401 is
      // also what `authenticate` answers, and a test reading the status alone
      // would pass for a route whose gate had been deleted and whose cookie had
      // simply stopped working.
      expect(res.body.message).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);

      // The point of this test. `pc:7` is the one key both routes count against,
      // so nobody gets ten attempts a quarter of an hour by alternating the two
      // doors onto one secret.
      expect(await gastado()).toBe(1);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("charges the caller's account for a password change whose current password was wrong", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    usuarioFindOne.mockResolvedValue(conHash() as never);
    try {
      const res = await request(app)
        .put(`/api/usuario/userpass/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ pass: "una-clave-de-prueba", oldPass: "no-es-la-mia", stepup_password: STEP_UP_OK });
      await settled();

      expect(res.status).toBe(401);
      expect(res.body.message).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      expect(await gastado()).toBe(1);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("counts the rename and the password change into one bucket, not one each", async () => {
    // The assertion a second `rateLimit()` call would break, and nothing else
    // would. Each `rateLimit()` builds a store of its own, so a per-route
    // limiter — even one keyed identically — would leave each of these reading
    // one hit, and anybody willing to alternate the two doors onto one secret
    // would get ten attempts a quarter of an hour instead of five.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    usuarioFindOne.mockResolvedValue(conHash() as never);
    try {
      for (const url of [`/api/usuario/username/${YO}`, `/api/usuario/userpass/${YO}`]) {
        const res = await request(app).put(url).set("Cookie", COOKIE).set(DEL_FRONTEND).send({
          user: "isalas",
          pass: "una-clave-de-prueba",
          oldPass: "no-es-la-mia",
          stepup_password: STEP_UP_OK,
        });
        await settled();
        // Both really reached the comparison, so the two hits below are two
        // wrong passwords and not two of anything else.
        expect(res.status, url).toBe(401);
      }

      expect(await gastado()).toBe(2);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("charges nothing for a request aimed at somebody else's account", async () => {
    /**
     * What provides this is `requiresOwnPassword`, and saying so is the whole
     * point of the rewrite.
     *
     * This test used to be called "charges nothing for a request the permission
     * guard already refused", and its comment credited the order of the mount:
     * *"the budget is mounted after the guard on purpose"*. It passed with the
     * two swapped — measured, 811 green — because the budget only charges when
     * the target is the caller and the guard only refuses when it is not. The
     * conditions are exactly complementary, so no response can tell the two
     * orders apart. The order is still deliberate and it is pinned structurally,
     * three tests below.
     *
     * `oldPass` is sent on purpose: a budget that keyed off the body carrying a
     * password rather than off whose account is being changed would charge here.
     */
    const res = await request(app)
      .put("/api/usuario/username/99")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas", oldPass: "la-mia" });
    await settled();

    expect(res.status).toBe(403);
    // Neither the caller's bucket nor the target's.
    expect(await gastado()).toBeUndefined();
    expect(await passwordConfirmLimiter.getKey("pc:99")).toBeUndefined();
  });

  it("demands the password before an administrator renames somebody else, and charges nothing for asking", async () => {
    // Decisión D6 del plan 4C: renombrar otra cuenta pide la contraseña
    // siempre. This used to reach the handler through `requireStepUp`'s
    // factor-less skip and pin a 409 from the name check; now the gate
    // refuses first. What the test still holds, and what it was written for:
    // a missing password is **not** a wrong one, so the shared confirmation
    // budget is not touched — billing a refusal that compared nothing would
    // answer 429 to the sixth piece of legitimate administrative work in a
    // quarter of an hour. `can` is mocked false for the rest of this file;
    // here the caller holds the permission.
    //
    // The mutual exclusion with `chargeConfirmBudgetOnSelfChange` is pinned
    // further down, in the `stepup_password` + `oldPass` test.
    puede = true;
    try {
      const res = await request(app)
        .put("/api/usuario/username/99")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas" });
      await settled();

      expect(res.status).toBe(403);
      // The mirror of the old `not.toBe(403)`: the *right* 403, not any 403.
      expect(res.body).toMatchObject({ code: "STEP_UP_REQUIRED", motivo: "contraseña-requerida" });
      expect(await gastado()).toBeUndefined();
      // Nor did it land in anybody else's bucket, keyed by the target rather
      // than the caller.
      expect(await passwordConfirmLimiter.getKey("pc:99")).toBeUndefined();
    } finally {
      puede = false;
    }
  });

  it("demands the password before an administrator resets somebody else's, and charges nothing for asking", async () => {
    // 🔴 Of the three mounts the plan had left off D6, this is the one that
    // matters most: resetting another account's password is how a stolen
    // administrator cookie takes the account over, and it used to reach the
    // handler on the cookie alone (the old test pinned a 500 from a fixture
    // limit, proving exactly that the mount let it through). Same budget rule
    // as the rename above: asking is free, only a wrong answer costs.
    puede = true;
    try {
      const res = await request(app)
        .put("/api/usuario/userpass/99")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ pass: "una-clave-de-prueba" });
      await settled();

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "STEP_UP_REQUIRED", motivo: "contraseña-requerida" });
      expect(await gastado()).toBeUndefined();
      expect(await passwordConfirmLimiter.getKey("pc:99")).toBeUndefined();
    } finally {
      puede = false;
    }
  });

  it("mounts the permission guard before the budget on both routes", () => {
    /**
     * A structural assertion, and deliberately so — see the long note on
     * `chargeConfirmBudgetOnSelfChange` in `usuario.routes.ts`.
     *
     * The property is real and no response can show it: the guard refuses
     * exactly the requests the budget does not charge for, so both orders answer
     * identically to everything. Writing a request-shaped test for it is how the
     * test three above came to claim the order while `requiresOwnPassword` was
     * doing the work — the fifth assertion in this project to pass against the
     * code it said it protected. Reading the mounted chain says what is actually
     * being held.
     *
     * Worth holding because the day the charge condition widens, this order is
     * the only thing between a stranger and a stranger's allowance. The MFA
     * plan's step-up could easily want an administrator to send `oldPass` when
     * acting on somebody else — and then a budget in front of the guard is a
     * stranger emptying the target's bucket by being refused over and over.
     */
    type Capa = { route?: { path: string; stack: { name: string }[] } };
    const rutas = (usuarioRouter as unknown as { stack: Capa[] }).stack
      .filter((capa) => capa.route)
      .map((capa) => ({ path: capa.route.path, chain: capa.route.stack.map((h) => h.name) }));

    for (const path of ["/username/:id", "/userpass/:id"]) {
      const ruta = rutas.find((r) => r.path === path);
      expect(ruta, `${path} no está montada`).toBeDefined();
      const chain = ruta.chain;
      // Both present first. Without these two, the comparison below passes for a
      // chain missing either name, because `indexOf` answers -1 and -1 is less
      // than everything — which is precisely the shape of assertion this file's
      // header is about.
      expect(chain, path).toContain("requireSelfOrPermissionGate");
      expect(chain, path).toContain("chargeConfirmBudgetOnSelfChange");
      expect(
        chain.indexOf("requireSelfOrPermissionGate"),
        `${path}: ${chain.join(" -> ")}`,
      ).toBeLessThan(chain.indexOf("chargeConfirmBudgetOnSelfChange"));
    }
  });

  it("refunds the rename a cached frontend sends with no current password at all", async () => {
    /**
     * The deploy window this plan is most worried about, and it used to cost the
     * people caught in it their budget.
     *
     * A bundle sitting in somebody's tab from before this arc renames without an
     * `oldPass` field, because the field does not exist in it. Every one of those
     * requests is a 400 it cannot satisfy — and charging for them spent the
     * budget of exactly the people the transition hurts, then took the password
     * change down with it, on the same bucket, for a quarter of an hour.
     *
     * `stepup_password` is supplied so the request clears `requireStepUp`
     * first — a bundle old enough to be missing `oldPass` would also be
     * missing this field and get refused for *free* by the gate before ever
     * reaching the rename's own check, which is a real improvement over what
     * this test originally measured but not the thing it exists to prove.
     * What is under test here is unchanged: a legitimate, non-guessing 400
     * still gets refunded once it does reach `updateUserName`.
     */
    const res = await request(app)
      .put(`/api/usuario/username/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas", stepup_password: STEP_UP_OK });
    await settled();

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(CURRENT_PASSWORD_REQUIRED_MESSAGE);
    // Charged and given back. `0` and not `undefined`: the bucket was touched,
    // which is what proves the route is behind it and that the refund — not a
    // missing mount — is why nothing was spent.
    expect(await gastado()).toBe(0);
  });

  it("refunds a password change that only failed the new password's own policy", async () => {
    // The case the auditor bet the deploy on. Omar changes his own password,
    // types the current one correctly, and picks a new one of eight characters.
    // The server wants twelve. Nothing in that request is a guess: the
    // comparison already said yes, and the answer tells him so.
    usuarioFindOne.mockResolvedValue(conHash() as never);

    const res = await request(app)
      .put(`/api/usuario/userpass/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ pass: "ochochar", oldPass: "la-mia", stepup_password: STEP_UP_OK });
    await settled();

    expect(res.status).toBe(400);
    // The reason, so this cannot be the other 400 on this route — the one for a
    // missing current password, which is the test above.
    expect(res.body.message).toBe(DEMASIADO_CORTA);
    expect(await gastado()).toBe(0);
  });

  it("rotates the session and tells the client the NEW deadline, not the dying one", async () => {
    /**
     * The successful self password change, through the real stack — which
     * nothing drove until now. Every other test on this route asserts a
     * refusal, so the rotation `updateUserPass` performs had no integration
     * coverage at all, and neither did the header it has to leave behind.
     *
     * The bug this pins is a genuine one and it is invisible from a unit test.
     * `authenticate` is the only middleware that writes
     * `SESSION_EXPIRES_HEADER`, it runs *before* the handler, and it computes
     * the deadline from the session this request arrived on — the row the
     * handler is about to revoke. `issueSession` then replaces the cookie. If
     * it does not also replace the header, the response carries the dying
     * session's remaining window beside a cookie good for a week.
     *
     * Twenty-nine days is what makes it visible. The old session is one day
     * from its thirty-day ceiling, so the header `authenticate` wrote says
     * roughly a day; the cookie the rotation hands over is good for seven. The
     * header's contract is that a value means "reschedule on it", so a client
     * would take the day — and log somebody out of a session opened seconds
     * earlier, which is the exact failure `authenticate`'s own comment says
     * this header exists to prevent.
     */
    const creada = new Date(Date.now() - 29 * DIA_MS);
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION,
        id_usuario: YO,
        created_at: creada,
        expires_at: new Date(Date.now() + 5 * DIA_MS),
        last_used_at: new Date(),
        estado: "completa",
        mfa_satisfied_at: null,
      },
    } as never);
    usuarioFindOne.mockResolvedValue(escribible() as never);
    // The one test in this file that means to open a transaction; see the spy's
    // own comment for why the default throws instead.
    transaction.mockImplementation((async (fn: (t: unknown) => Promise<unknown>) =>
      fn({ id: "una-transaccion" })) as never);

    const res = await request(app)
      .put(`/api/usuario/userpass/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ pass: "una-clave-larguisima", oldPass: "la-mia", stepup_password: STEP_UP_OK });
    await settled();

    expect(res.status).toBe(200);

    // A fresh cookie was handed over: the rotation really happened rather than
    // the old session being spared.
    const galletas = (res.headers["set-cookie"] ?? []) as unknown as string[];
    const sesionNueva = galletas.find((c) => c.startsWith("osefi_session="));
    expect(sesionNueva).toBeDefined();

    // And the header describes *that* session. More than six days out is the
    // whole assertion: the dying session could only have produced about one.
    const anunciado = new Date(res.headers[CABECERA_VENCIMIENTO] as string).getTime();
    expect(anunciado - Date.now()).toBeGreaterThan(6 * DIA_MS);

    // Tighter still: the header and the cookie name the same instant. A client
    // reading one and a browser obeying the other must not disagree about when
    // this session dies. `Expires` on a cookie has second resolution, hence the
    // tolerance rather than an equality.
    const expira = /expires=([^;]+)/i.exec(sesionNueva as string)?.[1];
    expect(expira).toBeDefined();
    expect(Math.abs(anunciado - new Date(expira as string).getTime())).toBeLessThan(2000);
  });

  it("never runs out of budget on the password policy, however many times it refuses", async () => {
    /**
     * The premise `PASSWORD_CONFIRM_LIMIT` was calibrated on — "nobody
     * legitimately reaches five in a quarter of an hour" — restored to being
     * true.
     *
     * Reacting to "at least 12 characters" by adding one character at a time is
     * the normal thing for a person to do, and with a charge on every request
     * the sixth try answered "Demasiados intentos. Espere unos minutos" and
     * closed the rename too. Two past the limit here, so a charging bucket would
     * certainly have cut in.
     */
    usuarioFindOne.mockResolvedValue(conHash() as never);

    for (let i = 0; i < PASSWORD_CONFIRM_LIMIT + 2; i++) {
      const res = await request(app)
        .put(`/api/usuario/userpass/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ pass: `corta${i}`, oldPass: "la-mia", stepup_password: STEP_UP_OK });
      await settled();

      // Still the policy talking, never the budget.
      expect(res.status, `intento ${i + 1}`).toBe(400);
      expect(res.body.message, `intento ${i + 1}`).toBe(DEMASIADO_CORTA);
    }

    expect(await gastado()).toBe(0);
  });

  it("runs out on wrong passwords, and then stops answering about the password at all", async () => {
    /**
     * The other side of the refund: the answers that do cost still add up, and
     * the limit still arrives.
     *
     * Somebody who has stolen a session cookie can ask these routes "is the
     * password X?" as often as they will answer, and a wrong answer costs the
     * account nothing by design — no `failed_attempts`, no lockout. So this
     * bucket is the whole of the limit, and it is keyed by account rather than
     * address so that asking from twenty addresses is still one budget.
     *
     * Runs with `mfa_satisfied_at: null` — the shared fixture's real value,
     * matching every session in production today, where nothing writes that
     * column yet. A fix-round review caught an earlier version of this test
     * describing a state that does not exist (the window pre-satisfied), which
     * made `requireStepUp` a no-op and left this arithmetic unwitnessed by
     * anything that actually runs.
     *
     * With the real state restored, each attempt below still charges `pc:7`
     * exactly **once** — from `chargeConfirmBudgetOnSelfChange`'s own
     * `oldPass` check, which is wrong here. `requireStepUp`'s own fallback
     * runs first with the correct `stepup_password` and charges nothing at
     * all: a right answer never calls the real limiter (see
     * `requireStepUp.ts`'s own docstring), so there is no second charge for
     * anything to refund. A fix-round review measured a version of this gate
     * that *did* charge a correct answer and refund it afterwards, and found
     * that the not-yet-refunded charge could inflate the count this same
     * `oldPass` check reads mid-request; that version is gone, and this test
     * is the arithmetic it would have broken.
     */
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("adivinando") as never);
    const attempt = () =>
      request(app)
        .put(`/api/usuario/username/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas", oldPass: "adivinando", stepup_password: STEP_UP_OK });
    try {
      for (let i = 0; i < PASSWORD_CONFIRM_LIMIT; i++) {
        const res = await attempt();
        await settled();
        expect(res.status, `intento ${i + 1}`).toBe(401);
        expect(res.body.message, `intento ${i + 1}`).toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      }

      const cortado = await attempt();
      await settled();
      expect(cortado.status).toBe(429);
      // And the refusal is no longer readable as an answer about the password,
      // which is the property that makes a budget a budget rather than a slower
      // oracle.
      expect(cortado.body.message).not.toBe(CURRENT_PASSWORD_WRONG_MESSAGE);
      expect(cortado.body.message).toMatch(/Demasiados intentos/i);

      // And the 429 does not let the caller straight back in. Since D6 this
      // one comes from the gate's read-only `agotado` branch, which never
      // touches the limiter: nothing is charged and nothing refunded, the
      // counter simply stays at the limit, and the next request meets it
      // again — and files a `critical` STEP_UP_DENIED line while it is there.
      const otro = await attempt();
      await settled();
      expect(otro.status).toBe(429);
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("keeps one budget per account, not one for everybody", async () => {
    // A key generator that ignored `req.user` — or fell back to a constant —
    // would put the whole company in one bucket, and five wrong passwords by one
    // person would close the rename for everyone. The key is read out of the
    // bucket rather than inferred from a second caller's answer, because two
    // accounts cannot easily be signed in at once through this harness.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(soloRechaza("no-es-la-mia") as never);
    try {
      await request(app)
        .put(`/api/usuario/username/${YO}`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "isalas", oldPass: "no-es-la-mia", stepup_password: STEP_UP_OK });
      await settled();

      expect(await gastado()).toBe(1);
      // Nothing landed in an address-shaped bucket, which is what the fallback
      // in `passwordConfirmKey` would have produced had `req.user` not been read.
      expect(await passwordConfirmLimiter.getKey("pc:ip:::ffff:127.0.0.1")).toBeUndefined();
    } finally {
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("lets a locked account rename itself with its own password, which is the ERP it is still working in", async () => {
    /**
     * F1, end to end through the real stack, and the reason it is here rather
     * than only beside `verifyOwnPassword`: the harm was never one function's
     * answer, it was the answer plus the token plus the shared bucket.
     *
     * Somebody who knows Ana's username fails five times on the login form and
     * her account rests for a quarter of an hour. `authenticate` does not read
     * `locked_until` — deliberately — so the session she already had keeps
     * working and she keeps using the ERP. She goes to rename herself and types
     * her password correctly; the shared comparator refused a resting account
     * before comparing anything, so she was told her password was wrong. Five
     * times, one token each, and the sixth answer was a 429 that also closed the
     * password change — the one screen that would have lifted the lockout.
     *
     * So: the rename goes through, and it costs her nothing.
     */
    usuarioFindByPk.mockResolvedValue(
      conHash({
        locked_until: new Date(Date.now() + 60_000),
        failed_attempts: LOCKOUT_AFTER_FAILURES,
      }) as never,
    );
    usuarioFindOne.mockResolvedValue(escribible() as never);

    const res = await request(app)
      .put(`/api/usuario/username/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas", oldPass: "la-mia", stepup_password: STEP_UP_OK });
    await settled();

    // The change itself, not merely "not a 401": a 500 or a 409 would satisfy
    // `not.toBe(401)` while leaving her exactly as stuck.
    expect(res.status).toBe(200);
    expect(res.body.user).toBe("isalas");
    expect(await gastado()).toBe(0);
  });
});

/**
 * `requireStepUp`, on the real routes it is mounted behind.
 *
 * `requireStepUp.test.ts` already proves the gate's own decisions against a
 * hand-built `req`/`res` — every branch, every refusal. What only a real
 * mount can show is the wiring around it: that the permission check truly
 * runs first (a caller without the permission spends no bcrypt comparison
 * and never queries the factor tables), that `PATCH /:id/desbloquear` really
 * has no gate on it, and that the real `factorInventory.js` module — not a
 * stub some other test replaced it with — is what decides whether the
 * password fallback is reachable at all.
 */
describe("requireStepUp, mounted on the real routes", () => {
  const CLAVE_YO = `pc:${YO}`;

  // No per-test session override needed anywhere in this describe block: the
  // shared default already carries `mfa_satisfied_at: null` and no factor
  // registered, which is the real, shipped state. An earlier round gave this
  // block its own `sinFactorReciente()` helper to force that state, back when
  // the shared default claimed a satisfied window instead — once the default
  // was corrected to match reality, the helper became a byte-for-byte
  // restatement of it and was removed rather than kept as dead ceremony.
  //
  // What this block does *not* assert: which routes mount the gate. Every test
  // here goes through a request, and a request cannot tell an unmounted gate
  // from a satisfied one — both answer whatever the handler answers. The
  // mounts are held structurally in `routes/routeGuards.test.ts`, in one
  // table — and the count is that table's business rather than a number
  // restated here. Do not start a second half-table.

  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(CLAVE_YO);
  });

  it("refuses without the permission before ever asking whether a factor exists", async () => {
    // `puede` stays false, the default for this whole file. If requireStepUp
    // ran first, a caller with no factor and no password would see its 403
    // and STEP_UP_REQUIRED instead of the permission's plain refusal — and
    // would have cost a query to the factor tables to get there.
    const res = await request(app)
      .post("/api/usuario")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "nuevo" });

    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe(CODIGO_STEP_UP);
    expect(passkeyCount).not.toHaveBeenCalled();
    expect(totpCount).not.toHaveBeenCalled();
  });

  it("demands the password before a user gets created, even with no factor to prove — decisión D6", async () => {
    /**
     * History, because it explains the shape of this test. A second audit
     * once found that this gate refused *every* gated write, unconditionally,
     * the moment it shipped: `web/src` did not send `stepup_password` yet, so
     * the fallback always read an absent field and always refused. This test
     * was the pin against that outage — "no factor, no password, let
     * through". Plan 4D then taught the client to answer the gate, and plan
     * 4C's decision D6 turned the password on for accounts, roles and the
     * permission matrix on purpose. So the same request is refused again —
     * but now with a `motivo` the client knows how to answer, which is the
     * difference between this and the outage: the mirror assertion below is
     * what says so.
     */
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "STEP_UP_REQUIRED", motivo: "contraseña-requerida" });
    } finally {
      puede = false;
    }
  });

  it("lets the same request through once the caller's own current password is supplied too", async () => {
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo", stepup_password: "la-de-verdad" });

      // Same 409, same reason as the no-password test above — sending a
      // correct password on top changes nothing about what createUsuario
      // itself does with an incomplete body.
      expect(res.status).toBe(409);
    } finally {
      puede = false;
    }
  });

  it("still refuses a wrong password, even though the account has no factor to fall back on", async () => {
    // `bcryptjs.compare` defaults to "yes" for this whole file (every login
    // test sends a real-looking password and expects it accepted), so a
    // guess only reads as wrong here if the mock is told to say so for it
    // specifically.
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(
      (async (plain: string) => plain !== "no-es-la-mia") as never,
    );
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo", stepup_password: "no-es-la-mia" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
      // And it costs the real, shared budget — not the free skip a missing
      // password gets.
      expect(await passwordConfirmLimiter.getKey(CLAVE_YO)).toEqual(
        expect.objectContaining({ totalHits: 1 }),
      );
    } finally {
      puede = false;
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("refuses the password once the real factorInventory module reports one", async () => {
    // The real module, not a mock of it: this is what proves the mount reads
    // the genuine `tieneAlgunFactor`, not a stand-in some other file left
    // behind.
    passkeyCount.mockResolvedValue(1);
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo", stepup_password: "la-de-verdad" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
    } finally {
      puede = false;
    }
  });

  it("closes the skip on its own: the same no-password request that just succeeded is refused once a factor exists", async () => {
    // The assertion the corrected rule exists to make provable, not merely
    // arguable: nothing is flipped by hand between this test and the one
    // above it letting the identical body through. The only difference is
    // what the real `factorInventory` module reports.
    passkeyCount.mockResolvedValue(1);
    puede = true;
    try {
      const res = await request(app)
        .post("/api/usuario")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ user: "nuevo" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
    } finally {
      puede = false;
    }
  });

  it("gates PATCH /:id/desbloquear too, once there is a factor to prove", async () => {
    /**
     * This route used to be the deliberate exception, and this test used to
     * pin it as one. What changed is not the convenience argument — lifting a
     * lockout really is what an administrator does in a hurry — but the claim
     * underneath it: that whoever holds `seguridad.editar` "can already do
     * worse through the routes above". From plan 4B's first registered
     * factor those routes refuse a session that has not proved one, and this
     * one would have gone on answering 200 while clearing `failed_attempts`
     * and `locked_until` — the login lockout, and the only brake against
     * password guessing that lives in the database rather than in a rate
     * limiter's in-memory window.
     *
     * `passkeyCount` at 1 is the real `factorInventory` module answering that
     * question, so this is 4B's condition reached today rather than a stub of
     * the gate. Without the mount the request reaches `desbloquearUsuario`
     * and answers 500 — the default fixture has no `.set`, so its write
     * throws — which is what this assertion is measured against.
     */
    passkeyCount.mockResolvedValue(1);
    puede = true;
    try {
      const res = await request(app)
        .patch(`/api/usuario/${YO}/desbloquear`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
    } finally {
      puede = false;
    }
  });

  it("now refuses to lift a lockout without the password, even with no factor anywhere", async () => {
    // 🔴 **Este test afirmaba lo contrario, y su razonamiento era el agujero.**
    //
    // Decía: «con nada registrado en ninguna parte —el estado real de hoy— la
    // tercera rama de la puerta deja pasar la petición intacta, así que un
    // administrador con prisa no teclea nada extra». Verdadero como
    // descripción, y equivocado como decisión.
    //
    // Lo que la auditoría de cierre midió: **hoy, con 0 de 9 cuentas con
    // factor**, `tieneAlgunFactor` del administrador es `false`, así que esa
    // rama significa que **una cookie de administrador robada desbloquea
    // cualquier cuenta sin contraseña**. Y en su ruta hermana —
    // `POST /usuario/:id/mfa/reset`, que borra las tres tablas de factores de
    // otra persona y revoca todas sus sesiones— significa borrar el segundo
    // factor de toda la plantilla en nueve peticiones.
    //
    // La regla estaba escrita desde el principio, en el docstring de la propia
    // opción: «every route that registers or **removes** a credential must be
    // mounted with it on. It is not a hardening knob to turn on later». La
    // comodidad del administrador con prisa no la vence.
    puede = true;
    try {
      const res = await request(app)
        .patch(`/api/usuario/${YO}/desbloquear`)
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
      // Y no por el motivo genérico: el cliente necesita saber que lo que
      // falta es la contraseña, no un factor que esta cuenta no tiene.
      expect(res.body.motivo).toBe("contraseña-requerida");
      // La otra mitad, y es la que prueba que se cerró de verdad: ya no se
      // escribe la línea que decía «una escritura sensible pasó sin la prueba
      // extra». No pasó nada.
      expect(logAction).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "STEP_UP_SKIPPED" }),
      );
    } finally {
      puede = false;
    }
  });
  it("applies the same corrected rule to the permission matrix: no factor, no password, let through", async () => {
    // `/3` and not `/2`: `MI_ROL` is 2, and `putPermisos` refuses a caller
    // editing its own role (409) before it ever reads the body — a
    // collision this test does not want, since what it is proving is that
    // the gate let the request reach the handler at all.
    puede = true;
    try {
      const res = await request(app)
        .put("/api/permisos/3")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({});

      // Decisión D6: the matrix demands the password now, before
      // `changesFrom({})` ever gets to say "No hay nada que guardar." — the
      // 400 this test used to pin arrives only after the password is typed.
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "STEP_UP_REQUIRED", motivo: "contraseña-requerida" });
    } finally {
      puede = false;
    }
  });

  it("still gates the permission matrix against a wrong password", async () => {
    const bcryptjs = (await import("bcryptjs")).default;
    vi.mocked(bcryptjs.compare).mockImplementation(
      (async (plain: string) => plain !== "no-es-la-mia") as never,
    );
    puede = true;
    try {
      const res = await request(app)
        .put("/api/permisos/3")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND)
        .send({ stepup_password: "no-es-la-mia" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODIGO_STEP_UP);
    } finally {
      puede = false;
      vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
    }
  });

  it("survives confirming the same password twice in one request — this gate's own check, then the rename's own — without crashing or leaving a charge behind", async () => {
    /**
     * A self-rename on `/username/:id`, with no factor registered and an
     * unsatisfied window, asks for the caller's password twice in one
     * request: once for this gate's own fallback, once for `updateUserName`'s
     * own `oldPass` check, both against the same `pc:7` key. Measured,
     * though: only **one** real charge is ever made here. This gate's own
     * check is correct, and a correct answer never calls the real limiter at
     * all (see `requireStepUp.ts`'s own docstring) — there is nothing for it
     * to charge or refund. The one charge that does happen is
     * `chargeConfirmBudgetOnSelfChange`'s, for `oldPass`, and it refunds
     * because `oldPass` is correct too. What this proves is narrower than
     * "two charges, both given back": it is that asking the same key about
     * the same secret from two call sites in one request does not crash and
     * leaves the budget exactly where it started.
     */
    usuarioFindOne.mockResolvedValue({
      dataValues: {
        id: YO, id_rol: MI_ROL, user: "isaias", pass: "$2a$12$hash",
        name: "Isaias", lastname: "Salas", image: null,
      },
      set(patch: Record<string, unknown>) {
        Object.assign(this.dataValues, patch);
      },
      save: async () => undefined,
      toJSON() {
        return { ...this.dataValues };
      },
    } as never);

    const res = await request(app)
      .put(`/api/usuario/username/${YO}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ user: "isalas-dos-veces", stepup_password: "la-de-verdad", oldPass: "la-de-verdad" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(await passwordConfirmLimiter.getKey(CLAVE_YO)).toEqual(
      expect.objectContaining({ totalHits: 0 }),
    );
  });

  /**
   * DELETE routes are gated too, and until now nothing exercised one — every
   * `DELETE` this file or `requireStepUp.test.ts` sent went to
   * `/api/auth/sessions/*`, which carries no gate at all. That gap mattered
   * for a specific reason: Express only parses a request body when the
   * client sends a `Content-Type` it recognises, and a body-less
   * `axios.delete(url)` — the shape the current frontend actually sends —
   * never triggers that parser. Whether `requireStepUp` can read
   * `stepup_password` off a DELETE at all was, until these three tests, an
   * article of faith rather than something measured — and the frontend
   * being built against this gate is about to send exactly that shape.
   *
   * `DELETE /api/rol/:id`, not `/api/usuario/:id` — both carry the gate, but
   * `deleteUsuario` opens a real `sequelize.transaction()` around a real
   * `UsuarioModel.destroy()`, neither of which this file mocks, and a fix
   * round measured that combination committing a genuine soft-delete against
   * the configured database (a copy of production), with only the target id
   * not existing standing between that and a real account. `deleteRol` opens
   * no transaction and touches only `RolModel.findOne` and
   * `UsuarioModel.count`, both spied above — so what is under test here is
   * `requireStepUp`'s own body-reading, unconnected to which controller
   * happens to sit behind it.
   *
   * That move was right and it cost something, said plainly because it went
   * unnoticed for a round: while these three sent their DELETEs to
   * `/api/usuario/:id`, they were the only thing in the suite that would
   * notice `requireStepUp()` disappearing from that route. Afterwards the gate
   * could be deleted from `usuario.routes.ts` with the whole suite still green.
   * Mount coverage is not this trio's job and never should have been: it now
   * lives in `routes/routeGuards.test.ts`, which pins every gated route
   * against the app Express actually assembled.
   *
   * `id: 99` is this file's own established stand-in for "a row that is not
   * `YO`'s" — see the rename/reset tests above, which already target it the
   * same way; `rolFindOne`'s default mock above answers it as a real,
   * archivable role rather than a 404, which is what lets these reach the
   * gate at all.
   */
  describe("on DELETE, where a body only exists if Content-Type says so", () => {
    it("reads nothing out of a body-less DELETE and refuses it properly, not with a crash", async () => {
      // Decisión D6: `DELETE /api/rol/:id` demands the password now, so a
      // body-less request is refused. What this still proves is the thing
      // the describe is named for — with no Content-Type there is no
      // `req.body` at all, and the gate has to read the absent field as
      // "not sent" rather than throw on `undefined[...]`. A crash here is a
      // 500; the right answer is the 403 the client knows how to turn into a
      // password prompt.
      puede = true;
      try {
        const res = await request(app)
          .delete("/api/rol/99")
          .set("Cookie", COOKIE)
          .set(DEL_FRONTEND);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: "STEP_UP_REQUIRED", motivo: "contraseña-requerida" });
        expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "STEP_UP_SKIPPED" }));
      } finally {
        puede = false;
      }
    });

    // 🔴 The only live-mount witness of the factor-less skip left after D6.
    // `requireStepUp.ts`'s own docstring says a gate nothing can satisfy is an
    // outage, and that branch — no factor, no password demanded, let through
    // with a `STEP_UP_SKIPPED` line — is what stops that. It used to be
    // proved through `DELETE /api/rol/:id`; D6 moved that route onto the
    // password, so the witness moves to the one body-less mount that still
    // takes the plain gate. Delete this and the branch has no mounted proof.
    it("still lets a body-less DELETE through where the route asks for no password: closing another session", async () => {
      const res = await request(app)
        .delete("/api/auth/sessions/99")
        .set("Cookie", COOKIE)
        .set(DEL_FRONTEND);

      // Pinned at the measured answer, not merely `not.toBe(403)`: `endSession`
      // answers 404 for a session id that is not the caller's, which is what
      // proves the gate called on rather than refusing — a 500 from a crash
      // after the gate would have passed the weaker assertion too.
      expect(res.status).toBe(404);
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: "STEP_UP_SKIPPED" }));
    });

    it("reads stepup_password out of a DELETE body once Content-Type says to parse one", async () => {
      // What this one holds, measured by mutating the gate three ways and
      // reading which of the trio went red — not argued from the shape of the
      // code, which is how the sentence that used to stand here came to be
      // false in both directions at once.
      //
      //   `req.body` → `req.query` in `requireStepUp.ts`: this test *and* the
      //   wrong-password one below go red; the body-less one above stays
      //   green. So this is not the only guard against the field being read
      //   out of the wrong place — the old comment claimed it was the only one
      //   that would *not* fail, which is neither true nor what it meant.
      //
      //   `requireStepUp()` deleted from `DELETE /api/rol/:id`: the other two
      //   go red and this one stays green. It cannot see the mount at all, and
      //   that is the honest reason it looks redundant next to them. The mount
      //   itself is pinned structurally, for every gated route at once, in
      //   `routes/routeGuards.test.ts`.
      //
      //   a correct password stops opening the gate (`confirmacion.ok`
      //   defeated): this is the only one of the three that goes red, and it
      //   is why the test is kept. The one below proves a *wrong* password is
      //   refused — which a gate that refused every password would satisfy
      //   just as well.
      //
      // The "reads the budget"/"charges on wrong"/"never charges on right"
      // behaviours are pinned at the unit level in `requireStepUp.test.ts` and
      // are not what this trio adds.
      puede = true;
      try {
        const res = await request(app)
          .delete("/api/rol/99")
          .set("Cookie", COOKIE)
          .set(DEL_FRONTEND)
          .send({ stepup_password: "la-de-verdad" });

        expect(res.status).toBe(200);
        // The discriminator this test exists for: a 200 here is ambiguous by
        // itself — it is also what a gate that silently failed to read the
        // body at all would answer, by falling through to the same skip the
        // test above exercises on purpose. Asserting the skip did *not* fire
        // is what proves this 200 came from a verified password instead.
        expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "STEP_UP_SKIPPED" }));
      } finally {
        puede = false;
      }
    });

    it("refuses and charges a wrong stepup_password sent on a DELETE", async () => {
      const bcryptjs = (await import("bcryptjs")).default;
      vi.mocked(bcryptjs.compare).mockImplementation(
        (async (plain: string) => plain !== "no-es-la-mia") as never,
      );
      puede = true;
      try {
        const res = await request(app)
          .delete("/api/rol/99")
          .set("Cookie", COOKIE)
          .set(DEL_FRONTEND)
          .send({ stepup_password: "no-es-la-mia" });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe(CODIGO_STEP_UP);
        expect(await passwordConfirmLimiter.getKey(CLAVE_YO)).toEqual(
          expect.objectContaining({ totalHits: 1 }),
        );
      } finally {
        puede = false;
        vi.mocked(bcryptjs.compare).mockResolvedValue(true as never);
      }
    });
  });
});

describe("what a database outage costs the office's login budget", () => {
  /**
   * One address for these two, and not the loopback the rest of this file
   * arrives on, so the counters read below belong to these requests alone.
   * `app.ts` sets `trust proxy` to one hop, which is what makes
   * `X-Forwarded-For` the address the buckets key on.
   */
  const DESDE = "198.51.100.7";
  const CLAVE_IP = `ip:${DESDE}`;
  const claveCuenta = (user: string) => `ipu:${DESDE}:${user}`;

  /**
   * express-rate-limit refunds from the response's own `finish` handler, which
   * is asynchronous: without one turn of the event loop these assertions read
   * the counter mid-flight.
   */
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const hits = async (limiter: { getKey: (k: string) => unknown }, key: string) =>
    ((await limiter.getKey(key)) as { totalHits?: number } | undefined)?.totalHits;

  beforeEach(async () => {
    await loginIpLimiter.resetKey(CLAVE_IP);
  });

  it("spends nothing on the old door's 503, on the real mount", async () => {
    // The two halves joined: `loginLimiters.test.ts` proves a 5xx is refunded
    // and `login.session.test.ts` proves this failure answers 503, but only
    // this goes through the mount in `app.ts` with a real session store on top
    // of a broken table, which is the shape the outage actually has.
    //
    // What it is guarding against is a cascade, not a wrong number. Behind the
    // office's NAT this key is the whole building, so before the refund fifteen
    // people retrying — which the message tells them to do — reached the
    // hundred, and then nobody could log in until the quarter-hour window
    // expired, with the database already back.
    await loginAccountIpLimiter.resetKey(claveCuenta("isaias"));
    sesionCreate.mockRejectedValue(new Error("pool agotado"));

    const res = await request(app)
      .post("/api/login")
      .set("X-Forwarded-For", DESDE)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    await settled();

    expect(res.status).toBe(503);
    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(0);
    expect(await hits(loginAccountIpLimiter, claveCuenta("isaias"))).toBe(0);
  });

  it("spends nothing on the new address either, which answers the same 503", async () => {
    // The same outage on `POST /api/auth/login`. Both addresses share one pair
    // of buckets — `auth.routes.ts` mounts the very same middleware — so a rule
    // that covered only one of them would have left the other charging for
    // outages.
    //
    // They also answer the same status now, which they did not before this
    // task: this address gave 500, because `handler()` turned the rejection
    // into one, and the old address gave 503 from a catch of its own. Merging
    // the two onto one handler kept the 503. Asserting it *here*, on the real
    // mount, is what makes the refund rule and the status one fact rather than
    // two that happen to agree.
    await loginAccountIpLimiter.resetKey(claveCuenta("isaias"));
    sesionCreate.mockRejectedValue(new Error("pool agotado"));

    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", DESDE)
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    await settled();

    expect(res.status).toBe(503);
    expect(await hits(loginIpLimiter, CLAVE_IP)).toBe(0);
    expect(await hits(loginAccountIpLimiter, claveCuenta("isaias"))).toBe(0);
  });

  // The other direction — that exempting this server's failures did not make a
  // guess cheaper — is pinned in `loginLimiters.test.ts` and not here: over the
  // whole 4xx range on `costsNothing` itself, and on the real mount by "puts a
  // POST through both buckets", which uses an empty password so it is refused
  // before anything is looked up. The version of that test which belonged here
  // reached the wrong-password branch of `verifyCredentials`, and that branch
  // calls `UsuarioModel.increment` — not one of the four query methods this file
  // replaces, so it really did send an UPDATE to whatever `.env` points at.
});

/**
 * The two reads the old front door left behind, and why the assertion is 404.
 *
 * `GET /api/login` verified a signed JWT off the `Authorization` header and
 * answered with the account's role and permissions — a second copy of what
 * `authenticate` does, with no session row behind it and nothing that could
 * revoke it. `GET /api/permisos/mias` answered with the caller's own permission
 * matrix. Both were replaced by `GET /api/auth/me`, which sends the account and
 * the matrix in one answer off the session cookie, and `web` stopped calling
 * either of them two plans ago.
 *
 * **404 and not 401, and the difference is the whole point.** A 401 says "I do
 * not know who you are", which invites a caller to try again with a better
 * credential; a 404 says "there is nothing at this address", which is the truth.
 * Getting that wrong is not hypothetical here: `authenticate` is mounted in
 * front of `permisoRoutes` in `app.ts`, so an *anonymous* request to
 * `/api/permisos/mias` answers 401 whether the route exists or not — a test
 * written without a credential would have passed identically before and after
 * the removal and asserted nothing at all.
 *
 * So both requests below carry a working session cookie, and each is paired
 * with a live address on the very same mount. Through `supertest` rather than by
 * calling a handler, because there is no handler left to call: what is under
 * test is the routing table, and the only thing that can see a routing table is
 * a request.
 */
describe("the addresses this arc retired", () => {
  it("has nothing at POST /api/auth/confirm-password, on a router that still serves five", async () => {
    /**
     * The endpoint that replaced "call the login and see if it works", retired
     * in turn because asking *before* an operation is the wrong shape: the
     * credential that authorises a write belongs in the request that performs
     * it, which is the rule the rename and the password change both follow. See
     * `auth.routes.ts`.
     *
     * A cookie is carried on purpose, for the reason the `permisos/mias` test
     * below spells out: `authenticate` is declared on every other route of this
     * router, so an anonymous request here could answer 401 whether the route
     * exists or not, and a 404 asserted without a credential would prove
     * nothing.
     */
    const res = await request(app)
      .post("/api/auth/confirm-password")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ pass: "una-clave-de-prueba" });
    expect(res.status).toBe(404);

    // The credential was good, so the 404 above cannot be read as a refusal.
    const me = await request(app).get("/api/auth/me").set("Cookie", COOKIE);
    expect(me.status).toBe(200);

    // And the router is still mounted. Without this the test would pass just as
    // well for somebody deleting `app.use("/api/auth", ...)` outright, which
    // would take the session cookie's own door down with it.
    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);
    expect(logout.status).toBe(200);
  });


  it("has nothing at GET /api/login, on a mount that still serves POST", async () => {
    const res = await request(app).get("/api/login").set("Cookie", COOKIE);
    expect(res.status).toBe(404);

    // `not.toBe(401)` is deliberately *not* written beside that line: `toBe(404)`
    // already excludes every other status, so a second assertion there could
    // never fail on its own and would only look like extra cover. What 401 needs
    // instead is a case that can really produce one, which is the two below.

    // The credential was good, so the 404 above cannot be read as a refusal.
    const me = await request(app).get("/api/auth/me").set("Cookie", COOKIE);
    expect(me.status).toBe(200);

    // And the mount is still there. Without this the test would also pass if
    // somebody deleted `app.use("/api/login", ...)` outright, which would take
    // `POST /api/login` down with it — the address a cached bundle still logs in
    // through, and the reason that one was kept when this one went.
    const post = await request(app)
      .post("/api/login")
      .send({ user: "isaias", pass: "una-clave-de-prueba" });
    expect(post.status).toBe(200);
  });

  it("has nothing at GET /api/permisos/mias, and 401 there without a cookie", async () => {
    const res = await request(app).get("/api/permisos/mias").set("Cookie", COOKIE);
    expect(res.status).toBe(404);

    // The half that makes the line above mean anything, and the reason this test
    // carries a cookie at all. `authenticate` is mounted in front of
    // `permisoRoutes` in `app.ts`, so an anonymous request to this path answers
    // 401 whether the route exists or not — measured, not assumed: a version of
    // this test written without a cookie asserted 404 and got 401, and would
    // have gone green identically before and after the removal. Asserting the
    // 401 keeps that premise from being quietly withdrawn: take `authenticate`
    // off that mount and this line fails, and the 404 above stops proving what
    // it claims to.
    const anonima = await request(app).get("/api/permisos/mias");
    expect(anonima.status).toBe(401);

    // The sibling read on the same router, with the same cookie: 403, because
    // `can` is mocked false in this file and the route asks for `roles.ver`. That
    // is what separates "this address is gone" from "this whole router stopped
    // being mounted", which would answer 404 here too.
    const matriz = await request(app).get("/api/permisos/").set("Cookie", COOKIE);
    expect(matriz.status).toBe(403);
  });
});

/**
 * Task 4's two routes, through the real mount.
 *
 * Scope is deliberately narrower than the rest of this file: see the comment
 * on `usuarioUpdate`/`tokenUsoUnicoUpdate` above for why `/email/send`'s own
 * happy path — which opens a real `sequelize.transaction()` — is not
 * exercised here at all. What this section proves instead is the mounting
 * and the gating (both routes really sit behind `authenticate`, in the real
 * Express stack, not just in a hand-built `req`), the real body-parser's
 * shape per Global Constraint #13, and — for `/email/verify` specifically,
 * whose design never opens a transaction — a real round trip through the
 * real `tokenStore.js`.
 */
describe("email verification, through the real stack", () => {
  /**
   * `POST /email/send` now sits behind `passwordConfirmLimiter` too (Ronda
   * de arreglo 2) — the same shared `pc:7` bucket `usuario.routes.ts` mounts
   * on the rename and the password change, deliberately, since it is the
   * same secret being confirmed for the same account. That bucket is a
   * module-level store with no reset between describe blocks, and the tests
   * in "changing your own credentials..." above happen to leave it at 0 by
   * the time their block ends — but only because their own last test
   * confirms a *correct* password, which is refunded. That is incidental to
   * their ordering, not a guarantee this block should lean on, so it is
   * reset here explicitly.
   */
  beforeEach(async () => {
    await passwordConfirmLimiter.resetKey(`pc:${YO}`);
  });

  it("mounts both routes, and refuses both without a cookie", async () => {
    const send = await request(app).post("/api/auth/email/send").send({ email: "a@osefi.net" });
    const verify = await request(app).post("/api/auth/email/verify").send({ token: "x" });

    expect(send.status).toBe(401);
    expect(verify.status).toBe(401);
  });

  it("answers 400, not 500, for a POST with no body at all — Global Constraint #13", async () => {
    // With a cookie, so the 400 cannot be mistaken for the 401 the two tests
    // above already cover.
    const send = await request(app).post("/api/auth/email/send").set("Cookie", COOKIE).set(DEL_FRONTEND);
    const verify = await request(app).post("/api/auth/email/verify").set("Cookie", COOKIE).set(DEL_FRONTEND);

    expect(send.status).toBe(400);
    expect(verify.status).toBe(400);
    // Neither reached a write: the validation refused before either handler's
    // first database call.
    expect(usuarioUpdate).not.toHaveBeenCalled();
    expect(tokenUsoUnicoUpdate).not.toHaveBeenCalled();
  });

  it("gets past the email check and still refuses with no password, through the real mount", async () => {
    // Unlike the "no body at all" test above, `email` really is present and
    // valid here — this is a step deeper into the handler, past the point
    // that test exercises. What this pins is that `passwordConfirmLimiter`,
    // freshly mounted on this route, really calls `next()` for a fresh
    // account rather than answering 429 or 500 on its own, so the 400 seen
    // is the handler's own "no password sent" and not the limiter
    // misbehaving. A password-bearing happy path is still not exercised
    // here — see the comment on `usuarioUpdate`/`tokenUsoUnicoUpdate` above
    // for why `/email/send`'s own transaction keeps that out of this file's
    // scope.
    const res = await request(app)
      .post("/api/auth/email/send")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ email: "a@osefi.net" });

    expect(res.status).toBe(400);
    expect(usuarioUpdate).not.toHaveBeenCalled();
  });

  it("stops taking a password for this address once the account has a factor", async () => {
    /**
     * The reason this route needed the gate, given that its handler already
     * demands the current password.
     *
     * The handler's check is a password check and will always be one. The
     * gate's second branch is the rule that a password stops being an
     * acceptable answer at all once there is a factor to prove — the whole
     * design's step-up list, and this route is on it ("cambiar el email
     * propio"). Without the mount, the request below reaches the handler,
     * the password is correct, and the address is changed by whoever holds
     * the cookie and the password but no factor: the account-takeover chain
     * this handler's own comment says it exists to break, re-opened by plan
     * 4B rather than closed by it.
     *
     * `passkeyCount` at 1 is the real `factorInventory` module answering
     * "this account has a factor" — the same lever plan 4B will pull for
     * real, not a stub of the gate.
     */
    passkeyCount.mockResolvedValue(1);

    const res = await request(app)
      .post("/api/auth/email/send")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ email: "a@osefi.net", pass: "la-de-verdad" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(CODIGO_STEP_UP);
    // Refused in front of the handler, not by it: no write, and the address
    // never reached `sendVerificationEmail` at all.
    expect(usuarioUpdate).not.toHaveBeenCalled();
  });

  it("answers the generic message, through the real tokenStore, for a token that does not redeem", async () => {
    // `tokenUsoUnicoUpdate` defaults to `[0, []]` — no row matched, which is
    // exactly what a made-up token looks like against the real `consumirToken`.
    const res = await request(app)
      .post("/api/auth/email/verify")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ token: "un-token-inventado" });

    expect(res.status).toBe(400);
    expect(usuarioUpdate).not.toHaveBeenCalled();
  });

  it("verifies the token's own account for real, through the real tokenStore and the real model", async () => {
    // The one happy path in this section that is safe to run for real:
    // `verifyEmail` never opens a transaction (see `email.controller.ts`), so
    // `consumirToken`'s single `TokenUsoUnicoModel.update` — spied, not the
    // real query — is the only write this whole request makes before this
    // test's own `usuarioUpdate` spy takes the second one.
    tokenUsoUnicoUpdate.mockResolvedValue([
      1,
      [{ dataValues: { id_usuario: YO, email_destino: "isaias@osefi.net" } }],
    ] as never);
    usuarioFindByPk.mockResolvedValue({
      dataValues: { id: YO, id_rol: MI_ROL, email: "isaias@osefi.net", pass_changed_at: PASS_CAMBIADA },
    } as never);

    const res = await request(app)
      .post("/api/auth/email/verify")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ token: "un-token-valido" });

    expect(res.status).toBe(200);
    const [values, options] = usuarioUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { where: Record<string, unknown> },
    ];
    expect(values.email_verified_at).toBeInstanceOf(Date);
    expect(options.where).toEqual({ id: YO });
  });
});

describe("the fourteen-day deadline, against a session that was already open", () => {
  // The hole this block exists to close, and the reason it is here rather than
  // only in `middleware/authenticate.test.ts`.
  //
  // `estado` used to be decided once, at login, and written into the session
  // row; `authenticate` read it from there for the rest of that session's life.
  // Nothing rewrote it and nothing revoked sessions when `mfa_grace_until`
  // passed. So somebody who logged in on day 13 of their grace period was still
  // `completa` on day 15 — and because a session in use keeps having its idle
  // expiry pushed back, that session, and a cookie stolen from it, kept the whole
  // ERP right up to the absolute ceiling: `SESSION_ABSOLUTE_DAYS` from the day it
  // was opened, which for one opened inside the grace period lands a fortnight to
  // a month past the deadline, on an account with no factor at all. The state
  // machine existed to impose a date, and the date was imposed on nobody who was
  // already logged in.
  //
  // Every other test in this file runs on the shared fixture, whose session is
  // `completa` — the one state where the gate in `authenticate` does nothing.
  // So the 403 had never been exercised against the assembled application at
  // all: not the mounted `authenticate`, not the real `sessionState.js`
  // allowlist, not a real router. That is what this block does, in through
  // `supertest` like the rest of the file.

  /** Yesterday: this account's fourteen days are over. */
  const VENCIDO = new Date(Date.now() - DIA_MS);
  /** Tomorrow: still inside the grace period. */
  const POR_VENCER = new Date(Date.now() + DIA_MS);
  /** Opened three days ago, i.e. before `VENCIDO`: a session the deadline is about. */
  const ABIERTA_ANTES = new Date(Date.now() - 3 * DIA_MS);

  /**
   * The account as `currentUser` reads it, with the deadline each test needs.
   *
   * **Four fields fewer than the shared fixture in `beforeEach`, not one more.**
   * That one carries `user`, `name`, `lastname` and `image` as well, which
   * `currentUser`'s projection never asks for and nothing in this block reads.
   * What it does *not* carry is `mfa_grace_until` — absent there means "the
   * clock never started", which is why none of the other 66 tests in this file
   * notice this rule at all.
   */
  const conPlazo = (mfa_grace_until: Date | null) => {
    usuarioFindByPk.mockResolvedValue({
      dataValues: { id: YO, id_rol: MI_ROL, pass_changed_at: PASS_CAMBIADA, mfa_grace_until },
    } as never);
  };

  /**
   * The session row, opened before the deadline unless a test says otherwise.
   *
   * The shared fixture opens its session *now*, which under this rule is a
   * session the deadline cannot be about — a `completa` row created after its
   * own deadline can only have been promoted there by something that verified a
   * factor. So the block sets its own `created_at`, and that is not fixture
   * decoration: it is the difference between the case this rule refuses and the
   * case it must not.
   */
  const sesionAbierta = (extra: Record<string, unknown> = {}) => {
    sesionFindOne.mockResolvedValue({
      dataValues: {
        id: MI_SESION,
        id_usuario: YO,
        created_at: ABIERTA_ANTES,
        expires_at: SESION_EXPIRA_FILA,
        last_used_at: new Date(),
        estado: "completa",
        mfa_satisfied_at: null,
        mfa_source: null,
        ...extra,
      },
    } as never);
  };

  beforeEach(() => {
    sesionAbierta();
    conPlazo(VENCIDO);
  });

  it("refuses the ERP to a complete session whose grace period ran out mid-session", async () => {
    // The session row says `completa`, exactly as the login wrote it before the
    // deadline arrived. Nothing has revoked it and nothing has rewritten it —
    // which is the whole point. The refusal has to come from re-reading the
    // account's deadline on this request.
    //
    // `GET /api/usuario/:id` with the caller's own id, deliberately: the
    // permission gate on that route is `requireSelfOrPermission`, so it lets
    // the caller through on their own row without needing a permission this
    // file's `can` mock refuses. Before this rule existed the request answered
    // **200 with the account's row** — an ERP read, served past the deadline.
    const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

    expect(res.status).toBe(403);
    // The sentence, not just the number: see `MENSAJE_FACTOR_PENDIENTE`'s
    // import above. A 403 from the permission gate would carry a different one.
    // El `code` viaja con la frase desde el plan 4D, tarea 9: es lo único que
    // permite al cliente reconocer esta negativa sin comparar el texto en
    // español, y por tanto decir «configura tu segundo factor» con un enlace
    // en vez del «no se pudo» genérico que enseñaba antes.
    //
    // 🔴 Esta afirmación vive en dos ficheros —aquí y en
    // `authenticate.test.ts`— y actualizar sólo uno es exactamente el fallo
    // que dejó este test en rojo al añadir el campo. Si tocas uno, busca el otro.
    expect(res.body).toEqual({
      message: MENSAJE_FACTOR_PENDIENTE,
      code: CODIGO_FACTOR_PENDIENTE,
    });
    // And it stopped inside `authenticate`, before the controller read
    // anything: `searchUsuario`'s own `UsuarioModel.findOne` never ran.
    expect(usuarioFindOne).not.toHaveBeenCalled();
  });

  it("gives it 403 and not 401, so the setup screen stays reachable", async () => {
    // The distinction the frontend acts on. A 401 ends the session and sends
    // somebody back to a login they have already passed — and passing it again
    // lands them in the same place, which is a loop with no way out. A 403
    // keeps them inside the application, where the screen that finishes their
    // setup is. Asserted apart from the test above because the number is a
    // contract with the client, not an implementation detail of the refusal.
    const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(403);
  });

  it("leaves the doors that finish the setup open to that same session", async () => {
    // The other half, and the reason the answer is a narrower state rather than
    // a dead session: `ONBOARDING_EXTRA` in `sessionState.ts` opens
    // `/api/auth/email`, and this request has to get past `authenticate` and
    // reach the handler — which then answers 400 for the password it was not
    // given, its own business. What matters here is that the 400 is the
    // handler's and not `authenticate`'s 403: a rule that closed everything
    // would leave the account with no way out of onboarding from inside the API.
    const res = await request(app)
      .post("/api/auth/email/send")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ email: "a@osefi.net" });

    expect(res.status).toBe(400);
  });

  it("keeps that door shut for the same state once the account does have a factor", async () => {
    // The other half of `permiteOnboarding`, and the line between the option
    // and a hole: it lets `onboarding` past the *state* check and nothing
    // else. An account with a factor can still hold an `onboarding` session —
    // this fixture is one, a session opened before the deadline on an account
    // that registered a factor afterwards — and for it, a password is not an
    // acceptable answer here any more than anywhere else. The refusal comes
    // from the factor check further down the gate, which the option does not
    // touch.
    passkeyCount.mockResolvedValue(1);

    const res = await request(app)
      .post("/api/auth/email/send")
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND)
      .send({ email: "a@osefi.net", pass: "la-de-verdad" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(CODIGO_STEP_UP);
  });

  it("refuses to close another session for that same session, and revokes nothing", async () => {
    /**
     * The attack an audit of this plan demonstrated end to end, closed.
     *
     * From this exact fixture — a cookie whose account is past its deadline,
     * so `onboarding`, refused on users, roles and the permission matrix —
     * `DELETE /api/auth/sessions/:id` used to answer 200 and revoke the row.
     * Run against every id `GET /api/auth/sessions` hands back except the
     * caller's own, that logs the victim out of every device while the stolen
     * cookie goes on working: the account's own way of noticing a second
     * device is what performs it.
     *
     * The 403 has to be the **gate's**, and that is what `code` pins.
     * `authenticate` also answers 403 to `onboarding`, but not here:
     * `ONBOARDING_EXTRA` opens `/api/auth/sessions`, so this request gets
     * past it and reaches `requireStepUp` — which is the only reason this
     * route needed a gate of its own rather than the allowlist.
     */
    const res = await request(app)
      .delete(`/api/auth/sessions/${AJENA}`)
      .set("Cookie", COOKIE)
      .set(DEL_FRONTEND);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(CODIGO_STEP_UP);
    // Not merely refused: nothing was revoked. A 403 written after the
    // revocation would answer the same number and still have logged the
    // victim out.
    expect(sesionUpdate).not.toHaveBeenCalled();
  });

  it("tells /api/auth/me the state it is actually enforcing", async () => {
    // **The one thing this rule changes on a request it does not refuse**, and
    // the reason it matters: `/api/auth/me` is in `PARCIAL`, so every state
    // reaches it, and it publishes `req.user.estado`. Until now it answered
    // `completa` — the value in the row — while `authenticate` was answering
    // 403 to the rest of the ERP, which is precisely the "a 200 followed by
    // 403s with no distinguishable cause" that endpoint's own comment says the
    // field exists to prevent. Both halves were tested separately and neither
    // covered the pair.
    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("onboarding");
  });

  it("stops handing that session the permission matrix", async () => {
    // The specification's "en estado no `completa`, devuelve estado sin
    // permisos", through the real stack rather than a hand-built `req`: the
    // state that reaches the handler here is the recomputed one, so this is
    // also what proves the withholding keys off the state `authenticate`
    // actually enforces and not the `completa` still written in the row.
    //
    // The rest of the body survives — this endpoint is what the front end
    // asks on load, and in this state it is one of the few that answer at all.
    const res = await request(app).get("/api/auth/me").set("Cookie", COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.permisos).toBeUndefined();
    expect(res.body.usuario.id).toBe(YO);
  });

  it("still lets the ERP through while the deadline is ahead", async () => {
    // The guard against over-refusing. This rule may only narrow what a session
    // reaches once the date has actually passed; a version that refused a grace
    // period still running would lock out the entire company on the day it
    // deployed.
    conPlazo(POR_VENCER);

    const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

    expect(res.status).toBe(200);
  });

  it("treats an account with no deadline stored as one whose clock never started", async () => {
    // `mfa_grace_until` is NULL for every account until its first login after
    // the deploy, and NULL again after the documented reprieve
    // (`UPDATE usuarios SET mfa_grace_until = NULL`, see `estadoInicialDeSesion`).
    // Reading NULL as "the deadline has passed" would 403 the whole payroll the
    // moment this shipped, and would make that reprieve do the opposite of what
    // it is written down as doing.
    conPlazo(null);

    const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

    expect(res.status).toBe(200);
  });

  describe("the sessions this deadline is not about", () => {
    // **A permanent lockout, caught in review before it could ship.**
    // `mfa_grace_until` is stamped once and never cleared, so "the deadline
    // passed" is not the same fact as "this account still has nothing
    // registered". A first version narrowed on the stamp alone, which meant
    // that from the moment plan 4B let somebody register a factor after their
    // own deadline, that account got 403 on the whole ERP for ever — on every
    // request, with logging out and back in returning to the same place.
    //
    // These run through the assembled app because that is where the lockout
    // would have been felt: a compliant account holding a cookie and being
    // refused every screen.

    it("keeps the ERP for a session opened after the deadline had gone by", async () => {
      // Plan 4B's own path: log in on day 20, prove a factor, and the endpoint
      // that verified it promotes the row to `completa`. The account's deadline
      // is still sitting on day 14 and always will be. This clause asks nothing
      // of 4B beyond the promotion it has to do anyway.
      sesionAbierta({ created_at: new Date(VENCIDO.getTime() + 1_000) });

      const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

      expect(res.status).toBe(200);
    });

    it("keeps the ERP for a session that has proved a factor", async () => {
      // The other clause, for the session that predates the deadline and
      // registers a factor from inside `onboarding`. No time window on the
      // stamp: borrowing `requireStepUp`'s ten minutes here would drop somebody
      // into `onboarding` ten minutes after they configured the very thing
      // `onboarding` was asking them to configure.
      sesionAbierta({ mfa_satisfied_at: new Date(Date.now() - 30 * 60_000) });

      const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

      expect(res.status).toBe(200);
    });

    it("does NOT keep the ERP for a session that got in on a remembered device", async () => {
      // This asserted the opposite until plan 4B, on the premise that "a device
      // can only have been remembered for an account that proved a factor
      // once". True when written, and false the moment that account deletes its
      // last factor — after which the exemption was **permanent and had no
      // window**, so the session kept the whole ERP for its full thirty days on
      // the strength of a cookie nobody proved anything with.
      //
      // `dispositivo` is the worst of the four sources for exactly that reason:
      // it is the only one written **without anybody proving anything at that
      // moment**. `mfa_satisfied_at` still stays NULL on such a login on
      // purpose — see the column's comment in the migration — so with the
      // source no longer counting as evidence, the deadline reaches this
      // session like any other.
      //
      // The end-to-end half of the same rule `sessionState.test.ts` pins as a
      // unit. Both, because this one goes through the real `authenticate` and
      // the real projection: a column quietly dropped from `attributes` would
      // switch the rule off here and nowhere else.
      sesionAbierta({ mfa_source: "dispositivo" });

      const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

      expect(res.status).toBe(403);
    });

    it("still keeps the ERP for the three sources that do mean a factor was shown", async () => {
      // The guard against the fix above swallowing the rule it belongs to.
      for (const fuente of ["passkey", "totp", "codigo"]) {
        sesionAbierta({ mfa_source: fuente });
        const res = await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);
        expect(res.status, fuente).toBe(200);
      }
    });
  });

  it("costs the hot path no extra query to work this out", async () => {
    // The measurement, pinned rather than asserted in a comment. `authenticate`
    // makes exactly two reads per request — the session row and the account —
    // and the deadline arrives on the second of them, as one more column in a
    // projection that was already being fetched. The three columns the scoping
    // clauses read come off the session row, which was being fetched anyway
    // too. Nothing here counts factors: `tieneAlgunFactor` reads two more
    // tables, and putting it in front of every request in the ERP would be two
    // more round trips where the fix needs none.
    await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

    expect(usuarioFindByPk).toHaveBeenCalledTimes(1);
    expect(sesionFindOne).toHaveBeenCalledTimes(1);
    expect(passkeyCount).not.toHaveBeenCalled();
    expect(totpCount).not.toHaveBeenCalled();
    expect(codigoCount).not.toHaveBeenCalled();
  });

  it("does not rewrite the session row to say so", async () => {
    // The trap in this task, stated as a test. Writing the recomputed state
    // back into `sesiones.estado` would turn it into a second snapshot — the
    // exact defect being fixed — and would put an UPDATE on the read path of
    // every request in the ERP. The row keeps what the login decided; the
    // verdict is computed from it, on every request.
    //
    // `last_used_at` is fresh in this block's fixture, so the throttled touch
    // does not fire either: no UPDATE against `sesiones` at all.
    await request(app).get(`/api/usuario/${YO}`).set("Cookie", COOKIE);

    expect(sesionUpdate).not.toHaveBeenCalled();
  });
});
