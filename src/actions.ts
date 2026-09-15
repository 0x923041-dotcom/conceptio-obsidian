/**
 * The action catalogue a chosen search result offers.
 *
 * Pure and synchronous, so the menu a user sees for a given document is
 * unit-testable: the modal renders whatever this returns and the plugin
 * dispatches the chosen entry by `kind`. Nothing here touches the vault, the
 * clipboard or the CLI.
 */

import { notePath } from "./format.js";
import type { ConceptioSettings } from "./settings.js";
import { CITATION_FORMAT_LABELS, type CitationFormat, type SearchResult } from "./types.js";

export type ActionKind =
  | "insert-citation"
  | "append-section"
  | "create-note"
  | "toggle-reading-list"
  | "copy-citation"
  | "copy-link"
  | "open-document"
  | "open-pdf";

export interface ResultAction {
  kind: ActionKind;
  label: string;
  detail: string;
  /** Citation format for the two citation actions. */
  format?: CitationFormat;
}

export interface ActionContext {
  result: SearchResult;
  settings: ConceptioSettings;
  /** Whether the document is already in the reading list. */
  saved: boolean;
}

/** The ordered action list for one document. */
export function resultActions(ctx: ActionContext): ResultAction[] {
  const { result, settings, saved } = ctx;
  const format = settings.citationFormat;
  const formatLabel = CITATION_FORMAT_LABELS[format];
  const actions: ResultAction[] = [
    {
      kind: "insert-citation",
      label: "Insert citation at cursor",
      detail: `${formatLabel} — into the note you are editing`,
      format,
    },
    {
      kind: "append-section",
      label: "Append cited section to this note",
      detail: "Heading, provenance and citation, without frontmatter",
    },
    {
      kind: "create-note",
      label: "Create a note for this document",
      detail: `${notePath(settings.noteFolder, result)}${settings.frontmatter ? " — with frontmatter" : ""}`,
    },
    {
      kind: "toggle-reading-list",
      label: saved ? "Remove from reading list" : "Save to reading list",
      detail: saved ? "Currently saved in this vault" : "Kept in this vault, exportable as a note",
    },
    {
      kind: "copy-citation",
      label: "Copy citation",
      detail: formatLabel,
      format,
    },
    {
      kind: "copy-link",
      label: "Copy markdown link",
      detail: "Links the Conceptio record",
    },
    {
      kind: "open-document",
      label: "Open the Conceptio record",
      detail: "In your default browser",
    },
  ];
  if (result.direct_pdf_url) {
    actions.push({
      kind: "open-pdf",
      label: "Open the PDF",
      detail: "The source's open-access copy",
    });
  }
  return actions;
}
