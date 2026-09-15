/**
 * The Conceptio ↔ Obsidian CLI contract, tested offline.
 *
 * These pin the thing that is expensive to discover later: the two CLIs share
 * one vocabulary. Every assertion here can run with no Obsidian, no vault and
 * no network — the registration surface and the archive are both injected.
 */

import { describe, expect, it, vi } from "vitest";
import {
  actionNames,
  buildCliBaseCommand,
  buildCliCommands,
  buildCliSurface,
  citationFormat,
  clipNotice,
  cliHandlerFor,
  formatDocument,
  formatResults,
  installCliCommands,
  intParam,
  isFlag,
  licenseParam,
  optionalInt,
  requiredParam,
  withDirectives,
  type CliCommand,
  type CliCommandDeps,
  type CliParams,
  type CliRegistrar,
} from "../src/cliCommands.js";
import { sampleDoc } from "./helpers.js";

/** A deps record where every operation is a spy with a sensible default. */
function fakeDeps(overrides: Partial<CliCommandDeps> = {}): CliCommandDeps {
  return {
    search: vi.fn(async () => [sampleDoc()]),
    resolve: vi.fn(async () => [sampleDoc()]),
    cite: vi.fn(async () => "@misc{conceptio7288, title={Attention Is All You Need}}"),
    info: vi.fn(async () => sampleDoc()),
    proof: vi.fn(async () => ({ doc_id: 7288, verified: true })),
    status: vi.fn(async () => ({ summary: "Conceptio — pro tier", text: "Conceptio — pro tier\n900 left", tier: "pro" })),
    saved: vi.fn(() => []),
    insertCitation: vi.fn(async () => "@misc{conceptio7288}"),
    createNote: vi.fn(async () => "Conceptio/Attention Is All You Need.md"),
    exportReadingList: vi.fn(async () => "Conceptio Reading List.md"),
    defaultFormat: () => "bibtex",
    notify: vi.fn(),
    ...overrides,
  };
}

const catalogue = (deps = fakeDeps()): CliCommand[] => buildCliCommands(deps);

/** What the CLI is actually given: the base command plus the namespaced ones. */
const surface = (deps = fakeDeps()): CliCommand[] => buildCliSurface(deps);

/** Find one command and run it, as Obsidian's dispatcher would. */
async function run(
  id: string,
  params: CliParams,
  deps = fakeDeps(),
): Promise<string> {
  const command = buildCliCommands(deps).find((entry) => entry.id === id);
  if (!command) throw new Error(`no such command: ${id}`);
  return command.run(params);
}

// --------------------------------------------------------------------------- //

describe("command catalogue", () => {
  it("uses the plugin-id convention Obsidian documents", () => {
    const ids = catalogue().map((command) => command.id);
    // "Use the format <plugin-id> for your default command, and
    // <plugin-id>:<action> for sub-commands" — Plugin.registerCliHandler docs.
    for (const id of ids) {
      expect(id, id).toMatch(/^conceptio(:[a-z0-9-]+)?$/);
    }
    expect(ids).toContain("conceptio");
    expect(ids.filter((id) => id === "conceptio")).toHaveLength(1);
  });

  it("claims every ID exactly once (Obsidian throws on a duplicate)", () => {
    const ids = catalogue().map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never collides with a core Obsidian CLI command", () => {
    // The documented core surface, verbatim from the CLI help. A plugin
    // command is only safe because it is namespaced; this is the guard for
    // anyone who later renames one to "search".
    const core = [
      "help", "version", "reload", "restart", "search", "search:context", "search:open",
      "read", "create", "append", "prepend", "move", "rename", "delete", "open", "file",
      "files", "folder", "folders", "daily", "daily:read", "daily:append", "tasks", "task",
      "tags", "tag", "properties", "property:set", "property:read", "aliases", "backlinks",
      "links", "unresolved", "orphans", "deadends", "outline", "bookmarks", "commands",
      "command", "hotkeys", "plugins", "plugins:enabled", "plugins:restrict", "plugin",
      "plugin:enable", "plugin:reload", "random", "eval", "diff", "history", "sync", "web",
    ];
    for (const command of catalogue()) {
      expect(core, command.id).not.toContain(command.id);
    }
  });

  it("describes every command and every flag", () => {
    for (const command of catalogue()) {
      expect(command.description.length, command.id).toBeGreaterThan(0);
      for (const [name, flag] of Object.entries(command.flags ?? {})) {
        expect(flag.description.length, `${command.id}.${name}`).toBeGreaterThan(0);
      }
    }
  });

  it("marks the parameters that genuinely cannot be defaulted as required", () => {
    const required = (id: string): string[] =>
      Object.entries(catalogue().find((c) => c.id === id)?.flags ?? {})
        .filter(([, flag]) => flag.required)
        .map(([name]) => name)
        .sort();
    expect(required("conceptio:search")).toEqual(["query"]);
    expect(required("conceptio:resolve")).toEqual(["identifier"]);
    expect(required("conceptio:cite")).toEqual(["id"]);
    expect(required("conceptio:info")).toEqual(["id"]);
    expect(required("conceptio:proof")).toEqual(["id"]);
    expect(required("conceptio:insert")).toEqual(["id"]);
    expect(required("conceptio:note")).toEqual(["id"]);
  });

  it("registers the whole surface and reports what it claimed", () => {
    const registered: string[] = [];
    const registrar: CliRegistrar = (command) => {
      registered.push(command);
    };
    const deps = fakeDeps();
    const ids = installCliCommands(registrar, deps);
    expect(registered).toEqual(ids);
    // The installed surface is the catalogue spelled out, plus the base command
    // in place of the catalogue's `conceptio` — no id appears twice, and none is
    // lost on the way.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(surface(deps).map((command) => command.id));
    expect(ids.filter((id) => id === "conceptio")).toHaveLength(1);
    for (const command of catalogue(deps)) expect(ids).toContain(command.id);
  });
});

