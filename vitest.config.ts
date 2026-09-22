import { defineConfig } from "vitest/config";
import * as path from "node:path";

// The real `obsidian` module is a desktop runtime surface (and its npm package
// is types + a stub). Tests get a local stub of exactly the API the plugin
// uses, aliased here — the pattern every client tree uses for its own runtime
// module.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/stubs/obsidian.ts"),
    },
    // The bundle Obsidian loads is `main.js`, sitting next to `main.ts`. Vite's
    // default order prefers `.js`, so `import ... from "../main"` in a test
    // resolves to the BUILD ARTIFACT once `npm run build` has run — the suite
    // passes before a build and fails after one (`Cannot find module
    // 'obsidian'`, since the bundle requires the external at runtime). Source
    // first makes the two orders identical by construction.
    extensions: [".ts", ".mts", ".js", ".mjs", ".json"],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
