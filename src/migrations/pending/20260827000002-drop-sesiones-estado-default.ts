import { QueryInterface } from "sequelize";

// 🔴 **THIS FILE IS PARKED. It is not in the migration set, and that is the
// point of the directory it sits in.**
//
// `migrate:deploy` applies everything outstanding in one pass — it takes no
// argument naming which migrations to run — so a file this migration's
// siblings can see is a file that runs on the next deploy. This one must not,
// for the reason spelled out below, and "remember not to deploy it yet" is not
// a mechanism.
//
// The mechanism is the path. `database/migrate.ts` globs
// `../migrations/*.{ts,js}`, and a single `*` does not cross a directory
// separator, so nothing under `migrations/pending/` is discovered — in
// development and, because `tsc` mirrors the tree, in `dist/` too. Verified
// against umzug's own glob library (`tinyglobby`) with that exact pattern and
// ignore list: a file one level down is not returned, a sibling is.
//
// **To arm it:** move this file and its test up one level into
// `src/migrations/`. Nothing else — no rename, no registration, no edit. The
// glob picks it up and the next `migrate:deploy` runs it. Do that only once
// the entry requirement below is satisfied.
//
// Its test runs where it is, because vitest globs the whole tree rather than
// this one directory, so parking the file does not park its proof.
//
// ---
//
// Finishes what `20260827000001` started and then backed out of:
// `sesiones.estado` loses its `DEFAULT 'completa'`.
//
// **Why this is its own migration instead of folded back into that one.**
// `DEFAULT 'completa'` was added by `20260826000002` to satisfy exactly one
// statement — the `ALTER TABLE` that introduced the column had to put
// something into the rows that already existed — and it should have expired
// the moment that statement committed. Nobody removed it, and while it
// stands, `estado` — which is the whole of what a session is allowed to do —
// has a value the database hands out when nobody asks for one. `createSession`
// (`src/auth/sessionStore.ts`) is built against the opposite decision: it
// takes no default for `estado` on purpose, "so the compiler asks at each
// call site which state this login deserves". A raw INSERT bypasses that
// compiler question entirely, and this default is what lets it succeed
// anyway — a rescue script, a seed, a `bulkInsert`, a `.create(...)` that
// forgets the field, each minting a session with the run of the whole ERP and
// no trace the decision was ever taken. That reasoning is sound, and it used
// to live in `20260827000001`'s header.
//
// 🔴 **Its entry requirement, and it is a hard one: do not apply this to a
// database any previous-image deploy could still reach.** The previous
// image's `createSession` predates the `estado` column and does not name it
// in its INSERT — `DEFAULT 'completa'` is the *only* thing that makes that
// INSERT legal. Measured with the project's own umzug, against the schema
// `20260827000001` produces: the same INSERT, run before this migration,
// succeeds; run after it, it dies on
// `el valor nulo en la columna «estado» de la relación «sesiones» viola la
// restricción "not-null"`.
//
// That failure is silent in the sense that matters most for anyone already
// in — sessions already open keep working, because the old code never
// selects a column it does not know about — and it is loud in the sense that
// reaches someone new: every *new* login on the old image starts failing, as
// a 503 that names "a dependency" (`src/auth/issueSession.ts`), with nothing
// pointing at this migration as the reason. `20260827000001`'s `up` runs
// inside the deploy order the specification mandates (migrations, then the
// new image, with no gap `migrate:deploy` leaves open on its own); this one
// must not run inside that order at all, because the whole point of that
// order is that the previous image is still serving traffic until the new
// one is up. Run this only once the previous image is fully retired from the
// fleet — which is also the point at which the specification's "roll the
// image back, leave the schema" rollback stops being an option, since that
// rollback depends on this exact default still standing.
//
// The rule the two migrations disagree on, on purpose: default the facts,
// never the policy. A fact — `created_at` say — is always correctly filled
// in by a default, so `20260827000001` gives four of them one. `estado` is a
// policy: the value a default supplies is a decision about privilege, wrong
// whenever the caller had a different answer to give, and it is what this
// migration removes.

export async function up({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // House rule for every migration here: a long-running query holding a
    // lock should make the migration fail fast and get retried, not queue
    // whatever else is touching this table behind it.
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ALTER COLUMN estado DROP DEFAULT",
      { transaction },
    );
  });
}

/**
 * Restores `DEFAULT 'completa'`.
 *
 * Correct only inside the same window `up` must never run in: while a
 * previous image without `estado` in its INSERT is still reachable. Outside
 * that window this reopens exactly the hole `up` closed — a raw INSERT that
 * forgets `estado` goes back to minting a session with the run of the whole
 * ERP, silently. Faithful rather than opinionated regardless, for the same
 * reason every `down` in this folder is: a `down` that improves on the state
 * it reverts to is a `down` whose dump no longer matches.
 */
export async function down({ context: queryInterface }: { context: QueryInterface }) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction });

    await queryInterface.sequelize.query(
      "ALTER TABLE sesiones ALTER COLUMN estado SET DEFAULT 'completa'",
      { transaction },
    );
  });
}
