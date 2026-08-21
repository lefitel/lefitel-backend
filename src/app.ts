import express, { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: number; id_rol: number };
    }
  }
}
import cors from "cors";
import { httpLogger } from "./middleware/httpLogger.js";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { UsuarioModel } from "./models/usuario.model.js";

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

const secretKey = process.env.JWT_SECRET;

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
app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    // x-new-token is not a CORS-safelisted response header, so without this the
    // browser cannot read it and the sliding session never renews: the server
    // was re-signing a JWT on every request and throwing it away.
    exposedHeaders: ["x-new-token", "Content-Disposition"],
  }),
);

// Middleware para verificar el token en rutas protegidas (+ sliding expiry)
// Además valida que el usuario siga existiendo (no archivado) para revocar acceso al instante.
function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) {
    return res.status(401).json({ message: "Su sesión expiró. Vuelva a iniciar sesión." });
  }

  jwt.verify(token, secretKey, async (err, user) => {
    // 401, not 403: the token is missing or invalid, so the caller is not
    // authenticated. The client uses this distinction to decide whether to log
    // the user out — a 403 over an individual resource must not end a session.
    if (err) return res.status(401).json({ message: "Su sesión expiró. Vuelva a iniciar sesión." });
    const u = user as { id: number; id_rol: number };

    try {
      // Read the role from the database rather than trusting the token. The
      // token is re-issued on every request, so a stale id_rol would survive
      // indefinitely and a demoted user would keep their old permissions until
      // the account was archived.
      const current = await UsuarioModel.findByPk(u.id, { attributes: ["id", "id_rol"] });
      if (!current) {
        return res.status(401).json({ message: "Su cuenta ya no está activa." });
      }
      u.id_rol = current.dataValues.id_rol as number;
    } catch {
      return res.sendStatus(500);
    }

    req.user = u;
    // Re-issue a fresh 7d token on every authenticated request (sliding expiry)
    const { iat: _iat, exp: _exp, ...payload } = user as Record<string, unknown>;
    const newToken = jwt.sign(payload, secretKey, { expiresIn: "7d" });
    res.setHeader("x-new-token", newToken);
    next();
  });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 10,                 // máximo 10 intentos por IP
  message: { message: "Demasiados intentos. Intente nuevamente en 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.use(express.static(process.env.IMAGES_DIR ?? "/images"));
app.use("/api/login", (req, res, next) => {
  if (req.method === "POST") return loginLimiter(req, res, next);
  next();
}, loginRoutes);

app.use("/api/upload", authenticateToken, uploadRoutes);
app.use("/api/reporte", authenticateToken, reporteRoutes);
app.use("/api/generador", authenticateToken, generadorRoutes);
app.use("/api/dashboard", authenticateToken, dashboardRoutes);

app.use("/api/adss", authenticateToken, adssRoutes);
app.use("/api/adssposte", authenticateToken, adssPosteRoutes);

app.use("/api/bitacora", authenticateToken, bitacoraRoutes);
app.use("/api/ciudad", authenticateToken, ciudadRoutes);
app.use("/api/eventoObs", authenticateToken, eventoObsRoutes);
app.use("/api/evento", authenticateToken, eventoRoutes);
app.use("/api/material", authenticateToken, materialRoutes);
app.use("/api/obs", authenticateToken, obsRoutes);
app.use("/api/poste", authenticateToken, posteRoutes);
app.use("/api/propietario", authenticateToken, propietarioRoutes);
app.use("/api/revision", authenticateToken, revisionRoutes);
app.use("/api/solucion", authenticateToken, solucionRoutes);
app.use("/api/tipoObs", authenticateToken, tipoObsRoutes);
app.use("/api/rol", authenticateToken, rolRoutes);
app.use("/api/usuario", authenticateToken, usuarioRoutes);
app.use("/api/permisos", authenticateToken, permisoRoutes);
// The gate is inside files.routes.ts now, one per action: listing the folder and
// emptying it are not the same permission.
app.use("/api/files", authenticateToken, filesRoutes);

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
