import express from "express";
import morgan from "morgan";
import cors from "cors";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";

// Import routes
import uploadRoutes from "./routes/upload.routes.js";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

const secretKey = process.env.JWT_SECRET;

// Middlewares
app.use(morgan("dev"));
app.use(express.json());
app.use(cors());

// Middleware para verificar el token en rutas protegidas
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, secretKey, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Routes
app.use(express.static("images"));
app.use("/api/login", loginRoutes);

app.use("/api/upload", authenticateToken, uploadRoutes);
app.use("/api/reporte", authenticateToken, reporteRoutes);

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
app.use("/api/rol", rolRoutes);
app.use("/api/usuario", usuarioRoutes);

export default app;
