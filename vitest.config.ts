import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only source tests. `npm run build` emits compiled copies into dist/, and
    // without this exclusion every test runs twice.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
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
