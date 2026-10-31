// The dropdown lists each form needs, one response per form.
//
// Three endpoints and not one `/api/catalog`, and §5.1 of the API standard spec
// explains why at length: `routeGuards.test.ts` decides whether a route is
// protected by reading a stamp of a single `modulo.accion` pair, so a single
// address serving eight blocks could not declare a permission at all. The real
// case was never "one catalogue" — it was "forms need lists", and that is one
// address per form.
//
// Three and not four. §5 first planned a `GET /api/usuario/options` serving
// the role list under `roles:editar`, and the audit of 3 September took it off
// the table: `GET /api/rol/` already serves exactly `{id, name}` to the same
// screen, and gating the same list at a second address under a *different*
// permission would have left a user manager without `roles:editar` staring at
// a dropdown that never loads. `UsuarioSheet` keeps calling `getRol()`.
//
// All three in one file because the blocks overlap and their projections do not.
// `ciudad` travels in two of the three responses with different columns, `obs`
// in two, and the three plain catalogues in two — sharing the reader and stating
// the columns per endpoint is what §5.2 asks for, and it is what lets the shape
// of each block be decided by whoever consumes it rather than by whoever wrote
// the model.
//
// Every column here was checked against the client that will consume it in C2,
// not guessed. `ciudad` carries `lat`/`lng` in every endpoint that lists cities,
// the tramo one included: the network map draws every city from the tramo
// options, and the pole form and the report screens draw theirs from the others.
// `obs` carries `id_tipoObs` because both incident forms group the list by type
// with `filter(o => o.id_tipoObs === …)`, which without the column yields an
// empty group that reads as "no observations configured". Nothing here carries
// `description` or `criticality`: no consumer of these three endpoints reads
// either off a catalogue list. The five Parámetros sections do read
// `description`, and they stay on the administration endpoints (§5.5).

import { Request, Response } from "express";
import { FindOptions } from "sequelize";
import { AdssModel } from "../models/adss.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { DepartamentoModel } from "../models/departamento.model.js";
import { MaterialModel } from "../models/material.model.js";
import { ObsModel } from "../models/obs.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { TipoObsModel } from "../models/tipoObs.model.js";
import { TramoModel } from "../models/tramo.model.js";
import { UsuarioModel } from "../models/usuario.model.js";
import { can } from "../permissions/store.js";
import { INCLUDE_TRAMO, nombreDeUsuario, presentarTramo, type TramoPresentado } from "../tramos/presentacion.js";
import { log } from "../utils/logger.js";
import { makeHandler } from "../utils/handler.js";

const opcionesLog = log("opciones");
const handler = makeHandler(opcionesLog);

/**
 * Any of the six catalogue models, as far as this file is concerned.
 *
 * Structural rather than `ModelDefined<A, B>`: each model is generic over its
 * own attribute interface, so no single instantiation accepts all six, and the
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
/**
 * A city the network editor is going to draw and edit: the same, plus its photo.
 *
 * Kept apart from `CIUDAD_DIBUJABLE` on purpose: the pole and report forms only
 * need to place a city, and the photo is a column they have no use for. `image` is
 * nullable on the model, so a city may come back without one.
 */
const CIUDAD_EDITABLE = [...CIUDAD_DIBUJABLE, "image"] as const;
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
 * "los archivados no viajan" is satisfied: all six models are `paranoid: true`,
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
 * Every live tramo, presented and in the order of its name.
 *
 * All of them, with poles or without: a tramo created a minute ago has none,
 * and it is exactly the one the pole form is about to need. The earlier version
 * of this block derived the pairs from the pole register and so could only
 * ever offer stretches that already had a pole on them.
 *
 * The tramo is read paranoid — an archived stretch is not a choice — but its
 * two cities are not, so one that was archived still gives the tramo its name.
 */
const tramosVivos = async (): Promise<TramoPresentado[]> => {
  const filas = await TramoModel.findAll({
    attributes: INCLUDE_TRAMO.attributes,
    include: INCLUDE_TRAMO.include,
    order: [["id", "ASC"]],
  });
  return filas.map(presentarTramo).sort((a, b) => (a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : a.id - b.id));
};

/** The nine departments, in the order they were seeded: the order people recite them in. */
const departamentos = () =>
  DepartamentoModel.findAll({ attributes: [...NOMBRE], order: [["id", "ASC"]], raw: true });

