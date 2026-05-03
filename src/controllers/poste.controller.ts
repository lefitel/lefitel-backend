import { Request, Response } from "express";
import { literal, Op } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { deleteImageFile } from "../utils/fileUtils.js";
import { logAction } from "../utils/logAction.js";
import { AdssModel } from "../models/adss.model.js";
import { AdssPosteModel } from "../models/adssPoste.model.js";
import { CiudadModel } from "../models/ciudad.model.js";
import { MaterialModel } from "../models/material.model.js";
import { PosteModel } from "../models/poste.model.js";
import { PropietarioModel } from "../models/propietario.model.js";
import { UsuarioModel } from "../models/usuario.model.js";

export async function getPoste(req: Request, res: Response) {
  const { ciudadA, ciudadB, ciudadId, archived, page, limit, filterColumn, filterValue, export: isExport } = req.query;
  const isArchived = archived === "true";

  const where: Record<string, unknown> = isArchived
    ? { deletedAt: { [Op.ne]: null } }
    : ciudadId
    ? { [Op.or]: [{ id_ciudadA: Number(ciudadId) }, { id_ciudadB: Number(ciudadId) }] }
    : (ciudadA && ciudadB)
      ? {
          [Op.or]: [
            { id_ciudadA: Number(ciudadA), id_ciudadB: Number(ciudadB) },
            { id_ciudadA: Number(ciudadB), id_ciudadB: Number(ciudadA) },
          ],
        }
      : {};

  if (filterColumn && filterValue && typeof filterValue === "string" && filterValue.trim()) {
    if (filterColumn === "name") {
      where["name"] = { [Op.iLike]: `%${filterValue.trim()}%` };
    }
  }

  const queryOptions = {
    where,
    paranoid: !isArchived,
    order: [["id", ciudadA && ciudadB ? "ASC" : "DESC"]] as [[string, string]],
    attributes: {
      include: [[
        literal(`(SELECT COUNT(*) FROM "eventos" WHERE "eventos"."id_poste" = "poste"."id" AND "eventos"."state" = false AND "eventos"."deletedAt" IS NULL)`),
        "pendingEvents",
      ] as [ReturnType<typeof literal>, string]],
      exclude: ["image"],
    },
    include: [
      { model: MaterialModel, paranoid: false, attributes: ["id", "name"] },
      { model: PropietarioModel, paranoid: false, attributes: ["id", "name"] },
      { model: CiudadModel, as: "ciudadA", paranoid: false, attributes: ["id", "name"] },
      { model: CiudadModel, as: "ciudadB", paranoid: false, attributes: ["id", "name"] },
      { model: UsuarioModel, attributes: ["id", "name", "lastname"] },
    ],
  };

  try {
    if (isExport === "true") {
      const data = await PosteModel.findAll(queryOptions);
      return res.status(200).json(data);
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(15, Number(limit) || 50));
    const offset = (pageNum - 1) * limitNum;

    const { count, rows } = await PosteModel.findAndCountAll({
      ...queryOptions,
      limit: limitNum,
      offset,
    });

    return res.status(200).json({
      data: rows,
      total: count,
      page: pageNum,
      totalPages: Math.ceil(count / limitNum),
      limit: limitNum,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getTramos(_req: Request, res: Response) {
  try {
    const rows = await PosteModel.findAll({
      attributes: ["id_ciudadA", "id_ciudadB"],
      group: ["id_ciudadA", "id_ciudadB"],
      raw: true,
    }) as unknown as { id_ciudadA: number; id_ciudadB: number }[];
    // Tramos bidireccionales: dedup (a,b) y (b,a) usando min/max como clave.
    const seen = new Set<string>();
    const result: { id_ciudadA: number; id_ciudadB: number }[] = [];
    for (const { id_ciudadA, id_ciudadB } of rows) {
      const minId = Math.min(id_ciudadA, id_ciudadB);
      const maxId = Math.max(id_ciudadA, id_ciudadB);
      const key = `${minId}-${maxId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ id_ciudadA: minId, id_ciudadB: maxId });
    }
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createPoste(req: Request, res: Response) {
  try {
    const { adss_ids, ...posteBody } = req.body;
    const TempPoste = await sequelize.transaction(async (t) => {
      const poste = await PosteModel.create(posteBody, { transaction: t });
      const posteId = poste.dataValues.id as number;
      if (Array.isArray(adss_ids) && adss_ids.length > 0) {
        await Promise.all(
          (adss_ids as number[]).map((id_adss) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (AdssPosteModel as any).create({ id_adss, id_poste: posteId }, { transaction: t })
          )
        );
      }
      return poste;
    });
    const posteId = TempPoste.dataValues.id as number;

    let adssLabel: string | null = null;
    if (Array.isArray(adss_ids) && adss_ids.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adssRows = await (AdssModel as any).findAll({
        where: { id: adss_ids },
        attributes: ["name"],
        paranoid: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adssLabel = adssRows.map((r: any) => r.dataValues.name).join(", ") || null;
    }

    logAction({
      id_usuario: req.user?.id,
      action: "CREATE_POSTE",
      entity: "Poste",
      entity_id: posteId,
      detail: `Registró Poste ${posteBody.name}`,
      metadata: { after: { name: posteBody.name, ...(adssLabel ? { adss: adssLabel } : {}) } },
      severity: 'info',
    });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function searchPoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempPoste = await PosteModel.findOne({
      where: { id },
      include: [
        { model: MaterialModel, paranoid: false },
        { model: PropietarioModel, paranoid: false },
        { model: CiudadModel, as: "ciudadA", paranoid: false },
        { model: CiudadModel, as: "ciudadB", paranoid: false },
        { model: UsuarioModel },
      ],
    });
    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function updatePoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const TempPoste = await PosteModel.findOne({ where: { id } });
    if (!TempPoste) return res.status(404).json({ message: "Poste no encontrado" });
    const oldImage = TempPoste.dataValues.image;
    const dv = TempPoste.dataValues as unknown as Record<string, unknown>;

    const { adss_ids, ...bodyWithoutAdss } = req.body;

    const isPrimVal = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
    const fkKeys = new Set(["id_propietario", "id_material", "id_ciudadA", "id_ciudadB"]);
    const beforeMeta: Record<string, unknown> = {};
    const afterMeta:  Record<string, unknown> = {};

    for (const k of Object.keys(bodyWithoutAdss)) {
      const bv = dv[k];
      if (bv === undefined || fkKeys.has(k)) continue;
      if (isPrimVal(bv) && isPrimVal(bodyWithoutAdss[k])) { beforeMeta[k] = bv; afterMeta[k] = bodyWithoutAdss[k]; }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fkRef = async (Model: any, pkVal: number | null | undefined) => {
      if (pkVal == null) return null;
      const row = await Model.findByPk(pkVal, { attributes: ["id", "name"], paranoid: false });
      return row ? { id: row.dataValues.id, name: row.dataValues.name } : null;
    };
    await Promise.all((
      [["id_propietario", PropietarioModel], ["id_material", MaterialModel], ["id_ciudadA", CiudadModel], ["id_ciudadB", CiudadModel]] as [string, unknown][]
    ).map(async ([k, Model]) => {
      const bv = dv[k] as number | null | undefined;
      const av = bodyWithoutAdss[k] as number | null | undefined;
      if (bv === undefined || bv === av) return;
      [beforeMeta[k], afterMeta[k]] = await Promise.all([fkRef(Model, bv), fkRef(Model, av)]);
    }));

    let adssLogData: { before: string | null; after: string | null } | null = null;

    await sequelize.transaction(async (t) => {
      TempPoste.set(bodyWithoutAdss);
      await TempPoste.save({ transaction: t });

      if (Array.isArray(adss_ids)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentAdssPoste = await (AdssPosteModel as any).findAll({ where: { id_poste: id }, transaction: t });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const currentIds = currentAdssPoste.map((a: any) => a.dataValues.id_adss as number);
        const toAdd = (adss_ids as number[]).filter((aid) => !currentIds.includes(aid));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toRemove = currentAdssPoste.filter((a: any) => !(adss_ids as number[]).includes(a.dataValues.id_adss as number));

        if (toAdd.length > 0 || toRemove.length > 0) {
          const allIds = [...new Set([...currentIds, ...(adss_ids as number[])])];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const allRows = await (AdssModel as any).findAll({ where: { id: allIds }, attributes: ["id", "name"], paranoid: false, transaction: t });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nameMap = new Map(allRows.map((r: any) => [r.dataValues.id as number, r.dataValues.name as string]));
          const beforeAdss = currentIds.map((aid: number) => nameMap.get(aid)).filter(Boolean).join(", ");
          const afterAdss = (adss_ids as number[]).map((aid) => nameMap.get(aid)).filter(Boolean).join(", ");

          await Promise.all([
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...toAdd.map((id_adss: number) => (AdssPosteModel as any).create({ id_adss, id_poste: Number(id) }, { transaction: t })),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...toRemove.map((a: any) => a.destroy({ transaction: t })),
          ]);

          adssLogData = { before: beforeAdss || null, after: afterAdss || null };
        }
      }
    });

    if (oldImage && bodyWithoutAdss.image && oldImage !== bodyWithoutAdss.image) {
      deleteImageFile(oldImage);
    }
    if (Object.keys(beforeMeta).some(k => beforeMeta[k] !== afterMeta[k])) {
      logAction({ id_usuario: req.user?.id, action: "UPDATE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Editó Poste #${id}`, metadata: { before: beforeMeta, after: afterMeta }, severity: 'warning' });
    }
    if (adssLogData) {
      logAction({
        id_usuario: req.user?.id,
        action: "UPDATE_ADSS_POSTE",
        entity: "Poste",
        entity_id: Number(id),
        detail: `Actualizó ADSS del Poste #${id}`,
        metadata: { before: { adss: adssLogData.before }, after: { adss: adssLogData.after } },
        severity: 'warning',
      });
    }

    res.status(200).json(TempPoste);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function deletePoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PosteModel.destroy({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "DELETE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Archivó Poste #${id}`, severity: 'critical' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
export async function desarchivarPoste(req: Request, res: Response) {
  const { id } = req.params;
  try {
    await PosteModel.restore({ where: { id } });
    logAction({ id_usuario: req.user?.id, action: "RESTORE_POSTE", entity: "Poste", entity_id: Number(id), detail: `Desarchivó Poste #${id}`, severity: 'info' });
    return res.sendStatus(200);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
