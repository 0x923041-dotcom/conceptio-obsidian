/**
 * Pure formatting helpers for the Conceptio Obsidian plugin.
 *
 * Everything here is side-effect free and free of `obsidian` imports, so the
 * note builders, frontmatter escaping and link shapes are unit-testable
 * offline. The only async work (citations, proof bundles) lives in `cli.ts`.
 */

import { CliError, CliMissingError } from "./cli.js";
import type { CitationFormat, SearchResult } from "./types.js";

/**
 * The fields the renderers need. Structural on purpose: a search result, a
 * reading-list entry and a stored bookmark all satisfy it, so every formatter
 * works on all three without casts.
 */
export interface DocLike {
  id?: number;
  title?: string;
  author?: string;
  year?: string;
  source?: string;
  source_label?: string;
}

/** Public origin the web app serves (override when self-hosted). */
export const READER_ORIGIN = "https://www.conceptio.app";

/** Longest description block we inline into a note. */
export const DESCRIPTION_MAX = 1200;

/** Public reader URL for a document — the page the web app serves. */
export function readerUrl(docId: number | string, origin: string = READER_ORIGIN): string {
  return `${stripTrailingSlash(origin) || READER_ORIGIN}/document/${docId}`;
}

/** Auth-gated machine-readable proof bundle endpoint (link target only). */
export function proofUrl(docId: number | string, origin: string = READER_ORIGIN): string {
  return `${readerUrl(docId, origin)}`;
}

function stripTrailingSlash(value: string): string {
  return String(value ?? "").replace(/\/+$/, "");
}

/** One-line result header: `author — title (year)`. */
export function formatResultLine(doc: DocLike): string {
  const title = doc.title || "Untitled";
  const author = doc.author ? `${doc.author} — ` : "";
  const year = doc.year ? ` (${doc.year})` : "";
  return `${author}${title}${year}`;
}

/** Compact metadata line: `author · year · source`. */
export function subtitleFor(doc: DocLike): string {
  const parts: string[] = [];
  if (doc.author) parts.push(doc.author);
  if (doc.year) parts.push(doc.year);
  const source = doc.source_label || doc.source || "";
  if (source) parts.push(source);
  return parts.join(" · ");
}

/** Short display label for an access level. */
export function formatAccessLevel(level: string | null | undefined): string {
  switch (level) {
    case "public_full_text":
      return "Full text";
    case "open_access":
      return "Open access";
    case "metadata_only":
      return "Metadata";
    default:
      return level && level.length ? level : "—";
  }
}

/** `[Title](origin/document/{id})` for notes and the reading-list export. */
export function markdownLink(doc: DocLike, origin: string = READER_ORIGIN): string {
  const title = (doc.title ?? "Document").trim() || "Document";
  return `[${title}](${readerUrl(doc.id as number, origin)})`;
}

/**
 * Minimal portable record for export (JSON) — the fields every consumer
 * needs, without the full server payload.
 */
export function jsonRecord(doc: SearchResult, origin: string = READER_ORIGIN): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: doc.id,
    title: doc.title,
    reader_url: readerUrl(doc.id, origin),
  };
  const optional: Array<keyof SearchResult> = [
    "author",
    "year",
    "source",
    "source_label",
    "category",
    "license",
    "access_level",
    "language",
    "url",
    "direct_pdf_url",
    "description",
  ];
  for (const key of optional) {
    const value = doc[key];
    if (value !== undefined && value !== null && value !== "") {
      record[key] = value;
    }
  }
  return record;
}

