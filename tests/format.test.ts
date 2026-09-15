import { describe, expect, it } from "vitest";
import { CliMissingError } from "../src/cli.js";
import {
  buildFrontmatter,
  buildNote,
  buildNoteSection,
  condenseDescription,
  DESCRIPTION_MAX,
  documentMarker,
  errorMessage,
  formatAccessLevel,
  formatResultLine,
  hasDocumentMarker,
  jsonRecord,
  markdownLink,
  noteFileName,
  notePath,
  readerUrl,
  readingListMarkdown,
  subtitleFor,
  yamlString,
} from "../src/format.js";
import { sampleDoc } from "./helpers.js";

describe("links and labels", () => {
  it("builds the reader url from the configured origin", () => {
    expect(readerUrl(7288)).toBe("https://www.conceptio.app/document/7288");
    expect(readerUrl(7288, "https://staging.test/")).toBe("https://staging.test/document/7288");
    expect(readerUrl(1, "")).toBe("https://www.conceptio.app/document/1");
  });

  it("renders the one-line and subtitle forms", () => {
    expect(formatResultLine(sampleDoc())).toBe("Ashish Vaswani; Noam Shazeer — Attention Is All You Need (2017)");
    expect(formatResultLine({ id: 1, title: "" })).toBe("Untitled");
    expect(subtitleFor(sampleDoc())).toBe("Ashish Vaswani; Noam Shazeer · 2017 · arXiv");
  });

  it("labels access levels and falls back honestly", () => {
    expect(formatAccessLevel("public_full_text")).toBe("Full text");
    expect(formatAccessLevel("metadata_only")).toBe("Metadata");
    expect(formatAccessLevel("")).toBe("—");
    expect(formatAccessLevel(null)).toBe("—");
    expect(formatAccessLevel("custom")).toBe("custom");
  });

  it("links the Conceptio record by title", () => {
    expect(markdownLink(sampleDoc(), "https://www.conceptio.app")).toBe(
      "[Attention Is All You Need](https://www.conceptio.app/document/7288)",
    );
  });

  it("surfaces CLI errors verbatim and never invents one", () => {
    expect(errorMessage(new CliMissingError("conceptio CLI not found — install it"))).toContain("install it");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("nope")).toBe("Something went wrong.");
  });
});

describe("frontmatter", () => {
  it("quotes and escapes values that would break the block", () => {
    expect(yamlString('A "quoted" title: with colon')).toBe('"A \\"quoted\\" title: with colon"');
    expect(yamlString("line one\nline two")).toBe('"line one line two"');
    expect(yamlString("back\\slash")).toBe('"back\\\\slash"');
    expect(yamlString(undefined)).toBe('""');
  });

  it("omits empty keys and renders tag arrays", () => {
    const block = buildFrontmatter([
      ["title", "A study"],
      ["author", ""],
      ["year", undefined],
      ["tags", ["conceptio", "papers"]],
      ["conceptio_id", 7288],
    ]);
    expect(block).toBe(
      ['---', 'title: "A study"', 'tags: ["conceptio", "papers"]', 'conceptio_id: "7288"', "---"].join("\n"),
    );
    expect(block).not.toContain("author");
  });
});