// --------------------------------------------------------------------------- //

describe("the two CLIs share one vocabulary", () => {
  /**
   * Sub-commands of the shared `conceptio` CLI and the Obsidian command that
   * mirrors each. This table *is* the compatibility contract, so a rename on
   * either side fails here rather than surprising a user mid-script.
   */
  const mirrored: Array<[string, string]> = [
    ["quota", "conceptio:quota"],
    ["search", "conceptio:search"],
    ["resolve", "conceptio:resolve"],
    ["cite", "conceptio:cite"],
    ["info", "conceptio:info"],
    ["proof", "conceptio:proof"],
  ];

  it.each(mirrored)("`conceptio %s` ↔ `obsidian %s`", (_sub, command) => {
    expect(catalogue().map((entry) => entry.id)).toContain(command);
  });

  it("deliberately leaves the non-vault sub-commands out", () => {
    // `auth`, `download`, `save`, `search-job` and `mcp` are terminal concerns:
    // a credential write, a file fetch, a Zotero/Obsidian handoff, async job
    // polling and a stdio server. None of them is an operation *inside* a vault,
    // so none gets an Obsidian command.
    const ids = catalogue().map((command) => command.id);
    for (const absent of ["auth", "download", "save", "search-job", "mcp"]) {
      expect(ids).not.toContain(`conceptio:${absent}`);
    }
  });

  it("accepts the same citation formats the CLI does", () => {
    const flag = catalogue().find((c) => c.id === "conceptio:cite")?.flags?.format;
    expect(flag?.description).toContain("bibtex");
    expect(flag?.description).toContain("oscola");
    expect(flag?.description).toContain("ansiz39");
  });
});

// --------------------------------------------------------------------------- //

