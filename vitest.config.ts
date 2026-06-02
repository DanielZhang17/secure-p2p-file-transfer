import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    passWithNoTests: true,
    setupFiles: ["src/client/test/setup.ts"],
    include: ["src/client/**/*.test.ts", "src/shared/**/*.test.ts"],
  },
});
