import { Router } from "express";
import { getAdssPoste } from "../controllers/adssPoste.controller.js";

const router = Router();

router.get("/:id_poste", getAdssPoste);

export default router;
