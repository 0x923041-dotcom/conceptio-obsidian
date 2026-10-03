import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
// Extensionless on purpose: with the build artifact (`main.js`) sitting next
// to the source, an explicit `.js` specifier would load the BUNDLE instead of
// the plugin class (see vitest.config.ts → resolve.extensions).
import ConceptioPlugin, { todayIso } from "../main";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { sampleDoc } from "./helpers.js";
import { clearNotices, fakeApp, notices } from "./stubs/obsidian.js";

const manifest = { id: "conceptio", name: "Conceptio", version: "0.1.0" } as PluginManifest;

interface PluginHooks {
  commands: Array<{ id: string; name: string; callback?: () => unknown }>;
  ribbonIcons: Array<{ icon: string; title: string }>;
  settingTabs: unknown[];
}

async function loadPlugin(options: { files?: string[] } = {}): Promise<{
  plugin: ConceptioPlugin;
  hooks: PluginHooks;
  app: ReturnType<typeof fakeApp>;
}> {
  const app = fakeApp(options);
  const plugin = new ConceptioPlugin(app.app as App, manifest);
  await plugin.onload();
  // Deterministic CLI resolution: never reach a real binary from a unit test.
  plugin.settings.cliBin = "/nonexistent/conceptio-test-bin";
  return { plugin, hooks: plugin as unknown as PluginHooks, app };
}

beforeEach(() => {
  clearNotices();
});