describe("descriptions", () => {
  it("collapses whitespace", () => {
    expect(condenseDescription("  a\n\n b\t c ")).toBe("a b c");
    expect(condenseDescription(undefined)).toBe("");
  });

  it("bounds a very long description with an ellipsis", () => {
    const long = "x".repeat(DESCRIPTION_MAX + 50);
    const out = condenseDescription(long);
    expect(out.length).toBe(DESCRIPTION_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("note names", () => {
  it("strips the characters Obsidian forbids", () => {
    expect(noteFileName({ id: 1, title: 'A/B: "C" <D>|E? #F ^G [H]' })).toBe("A B C D E F G H");
  });

  it("never returns an empty or dotted name, and bounds the length", () => {
    expect(noteFileName({ id: 42, title: "" })).toBe("Conceptio document 42");
    expect(noteFileName({ id: 42, title: "..." })).toBe("Conceptio document 42");
    expect(noteFileName({ id: 1, title: "x".repeat(300) }).length).toBe(120);
  });

  it("joins the configured folder into a vault path", () => {
    expect(notePath("Conceptio", sampleDoc())).toBe("Conceptio/Attention Is All You Need.md");
    expect(notePath("/Conceptio/Research/", sampleDoc())).toBe("Conceptio/Research/Attention Is All You Need.md");
    expect(notePath("", sampleDoc())).toBe("Attention Is All You Need.md");
  });
});

describe("buildNoteSection", () => {
  it("carries heading, provenance, access, citation and the marker", () => {
    const section = buildNoteSection(sampleDoc(), {
      origin: "https://www.conceptio.app",
      citation: "@article{vaswani2017}",
      format: "bibtex",
    });
    expect(section).toContain("# Attention Is All You Need");
    expect(section).toContain("> Ashish Vaswani; Noam Shazeer · 2017 · arXiv");
    expect(section).toContain("[Conceptio record](https://www.conceptio.app/document/7288)");
    expect(section).toContain("[Source document](https://arxiv.org/abs/1706.03762)");
    expect(section).toContain("[PDF](https://arxiv.org/pdf/1706.03762)");
    expect(section).toContain("**Access:** Full text · License: CC-BY-4.0");
    expect(section).toContain("## Citation (bibtex)");
    expect(section).toContain("```\n@article{vaswani2017}\n```");
    expect(section.trimEnd().endsWith(documentMarker(7288))).toBe(true);
    expect(section.startsWith("---")).toBe(false);
    expect(hasDocumentMarker(section, 7288)).toBe(true);
    expect(hasDocumentMarker(section, 999)).toBe(false);
  });

  it("omits the citation block when no citation was fetched", () => {
    const section = buildNoteSection(sampleDoc());
    expect(section).not.toContain("## Citation");
    expect(section).not.toContain("```");
  });

  it("does not invent links a document does not have", () => {
    const section = buildNoteSection(sampleDoc({ url: undefined, direct_pdf_url: undefined }));
    expect(section).toContain("[Conceptio record](");
    expect(section).not.toContain("[Source document]");
    expect(section).not.toContain("[PDF]");
  });
});

describe("buildNote", () => {
  it("writes frontmatter then the section", () => {
    const note = buildNote(sampleDoc(), {
      origin: "https://www.conceptio.app",
      accessed: "2026-09-14",
      tags: ["conceptio", "papers"],
      citation: "@article{vaswani2017}",
      format: "bibtex",
    });
    expect(note.startsWith("---\n")).toBe(true);
    expect(note).toContain('title: "Attention Is All You Need"');
    expect(note).toContain('author: "Ashish Vaswani; Noam Shazeer"');
    expect(note).toContain('source: "arXiv"');
    expect(note).toContain('conceptio_id: "7288"');
    expect(note).toContain('conceptio_url: "https://www.conceptio.app/document/7288"');
    expect(note).toContain('accessed: "2026-09-14"');
    expect(note).toContain('tags: ["conceptio", "papers"]');
    expect(note).toContain("# Attention Is All You Need");
    expect(note.endsWith("\n")).toBe(true);
    // Frontmatter closes before the body begins.
    expect(note.indexOf("\n---\n")).toBeLessThan(note.indexOf("# Attention"));
  });

  it("honours frontmatter: false for in-note sections", () => {
    const note = buildNote(sampleDoc(), { frontmatter: false });
    expect(note.startsWith("---")).toBe(false);
    expect(note.startsWith("# Attention Is All You Need")).toBe(true);
  });
});

describe("readingListMarkdown", () => {
  it("renders an empty list honestly", () => {
    expect(readingListMarkdown([])).toContain("_Nothing saved yet._");
  });

  it("renders one checkbox per item with its metadata", () => {
    const md = readingListMarkdown([
      { ...sampleDoc(), savedAt: 1 },
      { id: 9, title: "RFC 2119", source_label: "IETF", savedAt: 2 },
    ]);
    expect(md).toContain("- [ ] [Attention Is All You Need](https://www.conceptio.app/document/7288)");
    expect(md).toContain("Ashish Vaswani; Noam Shazeer · 2017 · arXiv");
    expect(md).toContain("- [ ] [RFC 2119](https://www.conceptio.app/document/9) — IETF");
  });
});

describe("jsonRecord", () => {
  it("drops empty fields and names the reader url", () => {
    const record = jsonRecord(sampleDoc({ category: "", language: undefined }));
    expect(record.id).toBe(7288);
    expect(record.reader_url).toBe("https://www.conceptio.app/document/7288");
    expect(record.source_label).toBe("arXiv");
    expect("category" in record).toBe(false);
    expect("language" in record).toBe(false);
  });
});
