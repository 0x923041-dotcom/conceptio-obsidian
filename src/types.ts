/**
 * Minimal result/citation types for the Conceptio Obsidian plugin.
 *
 * These mirror the public `/api/search`, `/api/resolve` and `/api/cite`
 * shapes the `conceptio` CLI passes through in `--json` mode. The CLI is the
 * single implementation of the wire contract — this file only names the fields
 * the plugin renders.
 */

export type CitationFormat =
  | "bibtex"
  | "apa"
  | "mla"
  | "chicago"
  | "ieee"
  | "harvard"
  | "ris"
  | "bluebook"
  | "oscola"
  | "iso690"
  | "ansiz39";

/** All 11 formats, ordered as the API lists them. */
export const CITATION_FORMATS: CitationFormat[] = [
  "bibtex",
  "apa",
  "mla",
  "chicago",
  "ieee",
  "harvard",
  "ris",
  "bluebook",
  "oscola",
  "iso690",
  "ansiz39",
];

/** Human-readable labels for the 11 formats. */
export const CITATION_FORMAT_LABELS: Record<CitationFormat, string> = {
  bibtex: "BibTeX",
  apa: "APA",
  mla: "MLA",
  chicago: "Chicago",
  ieee: "IEEE",
  harvard: "Harvard",
  ris: "RIS",
  bluebook: "Bluebook",
  oscola: "OSCOLA",
  iso690: "ISO 690",
  ansiz39: "ANSI Z39",
};

/** True when a string is one of the 11 citation formats. */
export function isCitationFormat(value: unknown): value is CitationFormat {
  return typeof value === "string" && (CITATION_FORMATS as string[]).includes(value);
}

/** One search result, as served by `/api/search` (the fields we render). */
export interface SearchResult {
  id: number;
  title: string;
  author?: string;
  year?: string;
  source?: string;
  source_label?: string;
  category?: string;
  license?: string;
  access_level?: string;
  language?: string;
  url?: string;
  direct_pdf_url?: string;
  description?: string;
  snippet?: string;
  proof?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Envelope of `conceptio search --json`. */
export interface SearchResponse {
  count?: number;
  total?: number;
  results: SearchResult[];
  [key: string]: unknown;
}

/** Envelope of `conceptio resolve --json`. */
export interface ResolveResponse {
  kind?: string;
  identifier?: string;
  results?: SearchResult[];
  [key: string]: unknown;
}