describe("todayIso", () => {
  it("formats the local date", () => {
    expect(todayIso(new Date(2026, 8, 14))).toBe("2026-09-14");
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("plugin load", () => {
  it("registers one unique command per surface plus the ribbon icon", async () => {
    const { hooks } = await loadPlugin();
    const ids = hooks.commands.map((command) => command.id);
    expect(ids).toEqual([
      "search",
      "resolve",
      "recall-citation",
      "choose-format",
      "create-note",
      "open-document",
      "reading-list",
      "reading-list-note",
      "status",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of hooks.commands) {
      expect(command.name.length).toBeGreaterThan(0);
      expect(typeof command.callback).toBe("function");
    }
    expect(hooks.ribbonIcons).toEqual([{ icon: "search", title: "Conceptio: search the archive" }]);
    expect(hooks.settingTabs).toHaveLength(1);
  });

  it("starts from the defaults and persists settings changes", async () => {
    const { plugin } = await loadPlugin();
    expect(plugin.settings.apiBase).toBe(DEFAULT_SETTINGS.apiBase);
    plugin.settings.apiKey = "ckey_live_x";
    await plugin.saveSettings();
    const saved = (plugin as unknown as { savedData(): Record<string, unknown> }).savedData();
    expect((saved.settings as Record<string, unknown>).apiKey).toBe("ckey_live_x");
  });
});

describe("commands that need a document", () => {
  it("explains how to pick one instead of failing silently", async () => {
    const { hooks } = await loadPlugin();
    const recall = hooks.commands.find((command) => command.id === "recall-citation");
    await recall?.callback?.();
    expect(notices.map((notice) => notice.message)).toEqual([
      "Pick a document first — run “Conceptio: Search the archive”.",
    ]);
  });
});

describe("createNote", () => {
  it("writes frontmatter + the document section into the configured folder", async () => {
    const { plugin, app } = await loadPlugin();
    await plugin.createNote(sampleDoc());
    const path = "Conceptio/Attention Is All You Need.md";
    const content = app.files.get(path);
    expect(content).toBeTruthy();
    expect(content).toContain('title: "Attention Is All You Need"');
    expect(content).toContain('conceptio_id: "7288"');
    expect(content).toContain(`accessed: "${todayIso()}"`);
    expect(content).toContain("# Attention Is All You Need");
    expect(content).toContain("<!-- conceptio:doc:7288 -->");
    expect(app.folders).toContain("Conceptio");
    expect(app.opened).toEqual([path]);
    expect(notices.at(-1)?.message).toBe(`Note created: ${path}`);
  });

  it("never clobbers a note the user already has", async () => {
    const { plugin, app } = await loadPlugin({ files: ["Conceptio/Attention Is All You Need.md"] });
    await plugin.createNote(sampleDoc());
    expect(app.files.get("Conceptio/Attention Is All You Need.md")).toBe("");
    expect(notices.at(-1)?.message).toBe("Note already exists: Conceptio/Attention Is All You Need.md");
  });

  it("respects frontmatter: false", async () => {
    const { plugin, app } = await loadPlugin();
    plugin.settings.frontmatter = false;
    await plugin.createNote(sampleDoc());
    expect(app.files.get("Conceptio/Attention Is All You Need.md")?.startsWith("# Attention")).toBe(true);
  });
});

describe("exportReadingList", () => {
  it("creates the reading-list note, then updates it in place", async () => {
    const { plugin, app } = await loadPlugin();
    await plugin.exportReadingList();
    expect(app.files.get("Conceptio Reading List.md")).toContain("_Nothing saved yet._");
    expect(notices.at(-1)?.message).toContain("Reading list exported");

    await plugin.exportReadingList();
    expect(app.modified).toHaveLength(1);
    expect(notices.at(-1)?.message).toContain("Reading list updated");
  });
});

describe("clipboard and status surfaces", () => {
  it("falls back to a Notice when there is no clipboard", async () => {
    const { plugin } = await loadPlugin();
    await (plugin as unknown as { copyText(text: string): Promise<void> }).copyText("hello");
    expect(notices.at(-1)?.message).toContain("hello");
  });

  it("reports the CLI's absence from the status command instead of throwing", async () => {
    const { plugin } = await loadPlugin();
    await plugin.showStatus();
    expect(notices.at(-1)?.message).toMatch(/conceptio CLI not found/);
  });

  it("explains a missing editor rather than inserting nothing", async () => {
    const { plugin } = await loadPlugin();
    await plugin.insertCitation(sampleDoc(), "apa");
    expect(notices.map((notice) => notice.message)).toContain(
      "Open a note first — the citation goes at the cursor.",
    );
  });
});

describe("the Obsidian CLI surface", () => {
  type Handler = (params: Record<string, string | "true">) => string | Promise<string>;
  type Registered = { command: string; description: string; handler: Handler };

  const handlers = (plugin: ConceptioPlugin): Registered[] =>
    (plugin as unknown as { cliHandlers: Registered[] }).cliHandlers;

  const handler = (plugin: ConceptioPlugin, command: string): Handler => {
    const found = handlers(plugin).find((entry) => entry.command === command);
    if (!found) throw new Error(`not registered: ${command}`);
    return found.handler;
  };

  it("claims the conceptio commands alongside the palette ones", async () => {
    const { plugin } = await loadPlugin();
    const ids = handlers(plugin).map((entry) => entry.command);
    expect(ids).toEqual([
      "conceptio",
      "conceptio:quota",
      "conceptio:search",
      "conceptio:resolve",
      "conceptio:cite",
      "conceptio:info",
      "conceptio:proof",
      "conceptio:insert",
      "conceptio:note",
      "conceptio:saved",
      "conceptio:reading-list",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("acknowledges synchronously, then reports the CLI's absence in-app", async () => {
    const { plugin } = await loadPlugin();
    // loadPlugin points the bridge at a binary that cannot exist, so the work
    // fails at exactly the CLI boundary — proving the handler reaches it.
    // The ack is what the terminal caller sees (Obsidian's CLI cannot return a
    // result that settles this late — README), and the failure is not silent.
    const ack = handler(plugin, "conceptio:quota")({});
    expect(ack).toBeTypeOf("string");
    expect(ack).toContain("notice");
    await vi.waitFor(() =>
      expect(notices.some((notice) => /conceptio CLI not found/.test(notice.message))).toBe(true),
    );
  });

  it("answers a missing editor with a notice, and still acknowledges", async () => {
    const { plugin } = await loadPlugin();
    const ack = handler(plugin, "conceptio:insert")({ id: "7288" });
    expect(ack).toBeTypeOf("string");
    await vi.waitFor(() =>
      expect(notices.some((notice) => /Open a note first/.test(notice.message))).toBe(true),
    );
  });

  it("rejects a malformed invocation before touching the CLI", async () => {
    const { plugin } = await loadPlugin();
    // Validation is synchronous by construction, so this is thrown — the one
    // shape Obsidian's CLI does print.
    expect(() => handler(plugin, "conceptio:cite")({})).toThrow(/Missing required parameter: id/);
    expect(notices).toHaveLength(0);
  });
});
