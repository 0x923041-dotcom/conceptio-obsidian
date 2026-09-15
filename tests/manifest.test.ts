/**
 * Release invariants for an Obsidian community plugin.
 *
 * These are the checks a listing (and the review that follows it) trips over
 * when they drift: a version bumped in `package.json` but not in `manifest.json`
 * or `versions.json`, a description over the length the store renders, a name
 * that contains "Obsidian", or `isDesktopOnly` quietly false on a plugin that
 * spawns a process. Cheap to pin, expensive to discover after submitting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as Record<string, unknown>;

const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");

describe("manifest.json", () => {
  it("carries every key the community listing requires", () => {
    for (const key of ["id", "name", "version", "minAppVersion", "description", "author"]) {
      expect(typeof manifest[key], key).toBe("string");
      expect(String(manifest[key]).length, key).toBeGreaterThan(0);
    }
  });

  it("uses a valid plugin id", () => {
    expect(String(manifest.id)).toMatch(/^[a-z0-9-]+$/);
  });

  it("does not put Obsidian in the plugin name", () => {
    expect(String(manifest.name).toLowerCase()).not.toContain("obsidian");
  });

  it("keeps the description within the length the store renders", () => {
    const description = String(manifest.description);
    expect(description.length).toBeLessThanOrEqual(250);
    expect(description.trim()).toBe(description);
  });

  it("declares desktop-only, because the archive call is a subprocess", () => {
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it("declares the public home the listing is submitted from", () => {
    // The same defect class as a `repository` field pointing at a 404: the field
    // is metadata the directory and BRAT paths depend on, so keep it declared
    // and in GitHub's owner/name shape.
    const repository = pkg.repository as { url?: string } | undefined;
    expect(repository?.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
  });

  it("declares a semantic version", () => {
    expect(String(manifest.version)).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("release metadata stays in step", () => {
  it("manifest version == package version", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("versions.json maps the current version to minAppVersion", () => {
    const version = String(manifest.version);
    expect(versions[version]).toBe(manifest.minAppVersion);
  });

  it("versions.json has no stale entries above the current version", () => {
    const current = String(manifest.version)
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    for (const key of Object.keys(versions)) {
      const [major, minor, patch] = key.split(".").map((part) => Number.parseInt(part, 10));
      const newer =
        major > current[0] ||
        (major === current[0] && minor > current[1]) ||
        (major === current[0] && minor === current[1] && patch > current[2]);
      expect(newer, `versions.json lists ${key}, newer than ${manifest.version}`).toBe(false);
    }
  });
});

describe("shipped files", () => {
  it("ships the stylesheet Obsidian loads automatically", () => {
    expect(fs.existsSync(path.join(root, "styles.css"))).toBe(true);
  });

  it("points the build at the entry file Obsidian loads", () => {
    // The bundle is a build artifact (gitignored); the source it comes from must
    // exist, and esbuild's configured output is main.js at the repo root.
    expect(fs.existsSync(path.join(root, "main.ts"))).toBe(true);
    const esbuild = fs.readFileSync(path.join(root, "esbuild.mjs"), "utf8");
    expect(esbuild).toContain('"./main.ts"');
    expect(esbuild).toContain('"./main.js"');
    expect(esbuild).toContain('"obsidian"');
  });

  it("keeps the runtime bundle out of git", () => {
    const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("main.js");
    expect(ignore).toContain("node_modules/");
  });
});
