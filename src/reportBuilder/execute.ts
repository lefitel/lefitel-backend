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
 * How many rows the report would return, without materialising any of them.
 *
 * An export has to know the size before it starts: pulling fifty thousand rows
 * into memory only to refuse them is the failure the cap exists to prevent.
 */
export async function countReport(config: ReportConfig, role: number): Promise<number> {
  const counted = buildCountQuery(config, role);

  return sequelize.transaction(async (transaction: Transaction) => {
    await sequelize.query(`SET LOCAL statement_timeout = ${Number(STATEMENT_TIMEOUT_MS)}`, {
      transaction,
    });
    const rows = await sequelize.query<{ total: number }>(counted.sql, {
      bind: counted.binds,
      type: QueryTypes.SELECT,
      transaction,
    });
    return Number(rows[0]?.total ?? 0);
  });
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
    // READ COMMITTED gives each statement its own snapshot, so a concurrent
    // insert between the rows query and the count query would report a total
    // that does not match what came back.
    await sequelize.query("SET LOCAL TRANSACTION ISOLATION LEVEL REPEATABLE READ", {
      transaction,
    });

    const rows = await sequelize.query<Record<string, unknown>>(built.sql, {
      bind: built.binds,
      type: QueryTypes.SELECT,
      transaction,
    });

    const totalRows = await sequelize.query<{ total: number }>(counted.sql, {
      bind: counted.binds,
      type: QueryTypes.SELECT,
      transaction,
    });

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
