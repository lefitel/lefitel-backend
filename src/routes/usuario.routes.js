import { Router } from "express";
import {
  createUsuario,
  deteleUsuario,
  getUsuario,
  searchUsuario,
  searchUsuario_user,
  updateUserName,
  updateUserPass,
  updateUsuario,
} from "../controllers/usuario.controller.js";

const router = Router();

// Routes
router.post("/", createUsuario);
router.put("/:id", updateUsuario);
router.put("/username/:id", updateUserName);
router.put("/userpass/:id", updateUserPass);

router.get("/", getUsuario);
router.get("/:id", searchUsuario);
router.get("/user/:user", searchUsuario_user);

router.delete("/:id", deteleUsuario);

export default router;
