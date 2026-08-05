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

/**
 * Lets a user act on their own record, and anyone with one of the listed roles
 * act on any record.
 *
 * Needed because the same endpoints serve two purposes: `GET /usuario/:id` is
 * how the profile page loads the current user, and also how administration
 * inspects anyone. Locking the whole route to admins would break the profile;
 * leaving it open hands the staff directory to every authenticated client.
 */
export function requireSelfOrRole(...allowed: number[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.id_rol;
    if (role === undefined) return res.sendStatus(401);
    if (allowed.includes(role)) return next();

    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (Number(raw) === req.user?.id) return next();

    return res.status(403).json({ message: "Solo puede consultar o modificar su propio usuario." });
  };
}
