import express, { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: number; id_rol: number };
    }
  }
}
import morgan from "morgan";
import cors from "cors";
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
import revicionRoutes from "./routes/revicion.routes.js";

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
import dashboardRoutes from "./routes/dashboard.routes.js";

const app = express();

const secretKey = process.env.JWT_SECRET;

// Middlewares
app.use(morgan("dev"));
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));

// Middleware para verificar el token en rutas protegidas (+ sliding expiry)
// Además valida que el usuario siga existiendo (no archivado) para revocar acceso al instante.
function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, secretKey, async (err, user) => {
    if (err) return res.sendStatus(403);
    const u = user as { id: number; id_rol: number };

    try {
      const exists = await UsuarioModel.findByPk(u.id, { attributes: ["id"] });
      if (!exists) return res.sendStatus(401);
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
app.use("/api/revicion", authenticateToken, revicionRoutes);
app.use("/api/solucion", authenticateToken, solucionRoutes);
app.use("/api/tipoObs", authenticateToken, tipoObsRoutes);
app.use("/api/rol", authenticateToken, rolRoutes);
app.use("/api/usuario", authenticateToken, usuarioRoutes);
app.use("/api/files", authenticateToken, filesRoutes);

export default app;
