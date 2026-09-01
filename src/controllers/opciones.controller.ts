// The dropdown lists each form needs, one response per form.
//
// Four endpoints and not one `/api/catalogo`, and §5.1 of the API standard spec
// explains why at length: `routeGuards.test.ts` decides whether a route is
// protected by reading a stamp of a single `modulo.accion` pair, so a single
// address serving eight blocks could not declare a permission at all. The real
// case was never "one catalogue" — it was "four forms need lists", and that is
// four addresses.
//
// All four in one file because the blocks overlap and their projections do not.
// `ciudad` travels in two of the four responses with different columns, `obs` in
// two, and the three plain catalogues in two — sharing the reader and stating
// the columns per endpoint is what §5.2 asks for, and it is what lets the shape
// of each block be decided by whoever consumes it rather than by whoever wrote
// the model.
//
// Every column here was checked against the client that will consume it in C2,
// not guessed. `ciudad` carries `lat`/`lng` because `PosteSheet` draws a map and
// `ReportRecorrido` traces a line with them — the sheet guards with
// `if (!a?.lat …)` and the report with the positive `if (a?.lat && a?.lng && …)`,
// so both render nothing at all, with no error, if the columns are missing.
// `obs` carries `id_tipoObs` because both incident forms group the list by type
// with `filter(o => o.id_tipoObs === …)`, which without the column yields an
// empty group that reads as "no observations configured". Nothing here carries
// `description` or `criticality`: no consumer of these four endpoints reads
// either off a catalogue list. The five Parámetros sections do read
// `description`, and they stay on the administration endpoints (§5.5).

import { Request, Response } from "express";
import { FindOptions } from "sequelize";
import { AdssModel } from "../models/adss.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { MaterialModel } from "../models/material.model.js";
import { ObsModel } from "../models/obs.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { RolModel } from "../models/rol.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const opcionesLog = log("opciones");
const handler = makeHandler(opcionesLog);

/**
 * Any of the seven catalogue models, as far as this file is concerned.
 *
 * Structural rather than `ModelDefined<A, B>`: each model is generic over its
 * own attribute interface, so no single instantiation accepts all seven, and the
 * alternatives are a generic parameter that buys nothing here — none of these
 * lists is typed on the way out, they are projections — or `any`. What this
 * helper needs of a model is one method, so that is what it asks for.
 *
 * **`FindOptions` and not `object`**, which is what this said first. `object`
 * declares no members, so the query literal below was checked against nothing at
 * all: `atributes`, `oder` and `paranoia: false` would every one of them have
 * compiled, and two of the three are caught downstream only because a test
 * happens to read them.
 */
type Catalogo = { findAll(opciones: FindOptions): Promise<unknown[]> };

/** A dropdown entry: what every list here has, and all that most of them need. */
const NOMBRE = ["id", "name"] as const;
/**
 * A city the caller is going to draw.
 *
 * `lat` and `lng` are `allowNull: false` on the model, so this projection cannot
 * come back half-filled.
 */
const CIUDAD_DIBUJABLE = ["id", "name", "lat", "lng"] as const;
/** An observation the caller is going to group by type. */
const OBS_AGRUPABLE = ["id", "name", "id_tipoObs"] as const;

