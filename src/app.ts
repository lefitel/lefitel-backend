import express, { Request, Response, NextFunction } from "express";
import type { EstadoSesion } from "./auth/sessionState.js";

/**
 * Who `authenticate` decided the caller is, for everything mounted behind it.
 *
 * `user` itself is optional — a request that never reached `authenticate`, or
 * was refused by it, has none — but **its fields are not**. `id_sesion`
 * and `expires_at` used to be optional too, and the reason was written down in
 * `sessionStore.ts`: a request authenticated by the old bearer token reached a
 * controller with no session row, so there was nothing to fill them with. That
 * credential is gone (`middleware/authenticate.ts`), so an authenticated
 * request now has a row by construction and these two are always there.
 *
 * The difference is not cosmetic. While they were optional, `auth.controller.ts`
 * had to ask in six places whether the caller had a row — including a
 * `logout` that answered 400 instead of logging anybody out, and a
 * `logout-all` whose message told the caller their own browser was still
 * inside. Those were reachable branches of a security endpoint; making the
 * fields required is what makes them unwritable rather than merely unused.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: number;
        id_rol: number;
        id_sesion: string;
        expires_at: Date;
        // Both required for the same reason the two above are: an
        // authenticated request has a session row by construction, so there is
        // nothing for a controller to check. `requireStepUp` reads them and
        // must not have to ask whether they are there — an optional field is
        // an invitation to a `?.` that silently reads `undefined` as "not
        // satisfied" in one place and as "no opinion" in another.
        estado: EstadoSesion;
        mfa_satisfied_at: Date | null;
        // The third one the gate reads, and required for the same reason: an
        // optional field here is what turns "this session confirmed its
        // password nine minutes ago" into `undefined` on one route and a
        // silently closed window on every other.
        password_confirmed_at: Date | null;
      };
    }
  }
}
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { httpLogger, HEALTH_PATH } from "./middleware/httpLogger.js";
import { authenticate, authenticateArchivos } from "./middleware/authenticate.js";
import { loginRateLimit } from "./middleware/loginLimiters.js";
import { requireSameOrigin, requireVerifiedOrigin } from "./middleware/csrf.js";
import { allowedOrigins, HSTS_MAX_AGE_SECONDS, ROLE_HEADER, SESSION_EXPIRES_HEADER } from "./config/security.js";

// Import routes
import filesRoutes from "./routes/files.routes.js";

import adssRoutes from "./routes/adss.routes.js";

import rolRoutes from "./routes/rol.routes.js";

import revisionRoutes from "./routes/revision.routes.js";

import eventoRoutes from "./routes/evento.routes.js";

import posteRoutes from "./routes/poste.routes.js";
import bitacoraRoutes from "./routes/bitacora.routes.js";
import ciudadRoutes from "./routes/ciudad.routes.js";
import materialRoutes from "./routes/material.routes.js";
import obsRoutes from "./routes/obs.routes.js";
import propietarioRoutes from "./routes/propietario.routes.js";
import tipoObsRoutes from "./routes/tipoObs.routes.js";
import tramoRoutes from "./routes/tramo.routes.js";
import usuarioRoutes from "./routes/usuario.routes.js";
import loginRoutes from "./routes/login.routes.js";
import authRoutes from "./routes/auth.routes.js";
import mfaRoutes from "./routes/mfa.routes.js";
import totpRoutes from "./routes/totp.routes.js";
import recoveryCodesRoutes from "./routes/recoveryCodes.routes.js";
import webauthnRoutes from "./routes/webauthn.routes.js";
import webauthnPasswordlessRoutes from "./routes/webauthnPasswordless.routes.js";
import reporteRoutes from "./routes/reporte.routes.js";
import rutaRoutes from "./routes/ruta.routes.js";
import generadorRoutes from "./routes/generador.routes.js";
import programacionRoutes from "./routes/programacion.routes.js";
import bajaRoutes from "./routes/baja.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import permisoRoutes from "./routes/permiso.routes.js";

const app = express();

// Express announces itself in every response. It costs nothing to remove and
// it is free reconnaissance for anyone deciding which exploits to try.
app.disable("x-powered-by");

// The Coolify proxy terminates TLS in front of the app, so without this every request
// carries the proxy's address and the rate limiters below share a single bucket
// across the whole user base.
app.set("trust proxy", 1);

// Middlewares
//
// First of all of them: a request that is rejected by the body parser or by CORS
// still deserves a line, and anything mounted after this one can reach the
// request's own logger through `req.log`.
app.use(httpLogger);

/**
 * "Is this process up", for the container's HEALTHCHECK and for nothing else.
 *
 * Mounted here, ahead of everything, because the check sends a bare request
 * from inside the container — no cookie, no `Origin`, no client header — and
 * every layer below this one exists to refuse exactly that.
 *
 * 204 and no body: reachable by anybody, so it says nothing. Not the version,
 * not the environment, and deliberately not whether the database answers. This
 * process only starts listening after the database has answered and the boot
 * checks have run (`index.ts`), which is the fact the deploy needs; asking the
 * database again on every probe would mark a healthy server unhealthy for a
 * blip that every real request already survives.
 *
 * It replaced a probe of `/`, which worked and wrote a `GET / → 401` warning
 * every ten seconds. `httpLogger` keeps this address out of the log.
 */