/** Friendly, human-readable message for any failure shape. */
export function errorMessage(err: unknown): string {
  if (err instanceof CliMissingError || err instanceof CliError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * Quote a value for YAML frontmatter. Always double-quoted, with the
 * characters that would break a block scalar escaped — a title with a colon,
 * a quote or a newline must not corrupt the file's metadata block.
 */
export function yamlString(value: unknown): string {
  const text = String(value ?? "")
    // Frontmatter is one line per key: a bare newline would end it early.
    .replace(/\r?\n+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
  return `"${text}"`;
}

/** Serialise a frontmatter block (keys without values are omitted). */
export function buildFrontmatter(fields: Array<[string, string | number | string[] | undefined]>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of fields) {
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => yamlString(v)).join(", ")}]`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/** Collapse and bound a description so a note stays readable. */
export function condenseDescription(description: string | null | undefined): string {
  const text = String(description ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= DESCRIPTION_MAX) return text;
  return `${text.slice(0, DESCRIPTION_MAX).trimEnd()}…`;
}

export interface NoteOptions {
  /** Public origin used for links (defaults to the hosted app). */
  origin?: string;
  /** Rendered citation text for the document, when one was fetched. */
  citation?: string;
  /** Format the citation was rendered in. */
  format?: CitationFormat;
  /** Date stamped into the frontmatter, `YYYY-MM-DD`. */
  accessed?: string;
  /** Frontmatter tags. */
  tags?: string[];
  /** Include the YAML frontmatter block (false for in-note sections). */
  frontmatter?: boolean;
}

/** A stable, filesystem-safe file name for a document note (no extension). */
export function noteFileName(doc: DocLike): string {
  const base = String(doc.title ?? "").trim() || (doc.id ? `Conceptio document ${doc.id}` : "Conceptio document");
  const cleaned = base
    // Obsidian forbids these in note names; the title also must not end in a dot.
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  const bounded = cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
  return bounded || `Conceptio document ${doc.id ?? ""}`.trim();
}

/** Vault path for a document note (folder is optional). */
export function notePath(folder: string, doc: DocLike): string {
  const dir = String(folder ?? "")
    .replace(/^[./\\]+/, "")
    .replace(/[\\/]+$/, "")
    .trim();
  const file = `${noteFileName(doc)}.md`;
  return dir ? `${dir}/${file}` : file;
}

/** Marker that lets a re-insert be recognised as the same document. */
export function documentMarker(docId: number | string): string {
  return `<!-- conceptio:doc:${docId} -->`;
}

/** Has a note body already been written for this document? */
export function hasDocumentMarker(body: string, docId: number | string): boolean {
  return String(body ?? "").includes(documentMarker(docId));
}

/**
 * The note body for a document: heading, metadata line, description, proof/
 * provenance links, the citation in a fenced block, and a hidden marker.
 */
export function buildNoteSection(doc: SearchResult, opts: NoteOptions = {}): string {
  const origin = opts.origin ?? READER_ORIGIN;
  const title = (doc.title || "Untitled").trim();
  const parts: string[] = [`# ${title}`, ""];

  const meta = subtitleFor(doc);
  if (meta) parts.push(`> ${meta}`, "");

  const description = condenseDescription(doc.description);
  if (description) parts.push(description, "");

  const links: string[] = [];
  links.push(`[Conceptio record](${readerUrl(doc.id, origin)})`);
  if (doc.url) links.push(`[Source document](${doc.url})`);
  if (doc.direct_pdf_url) links.push(`[PDF](${doc.direct_pdf_url})`);
  const access = formatAccessLevel(doc.access_level);
  const license = doc.license ? ` · License: ${doc.license}` : "";
  parts.push(`**Provenance:** ${links.join(" · ")}`, "");
  parts.push(`**Access:** ${access}${license}`, "");

  if (opts.citation && opts.citation.trim()) {
    const fence = "```";
    const format = opts.format ?? "bibtex";
    parts.push(`## Citation (${format})`, "", `${fence}`, opts.citation.trim(), `${fence}`, "");
  }

  parts.push(documentMarker(doc.id));
  return parts.join("\n");
}

/** A full note file: optional frontmatter + the document section. */
export function buildNote(doc: SearchResult, opts: NoteOptions = {}): string {
  const origin = opts.origin ?? READER_ORIGIN;
  const includeFrontmatter = opts.frontmatter !== false;
  const body = buildNoteSection(doc, opts);
  if (!includeFrontmatter) return `${body}\n`;
  const frontmatter = buildFrontmatter([
    ["title", doc.title || "Untitled"],
    ["author", doc.author],
    ["year", doc.year],
    ["source", doc.source_label || doc.source],
    ["category", doc.category],
    ["license", doc.license],
    ["access", formatAccessLevel(doc.access_level)],
    ["language", doc.language],
    ["conceptio_id", doc.id],
    ["conceptio_url", readerUrl(doc.id, origin)],
    ["source_url", doc.url],
    ["pdf_url", doc.direct_pdf_url],
    ["accessed", opts.accessed],
    ["tags", opts.tags],
  ]);
  return `${frontmatter}\n\n${body}\n`;
}

/** Markdown export of the reading list (checkbox list with links). */
export function readingListMarkdown(
  items: Array<DocLike & { savedAt?: number }>,
  origin: string = READER_ORIGIN,
): string {
  const lines = ["# Conceptio reading list", ""];
  if (!items.length) {
    lines.push("_Nothing saved yet._", "");
    return lines.join("\n");
  }
  for (const item of items) {
    const meta = subtitleFor(item);
    const suffix = meta ? ` — ${meta}` : "";
    lines.push(`- [ ] ${markdownLink(item, origin)}${suffix}`);
  }
  lines.push("");
  return lines.join("\n");
}
