import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only source tests. `npm run build` emits compiled copies into dist/, and
    // without this exclusion every test runs twice.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
