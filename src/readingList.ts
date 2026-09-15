/**
 * The vault reading list.
 *
 * Items are persisted through the plugin's data store, which lives inside the
 * vault (`.obsidian/plugins/conceptio/data.json`) — so the list travels with
 * the vault whenever the user syncs it, and an exported `Conceptio Reading
 * List` note can be regenerated at any time. Pure: the storage port is
 * injected, so the whole list is exercised offline.
 */

import { readingListMarkdown, READER_ORIGIN } from "./format.js";
import type { SearchResult } from "./types.js";

export const READING_LIST_VERSION = 1;
export const READING_LIST_KEY = "readingList";

export interface ReadingListItem {
  id: number;
  title: string;
  author?: string;
  year?: string;
  source?: string;
  source_label?: string;
  license?: string;
  access_level?: string;
  url?: string;
  /** Epoch milliseconds the item was saved. */
  savedAt: number;
}

export interface ReadingListPayload {
  version: number;
  items: ReadingListItem[];
}

/** Storage port — the plugin backs this with the vault data store. */
export interface ReadingListStorage {
  load(): Promise<unknown>;
  save(payload: ReadingListPayload): Promise<void>;
}

/** The subset of a search result the reading list keeps. */
export function toReadingListItem(doc: SearchResult, now: number): ReadingListItem {
  const item: ReadingListItem = { id: doc.id, title: doc.title || "Untitled", savedAt: now };
  if (doc.author) item.author = doc.author;
  if (doc.year) item.year = doc.year;
  if (doc.source) item.source = doc.source;
  if (doc.source_label) item.source_label = doc.source_label;
  if (doc.license) item.license = doc.license;
  if (doc.access_level) item.access_level = doc.access_level;
  if (doc.url) item.url = doc.url;
  return item;
}

/** Tolerant decode of persisted items (drops entries without an id). */
export function parseReadingList(raw: unknown): ReadingListItem[] {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).items ?? [])
      : Array.isArray(raw)
        ? raw
        : [];
  if (!Array.isArray(source)) return [];
  const out: ReadingListItem[] = [];
  const seen = new Set<number>();
  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : Number.parseInt(String(record.id ?? ""), 10);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    const item: ReadingListItem = {
      id,
      title: typeof record.title === "string" && record.title ? record.title : "Untitled",
      savedAt: typeof record.savedAt === "number" ? record.savedAt : 0,
    };
    for (const key of ["author", "year", "source", "source_label", "license", "access_level", "url"] as const) {
      const value = record[key];
      if (typeof value === "string" && value) item[key] = value;
    }
    out.push(item);
  }
  return out;
}

export class ReadingList {
  private items: ReadingListItem[] = [];

  constructor(
    private readonly storage: ReadingListStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await this.storage.load();
    } catch {
      raw = null;
    }
    this.items = parseReadingList(raw);
  }

  /** Newest first, as the web app's Saved view orders them. */
  list(): ReadingListItem[] {
    return [...this.items];
  }

  has(id: number): boolean {
    return this.items.some((item) => item.id === id);
  }

  size(): number {
    return this.items.length;
  }

  /** Add if absent. Returns true when the list changed. */
  async add(doc: SearchResult): Promise<boolean> {
    if (this.has(doc.id)) return false;
    this.items = [toReadingListItem(doc, this.now()), ...this.items];
    await this.persist();
    return true;
  }

  /** Remove by id. Returns true when the list changed. */
  async remove(id: number): Promise<boolean> {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return false;
    this.items = next;
    await this.persist();
    return true;
  }

  /** Toggle membership. Returns true when the document ends up SAVED. */
  async toggle(doc: SearchResult): Promise<boolean> {
    if (this.has(doc.id)) {
      await this.remove(doc.id);
      return false;
    }
    await this.add(doc);
    return true;
  }

  /** The exported note body. */
  markdown(origin: string = READER_ORIGIN): string {
    return readingListMarkdown(this.items, origin);
  }

  private async persist(): Promise<void> {
    await this.storage.save({ version: READING_LIST_VERSION, items: this.items });
  }
}
