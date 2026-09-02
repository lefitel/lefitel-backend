// The command that rewrites every `factor_totp` row onto a new encryption
// key — finding B4 and Decision 3 of `docs/plans/2026-09-01-factores-mfa.md`.
//
// **Built against the plan author's own recommendation, and built anyway,
// because the alternative loses data.** `key_version` has existed on
// `factor_totp` since the 4A migration with nothing that ever changes it. A
// script improvised the day a rotation is actually needed — one big
// `UPDATE ... SET key_version = 2` after re-encrypting everything in memory —
// is exactly the shape that turns "the process died at row 40 of 60" into
// twenty TOTP secrets nobody can ever decrypt again, because the variable
// that opened them is the one step 5 of the documented procedure
// (`docs/specs/2026-08-21-autenticacion-mfa-design.md` §9) removes from the
// environment once the rotation is believed finished.
//
// **The one property everything below serves: dying half way has to be
// safe to resume from, not merely safe to notice.** Concretely:
//
//   1. One row, one `sequelize.transaction()` call, never a transaction that
//      spans more than one row. A single transaction wrapping the whole
//      table looks tidier and is worse two different ways: if the process
//      dies, Postgres rolls the entire thing back and not one row actually
//      moved despite however long the process ran; and if somebody runs this
//      by hand with autocommit quietly enabled outside a transaction block,
//      every row that already got its `UPDATE` executed stays changed with
//      no way to tell where the run stopped. Per-row transactions turn
//      "where did it stop" into a question the table itself answers.
//   2. "What is left to do" is never a list computed once at the top and
//      then walked — it is `WHERE key_version <> :activa`, asked fresh
//      before every single row. A second invocation of this exact command,
//      run five minutes or five days after the first one died, asks the
//      same question and gets the true answer: whatever the first run did
//      not finish, and nothing it already did.
//   3. Every write touches `secreto_cifrado`, `iv`, `auth_tag` and
//      `key_version` in the one `UPDATE` statement — see `mfaCrypto.ts`'s own
//      header for why splitting those four across two statements is
//      "legal SQL, ciphertext nobody can open again."
//
// **The AAD comes from `auth/totpStore.ts`'s own `aadDeFactorTotp`, never a
// local copy of the string.** Decision 6 of the plan ties the AAD to
// `factor_totp.id` (never `id_usuario`, which cascades on an id merge and
// would silently point the AAD at the wrong value) — but the *exact* string
// is Task 4's call, not this script's. Task 4 was built after this file's
// first draft, which had guessed `` `factor_totp:${id}` `` here while
// `totpStore.ts` actually settled on `` `factor:${id}` `` — a real,
// documented mismatch (`totpStore.ts`'s own module header names this file by
// path) that would have made every single row fail to decrypt the moment it
// went through a rotation, loud and safe inside that row's own transaction,
// before any write, but still wrong. Importing the function instead of
// hard-coding the string is what makes that class of drift impossible going
// forward: if `aadDeFactorTotp` ever changes, this script changes with it
// automatically instead of silently falling out of sync again.
//
// **Two run commands, same reason `src/scripts/rescue.ts` has two.** `tsx` —
// what `npm run dev` uses everywhere in this project — is a `devDependency`,
// and the production Dockerfile's runtime stage does `npm ci --omit=dev`:
// nothing that only `tsx` can run survives the build. `tsconfig.json`
// includes `src/scripts/`, so `npm run build` emits `dist/scripts/`, and the
// same stage that ships `dist/` also ships `package.json` — which is what
// makes `auth:rotate-mfa-key:deploy` resolve inside the running container.
//
//   npm run auth:rotate-mfa-key          (development, via tsx)
//   npm run auth:rotate-mfa-key:deploy   (the container, via node dist/)

import { pathToFileURL } from "node:url";
import { Op, Transaction } from "sequelize";
import { sequelize } from "../database/sequelize.js";
import { FactorTotpModel } from "../models/factorTotp.model.js";
import { llaveActiva, llavePorVersion } from "../auth/mfaKeyring.js";
import { cifrar, descifrar } from "../auth/mfaCrypto.js";
import { aadDeFactorTotp } from "../auth/totpStore.js";
import type { IFactorTotp } from "../interfaces/index.js";

