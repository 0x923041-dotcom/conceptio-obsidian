/**
 * The plugin's Obsidian modals.
 *
 * Each modal is a thin presenter: the search itself, the action catalogue and
 * the citation format list all come from pure modules, so what a user sees is
 * decided by testable code and only the rendering lives here.
 */

import { App, Modal, Setting, SuggestModal } from "obsidian";
import type { ResultAction } from "./actions.js";
import { formatResultLine, subtitleFor } from "./format.js";
import type { ReadingListItem } from "./readingList.js";
import {
  CITATION_FORMAT_LABELS,
  CITATION_FORMATS,
  type CitationFormat,
  type SearchResult,
} from "./types.js";

/** Citation formats matching a typed query (name or id), in API order. */
export function filterCitationFormats(query: string): CitationFormat[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...CITATION_FORMATS];
  return CITATION_FORMATS.filter(
    (format) => format.includes(q) || CITATION_FORMAT_LABELS[format].toLowerCase().includes(q),
  );
}

/** Search the archive and pick one document. */
export class ConceptioSearchModal extends SuggestModal<SearchResult> {
  private results: SearchResult[] = [];
  /** Guards against an older, slower query overwriting a newer one. */
  private seq = 0;

  constructor(
    app: App,
    private readonly deps: {
      limit: number;
      search(query: string): Promise<SearchResult[]>;
      onChoose(result: SearchResult): void;
      onError(err: unknown): void;
    },
  ) {
    super(app);
    this.setPlaceholder("Search the Conceptio archive…  (source: lang: category:)");
  }

  override async getSuggestions(query: string): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const seq = ++this.seq;
    try {
      const results = await this.deps.search(q);
      if (seq !== this.seq) return this.results; // a newer query already answered
      this.results = results.slice(0, this.deps.limit);
      return this.results;
    } catch (err) {
      this.deps.onError(err);
      return [];
    }
  }

  override renderSuggestion(result: SearchResult, el: HTMLElement): void {
    el.empty();
    el.createDiv({ cls: "conceptio-suggestion-title", text: formatResultLine(result) });
    const meta = subtitleFor(result);
    if (meta) el.createDiv({ cls: "conceptio-suggestion-meta", text: meta });
  }

  override onChooseSuggestion(result: SearchResult): void {
    this.deps.onChoose(result);
  }
}

/** Choose what to do with a document. */
export class ConceptioActionModal extends SuggestModal<ResultAction> {
  constructor(
    app: App,
    private readonly actions: ResultAction[],
    private readonly onChoose: (action: ResultAction) => void,
  ) {
    super(app);
    this.setPlaceholder("What should Conceptio do with this document?");
  }

  override getSuggestions(query: string): ResultAction[] {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return this.actions;
    return this.actions.filter(
      (action) => action.label.toLowerCase().includes(q) || action.kind.includes(q),
    );
  }

  override renderSuggestion(action: ResultAction, el: HTMLElement): void {
    el.empty();
    el.createDiv({ cls: "conceptio-suggestion-title", text: action.label });
    el.createDiv({ cls: "conceptio-suggestion-meta", text: action.detail });
  }

  override onChooseSuggestion(action: ResultAction): void {
    this.onChoose(action);
  }
}

/** Choose one of the 11 citation formats. */
export class ConceptioFormatModal extends SuggestModal<CitationFormat> {
  constructor(
    app: App,
    private readonly onChoose: (format: CitationFormat) => void,
  ) {
    super(app);
    this.setPlaceholder("Citation format…");
  }

  override getSuggestions(query: string): CitationFormat[] {
    return filterCitationFormats(query);
  }

  override renderSuggestion(format: CitationFormat, el: HTMLElement): void {
    el.empty();
    el.createDiv({ cls: "conceptio-suggestion-title", text: CITATION_FORMAT_LABELS[format] });
    el.createDiv({ cls: "conceptio-suggestion-meta", text: format });
  }

  override onChooseSuggestion(format: CitationFormat): void {
    this.onChoose(format);
  }
}

/** Browse the vault reading list and act on one entry. */
export class ConceptioReadingListModal extends SuggestModal<ReadingListItem> {
  constructor(
    app: App,
    private readonly items: ReadingListItem[],
    private readonly onChoose: (item: ReadingListItem) => void,
  ) {
    super(app);
    this.setPlaceholder("Reading list…");
  }

  override getSuggestions(query: string): ReadingListItem[] {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.author ?? "").toLowerCase().includes(q) ||
        (item.source_label ?? item.source ?? "").toLowerCase().includes(q),
    );
  }

  override renderSuggestion(item: ReadingListItem, el: HTMLElement): void {
    el.empty();
    el.createDiv({ cls: "conceptio-suggestion-title", text: item.title });
    const meta = subtitleFor(item);
    el.createDiv({ cls: "conceptio-suggestion-meta", text: meta || "Saved" });
  }

  override onChooseSuggestion(item: ReadingListItem): void {
    this.onChoose(item);
  }
}

/** One text field — used for identifiers (`:ConceptioResolve`-style lookups). */
export class ConceptioPromptModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private readonly deps: {
      title: string;
      placeholder: string;
      cta: string;
      onSubmit(value: string): void;
    },
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.deps.title });
    new Setting(contentEl)
      .addText((text) => {
        text.setPlaceholder(this.deps.placeholder).onChange((value) => {
          this.value = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
        if (typeof window !== "undefined") window.setTimeout(() => text.inputEl.focus(), 0);
      })
      .addButton((button) => {
        button.setButtonText(this.deps.cta).setCta().onClick(() => this.submit());
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const value = this.value.trim();
    if (!value) return;
    this.close();
    this.deps.onSubmit(value);
  }
}
