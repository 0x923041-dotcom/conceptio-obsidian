import { describe, expect, it } from "vitest";
import { ensureFolder, normalizeFolder, normalizeNotePath, writeNote, type VaultLike } from "../src/notes.js";

function fakeVault(initial: string[] = []): {
  vault: VaultLike;
  files: Map<string, string>;
  folders: string[];
} {
  const files = new Map<string, string>();
  for (const path of initial) files.set(path, "existing");
  const folders: string[] = [];
  return {
    files,
    folders,
    vault: {
      getAbstractFileByPath(path: string) {
        if (files.has(path)) return { path };
        if (folders.includes(path)) return { path };
        return null;
      },
      async createFolder(path: string) {
        folders.push(path);
      },
      async create(path: string, content: string) {
        files.set(path, content);
      },
    },
  };
}

describe("path helpers", () => {
  it("normalises a folder setting", () => {
    expect(normalizeFolder(" /Conceptio/Research/ ")).toBe("Conceptio/Research");
    expect(normalizeFolder("Conceptio//Papers/./")).toBe("Conceptio/Papers");
    expect(normalizeFolder("../etc")).toBe("etc");
    expect(normalizeFolder("")).toBe("");
  });

  it("normalises a note path without touching the file name", () => {
    expect(normalizeNotePath("Conceptio//A note.md")).toBe("Conceptio/A note.md");
    expect(normalizeNotePath("A note.md")).toBe("A note.md");
  });
});

describe("ensureFolder", () => {
  it("creates each missing segment once", async () => {
    const { vault, folders } = fakeVault();
    await ensureFolder(vault, "Conceptio/Research/Papers");
    expect(folders).toEqual(["Conceptio", "Conceptio/Research", "Conceptio/Research/Papers"]);
  });

  it("skips folders that already exist", async () => {
    const { vault, folders } = fakeVault();
    folders.push("Conceptio");
    await ensureFolder(vault, "Conceptio/Papers");
    expect(folders).toEqual(["Conceptio", "Conceptio/Papers"]);
  });

  it("does nothing for an empty folder", async () => {
    const { vault, folders } = fakeVault();
    await ensureFolder(vault, "  ");
    expect(folders).toEqual([]);
  });
});

describe("writeNote", () => {
  it("creates the note and its parent folder", async () => {
    const { vault, files, folders } = fakeVault();
    const outcome = await writeNote(vault, "Conceptio/A note.md", "body");
    expect(outcome).toBe("created");
    expect(files.get("Conceptio/A note.md")).toBe("body");
    expect(folders).toEqual(["Conceptio"]);
  });

  it("never clobbers an existing note", async () => {
    const { vault, files } = fakeVault(["Conceptio/A note.md"]);
    const outcome = await writeNote(vault, "Conceptio/A note.md", "new body");
    expect(outcome).toBe("exists");
    expect(files.get("Conceptio/A note.md")).toBe("existing");
  });

  it("writes at the vault root when no folder is configured", async () => {
    const { vault, files, folders } = fakeVault();
    await writeNote(vault, "Root note.md", "body");
    expect(files.get("Root note.md")).toBe("body");
    expect(folders).toEqual([]);
  });

  it("reports an existing note when the create races another writer", async () => {
    const files = new Map<string, string>();
    const vault: VaultLike = {
      getAbstractFileByPath: (path: string) => (files.size > 0 ? { path } : null),
      async createFolder() {},
      async create(path: string, content: string) {
        // Simulate: the path appears while we were creating it.
        files.set(path, content);
        throw new Error("File already exists");
      },
    };
    // First call sees nothing, the create throws, and the post-check finds it.
    expect(await writeNote(vault, "A.md", "body")).toBe("exists");
  });
});
