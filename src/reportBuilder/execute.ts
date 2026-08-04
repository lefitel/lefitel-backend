// Runs a built query against the database.
//
// Kept apart from sqlBuilder so the builder stays a pure function that can be
// tested without a database.

import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { buildCountQuery, buildQuery } from "./sqlBuilder.js";
import { STATEMENT_TIMEOUT_MS } from "./catalog.js";
import type { BuiltQuery, ReportConfig } from "./types.js";

export interface ReportResult {
  columns: BuiltQuery["columns"];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Executes the report inside a transaction with a statement timeout, so a
 * badly shaped report degrades into an error instead of pinning the database.
 * The timeout is scoped with SET LOCAL, which reverts when the transaction ends.
 */
export async function runReport(config: ReportConfig, role: number): Promise<ReportResult> {
  const built = buildQuery(config, role);
  const counted = buildCountQuery(config, role);

  return sequelize.transaction(async (transaction: Transaction) => {
    await sequelize.query(`SET LOCAL statement_timeout = ${Number(STATEMENT_TIMEOUT_MS)}`, {
      transaction,
    });

    // `sequelize` is untyped in database/sequelize.ts, so the generic form of
    // .query() is unavailable here; the shape is asserted instead.
    const rows = (await sequelize.query(built.sql, {
      bind: built.binds,
      type: QueryTypes.SELECT,
      transaction,
    })) as Record<string, unknown>[];

    const totalRows = (await sequelize.query(counted.sql, {
      bind: counted.binds,
      type: QueryTypes.SELECT,
      transaction,
    })) as { total: number }[];

    // The last two binds are always limit and offset.
    const limit = Number(built.binds[built.binds.length - 2]);
    const offset = Number(built.binds[built.binds.length - 1]);

    return {
      columns: built.columns,
      rows,
      total: Number(totalRows[0]?.total ?? 0),
      limit,
      offset,
    };
  });
}