describe("parameter handling", () => {
  it("reports a missing parameter the way Obsidian's own commands do", () => {
    // The core handlers throw `Missing required parameter: x\nUsage: …` and the
    // CLI prints it verbatim; Conceptio keeps that wording.
    expect(() => requiredParam({}, "id", "conceptio:cite id=<doc-id>")).toThrow(
      /Missing required parameter: id\nUsage: conceptio:cite id=<doc-id>/,
    );
  });

  it("treats a bare flag as absent when a value is required", () => {
    expect(() => requiredParam({ query: "true" }, "query", "u")).toThrow(/Missing required parameter/);
  });

  it("rejects a non-numeric document id", () => {
    expect(() => intParam({ id: "abc" }, "id", "u")).toThrow(/"id" must be a number, got "abc"/);
  });

  it("defaults and validates optional numbers", () => {
    expect(optionalInt({}, "limit", 10)).toBe(10);
    expect(optionalInt({ limit: "25" }, "limit", 10)).toBe(25);
    expect(optionalInt({ limit: "true" }, "limit", 10)).toBe(10);
    expect(() => optionalInt({ limit: "x" }, "limit", 10)).toThrow(/"limit" must be a number/);
  });

  it("reads a bare boolean flag as true and nothing else as true", () => {
    expect(isFlag({ json: "true" }, "json")).toBe(true);
    expect(isFlag({}, "json")).toBe(false);
    expect(isFlag({ json: "false" }, "json")).toBe(false);
  });

  it("folds source/lang/category into the query as the CLI's directives", () => {
    expect(withDirectives("zero trust", {})).toBe("zero trust");
    expect(withDirectives("zero trust", { source: "arxiv", lang: "en" })).toBe(
      "zero trust source:arxiv lang:en",
    );
    // The bare-flag form must not leak into the query as a directive.
    expect(withDirectives("zero trust", { source: "true" })).toBe("zero trust");
  });

  it("only accepts the license the CLI accepts", () => {
    expect(licenseParam({})).toBeUndefined();
    expect(licenseParam({ license: "commercial-ok" })).toBe("commercial-ok");
    expect(() => licenseParam({ license: "free" })).toThrow(/"license" must be "commercial-ok"/);
  });

  it("falls back to the configured format and rejects an unknown one", () => {
    expect(citationFormat({}, fakeDeps())).toBe("bibtex");
    expect(citationFormat({ format: "apa" }, fakeDeps())).toBe("apa");
    expect(() => citationFormat({ format: "mla9" }, fakeDeps())).toThrow(
      /Unknown citation format "mla9"/,
    );
  });
});

// --------------------------------------------------------------------------- //

describe("rendering", () => {
  it("lists results as id · year · title with a count", () => {
    expect(formatResults([sampleDoc()])).toBe("7288\t2017\tAttention Is All You Need\n\n1 document(s).");
    expect(formatResults([])).toBe("No documents matched.");
  });

  it("summarises a document without inventing fields", () => {
    const rendered = formatDocument(sampleDoc());
    expect(rendered).toContain("Attention Is All You Need");
    expect(rendered).toContain("Ashish Vaswani; Noam Shazeer · 2017 · arXiv");
    expect(rendered).toContain("https://arxiv.org/abs/1706.03762");
    // A sparse document degrades to just its title.
    expect(formatDocument({ id: 1, title: "Bare" })).toBe("Bare");
  });
});

// --------------------------------------------------------------------------- //

