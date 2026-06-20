import { defineConfig } from "vitest/config";

// A jsdom environment so React Testing Library can render components into a DOM.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
  },
});
