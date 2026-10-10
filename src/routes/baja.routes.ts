import { Router } from "express";
import rateLimit from "express-rate-limit";
import { postConsultarBaja, postDarDeBaja } from "../controllers/baja.controller.js";

// Unsubscribing from a scheduled report. Mounted at `/api/unsubscribe`,
// **with no `authenticate` in front of it and no permission gate**: the
// person pressing the button is an outside address, which by definition has
// no account. What stands in for both is the token — thirty-two random bytes
// that only ever travelled in a message to that address.
//
// **Limited by address, and generously.** Nothing here can be guessed, so the
// bucket is not what keeps tokens safe; it is what stops this from being a
// free way to make the database answer questions all day. Thirty in fifteen
// minutes is far past any person opening a link and pressing a button.
const WINDOW_MS = 15 * 60 * 1000;

export const bajaLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 30,
  message: { message: "Demasiadas solicitudes. Espere unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.post("/lookup", bajaLimiter, postConsultarBaja);
router.post("/", bajaLimiter, postDarDeBaja);

export default router;