export const USO = `Reescribe cada fila de "factor_totp" bajo la clave de cifrado activa
(MFA_ENCRYPTION_KEY_ACTIVE), descifrando con la clave que su propia
"key_version" indica.

Uso:
  npm run auth:rotate-mfa-key
  npm run auth:rotate-mfa-key:deploy   (en el contenedor de producción)

Se puede interrumpir y volver a lanzar tantas veces como haga falta: cada
fila se convierte en su propia transacción, así que lo que ya se convirtió
se queda convertido y una segunda ejecución solo trabaja sobre lo que falta.

Si una fila no se puede descifrar (un "auth_tag" dañado, una "key_version"
sin clave configurada), el comando la marca IRRECUPERABLE y sigue con las
demás — no se queda atascado repitiendo la misma fila. El resumen final
distingue "pendientes" (lo que aún falta por intentar) de "irrecuperables"
(lo que este intento encontró roto); revísalo siempre al terminar.

🔴 NO BORRES LA CLAVE VIEJA (MFA_ENCRYPTION_KEY_<n> de la versión anterior)
HASTA QUE ESTE COMANDO TERMINE Y CONFIRME "0" FILAS PENDIENTES. Si termina
con alguna fila irrecuperable, NO la borres: sigue siendo la única clave que
podría llegar a abrirla. Borrar la clave vieja con filas pendientes o
irrecuperables las deja ilegibles para siempre — es el único paso de todo el
procedimiento que pierde datos. Ver el procedimiento completo en
docs/specs/2026-08-21-autenticacion-mfa-design.md §9.`;

/** What one full (or resumed) run of the rotation found and did. */
export interface ResultadoRotacion {
  totalFilas: number;
  yaEnVersionActiva: number;
  pendientesAlEmpezar: number;
  filasRotadas: number;
  /**
   * Rows this run tried to decrypt and could not — a tampered `auth_tag`
   * from a partial restore, or a `key_version` naming a key that was never
   * configured (or already removed). See finding A2: distinct from
   * `pendientesAlTerminar` in what it means for the operator, even though
   * the two numbers agree at the end of a run started with none excluded.
   * `pendientesAlTerminar` is "what the database says is left"; this is
   * "what this run actually found broken", which is what earns the row the
   * word *irrecuperable* rather than merely *pendiente*.
   */
  filasIrrecuperables: number;
  pendientesAlTerminar: number;
}

/** What `rotarUnaFila` found and did with the one row it picked. */
type ResultadoFila =
  | { tipo: "nada" }
  | { tipo: "rotada" }
  | { tipo: "irrecuperable"; id: number; motivo: string };

/**
 * Converts one pending row inside its own transaction, reports that there
 * was nothing left to convert, or reports that the row it picked could not
 * be decrypted — finding A2.
 *
 * The row is chosen and read with `Transaction.LOCK.UPDATE` **inside** this
 * same transaction — not by a separate query run before it — so there is no
 * gap between "this is the row we picked" and "this is the row we have
 * locked" for another writer (a live TOTP verification sealing `ultimo_paso`
 * on the very row being rotated) to land in.
 *
 * `idsIrrecuperables` excludes rows this same run already found unreadable.
 * Without it, `ORDER BY id ASC` would hand back that exact row again on
 * every iteration — the row never changes, so nothing about the query's
 * result ever would either — and the loop below could never reach a single
 * row past it, healthy or not.
 */
