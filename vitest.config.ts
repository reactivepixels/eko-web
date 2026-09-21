import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The engine accepts an injected AudioContext, so unit tests run in plain Node
    // with a MockAudioContext, so no jsdom or browser is needed for the pure logic.
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