describe("commands", () => {
  it("searches with directives, the limit and the license", async () => {
    const deps = fakeDeps();
    const output = await run(
      "conceptio:search",
      { query: "zero trust", source: "arxiv", limit: "3", license: "commercial-ok" },
      deps,
    );
    expect(deps.search).toHaveBeenCalledWith("zero trust source:arxiv", 3, "commercial-ok");
    expect(output).toContain("Attention Is All You Need");
  });

  it("emits JSON when the json flag is set", async () => {
    const output = await run("conceptio:search", { query: "x", json: "true" });
    expect(JSON.parse(output)).toHaveLength(1);
  });

  it("refuses a search with no query, before any archive call", async () => {
    const deps = fakeDeps();
    await expect(run("conceptio:search", {}, deps)).rejects.toThrow(
      /Missing required parameter: query/,
    );
    expect(deps.search).not.toHaveBeenCalled();
  });

  it("resolves an identifier", async () => {
    const deps = fakeDeps();
    await run("conceptio:resolve", { identifier: "10.1145/3290605.3300333" }, deps);
    expect(deps.resolve).toHaveBeenCalledWith("10.1145/3290605.3300333", 10);
  });

  it("cites by document id and honours the format", async () => {
    const deps = fakeDeps();
    const output = await run("conceptio:cite", { id: "7288", format: "apa" }, deps);
    expect(deps.cite).toHaveBeenCalledWith(7288, "apa");
    expect(output).toContain("@misc{conceptio7288");
  });

  it("wraps a citation in JSON only when asked", async () => {
    const output = await run("conceptio:cite", { id: "7288", json: "true" });
    expect(JSON.parse(output)).toEqual({
      id: 7288,
      format: "bibtex",
      citation: "@misc{conceptio7288, title={Attention Is All You Need}}",
    });
  });

  it("reports metadata and the evidence bundle", async () => {
    expect(await run("conceptio:info", { id: "7288" })).toContain("Attention Is All You Need");
    expect(JSON.parse(await run("conceptio:proof", { id: "7288" }))).toEqual({
      doc_id: 7288,
      verified: true,
    });
  });

  it("inserts into the active note through the plugin's own path", async () => {
    const deps = fakeDeps();
    const output = await run("conceptio:insert", { id: "7288" }, deps);
    expect(deps.insertCitation).toHaveBeenCalledWith(7288, "bibtex");
    expect(output).toContain("Inserted (bibtex)");
  });

  it("fetches the document before writing a note", async () => {
    const deps = fakeDeps();
    const output = await run("conceptio:note", { id: "7288" }, deps);
    expect(deps.info).toHaveBeenCalledWith(7288);
    expect(deps.createNote).toHaveBeenCalledWith(sampleDoc());
    expect(output).toBe("Note ready: Conceptio/Attention Is All You Need.md");
  });

  it("lists and exports the reading list", async () => {
    expect(await run("conceptio:saved", {})).toBe("The reading list is empty.");
    const deps = fakeDeps({ saved: () => [{ id: 7288, title: "Attention", savedAt: 1 }] });
    expect(await run("conceptio:saved", {}, deps)).toContain("Attention");
    expect(JSON.parse(await run("conceptio:saved", { json: "true" }, deps))).toHaveLength(1);
    expect(await run("conceptio:reading-list", {})).toBe(
      "Reading list exported: Conceptio Reading List.md",
    );
  });

  it("shows the account status from the default command and quota", async () => {
    expect(await run("conceptio", {})).toBe("Conceptio — pro tier\n900 left");
    expect(await run("conceptio:quota", {})).toBe("Conceptio — pro tier");
    expect(JSON.parse(await run("conceptio", { json: "true" }))).toEqual({
      tier: "pro",
      summary: "Conceptio — pro tier",
    });
  });
});

// --------------------------------------------------------------------------- //