/**
 * `postes:ver`, and the pole form's lists in one round trip: the four
 * catalogues, the tramos a pole can stand on and the departments.
 *
 * **`ver` is not what every caller is gated by, and this paragraph used to name
 * the wrong screens.** It said `poste/index.tsx` and `PosteSheet` render behind
 * `editar`/`crear` and not `ver`; C2's audit measured it and both actually hang
 * off `<ModuleRoute modulo="postes">`, which already demands `postes.ver` and
 * redirects without it. Neither is reachable by the role the paragraph
 * described. The two places where the gap is real are:
 *
 *   - **the home screen**, which requires `eventos.ver` and opens `PosteSheet`
 *     behind `postes.editar` alone. A role with those two and without
 *     `postes.ver` used to fill the form and now cannot;
 *   - **`EventoSheet` opened from the pole screens**, for the same shape of
 *     reason against `/api/evento/options`.
 *
 * No seeded role is in either position — all three have `ver` wherever they have
 * `editar`. And the seed is proof for now, which is worth stating precisely
 * because the first version of this paragraph overstated it: production runs
 * `master`, where the permission matrix does not exist at all — the roles are
 * three constants compiled into the client bundle — so no custom role can exist
 * out there today. What changes that is the cut (§11), which ships the matrix
 * editor; from then on anybody can make one of these roles in two clicks. Both
 * screens now say what happened instead of showing an empty form: see
 * `estadoOpciones` in each.
 *
 * Worth knowing beside it: `GET /api/poste/` and `/:id` are gated by the same
 * `postes.ver` (see `poste.routes.ts`), so this endpoint asks no more than the
 * pole list itself does.
 */
export const getOpcionesPoste = handler("getOpcionesPoste", async (_req: Request, res: Response) => {
  const [adss, material, propietario, ciudad, tramos, departamento] = await Promise.all([
    lista(AdssModel, NOMBRE),
    lista(MaterialModel, NOMBRE),
    lista(PropietarioModel, NOMBRE),
    lista(CiudadModel, CIUDAD_DIBUJABLE),
    tramosVivos(),
    departamentos(),
  ]);
  res.status(200).json({ adss, material, propietario, ciudad, tramos, departamento });
});

/**
 * `eventos:ver`, for both incident forms.
 *
 * Deliberately without a `poste` block, and C5 sharpened the reason rather than
 * retiring it. `AddEventoPageSheet` does need the list of poles, and it asks
 * `GET /api/poste/?limit=all` for it — which since C5 costs `postes.ver`.
 * Folding the register in here would serve it under `eventos.ver` instead,
 * which is now not merely untidy: it would hand the whole pole register to a
 * role that C5 just decided may not read it, through the back door of a form's
 * dropdown. The two loads stay separate, and the sheet says which one was
 * refused.
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
 * The widest of the three. `reportes` has exactly one action in the permission
 * vocabulary — `ver` — so it is the only pair this route could ask for.
 */
export const getOpcionesReporte = handler("getOpcionesReporte", async (_req: Request, res: Response) => {
  const [ciudad, adss, material, propietario, obs, tramos] = await Promise.all([
    lista(CiudadModel, CIUDAD_DIBUJABLE),
    lista(AdssModel, NOMBRE),
    lista(MaterialModel, NOMBRE),
    lista(PropietarioModel, NOMBRE),
    lista(ObsModel, NOMBRE),
    tramosVivos(),
  ]);
  res.status(200).json({ ciudad, adss, material, propietario, obs, tramos });
});

/** Every live account as the encargado picker shows it, by name. `findAll` is paranoid. */
const usuariosVivos = async (): Promise<{ id: number; nombre: string }[]> => {
  const filas = (await UsuarioModel.findAll({ attributes: ["id", "name", "lastname"], raw: true })) as unknown as
    { id: number; name: string | null; lastname: string | null }[];
  return filas
    .map((u) => ({ id: u.id, nombre: nombreDeUsuario(u) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
};

/**
 * `tramos:ver`, for the tramo dialog and the network map on the Tramos screen.
 *
 * The cities carry `lat` and `lng`: the map draws every live city from this
 * list, including those that have no tramo yet, which `GET /api/tramo/` cannot
 * give it because it only knows cities through the tramos they end. They also
 * carry `image`, which the map's city card shows and replaces.
 *
 * The same dialog opened from the pole form does not come here: that form is
 * reached with `postes.*` and possibly without `tramos.ver`, and it already
 * holds both lists from `/api/poste/options`.
 *
 * `usuarios` is the encargado picker of the tramo card, and only for somebody
 * who can use it (`tramos.editar`). `GET /api/usuario/` asks `seguridad.ver`,
 * which a tramo editor usually lacks; an id and a name of each live account is
 * all a picker needs, and nothing of the security record comes with it.
 */
export const getOpcionesTramo = handler("getOpcionesTramo", async (req: Request, res: Response) => {
  const editor = await can(req.user?.id_rol, "tramos", "editar");
  const [ciudad, departamento, usuarios] = await Promise.all([
    lista(CiudadModel, CIUDAD_EDITABLE),
    departamentos(),
    editor ? usuariosVivos() : Promise.resolve(undefined),
  ]);
  res.status(200).json({ ciudad, departamento, ...(usuarios ? { usuarios } : {}) });
});

