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
      };
    }
  }
}
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { httpLogger } from "./middleware/httpLogger.js";
import { authenticate } from "./middleware/authenticate.js";
import { loginRateLimit } from "./middleware/loginLimiters.js";
import { requireSameOrigin } from "./middleware/csrf.js";
import { allowedOrigins, HSTS_MAX_AGE_SECONDS, ROLE_HEADER, SESSION_EXPIRES_HEADER } from "./config/security.js";

// Import routes
import uploadRoutes from "./routes/upload.routes.js";
import filesRoutes from "./routes/files.routes.js";

import adssRoutes from "./routes/adss.routes.js";
import adssPosteRoutes from "./routes/adssPoste.routes.js";

import rolRoutes from "./routes/rol.routes.js";

import solucionRoutes from "./routes/solucion.routes.js";
import revisionRoutes from "./routes/revision.routes.js";

import eventoRoutes from "./routes/evento.routes.js";

import posteRoutes from "./routes/poste.routes.js";
import bitacoraRoutes from "./routes/bitacora.routes.js";
import ciudadRoutes from "./routes/ciudad.routes.js";
import eventoObsRoutes from "./routes/eventoObs.routes.js";
import materialRoutes from "./routes/material.routes.js";
import obsRoutes from "./routes/obs.routes.js";
import propietarioRoutes from "./routes/propietario.routes.js";
import tipoObsRoutes from "./routes/tipoObs.routes.js";
import usuarioRoutes from "./routes/usuario.routes.js";
import loginRoutes from "./routes/login.routes.js";
import authRoutes from "./routes/auth.routes.js";
import reporteRoutes from "./routes/reporte.routes.js";
import generadorRoutes from "./routes/generador.routes.js";
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

app.use("/api/upload", authenticate, uploadRoutes);
app.use("/api/reporte", authenticate, reporteRoutes);
app.use("/api/generador", authenticate, generadorRoutes);
app.use("/api/dashboard", authenticate, dashboardRoutes);

app.use("/api/adss", authenticate, adssRoutes);
app.use("/api/adssposte", authenticate, adssPosteRoutes);

app.use("/api/bitacora", authenticate, bitacoraRoutes);
app.use("/api/ciudad", authenticate, ciudadRoutes);
app.use("/api/eventoObs", authenticate, eventoObsRoutes);
app.use("/api/evento", authenticate, eventoRoutes);
app.use("/api/material", authenticate, materialRoutes);
app.use("/api/obs", authenticate, obsRoutes);
app.use("/api/poste", authenticate, posteRoutes);
app.use("/api/propietario", authenticate, propietarioRoutes);
app.use("/api/revision", authenticate, revisionRoutes);
app.use("/api/solucion", authenticate, solucionRoutes);
app.use("/api/tipoObs", authenticate, tipoObsRoutes);
app.use("/api/rol", authenticate, rolRoutes);
app.use("/api/usuario", authenticate, usuarioRoutes);
app.use("/api/permisos", authenticate, permisoRoutes);
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
 */
const imagenesEstaticas = express.static(process.env.IMAGES_DIR ?? "/images");
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/")) return next();
  void authenticate(req, res, () => imagenesEstaticas(req, res, next));
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
