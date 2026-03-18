import { Router } from "express";
import { getDashboard } from "../controllers/dashboard.controller.js";

const router = Router();

router.get("/", getDashboard);

export default router;