app.get(HEALTH_PATH, (_req, res) => {
  res.status(204).end();
});

/**
 * Two of helmet's defaults are wrong for this server, and one of them fails in
 * a way nothing would report.
 *
 * `crossOriginResourcePolicy` defaults to `same-origin`. The photographs are
 * served from here by `express.static` and displayed by a page hosted on
 * Vercel, so with the default every `<img>` in the application would come back
 * blocked — in the browser only, with the server logging a clean 200.
 *
 * `contentSecurityPolicy` is off because this process serves JSON and files,
 * never HTML. A policy on a JSON response governs nothing; the page's own
 * policy is Vercel's business.
 *
 * HSTS is set here as well as at the proxy. Whichever answers, the browser gets
 * told once.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true },
  }),
);
app.use(express.json());
/**
 * `req.body` is an object even when nothing parsed one.
 *
 * Express 4 left `{}` on a request no body parser matched — a POST with no
 * content type, or the form-encoded post `express.json()` ignores, or the empty
 * body `axios.delete()` sends. Express 5 leaves `undefined` instead, and two
 * dozen controllers read `req.body.campo` straight, so the same request stopped
 * being a 400 from a validator and became a TypeError the terminal handler turns
 * into a 500: a caller's mistake reported as this server breaking, and a real
 * incident harder to find among them.
 *
 * One line here rather than a guard at twenty-four call sites, and it keeps the
 * answers the frontend already expects. It runs after the parser on purpose —
 * before it, there would be nothing to leave alone.
 */
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
// `res.cookie` is native to Express; `req.cookies` is not. Without this the
// session can be handed out and never read back.
app.use(cookieParser());
/**
 * One list of origins, read once, used by both of the next two middlewares.
 *
 * `allowedOrigins` holds the parsing and the reasoning, including why falling
 * back to the development origin cannot happen on a process that serves
 * production traffic. Handing the same array to `cors()` and to
 * `requireSameOrigin` is the point: an origin list kept in two places is an
 * origin list that will differ in one place, and the difference nobody notices
 * is the guard's copy being the wider one.
 */
const ORIGINS = allowedOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV);