async function rotarUnaFila(
  versionActiva: number,
  idsIrrecuperables: readonly number[],
): Promise<ResultadoFila> {
  return sequelize.transaction(async (t) => {
    // `raw: true` returns a plain object, not a Model instance — same
    // convention as every other raw read in this codebase (see
    // `permissions/store.ts`, `controllers/opciones.controller.ts`), and the
    // reason for the cast: Sequelize's own typings for `.findOne` do not
    // narrow based on the `raw` option.
    const fila = (await FactorTotpModel.unscoped().findOne({
      where: {
        key_version: { [Op.ne]: versionActiva },
        ...(idsIrrecuperables.length > 0 ? { id: { [Op.notIn]: idsIrrecuperables } } : {}),
      },
      order: [["id", "ASC"]],
      raw: true,
      transaction: t,
      lock: Transaction.LOCK.UPDATE,
    })) as unknown as IFactorTotp | null;
    if (!fila) return { tipo: "nada" as const };

    const aad = aadDeFactorTotp(fila.id);
    let secretoPlano: string;
    try {
      secretoPlano = descifrar(
        {
          ciphertext: fila.secreto_cifrado,
          iv: fila.iv,
          auth_tag: fila.auth_tag,
          key_version: fila.key_version,
        },
        aad,
      );
    } catch (err) {
      // Caught here, not left to propagate: a decrypt failure on *this* row
      // says nothing about any other row, and re-throwing would abort the
      // whole run over one row that was never going to become readable by
      // retrying it. Nothing was written — the row is left exactly as found,
      // and the transaction commits empty (the same as finding no pending
      // row at all). Deliberately not the caught error's own generic
      // `.message` scrubbed the way `mfaKeyCheck.ts` does for finding B12:
      // this runs on an operator's own terminal, not behind an API response
      // an unprivileged caller could probe, and the underlying reason
      // (`"MFA_ENCRYPTION_KEY_3 no está configurada"` vs. a tag mismatch) is
      // exactly what they need to tell "restore the missing key" apart from
      // "this row is actually corrupt".
      return {
        tipo: "irrecuperable" as const,
        id: fila.id,
        motivo: err instanceof Error ? err.message : String(err),
      };
    }
    // Re-encrypting through `cifrar()` (never a hand-rolled cipher call) is
    // what guarantees a fresh IV here — see `mfaCrypto.ts`'s own header on
    // why reusing one is a break, not a degradation. Left outside the `try`
    // above on purpose: a failure here means the *active* key itself is
    // broken, which every remaining row would hit identically — that is a
    // reason to stop the whole run loudly, not to label one row
    // irrecuperable and move on.
    const cifrado = cifrar(secretoPlano, aad);

    // The four columns, one `UPDATE`, exactly as `mfaCrypto.ts` requires.
    await FactorTotpModel.update(
      {
        secreto_cifrado: cifrado.ciphertext,
        iv: cifrado.iv,
        auth_tag: cifrado.auth_tag,
        key_version: cifrado.key_version,
      },
      { where: { id: fila.id }, transaction: t },
    );
    return { tipo: "rotada" as const };
  });
}

/**
 * The whole rotation, resumable by construction. Throws — without ever
 * having attempted a single write — if `MFA_ENCRYPTION_KEY_ACTIVE` names a
 * version the keyring does not actually have; a rotation cannot begin
 * without an active key, and there is nothing to roll back because nothing
 * happened yet.
 *
 * Otherwise loops one row and one transaction at a time until a transaction
 * finds nothing left with `key_version <>` the active version — which is
 * also the exit condition on a resumed run where every row was already
 * converted: the very first call finds nothing pending and the loop never
 * executes.
 */