/**
 * One catalogue, projected and ordered.
 *
 * **`order` is not decoration.** Every catalogue read in this API sorts by `id
 * DESC` today, and a `findAll` without `order` gets Postgres's heap order, which
 * is stable until the first `UPDATE` or `VACUUM` moves a row. `ReportTramoSec`
 * builds one table column per propietario, per material, per ADSS and per
 * observation *in list order*, and hands the same lists to the Excel and PDF
 * exporters — so an unordered list here means an export whose columns rearrange
 * themselves between runs, with nothing on screen to explain it. Matching the
 * existing endpoints exactly is also what keeps C2 from being a visible change.
 *
 * **No `paranoid: false` and no `archived` query parameter**, which is how §5's
 * "los archivados no viajan" is satisfied: all seven models are `paranoid: true`,
 * so the default already excludes archived rows. Do not copy the
 * `paranoid: false` that appears in `poste.controller.ts`'s includes — that is
 * there so an archived city can still label a pole that exists, which is the
 * opposite of what a list of choices wants.
 *
 * `raw: true` because these are projections, not rows anybody writes back:
 * plain objects carry exactly the columns asked for, which is what the response
 * contract in §5.2 promises. `opciones.test.ts` asserts that contract off this
 * `attributes` list rather than off the response body — the models are mocked
 * there, so the rows in the answer are the test's own and would prove nothing.
 */
const lista = (model: Catalogo, columnas: readonly string[]) =>
  model.findAll({ attributes: [...columnas], order: [["id", "DESC"]], raw: true });

/**
 * The distinct city pairs poles actually run between.
 *
 * The dedupe is the same one `getTramos` has done since before this endpoint
 * existed: a tramo is bidirectional, so `(3,7)` and `(7,3)` are one entry, keyed
 * by min/max.
 *
 * **What is deliberately different from `getTramos`: pairs naming a city that is
 * no longer live are dropped.** `PosteModel.findAll` is paranoid and excludes
 * archived *poles*, but says nothing about their cities, so the old endpoint can
 * and does return a pair whose city is absent from the `ciudad` block of this
 * same response — a neighbour the combobox cannot render and the line cannot be
 * drawn to. Filtering against the cities actually being served is what makes the
 * two blocks consistent with each other. `getTramos` is left alone on purpose:
 * it has a live consumer (`useTramoNeighbors`) and changing what it returns
 * belongs to the task that retires it, not to this one.
 */