app.use(
  cors({
    origin: ORIGINS,
    /**
     * Without this the whole cookie is unreachable code.
     *
     * A browser throws away the `Set-Cookie` of a cross-origin response unless
     * it also carries `Access-Control-Allow-Credentials: true`, and refuses to
     * send the cookie back unless the request was made in credentials mode.
     * www.osefi.net and api.osefi.net are different origins, so both halves
     * apply: the login was setting a cookie the browser discarded, and six
     * tasks of session work could never have run in production. The other half
     * lives in the frontend — see `web/src/api/http.ts`.
     *
     * Safe here only because `origin` is a list and never a wildcard. `*`
     * alongside credentials is the combination browsers forbid outright, and
     * `allowedOrigins` cannot produce it: `requiredEnv` stops the process
     * booting in production without CORS_ORIGIN, and a CORS_ORIGIN of `*` is
     * dropped from the list rather than honoured.
     */
    credentials: true,
    // A response header that is not CORS-safelisted still crosses the wire —
    // api.osefi.net and www.osefi.net are different origins — but the
    // frontend's own JavaScript is refused permission to read it unless it is
    // named here, and that refusal is invisible in a `curl` transcript and in
    // the network tab's raw response alike. `ROLE_HEADER` is set by
    // `authenticate` on every authenticated response (see
    // `middleware/authenticate.ts`) and read by the frontend to notice a role
    // that changed mid-session; `SESSION_EXPIRES_HEADER` is set on those same
    // responses and is what the browser's expiry countdown is armed from —
    // unreadable to the page's script, that countdown runs for the life of the
    // tab on whatever `GET /auth/me` said when it opened, and ends a session
    // the server has since renewed; `Content-Disposition` is what lets it read
    // an exported file's real name instead of saving everything as "download".
    //
    // `x-new-token` used to head this list and is gone from it. The server
    // stopped re-signing a JWT per request, so nothing emits that header any
    // more, and read permission for a header nobody sends is worse than
    // useless: it tells the next person the mechanism is still there. That
    // mechanism is what `ROLE_HEADER` replaced — see its comment in
    // `config/security.ts`.
    //
    // Nothing left in this array is safe to delete without checking who reads
    // it first: `app.security.test.ts` pins the whole list by equality rather
    // than by "contains", because dropping an entry — not the array losing all
    // meaning — is the realistic way this breaks. What that test cannot see is
    // the effect: `supertest` does not apply
    // `Access-Control-Expose-Headers`, so this list governs only whether a
    // real browser's JavaScript may read the header, never whether it travels.
    exposedHeaders: ["Content-Disposition", ROLE_HEADER, SESSION_EXPIRES_HEADER],
  }),
);

/**
 * Mounted after `cors()`, and the order matters twice.
 *
 * A 403 written before `cors()` runs would come back without
 * `Access-Control-Allow-Origin`, and a browser then hides the entire response —
 * status code included, not only the body — behind an opaque CORS error. That
 * used to be justified here as "so the frontend can read the sentence
 * explaining what to do", which overstates what the frontend actually does with
 * it: roughly thirty write functions across `src/api/` (`Ciudad.api.ts`,
 * `Adss.api.ts`, and the same shape in Material, Obs, Poste, Propietario,
 * TipoObs, Usuario, Evento) discard the whole response with `.catch(() => 400)`
 * and hand the caller a hardcoded number, so the sentence in `message` never
 * reaches a screen from most of them regardless of mount order. Only four call
 * sites read `response.data.message` at all (`generador.api.ts`,
 * `Permisos.api.ts`, `Login.api.ts`, `Usuario.api.ts`).
 *
 * What the order genuinely protects is narrower and still real: the global
 * response interceptor in `SesionProvider.tsx` reads `error.response?.status`
 * on *every* request to decide whether to end the session, and the four call
 * sites above read the body — both need a response CORS lets through at all,
 * with a real status code attached, rather than a network-level failure with
 * nothing on it. Mounting after `cors()` is what keeps a same-origin 403 from
 * degrading into that opaque failure for those five places. The practical
 * consequence for everyone else: when a proxy strips this app's custom header
 * in transit, what a user sees is not this sentence — it is an ordinary,
 * unexplained "no se pudo guardar" from whichever screen they were on, because
 * the write function that called it already turned the 403 into a bare 400.
 *
 * And `cors()` answers the preflight itself, so no `OPTIONS` request ever
 * reaches this guard — which is right, since a preflight changes nothing.
 *
 * Global rather than per router: a CSRF check that has to be remembered at each
 * mount is a check that will be forgotten at the next one. It decides for itself
 * which requests it applies to, from the method and the credential.
 */
