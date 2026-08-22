// Runs a built query against the database.
//
// Kept apart from sqlBuilder so the builder stays a pure function that can be
// tested without a database.

import { QueryTypes, Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { buildCountQuery, buildQuery } from "./sqlBuilder.js";
import { STATEMENT_TIMEOUT_MS } from "./catalog.js";
import type { BuiltQuery, ReportConfig } from "./types.js";
import type { Viewer } from "./viewer.js";

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
export async function countReport(config: ReportConfig, viewer: Viewer): Promise<number> {
  const counted = buildCountQuery(config, viewer);

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

export interface RunOptions {
  /**
   * Called with the total before a single row is read, inside the same snapshot
   * the rows will come from.
   *
   * Exists for the export path, which has to refuse an oversized report without
   * materialising it. It used to do that with a separate `countReport` call, so
   * every export counted twice — two round trips, two plans of the same
   * aggregate — and the count that decided whether the file could be built came
   * from a different snapshot than the rows that went into it. Under a
   * concurrent insert the two disagreed, and the number printed in the header
   * was not the number of rows in the sheet.
   *
   * Throwing from here aborts the transaction, so a refusal costs one count and
   * no rows at all.
   */
  guard?: (total: number) => void;
}

/**
 * Executes the report inside a transaction with a statement timeout, so a
 * badly shaped report degrades into an error instead of pinning the database.
 * The timeout is scoped with SET LOCAL, which reverts when the transaction ends.
 */
export async function runReport(
  config: ReportConfig,
  viewer: Viewer,
  options: RunOptions = {},
): Promise<ReportResult> {
  const built = buildQuery(config, viewer);
  const counted = buildCountQuery(config, viewer);

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

    // Counted first, so `guard` can refuse before anything is read. Both
    // statements see the same snapshot, so the order carries no other meaning.
    const totalRows = await sequelize.query<{ total: number }>(counted.sql, {
      bind: counted.binds,
      type: QueryTypes.SELECT,
      transaction,
    });
    const total = Number(totalRows[0]?.total ?? 0);
    options.guard?.(total);

    const rows = await sequelize.query<Record<string, unknown>>(built.sql, {
      bind: built.binds,
      type: QueryTypes.SELECT,
      transaction,
    });

    // The last two binds are always limit and offset.
    const limit = Number(built.binds[built.binds.length - 2]);
    const offset = Number(built.binds[built.binds.length - 1]);

    return {
      columns: built.columns,
      rows,
      total,
      limit,
      offset,
    };
  });
}
