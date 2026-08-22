import express, { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: number; id_rol: number; id_sesion?: string };
    }
  }
}
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { httpLogger } from "./middleware/httpLogger.js";
import { authenticate } from "./middleware/authenticate.js";
import { loginRateLimit } from "./middleware/loginLimiters.js";
import { HSTS_MAX_AGE_SECONDS } from "./config/security.js";

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
app.use(
  cors({
    // No fallback in production: `index.ts` refuses to start without the
    // variable, so reaching here without one means development. Leaving the
    // Vite port as a silent default would, once credentials are enabled in the
    // next plan, authorise whatever is listening on the visitor's own machine.
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    // x-new-token is not a CORS-safelisted response header, so without this the
    // browser cannot read it and the sliding session never renews: the server
    // was re-signing a JWT on every request and throwing it away.
    exposedHeaders: ["x-new-token", "Content-Disposition"],
  }),
);

// Routes
app.use(express.static(process.env.IMAGES_DIR ?? "/images"));
// Both login buckets and the POST-only rule live in loginLimiters.ts, as one
// named middleware. Written out here it was an anonymous arrow nothing could
// assert about.
app.use("/api/login", loginRateLimit, loginRoutes);

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
