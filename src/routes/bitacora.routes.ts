import { Router } from "express";
import { getAllBitacora, getBitacora } from "../controllers/bitacora.controller.js";

const router = Router();

router.get("/", getAllBitacora);
router.get("/:id_usuario", getBitacora);

export default router;
