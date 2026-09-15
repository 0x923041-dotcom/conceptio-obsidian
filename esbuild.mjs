// Bundles main.ts into the single `main.js` an Obsidian plugin ships.
// `obsidian`, Electron and CodeMirror are provided by the host and stay
// external; Node built-ins (child_process) are available on desktop, which is
// the only platform this plugin targets (`isDesktopOnly: true`).
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

await esbuild.build({
  entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
  bundle: true,
  outfile: fileURLToPath(new URL("./main.js", import.meta.url)),
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
