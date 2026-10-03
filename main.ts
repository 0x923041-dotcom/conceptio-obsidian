/**
 * Conceptio for Obsidian.
 *
 * A thin presenter over the shared `conceptio` CLI (`pip install
 * conceptio-search`): search the open-access archive from inside the vault,
 * insert citations into notes, write cited notes with frontmatter and a proof
 * link, and keep a reading list that travels with the vault. Auth, retries,
 * rate-limit handling and upgrade hints all live in the CLI — this plugin
 * never talks to the REST API directly and never stores a credential of its
 * own beyond the setting you type into it.
 *
 * The archive calls spawn a process, so the plugin is desktop-only.
 */

import {
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type App,
  type Editor,
} from "obsidian";
import { resultActions, type ResultAction } from "./src/actions.js";
import { buildCli, type CliHandle } from "./src/cli.js";
import {
  installCliCommands,
  type CliCommandDeps,
  type CliRegistrar,
} from "./src/cliCommands.js";
import {
  buildNote,
  buildNoteSection,
  errorMessage,
  markdownLink,
  notePath,
  readerUrl,
} from "./src/format.js";
import { ensureFolder, normalizeNotePath, writeNote } from "./src/notes.js";
import { ReadingList, READING_LIST_KEY } from "./src/readingList.js";
import {
  ConceptioActionModal,
  ConceptioFormatModal,
  ConceptioPromptModal,
  ConceptioReadingListModal,
  ConceptioSearchModal,
} from "./src/searchModal.js";
import {
  DataStore,
  DEFAULT_SETTINGS,
  normalizeSettings,
  parseTags,
  type ConceptioSettings,
} from "./src/settings.js";
import { CITATION_FORMAT_LABELS, type SearchResult } from "./src/types.js";