app.use(requireSameOrigin(ORIGINS));

// Routes
// Both login buckets and the POST-only rule live in loginLimiters.ts, as one
// named middleware. Written out here it was an anonymous arrow nothing could
// assert about.
app.use("/api/login", loginRateLimit, loginRoutes);
// No `authenticate` at the mount, unlike every router below it. `POST
// /api/auth/login` is what produces a credential and cannot ask for one, so
// each route in auth.routes.ts declares its own — which is also what makes the
// exception visible on the line it applies to instead of here.
app.use("/api/auth", authRoutes);
/**
 * The second factor, in three routers rather than folded into `authRoutes`.
 *
 * Each was built by a different task and each declares its own gates on the
 * line they apply to — `totpRoutes` also puts a 503 in front of all of its
 * routes when the encryption key does not open the stored secrets, which is the
 * whole of "a wrong key stops the TOTP, not the ERP".
 *
 * Mounted after `authRoutes` and under the same prefix: Express falls through a
 * router that matches nothing, and keeping them apart means each file reads end
 * to end without sorting out which endpoint belongs to which half of the plan.
 *
 * `authenticate` is declared inside each router rather than here, matching
 * `authRoutes` above and for the same reason — `/api/auth/mfa/verify` is
 * reached by a session that has a cookie and has not proved a factor, so which
 * middleware guards it is a fact about the route, not about the mount.
 */
app.use("/api/auth", mfaRoutes);
app.use("/api/auth/totp", totpRoutes);
app.use("/api/auth/recovery-codes", recoveryCodesRoutes);
/**
 * The passwordless door — plan 4C, phase 2 — mounted **before** the
 * authenticated passkey router below, under a prefix of its own, and behind
 * `requireVerifiedOrigin` and nothing else.
 *
 * 🔴 The gate is the whole CSRF story for these two routes. The global
 * `requireSameOrigin` above waves a cookie-less write through on the
 * argument that `authenticate` refuses it next — and this is the one router
 * whose routes have no `authenticate`, because they are how somebody with no
 * credential gets one, and whose answer is a `Set-Cookie`. `csrf.ts` has the
 * two things a cross-site page could do with that. Mounted here rather than
 * inside the router so it takes the same `ORIGINS` array as `cors()` and the
 * global gate: an origin list kept in two places is one that differs in one.
 * `routeGuards.test.ts` reads the gate's name off this mount and pins that
 * exactly these two routes carry it.
 */
app.use("/api/auth/webauthn/passwordless", requireVerifiedOrigin(ORIGINS), webauthnPasswordlessRoutes);
// 🔴 This prefix is not a choice. `auth/sessionState.ts` already reserves
// `/api/auth/webauthn/login`, `/api/auth/webauthn/register` and
// `/api/auth/webauthn/credentials` in its allow-lists — mounting anywhere else
// leaves a `parcial` session with no reachable door and no error that says so.
// See `webauthn.routes.ts` for the loop that produces, and for why the tempting
// opposite mistake (widening the allow-list to this whole prefix) is worse.
// `/passwordless` above is the deliberate exception: outside every list, and
// reachable by nobody who has a session to be in a list with.
app.use("/api/auth/webauthn", webauthnRoutes);

