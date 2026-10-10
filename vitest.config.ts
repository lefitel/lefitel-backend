import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only source tests. `npm run build` emits compiled copies into dist/, and
    // without this exclusion every test runs twice.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    /**
     * Fifteen seconds, where Vitest's default is five.
     *
     * The export tests do real work — `sharp` resizing a photograph, jsPDF
     * laying out a document — and the first one in each file also pays for
     * loading the library: about 2.5 s on an idle machine. Under a full run
     * they went over five. Measured across four full runs on 9 October: two
     * tests in `photos.test.ts` twice, then one in `pdf.test.ts` and one in
     * `export.integration.test.ts`, a different set each time, every one a
     * timeout and every one passing on its own.
     *
     * It matters more here than on a laptop: this suite is a gate in the
     * Dockerfile, so a timeout on a loaded build host aborts a deploy. Raised
     * for the suite rather than pinned per file, as `web/vitest.config.ts` did
     * for the same reason, so the next slow test does not rediscover it. A test
     * that genuinely hangs still fails, ten seconds later.
     */
    testTimeout: 15_000,
    /**
     * The suite runs with the second factor **mandatory**, which is not what
     * production runs with.
     *
     * `MFA_OBLIGATORIO` is off by default (see `mfaObligatorio` in
     * `src/config/security.ts`): a second factor is optional. But the mandatory
     * mode — the deadline, `onboarding`, the doors it opens — is still in the
     * code, one environment variable away from being live, and several hundred
     * tests across two dozen files are what hold it together. Leaving the
     * default here would switch all of them off at once and nobody would see it
     * happen: they would simply start asserting about a path that no longer
     * runs, or fail for a reason unrelated to what they test.
     *
     * So the default for tests is the mode with the most machinery in it, and
     * the optional mode is tested where it is decided — the blocks named
     * "with the second factor optional" in `factorInventory.test.ts` and
     * `sessionState.test.ts`, which turn this off with `vi.stubEnv`.
     */
    env: {
      MFA_OBLIGATORIO: "true",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // What is worth knowing the coverage of. Models are Sequelize
      // declarations, migrations run once and are verified by running them,
      // and `index.ts` is the boot sequence — counting them drags the number
      // around without telling anyone anything useful.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/models/**",
        "src/migrations/**",
        "src/interfaces/**",
        "src/index.ts",
      ],
    },
  },
});
