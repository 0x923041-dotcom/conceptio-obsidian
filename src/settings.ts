/**
 * Plugin settings, the vault-local data store, and their pure helpers.
 *
 * The store is a thin namespaced view over Obsidian's `loadData`/`saveData`
 * (`<vault>/.obsidian/plugins/conceptio/data.json`), which is what makes the
 * reading list travel with the vault when the user syncs it. Keeping the
 * IO behind an interface lets the whole layer be tested offline.
 */

import type { CitationFormat } from "./types.js";
import { isCitationFormat } from "./types.js";

export interface ConceptioSettings {
  /** API origin (self-hosted overrides). */
  apiBase: string;
  /** Dev/Enterprise API key (`ckey_live_…`). */
  apiKey: string;
  /** Pro license key — handed to the CLI as `CONCEPTIO_LICENSE_KEY`. */
  licenseKey: string;
  /** CLI executable when `conceptio` is not on PATH. */
  cliBin: string;
  /** Format the primary Insert citation action uses. */
  citationFormat: CitationFormat;
  /** Results fetched per query (1–100). */
  resultLimit: number;
  /** Vault folder new document notes are written to ("" = vault root). */
  noteFolder: string;
  /** Write YAML frontmatter into new document notes. */
  frontmatter: boolean;
  /** Comma-separated frontmatter tags for new notes. */
  tags: string;
  /** Note the reading list is exported to. */
  readingListNote: string;
}

export const DEFAULT_SETTINGS: ConceptioSettings = {
  apiBase: "https://www.conceptio.app",
  apiKey: "",
  licenseKey: "",
  cliBin: "",
  citationFormat: "apa",
  resultLimit: 10,
  noteFolder: "Conceptio",
  frontmatter: true,
  tags: "conceptio",
  readingListNote: "Conceptio Reading List.md",
};

/** Server range for `-l/--limit`. */
export function clampLimit(value: unknown, fallback = DEFAULT_SETTINGS.resultLimit): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.trunc(n), 100));
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Tolerant merge of stored settings over the defaults (never throws). */
export function normalizeSettings(raw: unknown): ConceptioSettings {
  const data = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const format = data.citationFormat;
  return {
    apiBase: str(data.apiBase, DEFAULT_SETTINGS.apiBase).trim().replace(/\/+$/, "") || DEFAULT_SETTINGS.apiBase,
    apiKey: str(data.apiKey, DEFAULT_SETTINGS.apiKey).trim(),
    licenseKey: str(data.licenseKey, DEFAULT_SETTINGS.licenseKey).trim(),
    cliBin: str(data.cliBin, DEFAULT_SETTINGS.cliBin).trim(),
    citationFormat: isCitationFormat(format) ? format : DEFAULT_SETTINGS.citationFormat,
    resultLimit: clampLimit(data.resultLimit),
    noteFolder: str(data.noteFolder, DEFAULT_SETTINGS.noteFolder).trim(),
    frontmatter: bool(data.frontmatter, DEFAULT_SETTINGS.frontmatter),
    tags: str(data.tags, DEFAULT_SETTINGS.tags).trim(),
    readingListNote: str(data.readingListNote, DEFAULT_SETTINGS.readingListNote).trim() || DEFAULT_SETTINGS.readingListNote,
  };
}

/** Split the comma-separated tag setting, dropping blanks and duplicates. */
export function parseTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(value ?? "").split(",")) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** IO the store sits on — Obsidian's loadData/saveData in production. */
export interface DataIO {
  load(): Promise<unknown>;
  save(data: Record<string, unknown>): Promise<void>;
}

/** Namespaced, cached view over one `data.json` document. */
export class DataStore {
  private data: Record<string, unknown> = {};
  private loaded = false;

  constructor(private readonly io: DataIO) {}

  async init(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await this.io.load();
    } catch {
      raw = null;
    }
    this.data =
      raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    this.loaded = true;
  }

  /** Read one namespace; `fallback` when absent. */
  get<T>(key: string, fallback: T): T {
    const value = this.data[key];
    return value === undefined || value === null ? fallback : (value as T);
  }

  /** Write one namespace and flush the whole document. */
  async set(key: string, value: unknown): Promise<void> {
    if (!this.loaded) await this.init();
    this.data[key] = value;
    await this.io.save({ ...this.data });
  }
}