describe("delivery: what the CLI can actually carry", () => {
  /**
   * Obsidian's CLI prints a handler's return value only when it settles within
   * tens of milliseconds of the dispatch (measured; README has the evidence).
   * Archive calls take hundreds, so those commands acknowledge synchronously
   * and deliver in-app — and these tests pin both halves of that bargain.
   */
  const handlerFor = (id: string, deps: CliCommandDeps, params: CliParams = {}) => {
    const command = buildCliCommands(deps).find((entry) => entry.id === id)!;
    return { command, handler: cliHandlerFor(command, deps), params };
  };

  it("splits the surface by where the answer has to go", () => {
    const byDelivery = (delivery: string) =>
      surface()
        .filter((command) => (command.delivery ?? "stdout") === delivery)
        .map((command) => command.id)
        .sort();
    // Everything that waits on the archive must acknowledge; local work keeps
    // returning on stdout, because that value does arrive. The base command is
    // not wrapped itself — it forwards to an already-wrapped action.
    expect(byDelivery("notice")).toEqual([
      "conceptio:cite",
      "conceptio:info",
      "conceptio:insert",
      "conceptio:note",
      "conceptio:proof",
      "conceptio:quota",
      "conceptio:resolve",
      "conceptio:search",
    ]);
    expect(byDelivery("stdout")).toEqual(["conceptio", "conceptio:reading-list", "conceptio:saved"]);
  });

  it("gives every notice-delivery command something to say synchronously", () => {
    for (const command of catalogue()) {
      if ((command.delivery ?? "stdout") !== "notice") continue;
      const ack = command.ack?.({ query: "zero trust", id: "7288", identifier: "10.1/x" });
      expect(ack, command.id).toBeTypeOf("string");
      expect(ack, command.id).not.toBe("");
    }
  });

  it("returns the acknowledgement synchronously, not a promise", () => {
    const deps = fakeDeps();
    const { handler } = handlerFor("conceptio:quota", deps);
    const answer = handler({});
    expect(answer).toBeTypeOf("string");
    expect(String(answer)).toContain("notice");
  });

  it("still runs the work, and delivers its value in-app", async () => {
    const notify = vi.fn();
    const deps = fakeDeps({ notify });
    const { handler } = handlerFor("conceptio:quota", deps);
    handler({});
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith("Conceptio — pro tier");
    expect(deps.status).toHaveBeenCalledTimes(1);
  });

  it("delivers the real payload of a search, not a placeholder", async () => {
    const notify = vi.fn();
    const deps = fakeDeps({ notify });
    const { handler } = handlerFor("conceptio:search", deps);
    const ack = handler({ query: "zero trust" });
    expect(String(ack)).toContain("zero trust");
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(String(notify.mock.calls[0][0])).toContain("Attention Is All You Need");
  });

  it("reports a failure instead of going silent after spending a credit", async () => {
    const notify = vi.fn();
    const boom = new Error("CLI failed: quota exceeded");
    const deps = fakeDeps({ notify, search: vi.fn(async () => Promise.reject(boom)) });
    const { handler } = handlerFor("conceptio:search", deps);
    handler({ query: "zero trust" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("CLI failed: quota exceeded"));
  });

  it("still throws a validation error out of the handler", () => {
    // The one path the CLI *can* print: core commands report a missing
    // parameter the same way, and re-wrapping it in a promise would turn a
    // printed error into a notice nobody is looking at.
    const { handler } = handlerFor("conceptio:cite", fakeDeps(), {});
    expect(() => handler({})).toThrow(/Missing required parameter: id/);
  });

  it("registers the two-phase handler, and leaves local commands as they were", async () => {
    const notify = vi.fn();
    const registered: Record<string, (params: CliParams) => unknown> = {};
    installCliCommands((id, _d, _f, handler) => (registered[id] = handler), fakeDeps({ notify }));

    // Local work still answers on stdout: its value does arrive.
    expect(String(await registered["conceptio:reading-list"]({}))).toBe(
      "Reading list exported: Conceptio Reading List.md",
    );
    expect(notify).not.toHaveBeenCalled();

    // Archive work acknowledges synchronously and lands in a notice.
    const ack = registered["conceptio:quota"]({});
    expect(ack).toBeTypeOf("string");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Conceptio — pro tier"));
  });

  it("clips a result too long for a notice", () => {
    const long = "x".repeat(5000);
    expect(clipNotice(long).length).toBeLessThan(long.length);
    expect(clipNotice(long)).toContain("truncated");
    expect(clipNotice("short")).toBe("short");
  });
});

// --------------------------------------------------------------------------- //

describe("the base command — the door that opens on every build", () => {
  /**
   * `obsidian conceptio [<action>] [key=value …]`.
   *
   * Measured: a colon-command with arguments is refused by an older Obsidian
   * shell before it reaches the plugin, while a command whose first token has
   * no colon carries arguments normally. So this spelling is not sugar — it is
   * what keeps every operation reachable without asking anyone to reinstall.
   */
  const base = (deps = fakeDeps()) => {
    const commands = buildCliCommands(deps);
    const command = buildCliBaseCommand(commands, deps);
    return { command, handler: cliHandlerFor(command, deps), deps };
  };

  it("keeps the base id, so nothing that already worked changes meaning", () => {
    const { command } = base();
    expect(command.id).toBe("conceptio");
    expect(actionNames(buildCliCommands(fakeDeps()))).toEqual([
      "cite",
      "info",
      "insert",
      "note",
      "proof",
      "quota",
      "reading-list",
      "resolve",
      "saved",
      "search",
    ]);
  });

  it("lists every action in its own help, so `help` is enough to find them", () => {
    const { command } = base();
    const described = command.description + " " + command.flags!.action.description;
    for (const name of actionNames(buildCliCommands(fakeDeps()))) {
      expect(described, name).toContain(name);
    }
  });

  it("routes action=<name> to the same handler the namespaced command uses", async () => {
    const notify = vi.fn();
    const deps = fakeDeps({ notify });
    const { handler } = base(deps);
    // quota: archive-backed, so it answers synchronously and delivers a notice.
    const ack = handler({ action: "quota" });
    expect(ack).toBeTypeOf("string");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Conceptio — pro tier"));
    // search: the query and its directives arrive exactly as on `conceptio:search`.
    const searchAck = handler({ action: "search", query: "zero trust", source: "arxiv" });
    expect(String(searchAck)).toContain("zero trust");
    await vi.waitFor(() =>
      expect(deps.search).toHaveBeenCalledWith("zero trust source:arxiv", 10, undefined),
    );
  });

  it("accepts the action bare, the way a terminal reads best", async () => {
    // `obsidian conceptio search query="…" json` — a bare key arrives as "true".
    const notify = vi.fn();
    const deps = fakeDeps({ notify });
    const { handler } = base(deps);
    const ack = handler({ search: "true", query: "zero trust", json: "true" });
    expect(String(ack)).toContain("zero trust");
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(JSON.parse(String(notify.mock.calls[0][0]))[0].title).toBe("Attention Is All You Need");
    // `json` is a flag, not an action: it must not have been read as one.
    expect(deps.search).toHaveBeenCalledTimes(1);
  });

  it("still defaults to the account status when no action is named", async () => {
    // Unchanged from before this command learned to route: `conceptio` alone is
    // the status, including its `json` form. The status command answers with its
    // long text, the way it always has.
    const notify = vi.fn();
    const deps = fakeDeps({ notify });
    const { handler } = base(deps);
    const ack = handler({});
    expect(ack).toBeTypeOf("string");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Conceptio — pro tier\n900 left"));
    expect(deps.status).toHaveBeenCalledTimes(1);
  });

  it("answers an unknown action with the list, synchronously", () => {
    const { handler } = base();
    expect(() => handler({ action: "teleport" })).toThrow(/Unknown action "teleport"\. Try one of: cite/);
    // A stray bare word that is not ours stays a parameter, not an error.
    expect(() => handler({ teleport: "true" })).not.toThrow();
  });

  it("keeps validation synchronous through the base door", () => {
    const { handler } = base();
    expect(() => handler({ action: "cite" })).toThrow(/Missing required parameter: id/);
    expect(() => handler({ cite: "true" })).toThrow(/Missing required parameter: id/);
  });

  it("delivers local actions on stdout, exactly like their namespaced twins", async () => {
    const notify = vi.fn();
    const { handler } = base(fakeDeps({ notify }));
    expect(String(await handler({ action: "reading-list" }))).toBe(
      "Reading list exported: Conceptio Reading List.md",
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("cannot fall behind an action: both doors come from one catalogue", () => {
    const deps = fakeDeps();
    const commands = buildCliCommands(deps);
    const described = buildCliBaseCommand(commands, deps).flags!.action.description;
    for (const command of commands.filter((c) => c.id.startsWith("conceptio:"))) {
      const name = command.id.slice("conceptio:".length);
      expect(actionNames(commands), name).toContain(name);
      // Every action in the catalogue is named in the base command's help.
      expect(described, name).toContain(name);
    }
  });

  it("declares every action's parameters, and requires none of them", () => {
    // A parameter the host does not know about is not reliably carried, so the
    // base command's flag list is the union of the actions' own. None may be
    // marked required: `conceptio` alone is a valid invocation, and so is
    // `conceptio cite id=42` (no query). Requiredness is enforced per action.
    const deps = fakeDeps();
    const commands = buildCliCommands(deps);
    const flags = buildCliBaseCommand(commands, deps).flags!;
    for (const command of commands.filter((c) => c.id.startsWith("conceptio:"))) {
      for (const name of Object.keys(command.flags ?? {})) {
        expect(flags, `${command.id} → ${name}`).toHaveProperty(name);
      }
    }
    for (const [name, flag] of Object.entries(flags)) {
      expect(flag.required, name).toBeFalsy();
    }
    // `action` is the base command's own, and it is the one thing `help` needs.
    expect(flags).toHaveProperty("action");
  });

  it("routes a bare action's parameters straight through, values intact", async () => {
    // The whole point of the union: a parameterized action is reachable in the
    // spelling that carries arguments on every build.
    const deps = fakeDeps();
    const { handler } = base(deps);
    handler({ cite: "true", id: "7288", format: "apa" });
    await vi.waitFor(() => expect(deps.cite).toHaveBeenCalledWith(7288, "apa"));
    handler({ action: "search", query: "zero trust", limit: "3", license: "commercial-ok" });
    await vi.waitFor(() =>
      expect(deps.search).toHaveBeenCalledWith("zero trust", 3, "commercial-ok"),
    );
  });

  it("clips a result too long for a notice (again, through the base door)", () => {
    const long = "x".repeat(5000);
    expect(clipNotice(long).length).toBeLessThan(long.length);
    expect(clipNotice(long)).toContain("truncated");
    expect(clipNotice("short")).toBe("short");
  });
});
