import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["tests/setup/no-network.ts"],
  },
});
