import { Router } from "express";
import {
  createUsuario,
  deteleUsuario,
  getUsuario,
  searchUsuario,
  searchUsuario_user,
  updateUsuario,
} from "../controllers/usuario.controller.js";

const router = Router();

// Routes
router.post("/", createUsuario);
router.put("/:id", updateUsuario);
router.get("/", getUsuario);
router.get("/:id", searchUsuario);
router.get("/user/:user", searchUsuario_user);

router.delete("/:id", deteleUsuario);

export default router;