/** `YYYY-MM-DD` in the user's local timezone. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default class ConceptioPlugin extends Plugin {
  override settings: ConceptioSettings = { ...DEFAULT_SETTINGS };
  private store!: DataStore;
  private readingList!: ReadingList;
  /** Last document the user picked, so the palette commands can act on it. */
  private lastResult: SearchResult | null = null;

  override async onload(): Promise<void> {
    this.store = new DataStore({
      load: () => this.loadData(),
      save: async (data) => {
        await this.saveData(data);
      },
    });
    await this.store.init();
    this.settings = normalizeSettings(this.store.get<unknown>("settings", null));

    this.readingList = new ReadingList({
      load: async () => this.store.get<unknown>(READING_LIST_KEY, null),
      save: async (payload) => {
        await this.store.set(READING_LIST_KEY, payload);
      },
    });
    await this.readingList.init();

    this.addRibbonIcon("search", "Conceptio: search the archive", () => {
      this.openSearch();
    });

    this.addCommand({ id: "search", name: "Search the archive", callback: () => this.openSearch() });
    this.addCommand({
      id: "resolve",
      name: "Resolve an identifier",
      callback: () => this.resolveIdentifier(),
    });
    this.addCommand({
      id: "recall-citation",
      name: "Insert citation for the last document",
      callback: () => this.withLastResult((doc) => this.insertCitation(doc, this.settings.citationFormat)),
    });
    this.addCommand({
      id: "choose-format",
      name: "Insert citation — choose format",
      callback: () => this.withLastResult((doc) => this.chooseCitationFormat(doc)),
    });
    this.addCommand({
      id: "create-note",
      name: "Create a note for the last document",
      callback: () => this.withLastResult((doc) => this.createNote(doc)),
    });
    this.addCommand({
      id: "open-document",
      name: "Open the last document in the browser",
      callback: () => this.withLastResult((doc) => this.openUrl(readerUrl(doc.id, this.settings.apiBase))),
    });
    this.addCommand({
      id: "reading-list",
      name: "Open the reading list",
      callback: () => this.openReadingList(),
    });
    this.addCommand({
      id: "reading-list-note",
      name: "Export the reading list to a note",
      callback: () => this.exportReadingList(),
    });
    this.addCommand({
      id: "status",
      name: "Show the account status",
      callback: () => this.showStatus(),
    });

    this.addSettingTab(new ConceptioSettingTab(this.app, this));
    this.registerCliCommands();
  }

  /** Persist settings (called by the settings tab). */
  async saveSettings(): Promise<void> {
    await this.store.set("settings", this.settings);
  }

  /** The CLI bridge, built fresh so a settings change applies immediately. */
  private cli(): CliHandle {
    return buildCli({
      apiBase: this.settings.apiBase,
      apiKey: this.settings.apiKey,
      licenseKey: this.settings.licenseKey,
      bin: this.settings.cliBin,
    });
  }

  /**
   * Expose Conceptio's operations as Obsidian CLI commands — `obsidian
   * conceptio:search query="zero trust"`. Feature-detected on purpose:
   * `registerCliHandler` arrived in Obsidian 1.12.2 (the same release that
   * shipped the CLI), and this plugin still runs on older apps, where the
   * palette, ribbon and commands are all it needs.
   */
  private registerCliCommands(): void {
    if (typeof this.registerCliHandler !== "function") return;
    const register = this.registerCliHandler.bind(this) as CliRegistrar;
    installCliCommands(register, this.cliCommandDeps());
  }

  /**
   * What the CLI commands render. Every entry routes through the same code path
   * a palette command uses, so the two surfaces cannot drift apart.
   */
  private cliCommandDeps(): CliCommandDeps {
    const cli = (): CliHandle => this.cli();
    return {
      search: (query, limit, license) => cli().search(query, limit, license),
      resolve: (identifier, limit) => cli().resolve(identifier, limit),
      cite: (docId, format) => cli().cite(docId, format),
      info: (docId) => cli().info(docId),
      proof: (docId) => cli().proof(docId),
      status: () => cli().status(),
      saved: () => this.readingList.list(),
      insertCitation: async (docId, format) => {
        // The palette path explains this with a Notice; from the CLI an error
        // is the honest answer, because there is no window to notice.
        if (!this.activeEditor()) {
          throw new Error("Open a note first — the citation goes at the cursor.");
        }
        return this.insertCitation({ id: docId }, format);
      },
      createNote: (result) => this.createNote(result),
      exportReadingList: () => this.exportReadingList(),
      defaultFormat: () => this.settings.citationFormat,
      // Where an archive-backed command's answer lands: the Obsidian CLI cannot
      // return it (README, "The Obsidian CLI contract, as measured"), so the
      // work runs and its result is shown here instead of nowhere.
      notify: (message) => new Notice(message, 12000),
    };
  }

  private activeEditor(): Editor | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
  }

  private async withLastResult(fn: (doc: SearchResult) => Promise<unknown> | unknown): Promise<void> {
    if (!this.lastResult) {
      new Notice("Pick a document first — run “Conceptio: Search the archive”.");
      return;
    }
    try {
      await fn(this.lastResult);
    } catch (err) {
      new Notice(errorMessage(err), 8000);
    }
  }

  /** Search, then offer the actions for the document the user picks. */
  openSearch(): void {
    const cli = this.cli();
    new ConceptioSearchModal(this.app, {
      limit: this.settings.resultLimit,
      search: (query) => cli.search(query, this.settings.resultLimit),
      onChoose: (result) => this.chooseAction(result),
      onError: (err) => new Notice(errorMessage(err), 8000),
    }).open();
  }

  /** Resolve a known identifier (RFC, DOI, arXiv, PMID, case citation). */
  resolveIdentifier(): void {
    const cli = this.cli();
    new ConceptioPromptModal(this.app, {
      title: "Resolve an identifier",
      placeholder: "RFC 2119 · doi:10.1145/3290605.3300333 · 410 U.S. 113",
      cta: "Resolve",
      onSubmit: (value) => {
        void (async () => {
          try {
            const results = await cli.resolve(value, this.settings.resultLimit);
            if (!results.length) {
              new Notice(`No document in the archive matches “${value}”.`);
              return;
            }
            if (results.length === 1) {
              await this.chooseAction(results[0]);
              return;
            }
            // More than one match: let the user pick, then act on it.
            new ConceptioSearchModal(this.app, {
              limit: results.length,
              search: async () => results,
              onChoose: (result) => void this.chooseAction(result),
              onError: (err) => new Notice(errorMessage(err), 8000),
            }).open();
          } catch (err) {
            new Notice(errorMessage(err), 8000);
          }
        })();
      },
    }).open();
  }

  /** The action menu for one document. */
  private async chooseAction(result: SearchResult): Promise<void> {
    this.lastResult = result;
    const actions = resultActions({
      result,
      settings: this.settings,
      saved: this.readingList.has(result.id),
    });
    new ConceptioActionModal(this.app, actions, (action) => {
      void this.runAction(action, result);
    }).open();
  }

  /** Dispatch one chosen action. */
  private async runAction(action: ResultAction, result: SearchResult): Promise<void> {
    try {
      switch (action.kind) {
        case "insert-citation":
          await this.insertCitation(result, action.format ?? this.settings.citationFormat);
          return;
        case "append-section":
          await this.appendSection(result);
          return;
        case "create-note":
          await this.createNote(result);
          return;
        case "toggle-reading-list":
          await this.toggleReadingList(result);
          return;
        case "copy-citation":
          await this.copyCitation(result, action.format ?? this.settings.citationFormat);
          return;
        case "copy-link":
          await this.copyText(markdownLink(result, this.settings.apiBase));
          return;
        case "open-document":
          this.openUrl(readerUrl(result.id, this.settings.apiBase));
          return;
        case "open-pdf":
          if (result.direct_pdf_url) this.openUrl(result.direct_pdf_url);
          return;
      }
    } catch (err) {
      new Notice(errorMessage(err), 8000);
    }
  }

  /**
   * Insert a citation at the cursor of the active note.
   *
   * Takes only the document ID so the CLI command (`conceptio:insert id=…`) can
   * call it too, and returns the citation so the CLI has something to print.
   */
  async insertCitation(result: Pick<SearchResult, "id">, format: string): Promise<string> {
    const editor = this.activeEditor();
    if (!editor) {
      new Notice("Open a note first — the citation goes at the cursor.");
      return "";
    }
    const citation = await this.cli().cite(result.id, format as never);
    editor.replaceSelection(citation.endsWith("\n") ? citation : `${citation}\n`);
    new Notice(`Citation inserted (${format}).`);
    return citation;
  }

  private async copyCitation(result: SearchResult, format: string): Promise<void> {
    const citation = await this.cli().cite(result.id, format as never);
    await this.copyText(citation);
  }

  private chooseCitationFormat(result: SearchResult): void {
    new ConceptioFormatModal(this.app, (format) => {
      void this.insertCitation(result, format).catch((err) => new Notice(errorMessage(err), 8000));
    }).open();
  }

  /** Append the document's cited section to the note being edited. */
  private async appendSection(result: SearchResult): Promise<void> {
    const editor = this.activeEditor();
    if (!editor) {
      new Notice("Open a note first — the section is appended at the cursor.");
      return;
    }
    const citation = await this.optionalCitation(result);
    const section = buildNoteSection(result, {
      origin: this.settings.apiBase,
      citation,
      format: this.settings.citationFormat,
    });
    const atCursor = editor.getCursor();
    editor.replaceSelection(`\n${section}\n`);
    editor.setCursor({ line: atCursor.line, ch: 0 });
    new Notice("Cited section appended.");
  }

  /** Create (never overwrite) a note for the document; returns its vault path. */
  async createNote(result: SearchResult): Promise<string> {
    const citation = await this.optionalCitation(result);
    const content = buildNote(result, {
      origin: this.settings.apiBase,
      citation,
      format: this.settings.citationFormat,
      accessed: todayIso(),
      tags: parseTags(this.settings.tags),
      frontmatter: this.settings.frontmatter,
    });
    const path = notePath(this.settings.noteFolder, result);
    const outcome = await writeNote(this.app.vault, path, content);
    const target = normalizeNotePath(path);
    await this.app.workspace.openLinkText(target, "", false);
    new Notice(
      outcome === "created" ? `Note created: ${target}` : `Note already exists: ${target}`,
      6000,
    );
    return target;
  }

  private async toggleReadingList(result: SearchResult): Promise<void> {
    const saved = await this.readingList.toggle(result);
    new Notice(saved ? "Saved to your reading list." : "Removed from your reading list.");
  }

  private openReadingList(): void {
    const items = this.readingList.list();
    if (!items.length) {
      new Notice("Your reading list is empty — search the archive and save a document.");
      return;
    }
    new ConceptioReadingListModal(this.app, items, (item) => {
      void this.chooseAction(item as unknown as SearchResult);
    }).open();
  }

  /** (Re)write the reading-list note in the vault; returns its vault path. */
  async exportReadingList(): Promise<string> {
    const content = this.readingList.markdown(this.settings.apiBase);
    const path = normalizeNotePath(this.settings.readingListNote);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      new Notice(`Reading list updated: ${path}`, 6000);
      return path;
    }
    const slash = path.lastIndexOf("/");
    if (slash > 0) await ensureFolder(this.app.vault, path.slice(0, slash));
    await this.app.vault.create(path, content);
    new Notice(`Reading list exported: ${path}`, 6000);
    return path;
  }

  /** Tier and quota, structured when the CLI offers it and verbatim otherwise. */
  async showStatus(): Promise<void> {
    try {
      const status = await this.cli().status();
      new Notice(status.summary || "The CLI returned no status.", 10000);
    } catch (err) {
      new Notice(errorMessage(err), 8000);
    }
  }

  /** A citation is nice to have: a rate-limited tier must not block the note. */
  private async optionalCitation(result: SearchResult): Promise<string | undefined> {
    try {
      return await this.cli().cite(result.id, this.settings.citationFormat);
    } catch {
      return undefined;
    }
  }

  private async copyText(text: string): Promise<void> {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      new Notice("Copied to the clipboard.");
      return;
    }
    new Notice(`Copy this:\n${text}`, 10000);
  }

  private openUrl(url: string | undefined): void {
    if (!url) return;
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank");
      return;
    }
    new Notice(url, 10000);
  }
}

