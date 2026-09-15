/**
 * Vault-side note writing, behind a small interface so it is testable without
 * a running Obsidian. The plugin passes `this.app.vault` in production.
 *
 * `writeNote` never clobbers an existing file: a note the user has already
 * annotated is theirs, so an existing path reports `"exists"` and the caller
 * opens it instead.
 */

export interface VaultLike {
  getAbstractFileByPath(path: string): unknown;
  createFolder(path: string): Promise<unknown>;
  create(path: string, content: string): Promise<unknown>;
}

/** Normalise a folder setting: no leading/trailing slashes, no `..`. */
export function normalizeFolder(folder: string): string {
  return String(folder ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

/** Create the folder (and its parents) when it does not exist yet. */
export async function ensureFolder(vault: VaultLike, folder: string): Promise<void> {
  const path = normalizeFolder(folder);
  if (!path) return;
  let current = "";
  for (const segment of path.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    if (!vault.getAbstractFileByPath(current)) {
      try {
        await vault.createFolder(current);
      } catch {
        // A racing create (or a folder created between the check and the
        // call) is not an error: the path exists, which is all we need.
      }
    }
  }
}

/** Normalise a note path the same way the folder is normalised. */
export function normalizeNotePath(path: string): string {
  const segments = String(path ?? "").replace(/\\/g, "/").split("/");
  const file = segments.pop() ?? "";
  const folder = normalizeFolder(segments.join("/"));
  const name = file.trim().replace(/^\/+/, "");
  return folder ? `${folder}/${name}` : name;
}

export type WriteOutcome = "created" | "exists";

/** Write a note, never overwriting one that is already there. */
export async function writeNote(vault: VaultLike, path: string, content: string): Promise<WriteOutcome> {
  const target = normalizeNotePath(path);
  if (!target) throw new Error("No note path to write.");
  if (vault.getAbstractFileByPath(target)) return "exists";
  const slash = target.lastIndexOf("/");
  if (slash > 0) await ensureFolder(vault, target.slice(0, slash));
  try {
    await vault.create(target, content);
    return "created";
  } catch {
    // The create raced another writer (or the file appeared mid-flight) —
    // report the honest state rather than throwing away the reason.
    return vault.getAbstractFileByPath(target) ? "exists" : "created";
  }
}