async function tramosEntre(ciudadesVivas: Set<number>) {
  const filas = await PosteModel.findAll({
    attributes: ["id_ciudadA", "id_ciudadB"],
    group: ["id_ciudadA", "id_ciudadB"],
    raw: true,
  }) as unknown as { id_ciudadA: number; id_ciudadB: number }[];

  const vistos = new Set<string>();
  const tramos: { id_ciudadA: number; id_ciudadB: number }[] = [];
  for (const { id_ciudadA, id_ciudadB } of filas) {
    if (!ciudadesVivas.has(id_ciudadA) || !ciudadesVivas.has(id_ciudadB)) continue;
    const menor = Math.min(id_ciudadA, id_ciudadB);
    const mayor = Math.max(id_ciudadA, id_ciudadB);
    const clave = `${menor}-${mayor}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    tramos.push({ id_ciudadA: menor, id_ciudadB: mayor });
  }
  return tramos;
}

/**
 * `postes:ver`, and the pole form's four lists in one round trip.
 *
 * Six requests today, across the pair that will consume this: `PosteSheet` makes
 * four of them (five while editing, counting `getAdssPoste`) and the inline
 * editing in `poste/index.tsx` two more.
 *
 * **`ver` is not what either screen is gated by, and C2 needs to know.** Both
 * render behind `postes.editar` or `postes.crear` — `PermissionGuard` in the
 * sheet, `can(rol, "postes", "editar")` around the fetch in the list — so a
 * custom role holding `editar` without `ver` reaches the form and gets 403 from
 * here, and `poste/index.tsx` swallows it with an empty `.catch`: the dropdowns
 * simply never populate. No seeded role is in that position (all three have `ver`
 * wherever they have `editar`), but the matrix editor can make one. The same
 * sentence as the one on `getOpcionesUsuario` below, for the same reason.
 *
 * Worth knowing beside it: this is the **only gated read on that router**.
 * `GET /api/poste/`, `/tramos` and `/:id` carry no permission at all — they are
 * named in `READ_GATE_NOT_APPLICABLE` — so C2 can only ever tighten what a role
 * may see here, never widen it.
 */
export const getOpcionesPoste = handler("getOpcionesPoste", async (_req: Request, res: Response) => {
  const [adss, material, propietario, ciudad] = await Promise.all([
    lista(AdssModel, NOMBRE),
    lista(MaterialModel, NOMBRE),
    lista(PropietarioModel, NOMBRE),
    lista(CiudadModel, CIUDAD_DIBUJABLE),
  ]);
  res.status(200).json({ adss, material, propietario, ciudad });
});

/**
 * `eventos:ver`, for both incident forms.
 *
 * Deliberately without a `poste` block. `AddEventoPageSheet` does need the list
 * of poles, and it gets it today through `?export=true`, which C3 retires —
 * but serving the pole register under `eventos.ver` would be a worse problem
 * than the one it solves. §5.5 leaves that decision to C3.
 */
export const getOpcionesEvento = handler("getOpcionesEvento", async (_req: Request, res: Response) => {
  const [obs, tipoObs] = await Promise.all([
    lista(ObsModel, OBS_AGRUPABLE),
    lista(TipoObsModel, NOMBRE),
  ]);
  res.status(200).json({ obs, tipoObs });
});

/**
 * `reportes:ver`, for the three report screens.
 *
 * The widest of the four, and the only one whose blocks depend on each other:
 * `tramos` is filtered against the `ciudad` block, so the cities are fetched
 * first and the pairs after. `reportes` has exactly one action in the permission
 * vocabulary — `ver` — so it is the only pair this route could ask for.
 */
export const getOpcionesReporte = handler("getOpcionesReporte", async (_req: Request, res: Response) => {
  const ciudad = await lista(CiudadModel, CIUDAD_DIBUJABLE) as unknown as { id: number }[];
  const [adss, material, propietario, obs, tramos] = await Promise.all([
    lista(AdssModel, NOMBRE),
    lista(MaterialModel, NOMBRE),
    lista(PropietarioModel, NOMBRE),
    lista(ObsModel, NOMBRE),
    tramosEntre(new Set(ciudad.map((c) => c.id))),
  ]);
  res.status(200).json({ ciudad, adss, material, propietario, obs, tramos });
});

/**
 * `roles:editar`, and the pair is the point — see §5.3.
 *
 * 🔴 **Not mounted yet, and that is the one loose end of B1.** Its route belongs
 * in `usuario.routes.ts`, and its permission has to be declared in
 * `ROLES_GATES` inside `routeGuards.test.ts` — `MODULOS_TABULADOS` fails any
 * gated route under `/api/usuario` that no table names. Both files had another
 * session's uncommitted work in them when this was written, so mounting it would
 * have meant committing somebody else's half-finished change. Three lines when
 * they land: the route, the table entry, and a case in `opciones.test.ts`.
 *
 * Not `seguridad:ver`, which is what the screen around this list is gated by.
 * Whoever picks a role from this dropdown is about to assign one, and
 * `createUsuario` answers 403 to a caller without `roles.editar` **and files a
 * `severity: 'critical'` line reading `ROLE_CHANGE_DENIED`**. Serving the list
 * under a permission that cannot use it would turn a user manager's ordinary
 * afternoon into a run of privilege-escalation alerts.
 *
 * Consequence worth handing to C2: a custom role holding `seguridad.editar`
 * without `roles.editar` gets 403 here, and `UsuarioSheet`'s `loadRoles` has no
 * `.catch`, so its `finally`-less `setLoadingRoles(false)` never runs and the
 * combobox stays a skeleton. No seeded role is in that position — role 1 holds
 * both, roles 2 and 3 hold neither and cannot reach the screen — but the matrix
 * editor can create one.
 */
export const getOpcionesUsuario = handler("getOpcionesUsuario", async (_req: Request, res: Response) => {
  const rol = await lista(RolModel, NOMBRE);
  res.status(200).json({ rol });
});