/** Settings tab — credentials, endpoint, and note shape. */
export class ConceptioSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ConceptioPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        "A Conceptio API key (ckey_live_…) — the Dev plan is the agent tier for the CLI and " +
          "every surface that rides it. Saved keys from `conceptio auth` are also honored; " +
          "leave this empty to use them.",
      )
      .addText((text) =>
        text
          .setPlaceholder("ckey_live_…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Pro license key")
      .setDesc("Optional. Used only when no API key is set.")
      .addText((text) =>
        text
          .setPlaceholder("CONCEPTIO-XXXX-XXXX-XXXX")
          .setValue(this.plugin.settings.licenseKey)
          .onChange(async (value) => {
            this.plugin.settings.licenseKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API origin")
      .setDesc("Defaults to the hosted archive; change it only for a self-hosted deployment.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.apiBase)
          .setValue(this.plugin.settings.apiBase)
          .onChange(async (value) => {
            this.plugin.settings.apiBase = value.trim() || DEFAULT_SETTINGS.apiBase;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("CLI executable")
      .setDesc("Leave empty for `conceptio` on PATH. Needed when pip installed it elsewhere.")
      .addText((text) =>
        text
          .setPlaceholder("conceptio")
          .setValue(this.plugin.settings.cliBin)
          .onChange(async (value) => {
            this.plugin.settings.cliBin = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Citation format")
      .setDesc("Used by “Insert citation at cursor” and by new notes.")
      .addDropdown((dropdown) => {
        for (const [format, label] of Object.entries(CITATION_FORMAT_LABELS)) {
          dropdown.addOption(format, label);
        }
        dropdown.setValue(this.plugin.settings.citationFormat).onChange(async (value) => {
          this.plugin.settings.citationFormat = value as ConceptioSettings["citationFormat"];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Results per search")
      .setDesc("How many documents a query fetches (1–100).")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.resultLimit))
          .onChange(async (value) => {
            this.plugin.settings.resultLimit = normalizeSettings({
              resultLimit: value,
            }).resultLimit;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Note folder")
      .setDesc("Where “Create a note for this document” writes. Empty means the vault root.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.noteFolder)
          .setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Frontmatter in new notes")
      .setDesc("Write a YAML frontmatter block (title, author, source, license, conceptio_url, …).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.frontmatter).onChange(async (value) => {
          this.plugin.settings.frontmatter = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Frontmatter tags")
      .setDesc("Comma-separated tags added to new notes.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.tags)
          .setValue(this.plugin.settings.tags)
          .onChange(async (value) => {
            this.plugin.settings.tags = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Reading-list note")
      .setDesc("The note “Export the reading list” writes and updates.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.readingListNote)
          .setValue(this.plugin.settings.readingListNote)
          .onChange(async (value) => {
            this.plugin.settings.readingListNote = value.trim() || DEFAULT_SETTINGS.readingListNote;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Check the connection")
      .setDesc("Runs `conceptio quota` and reports the tier this credential grants.")
      .addButton((button) =>
        button.setButtonText("Check").onClick(() => {
          void this.plugin.showStatus();
        }),
      );
  }
}