export async function rotarClaveMfa(): Promise<ResultadoRotacion> {
  const activa = llaveActiva();
  // Confirm the version this row-by-row loop will decrypt *into* is itself
  // openable — `llaveActiva()` already validated it, but calling
  // `llavePorVersion` here too costs nothing and reads as the same
  // "the active key actually resolves" guarantee `mfaKeyCheck.ts` (Task 2)
  // performs at boot, applied to this command's own entry point.
  llavePorVersion(activa.version);

  const totalFilas = await FactorTotpModel.unscoped().count();
  const pendientesAlEmpezar = await FactorTotpModel.unscoped().count({
    where: { key_version: { [Op.ne]: activa.version } },
  });
  const yaEnVersionActiva = totalFilas - pendientesAlEmpezar;

  console.log(
    `Filas en factor_totp: ${totalFilas}. Ya en la versión activa (${activa.version}): ` +
      `${yaEnVersionActiva}. Pendientes de rotar: ${pendientesAlEmpezar}.`,
  );

  if (pendientesAlEmpezar === 0) {
    console.log("Nada que rotar: todas las filas ya están en la versión activa.");
    return {
      totalFilas,
      yaEnVersionActiva,
      pendientesAlEmpezar,
      filasRotadas: 0,
      filasIrrecuperables: 0,
      pendientesAlTerminar: 0,
    };
  }

  let filasRotadas = 0;
  // Ids this run has already found unreadable — excluded from every
  // subsequent pick so the loop keeps making progress on the rest instead of
  // reselecting the same broken row forever (finding A2).
  const idsIrrecuperables: number[] = [];
  const detallesIrrecuperables: string[] = [];

  // Re-asks "is there a pending row" fresh on every iteration (inside
  // `rotarUnaFila`'s own transaction) rather than walking a list fetched
  // once up front — see the module header, point 2. Loops until nothing is
  // left to even attempt, not until nothing is left to *convert*: an
  // irrecuperable row does not stop the loop, it narrows what the next pick
  // is allowed to choose.
  for (;;) {
    const resultado = await rotarUnaFila(activa.version, idsIrrecuperables);
    if (resultado.tipo === "nada") break;
    if (resultado.tipo === "irrecuperable") {
      idsIrrecuperables.push(resultado.id);
      const detalle = `factor_totp.id=${resultado.id}: ${resultado.motivo}`;
      detallesIrrecuperables.push(detalle);
      console.error(`Fila irrecuperable, se salta (${detalle}).`);
      continue;
    }
    filasRotadas++;
    console.log(`Fila rotada (${filasRotadas}/${pendientesAlEmpezar}).`);
  }

  const pendientesAlTerminar = await FactorTotpModel.unscoped().count({
    where: { key_version: { [Op.ne]: activa.version } },
  });

  if (pendientesAlTerminar === 0) {
    console.log(
      `Terminado. Todas las filas están en la versión activa (${activa.version}). Ya puedes ` +
        "borrar la clave vieja: no queda ninguna fila que dependa de ella.",
    );
  } else {
    // Deliberately never this message when `pendientesAlTerminar > 0`: those
    // rows are exactly the irrecuperable ones (nothing else can make the
    // loop above stop while still leaving a row behind), and telling the
    // operator to delete the one key that could still open them is how
    // finding A1 turns from "possible" into "certain".
    console.error(
      `Terminado con ${pendientesAlTerminar} fila(s) irrecuperable(s), fuera de la versión ` +
        `activa (${activa.version}):\n` +
        detallesIrrecuperables.map((d) => `  - ${d}`).join("\n") +
        "\nNO borres la clave vieja: mientras estas filas sigan así, sigue siendo la única " +
        "clave que podría llegar a abrirlas. Revísalas a mano antes de continuar (ver " +
        "docs/specs/2026-08-21-autenticacion-mfa-design.md §9).",
    );
  }

  return {
    totalFilas,
    yaEnVersionActiva,
    pendientesAlEmpezar,
    filasRotadas,
    filasIrrecuperables: idsIrrecuperables.length,
    pendientesAlTerminar,
  };
}

/**
 * `process.argv.slice(2)` plus the exit code, the same split
 * `src/scripts/rescue.ts` uses so `run()` below is the only place that
 * decides when the process may actually end.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USO);
    return 0;
  }
  try {
    await rotarClaveMfa();
    return 0;
  } catch (err) {
    console.error(
      "La rotación no terminó por un error inesperado:",
      err instanceof Error ? err.message : String(err),
    );
    console.error(
      "Vuelve a ejecutar el mismo comando: las filas que ya se convirtieron se quedan " +
        "convertidas, solo se reintentan las que faltan.",
    );
    return 1;
  }
}

/**
 * `sequelize.close()` always runs, success or failure — same reason
 * `src/scripts/rescue.ts` has one: without it the connection pool keeps a
 * handle open and the process never exits on its own, which in a container
 * reads as the command hanging after it already printed its own result.
 *
 * Exported so `rotateMfaKey.test.ts` can assert `sequelize.close` ran on
 * both the clean path and the thrown-error path.
 */
export async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } finally {
    await sequelize.close();
  }
}

// Only when executed directly — the same guard `database/migrate.ts` and
// `src/scripts/rescue.ts` use, and for the identical reason: without it,
// importing this module (from a test, say) would rotate real keys as a side
// effect of the import itself.
const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  void run();
}
