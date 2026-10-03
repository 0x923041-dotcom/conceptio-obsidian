/**
 * The committed bundle is a SHIPPED artifact, not a build product.
 *
 * Obsidian loads `main.js` verbatim, and so do BRAT and the community listing —
 * there is no build step on install. So a source change committed without a
 * rebuild ships the previous code, silently: every other test still passes
 * (they run against `main.ts`), the release looks complete, and the vault runs
 * something else. Same class as a public mirror falling behind its canonical
 * tree, so it gets the same treatment — one check that compares the artifact to
 * the source it claims to be built from.
 *
 * It runs the real `node esbuild.mjs` instead of repeating that file's options,
 * so this check cannot drift from the build it verifies. The original bytes are
 * restored afterwards: the test reports a stale bundle, it does not silently
 * rewrite the repo.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const bundlePath = path.join(root, "main.js");

/** Line endings are checkout-dependent and irrelevant to a JS bundle. */
const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

describe("the committed bundle", () => {
  it("is a fresh build of main.ts", () => {
    const committed = fs.readFileSync(bundlePath, "utf8");
    try {
      execFileSync(process.execPath, ["esbuild.mjs"], { cwd: root, stdio: "pipe" });
      const rebuilt = fs.readFileSync(bundlePath, "utf8");
      expect(normalize(rebuilt)).toBe(normalize(committed));
    } finally {
      fs.writeFileSync(bundlePath, committed);
    }
  });

  it("is not empty, so a truncated build cannot pass unnoticed", () => {
    const committed = fs.readFileSync(bundlePath, "utf8");
    expect(committed.length).toBeGreaterThan(10_000);
    expect(committed).toContain("require(\"obsidian\")");
  });
});
