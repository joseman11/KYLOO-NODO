import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 180_000,
    reporters: ["default"],
  },
});
