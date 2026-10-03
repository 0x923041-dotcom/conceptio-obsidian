import { describe, expect, it } from "vitest";
import { resultActions } from "../src/actions.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.js";
import { sampleDoc } from "./helpers.js";

const settings = normalizeSettings(DEFAULT_SETTINGS);

describe("resultActions", () => {
  it("offers the full set for an open-access document with a PDF", () => {
    const actions = resultActions({ result: sampleDoc(), settings, saved: false });
    expect(actions.map((action) => action.kind)).toEqual([
      "insert-citation",
      "append-section",
      "create-note",
      "toggle-reading-list",
      "copy-citation",
      "copy-link",
      "open-document",
      "open-pdf",
    ]);
  });

  it("names the configured citation format on both citation actions", () => {
    const actions = resultActions({
      result: sampleDoc(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, citationFormat: "bibtex" }),
      saved: false,
    });
    const citation = actions.find((action) => action.kind === "insert-citation");
    const copy = actions.find((action) => action.kind === "copy-citation");
    expect(citation?.format).toBe("bibtex");
    expect(citation?.detail).toContain("BibTeX");
    expect(copy?.detail).toBe("BibTeX");
  });

  it("flips the reading-list action on membership", () => {
    const unsaved = resultActions({ result: sampleDoc(), settings, saved: false });
    const saved = resultActions({ result: sampleDoc(), settings, saved: true });
    expect(unsaved.find((a) => a.kind === "toggle-reading-list")?.label).toBe("Save to reading list");
    expect(saved.find((a) => a.kind === "toggle-reading-list")?.label).toBe("Remove from reading list");
  });

  it("shows where the note will land, honouring the folder setting", () => {
    const actions = resultActions({
      result: sampleDoc(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, noteFolder: "Research/Papers" }),
      saved: false,
    });
    expect(actions.find((a) => a.kind === "create-note")?.detail).toContain(
      "Research/Papers/Attention Is All You Need.md",
    );
  });

  it("only offers the PDF action when the document has one", () => {
    const actions = resultActions({
      result: sampleDoc({ direct_pdf_url: undefined }),
      settings,
      saved: false,
    });
    expect(actions.some((action) => action.kind === "open-pdf")).toBe(false);
  });

  it("uses a stable kind per entry", () => {
    const actions = resultActions({ result: sampleDoc(), settings, saved: false });
    const kinds = actions.map((action) => action.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const action of actions) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.detail.length).toBeGreaterThan(0);
    }
  });
});