// D1 (§3.2, §3.4). Four mounts fewer than before this change:
//
// - `/api/adssposte`, `/api/eventoObs` and `/api/solucion` were root resources
//   for listings that only exist with respect to one row. They hang off their
//   parent now — `/api/poste/:id/adss`, `/api/evento/:id/obs`,
//   `/api/evento/:id/solucion` — and their routers are gone.
// - `/api/upload` was a verb mounted as a root resource. Storing a file is
//   `POST /api/files/`, in the router that already manages them.
//
// And three renamed: `/api/generador` → `/api/generator` and `/api/permisos`
// → `/api/permiso` (the mount is the noun, in the singular), `/api/tipoObs`
// → `/api/tipo-obs` (kebab-case; this and `eventoObs` were the only two
// segments with a capital letter in the whole API).
app.use("/api/reporte", authenticate, reporteRoutes);
// The road-route proxy. `authenticate` and nothing else — `ruta.routes.ts`
// carries the reasoning, and `routeGuards.test.ts` pins that the exception is
// deliberate. It exists so the provider's key stops shipping inside the
// frontend bundle, where Vite writes every `VITE_*` value literally.
app.use("/api/ruta", authenticate, rutaRoutes);
// Unsubscribing from a scheduled report: public on purpose, like the password
// reset — an outside address has no session to authenticate. The token in the
// body is the credential; see `routes/baja.routes.ts`.
app.use("/api/unsubscribe", bajaRoutes);
// Before the generator itself: Express walks mounts in order, and this one is
// the more specific path.
app.use("/api/generator/schedules", authenticate, programacionRoutes);
app.use("/api/generator", authenticate, generadorRoutes);
app.use("/api/dashboard", authenticate, dashboardRoutes);

app.use("/api/adss", authenticate, adssRoutes);

app.use("/api/bitacora", authenticate, bitacoraRoutes);
app.use("/api/ciudad", authenticate, ciudadRoutes);
app.use("/api/evento", authenticate, eventoRoutes);
app.use("/api/material", authenticate, materialRoutes);
app.use("/api/obs", authenticate, obsRoutes);
app.use("/api/poste", authenticate, posteRoutes);
app.use("/api/propietario", authenticate, propietarioRoutes);
app.use("/api/revision", authenticate, revisionRoutes);
app.use("/api/tipo-obs", authenticate, tipoObsRoutes);
app.use("/api/tramo", authenticate, tramoRoutes);
app.use("/api/rol", authenticate, rolRoutes);
app.use("/api/usuario", authenticate, usuarioRoutes);
app.use("/api/permiso", authenticate, permisoRoutes);
// The gate is inside files.routes.ts now, one per action: listing the folder and
// emptying it are not the same permission.
app.use("/api/files", authenticate, filesRoutes);

/**
 * The field photographs, behind the session.
 *
 * This mount used to sit above every `/api/...` router and eleven lines above
 * the first `authenticate`, which made a stored file name the entire
 * credential: `GET /1712428860328_210.jpg` answered 200 with the image to
 * anybody on the internet, no cookie required. The names are not a secret
 * either — `upload.controller.ts` writes `${Date.now()}_${originalName}`, and
 * the original names in this database are `Imagen1`..`Imagen26`, WhatsApp names
 * carrying their own date, and in some rows the pole number itself. The only
 * unguessable component is a millisecond, and a naming session's photographs
 * sit seconds apart.
 *
 * It has to move *below* the API routers rather than be wrapped where it stood:
 * `app.use(authenticate, ...)` carries no path, so it would have run for
 * everything mounted underneath it — a session in front of `POST /api/login`.
 *
 * `/api/...` is skipped rather than authenticated so an unknown API path stays
 * a 404. Letting `authenticate` answer it would turn every client typo into
 * "su sesión expiró", which is a different bug report.
 *
 * No URL changes and the frontend is untouched. The cookie is host-only on the
 * API's host with `SameSite=Lax`, and www and api share a registrable domain,
 * so it rides an `<img>` exactly as it already rides XHR — see
 * `auth/sessionCookie.ts`, which spells out why there is no `domain`. Every
 * screen that renders one of these is inside `/app/...` and already holds a
 * session; the public pages use bundled logos, not stored files.
 *
 * What this does not fix: a photograph is still reachable by anyone with *a*
 * session, whatever pole it belongs to. Scoping it to the owner is the separate
 * piece of work this unblocks rather than replaces.
 *
 * **`authenticateArchivos`, not `authenticate`.** This mount is not a router
 * under `/api/...`, so `authenticate`'s own gate — `puedeAlcanzar`, which
 * only knows `/api/auth/...` — had no opinion about an image path and, asked
 * anyway, answered no by default: every `onboarding` session got **403 on
 * every photograph** the moment its account's MFA grace period ran out,
 * because nothing had ever decided what images owe a session mid-setup, not
 * because the deadline was supposed to close them. `completa` never showed
 * this — `puedeAlcanzar("completa", ...)` is unconditionally `"todo"` — which
 * is why the hole was invisible until a grace period actually expired.
 * `authenticateArchivos` carries `puedeVerArchivosEstaticos`
 * (`auth/sessionState.ts`) instead: an explicit, separate allowlist that
 * opens this mount to `onboarding` and `completa` and keeps it shut for
 * `parcial`, decided by what this route is rather than derived from what it
 * is not. See `src/app.images.test.ts` for the three states covered.
 */
