import { Request, Response, NextFunction } from "express";

/**
 * Server-side role check.
 *
 * The rest of the API relies on the frontend to hide what a role should not
 * reach, which means any authenticated user can call those endpoints directly.
 * The report builder cannot afford that: it would turn a theoretical gap into a
 * two-click data export. Routes here verify the role on the server.
 *
 * Must run after authenticateToken, which is what populates req.user.
 */
export function requireRole(...allowed: number[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.id_rol;
    if (role === undefined) return res.sendStatus(401);
    if (!allowed.includes(role)) {
      return res.status(403).json({ message: "No tiene permiso para acceder a este módulo." });
    }
    next();
  };
}
