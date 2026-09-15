import { beforeEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { ResultAction } from "../src/actions.js";
import type { ReadingListItem } from "../src/readingList.js";
import {
  ConceptioActionModal,
  ConceptioFormatModal,
  ConceptioPromptModal,
  ConceptioReadingListModal,
  ConceptioSearchModal,
  filterCitationFormats,
} from "../src/searchModal.js";
import { CITATION_FORMATS, type SearchResult } from "../src/types.js";
import { sampleDoc } from "./helpers.js";
import {
  clearNotices,
  clearSettingsInstances,
  MockEl,
  settingsInstances,
} from "./stubs/obsidian.js";

const app = {} as unknown as App;

/** The rendered lines of a suggestion element. */
function lines(el: MockEl): string[] {
  return el.children.map((child) => child.text);
}

beforeEach(() => {
  clearNotices();
  clearSettingsInstances();
});

describe("filterCitationFormats", () => {
  it("returns every format for an empty query, in API order", () => {
    expect(filterCitationFormats("")).toEqual(CITATION_FORMATS);
    expect(filterCitationFormats("   ")).toEqual(CITATION_FORMATS);
  });

  it("matches on the id and on the human label", () => {
    expect(filterCitationFormats("bib")).toEqual(["bibtex"]);
    expect(filterCitationFormats("ISO 690")).toEqual(["iso690"]);
    expect(filterCitationFormats("z39")).toEqual(["ansiz39"]);
    expect(filterCitationFormats("nothing")).toEqual([]);
  });
});

describe("ConceptioSearchModal", () => {
  it("does not call the archive for an empty query", async () => {
    let calls = 0;
    const modal = new ConceptioSearchModal(app, {
      limit: 10,
      search: async () => {
        calls += 1;
        return [];
      },
      onChoose: () => {},
      onError: () => {},
    });
    expect(await modal.getSuggestions("   ")).toEqual([]);
    expect(calls).toBe(0);
  });

  it("trims the query, slices to the configured limit and renders the lines", async () => {
    const seen: string[] = [];
    const modal = new ConceptioSearchModal(app, {
      limit: 2,
      search: async (query) => {
        seen.push(query);
        return [sampleDoc(), sampleDoc({ id: 9, title: "Second" }), sampleDoc({ id: 10, title: "Third" })];
      },
      onChoose: () => {},
      onError: () => {},
    });
    const results = await modal.getSuggestions("  zero trust  ");
    expect(seen).toEqual(["zero trust"]);
    expect(results.map((result) => result.id)).toEqual([7288, 9]);

    const el = new MockEl("div");
    modal.renderSuggestion(results[0], el as unknown as HTMLElement);
    expect(lines(el)).toEqual([
      "Ashish Vaswani; Noam Shazeer — Attention Is All You Need (2017)",
      "Ashish Vaswani; Noam Shazeer · 2017 · arXiv",
    ]);
  });

  it("keeps a slow older query from overwriting a newer answer", async () => {
    const pending: Array<(results: SearchResult[]) => void> = [];
    const modal = new ConceptioSearchModal(app, {
      limit: 10,
      search: () =>
        new Promise<SearchResult[]>((resolve) => {
          pending.push(resolve);
        }),
      onChoose: () => {},
      onError: () => {},
    });
    const first = modal.getSuggestions("old");
    const second = modal.getSuggestions("new");
    pending[1]([sampleDoc({ id: 2, title: "New" })]);
    expect((await second).map((r) => r.id)).toEqual([2]);
    pending[0]([sampleDoc({ id: 1, title: "Old" })]);
    expect((await first).map((r) => r.id)).toEqual([2]); // still the newer answer
  });

  it("reports a failure and shows nothing rather than a stale list", async () => {
    const errors: unknown[] = [];
    const modal = new ConceptioSearchModal(app, {
      limit: 10,
      search: async () => {
        throw new Error("conceptio CLI not found");
      },
      onChoose: () => {},
      onError: (err) => errors.push(err),
    });
    expect(await modal.getSuggestions("x")).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("hands the chosen document to the caller", () => {
    const chosen: SearchResult[] = [];
    const modal = new ConceptioSearchModal(app, {
      limit: 10,
      search: async () => [],
      onChoose: (result) => chosen.push(result),
      onError: () => {},
    });
    modal.onChooseSuggestion(sampleDoc());
    expect(chosen[0].id).toBe(7288);
  });
});

describe("ConceptioActionModal", () => {
  const actions: ResultAction[] = [
    { kind: "insert-citation", label: "Insert citation at cursor", detail: "APA", format: "apa" },
    { kind: "create-note", label: "Create a note for this document", detail: "Conceptio/x.md" },
  ];

  it("filters on the label and on the kind", () => {
    const modal = new ConceptioActionModal(app, actions, () => {});
    expect(modal.getSuggestions("")).toEqual(actions);
    expect(modal.getSuggestions("note").map((a) => a.kind)).toEqual(["create-note"]);
    expect(modal.getSuggestions("copy")).toEqual([]);
  });

  it("renders the label and the detail, and reports the choice", () => {
    const chosen: ResultAction[] = [];
    const modal = new ConceptioActionModal(app, actions, (action) => chosen.push(action));
    const el = new MockEl("div");
    modal.renderSuggestion(actions[1], el as unknown as HTMLElement);
    expect(lines(el)).toEqual(["Create a note for this document", "Conceptio/x.md"]);
    modal.onChooseSuggestion(actions[1]);
    expect(chosen[0].kind).toBe("create-note");
  });
});

describe("ConceptioFormatModal", () => {
  it("lists formats, renders them, and reports the choice", () => {
    const chosen: string[] = [];
    const modal = new ConceptioFormatModal(app, (format) => chosen.push(format));
    expect(modal.getSuggestions("chic")).toEqual(["chicago"]);
    const el = new MockEl("div");
    modal.renderSuggestion("chicago", el as unknown as HTMLElement);
    expect(lines(el)).toEqual(["Chicago", "chicago"]);
    modal.onChooseSuggestion("chicago");
    expect(chosen).toEqual(["chicago"]);
  });
});

describe("ConceptioReadingListModal", () => {
  const items: ReadingListItem[] = [
    { id: 1, title: "Attention Is All You Need", author: "Vaswani", savedAt: 2 },
    { id: 2, title: "RFC 2119", source_label: "IETF", savedAt: 1 },
  ];

  it("filters on the title, the author and the source", () => {
    const modal = new ConceptioReadingListModal(app, items, () => {});
    expect(modal.getSuggestions("").length).toBe(2);
    expect(modal.getSuggestions("vaswani").map((i) => i.id)).toEqual([1]);
    expect(modal.getSuggestions("ietf").map((i) => i.id)).toEqual([2]);
    expect(modal.getSuggestions("nothing")).toEqual([]);
  });

  it("falls back to a plain label for an item with no metadata", () => {
    const modal = new ConceptioReadingListModal(app, [{ id: 3, title: "Bare", savedAt: 0 }], () => {});
    const el = new MockEl("div");
    modal.renderSuggestion({ id: 3, title: "Bare", savedAt: 0 }, el as unknown as HTMLElement);
    expect(lines(el)).toEqual(["Bare", "Saved"]);
  });

  it("reports the chosen entry", () => {
    const chosen: ReadingListItem[] = [];
    const modal = new ConceptioReadingListModal(app, items, (item) => chosen.push(item));
    modal.onChooseSuggestion(items[1]);
    expect(chosen[0].id).toBe(2);
  });
});

describe("ConceptioPromptModal", () => {
  it("submits the typed value and closes", () => {
    const submitted: string[] = [];
    const modal = new ConceptioPromptModal(app, {
      title: "Resolve an identifier",
      placeholder: "RFC 2119",
      cta: "Resolve",
      onSubmit: (value) => submitted.push(value),
    });
    modal.open();
    const setting = settingsInstances.at(-1);
    expect(setting?.name).toBe("");
    setting?.texts[0].type("  RFC 2119  ");
    setting?.buttons[0].press();
    expect(submitted).toEqual(["RFC 2119"]);
    expect((modal as unknown as { opened: boolean }).opened).toBe(false);
  });

  it("never submits an empty value", () => {
    const submitted: string[] = [];
    const modal = new ConceptioPromptModal(app, {
      title: "Resolve",
      placeholder: "",
      cta: "Resolve",
      onSubmit: (value) => submitted.push(value),
    });
    modal.open();
    settingsInstances.at(-1)?.texts[0].type("   ");
    settingsInstances.at(-1)?.buttons[0].press();
    expect(submitted).toEqual([]);
    expect((modal as unknown as { opened: boolean }).opened).toBe(true); // the modal stays open
  });
});