const imagenesEstaticas = express.static(process.env.IMAGES_DIR ?? "/images");
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/")) return next();
  void authenticateArchivos(req, res, () => imagenesEstaticas(req, res, next));
});

/**
 * An address that does not exist, answered in JSON.
 *
 * A 404 is not an error — nothing threw — so it never reaches the terminal
 * handler below, and until now it fell through to Express's `finalhandler`,
 * which answers **HTML**. Every client module in `web` reads
 * `error.response.data.message` and falls back to its own wording when that is
 * missing, so seventeen call sites were showing a generic phrase for what is
 * really a very specific fault: the address is wrong.
 *
 * That matters most for the task that makes 404s on purpose. Renaming routes
 * (D1) means a browser holding yesterday's bundle asks for an address that has
 * moved, and this is what it will be told. Hence the wording: **the address does
 * not exist**, and not "an error occurred" — a phrase that sends whoever reads
 * the report looking for a server fault that is not there.
 *
 * **Global, not scoped to `/api`.** This process serves the API and one
 * `express.static` mount for the images directory; the web client is deployed
 * elsewhere. So there is no path here that should ever answer HTML. In practice
 * a non-API path is answered by `authenticateArchivos` with 401 long before it
 * gets here — deliberately, so that the mount cannot be used to guess which
 * photographs exist (`app.images.test.ts`) — and this handler is what serves the
 * rest.
 *
 * **Three parameters, and the third is load-bearing twice over.** A function of
 * four is an error handler to Express and would never run, which would remove
 * this silently; and `res.headersSent` has to hand the request onwards rather
 * than answer twice, because a second `res.status()` throws
 * `ERR_HTTP_HEADERS_SENT` into the handler below, which would then try to answer
 * a third time. Not reachable today — the two places that could respond late
 * both check `headersSent` themselves — which is why it is one line and a
 * comment rather than a test.
 *
 * It does not log. `httpLogger` already writes a line per request, with the
 * request id, and logging here as well produces the double entry the terminal
 * handler below documents. The exception is a missing image: `isNoise` in
 * `httpLogger` ignores static asset extensions, so those 404s are logged
 * nowhere. That is on purpose too — one export fetches photographs by the
 * thousand — and the place that answers "which references are broken" is the
 * Archivos screen, which asks the database rather than the log.
 */
app.use((_req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next();
  res.status(404).json({ message: "La dirección solicitada no existe." });
});

/**
 * Terminal error handler.
 *
 * Anything thrown before a controller — the body-parser size limit, malformed
 * JSON — used to reach Express's default handler, which serves HTML with
 * absolute filesystem paths whenever NODE_ENV is not "production". It also
 * broke the client, which expects `{message}` on every failure.
 */
app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  // Deliberately does not log. `httpLogger` runs in front of everything and
  // already writes one line for a failed request, with the request id attached;
  // logging here as well printed every error twice, once with the id and once
  // without, which reads like two separate failures.
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ message: "La petición es demasiado grande." });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "La petición no es válida." });
  }
  const status = typeof err?.status === "number" ? err.status : 500;
  res.status(status).json({ message: "Ocurrió un error al procesar la petición." });
});

export default app;
