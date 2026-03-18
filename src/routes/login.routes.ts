import { Router } from "express";
import {
  loginUsuario,
  comprobarToken,
} from "../controllers/login.controller.js";

const router = Router();

// Routes
router.post("/", loginUsuario);
router.get("/", comprobarToken);

export default router;
