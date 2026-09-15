/**
 * Conceptio as first-class Obsidian CLI commands.
 *
 * Obsidian 1.12.2+ ships an `obsidian` command line interface, and
 * `Plugin.registerCliHandler()` lets a plugin claim namespaced command IDs in
 * that same command map (the doc comment is explicit: "Use the format
 * `<plugin-id>` for your default command, and `<plugin-id>:<action>` for
 * sub-commands"). This module claims Conceptio's operations there — mirroring
 * the shared `conceptio` CLI's own sub-commands one for one, so the same
 * vocabulary works from either door:
 *
 *   conceptio search "zero trust source:arxiv" --json
 *   obsidian conceptio:search query="zero trust source:arxiv" json
 *
 * The plugin stays a presenter: every archive call still runs through the
 * shared `conceptio` CLI (src/cli.ts). Nothing here talks to the network or to
 * the REST API directly, so the CLI remains the single implementation of the
 * wire contract.
 *
 * The registration surface is injected (`CliRegistrar`) rather than reached
 * through `this`, so the whole catalogue is testable offline with no running
 * Obsidian and no `Plugin` instance.
 *
 * ## Why some commands answer in two steps (`delivery: "notice"`)
 *
 * Measured against Obsidian 1.13.7 on Windows, from the app's side: a CLI
 * handler's return value reaches the caller **only if it settles within a few
 * tens of milliseconds** of the dispatch. A handler that resolves in ~1ms is
 * printed; one that resolves 50ms later prints nothing and the client has
 * already exited. Everything that spawns the shared `conceptio` CLI costs
 * hundreds of milliseconds, so those answers can never be returned.
 *
 * Silence would also hide that the work happened, so those commands answer
 * synchronously (`ack`) and deliver the real result in-app via `notify`, where
 * a human can read it — while the archive call, the note it writes and the
 * credits it spends are all unchanged. Commands whose work is local (the
 * reading list, the export) keep answering on stdout, because that arrives.
 * The evidence and the reproduction live in README.md (“The Obsidian CLI
 * contract, as measured”).
 */

import type { CliData, CliFlag, CliHandler } from "obsidian";
import type { QuotaStatus } from "./cli.js";
import type { ReadingListItem } from "./readingList.js";
import {
  CITATION_FORMATS,
  isCitationFormat,
  type CitationFormat,
  type SearchResult,
} from "./types.js";

/**
 * The one method this module needs from the plugin. Typed as Obsidian's own
 * `registerCliHandler` so `main.ts` can pass `this.registerCliHandler.bind(this)`
 * with no adapter.
 */
export type CliRegistrar = (
  command: string,
  description: string,
  flags: Record<string, CliFlag> | null,
  handler: CliHandler,
) => void;

/** Parsed CLI parameters, exactly as Obsidian hands them to a handler. */
export type CliParams = CliData;

/**
 * How a command's answer reaches the caller.
 *
 * - `stdout` — returned as the handler's value. Correct for work that finishes
 *   locally (a few ms), because that value is the one the CLI will print.
 * - `notice` — acknowledged synchronously and delivered in-app. Necessary for
 *   anything that waits on the archive, which cannot make the print window.
 */
export type CliDelivery = "stdout" | "notice";

/** The operations the commands render. Faked wholesale in the tests. */
export interface CliCommandDeps {
  /** `conceptio search` — filters ride along as query directives, as in the CLI. */
  search(query: string, limit: number, license?: string): Promise<SearchResult[]>;
  /** `conceptio resolve` */
  resolve(identifier: string, limit: number): Promise<SearchResult[]>;
  /** `conceptio cite` */
  cite(docId: number, format: CitationFormat): Promise<string>;
  /** `conceptio info` — full metadata for one document. */
  info(docId: number): Promise<SearchResult>;
  /** `conceptio proof` */
  proof(docId: number): Promise<Record<string, unknown>>;
  /** `conceptio quota` */
  status(): Promise<QuotaStatus>;
  /** The vault's reading list, without touching the disk. */
  saved(): ReadonlyArray<ReadingListItem>;
  /** Insert a citation at the cursor of the active note; returns the citation. */
  insertCitation(docId: number, format: CitationFormat): Promise<string>;
  /** Write a cited note into the vault; returns its vault path. */
  createNote(result: SearchResult): Promise<string>;
  /** (Re)write the reading-list note; returns its vault path. */
  exportReadingList(): Promise<string>;
  /** The user's configured citation format. */
  defaultFormat(): CitationFormat;
  /**
   * Show a result in-app — used by commands that cannot return one (see the
   * module doc). In the plugin this is a `Notice`; in tests it records.
   */
  notify(message: string): void;
}

/** One command in the catalogue. */
export interface CliCommand {
  /** `conceptio` (the default command) or `conceptio:<action>`. */
  id: string;
  description: string;
  flags: Record<string, CliFlag> | null;
  run: CliHandler;
  /** Defaults to `stdout`; see `CliDelivery`. */
  delivery?: CliDelivery;
  /**
   * The synchronous answer, required when `delivery` is `notice` (and ignored
   * otherwise). Receives the parsed parameters so it can name what it started.
   */
  ack?: (params: CliParams) => string;
}

/** Notices are read at a glance; anything longer belongs in a note. */
export const NOTICE_LIMIT = 900;

/** Clip a delivered result to something a `Notice` can actually show. */
export function clipNotice(message: string): string {
  const text = String(message ?? "").trim();
  if (text.length <= NOTICE_LIMIT) return text;
  return `${text.slice(0, NOTICE_LIMIT)}\n… (truncated — run the Conceptio CLI for the full output)`;
}

/** A result row the catalogue can render — search hits and saved items alike. */
type ResultRow = { id: number; title: string; year?: string };

// --------------------------------------------------------------------------- //
// parameter helpers
// --------------------------------------------------------------------------- //

/**
 * A required parameter, or the platform's own error shape. Obsidian's core
 * handlers (`web url=<url>`, …) throw `"Missing required parameter: x\nUsage:
 * …"`, and the CLI prints that verbatim — so Conceptio keeps the same wording
 * instead of inventing a second dialect.
 */
export function requiredParam(params: CliParams, name: string, usage: string): string {
  const value = String(params[name] ?? "").trim();
  if (!value || value === "true") {
    throw new Error(`Missing required parameter: ${name}\nUsage: ${usage}`);
  }
  return value;
}

/** A required parameter parsed as an integer. */
export function intParam(params: CliParams, name: string, usage: string): number {
  const raw = requiredParam(params, name, usage);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`"${name}" must be a number, got "${raw}"\nUsage: ${usage}`);
  }
  return value;
}

/** An optional integer parameter with a default. */
export function optionalInt(params: CliParams, name: string, fallback: number): number {
  const raw = String(params[name] ?? "").trim();
  if (!raw || raw === "true") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`"${name}" must be a number, got "${raw}"`);
  }
  return value;
}

/** A boolean flag: Obsidian delivers bare flags as the string `"true"`. */
export function isFlag(params: CliParams, name: string): boolean {
  return params[name] === "true";
}

/** An optional string parameter, `undefined` when absent. */
export function optionalString(params: CliParams, name: string): string | undefined {
  const raw = String(params[name] ?? "").trim();
  return raw && raw !== "true" ? raw : undefined;
}

/**
 * Fold `source`/`lang`/`category` into the query as directives.
 *
 * The shared CLI expresses these filters *inside* the query string
 * (`search "zero trust source:arxiv lang:en"`), not as flags — so the Obsidian
 * commands accept them as named parameters and translate, rather than growing a
 * second spelling the CLI would not understand.
 */
export function withDirectives(query: string, params: CliParams): string {
  const parts = [query.trim()];
  for (const key of ["source", "lang", "category"] as const) {
    const value = optionalString(params, key);
    if (value) parts.push(`${key}:${value}`);
  }
  return parts.filter(Boolean).join(" ");
}

/** The `license` parameter, validated against the CLI's only accepted value. */
export function licenseParam(params: CliParams): string | undefined {
  const raw = optionalString(params, "license");
  if (raw === undefined) return undefined;
  if (raw !== "commercial-ok") {
    throw new Error(`"license" must be "commercial-ok", got "${raw}"`);
  }
  return raw;
}

/** The citation format for this invocation: the parameter, else the setting. */
export function citationFormat(params: CliParams, deps: CliCommandDeps): CitationFormat {
  const raw = optionalString(params, "format") ?? deps.defaultFormat();
  if (!isCitationFormat(raw)) {
    throw new Error(
      `Unknown citation format "${raw}". Try one of: ${CITATION_FORMATS.join(", ")}`,
    );
  }
  return raw;
}

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

/** Tab-separated `id · year · title` rows, plus a count — the CLI's own shape. */
export function formatResults(rows: ReadonlyArray<ResultRow>): string {
  if (!rows.length) return "No documents matched.";
  const body = rows.map((row) => [String(row.id), row.year ?? "—", row.title].join("\t"));
  return `${body.join("\n")}\n\n${rows.length} document(s).`;
}

/** A human summary of one document, for `conceptio:info` without `json`. */
export function formatDocument(doc: SearchResult): string {
  const lines = [doc.title || "Untitled"];
  const byline = [doc.author, doc.year, doc.source_label ?? doc.source]
    .filter((part) => typeof part === "string" && part)
    .join(" · ");
  if (byline) lines.push(byline);
  if (doc.url) lines.push(doc.url);
  if (doc.license) lines.push(`License: ${doc.license}`);
  if (doc.access_level) lines.push(`Access: ${doc.access_level}`);
  return lines.join("\n");
}

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

// --------------------------------------------------------------------------- //
// the catalogue
// --------------------------------------------------------------------------- //

/**
 * Every Conceptio operation, as an Obsidian CLI command.
 *
 * The IDs are the contract: `conceptio` is the default command (Obsidian's
 * documented convention for a plugin's primary action) and the rest are
 * `conceptio:<action>`. The flag names mirror the shared CLI's flags and
 * sub-commands, so a script written against one reads naturally against the
 * other.
 */
export function buildCliCommands(deps: CliCommandDeps): CliCommand[] {
  return [
    {
      id: "conceptio",
      description: "Show the Conceptio account status",
      flags: { json: { description: "Emit JSON" } },
      delivery: "notice",
      ack: () => "Checking the Conceptio account — the result will appear in a notice.",
      run: async (params) => {
        const status = await deps.status();
        return isFlag(params, "json") ? asJson({ tier: status.tier, summary: status.summary }) : status.text;
      },
    },
    {
      id: "conceptio:quota",
      description: "Show the current tier and credit usage",
      flags: { json: { description: "Emit JSON" } },
      delivery: "notice",
      ack: () => "Checking the current tier and credit usage — the result will appear in a notice.",
      run: async (params) => {
        const status = await deps.status();
        return isFlag(params, "json") ? asJson({ tier: status.tier, summary: status.summary }) : status.summary;
      },
    },
    {
      id: "conceptio:search",
      description: "Search the Conceptio open-access archive",
      flags: {
        query: {
          value: "<text>",
          description: "Search query (supports source:/lang:/category: directives)",
          required: true,
        },
        limit: { value: "<n>", description: "Max documents (1–100)" },
        source: { value: "<source>", description: "Filter by source" },
        lang: { value: "<code>", description: "Filter by language code" },
        category: { value: "<category>", description: "Filter by category" },
        license: { value: "commercial-ok", description: "Require a commercial-use license" },
        json: { description: "Emit JSON" },
      },
      delivery: "notice",
      ack: (params) => `Searching the archive for “${optionalString(params, "query") ?? ""}” — results will appear in a notice.`,
      // Not `async` on purpose: everything before the first `await` must throw
      // synchronously, so a malformed invocation is still an error the CLI
      // prints (see `cliHandlerFor`).
      run: (params) => {
        const query = withDirectives(
          requiredParam(params, "query", 'conceptio:search query="<text>"'),
          params,
        );
        const limit = optionalInt(params, "limit", 10);
        const license = licenseParam(params);
        return deps.search(query, limit, license).then((results) =>
          isFlag(params, "json") ? asJson(results) : formatResults(results),
        );
      },
    },
    {
      id: "conceptio:resolve",
      description: "Resolve an identifier (DOI, arXiv, RFC, PMID, case citation)",
      flags: {
        identifier: { value: "<identifier>", description: "The identifier to resolve", required: true },
        limit: { value: "<n>", description: "Max matches" },
        json: { description: "Emit JSON" },
      },
      delivery: "notice",
      ack: (params) =>
        `Resolving “${optionalString(params, "identifier") ?? ""}” — matches will appear in a notice.`,
      run: (params) => {
        const identifier = requiredParam(params, "identifier", 'conceptio:resolve identifier="<identifier>"');
        const limit = optionalInt(params, "limit", 10);
        return deps
          .resolve(identifier, limit)
          .then((results) => (isFlag(params, "json") ? asJson(results) : formatResults(results)));
      },
    },
    {
      id: "conceptio:cite",
      description: "Export a citation for a document",
      flags: {
        id: { value: "<doc-id>", description: "Document ID", required: true },
        format: { value: "<format>", description: `One of: ${CITATION_FORMATS.join(", ")}` },
        json: { description: "Emit JSON" },
      },
      delivery: "notice",
      ack: (params) => `Fetching the citation for #${optionalString(params, "id") ?? ""} — it will appear in a notice.`,
      run: (params) => {
        const id = intParam(params, "id", "conceptio:cite id=<doc-id>");
        const format = citationFormat(params, deps);
        return deps
          .cite(id, format)
          .then((citation) => (isFlag(params, "json") ? asJson({ id, format, citation }) : citation));
      },
    },
    {
      id: "conceptio:info",
      description: "View full metadata for a document",
      flags: {
        id: { value: "<doc-id>", description: "Document ID", required: true },
        json: { description: "Emit JSON" },
      },
      delivery: "notice",
      ack: (params) => `Looking up document #${optionalString(params, "id") ?? ""} — its metadata will appear in a notice.`,
      run: (params) => {
        const id = intParam(params, "id", "conceptio:info id=<doc-id>");
        return deps.info(id).then((doc) => (isFlag(params, "json") ? asJson(doc) : formatDocument(doc)));
      },
    },
    {
      id: "conceptio:proof",
      description: "Fetch the machine-readable evidence bundle for a document",
      flags: { id: { value: "<doc-id>", description: "Document ID", required: true } },
      delivery: "notice",
      ack: (params) => `Fetching the evidence bundle for #${optionalString(params, "id") ?? ""} — it will appear in a notice.`,
      run: (params) =>
        deps.proof(intParam(params, "id", "conceptio:proof id=<doc-id>")).then((bundle) => asJson(bundle)),
    },
    {
      id: "conceptio:insert",
      description: "Insert a citation into the active note",
      flags: {
        id: { value: "<doc-id>", description: "Document ID", required: true },
        format: { value: "<format>", description: `One of: ${CITATION_FORMATS.join(", ")}` },
      },
      delivery: "notice",
      ack: (params) => `Inserting the citation for #${optionalString(params, "id") ?? ""} — a notice will confirm.`,
      run: (params) => {
        const id = intParam(params, "id", "conceptio:insert id=<doc-id>");
        const format = citationFormat(params, deps);
        return deps.insertCitation(id, format).then((citation) => `Inserted (${format}):\n${citation}`);
      },
    },
    {
      id: "conceptio:note",
      description: "Create a cited note in the vault for a document",
      flags: { id: { value: "<doc-id>", description: "Document ID", required: true } },
      delivery: "notice",
      ack: (params) => `Creating the note for #${optionalString(params, "id") ?? ""} — a notice will confirm the path.`,
      run: (params) => {
        const id = intParam(params, "id", "conceptio:note id=<doc-id>");
        return deps.info(id).then((doc) => deps.createNote(doc)).then((path) => `Note ready: ${path}`);
      },
    },
    {
      id: "conceptio:saved",
      description: "List the documents saved in the vault reading list",
      flags: { json: { description: "Emit JSON" } },
      run: async (params) => {
        const items = deps.saved();
        if (isFlag(params, "json")) return asJson(items);
        return items.length ? formatResults(items) : "The reading list is empty.";
      },
    },
    {
      id: "conceptio:reading-list",
      description: "Export the reading list to a note",
      flags: null,
      run: async () => `Reading list exported: ${await deps.exportReadingList()}`,
    },
  ];
}

/**
 * The handler the CLI actually gets for one command.
 *
 * For `stdout` commands it is the command's own handler, unchanged. For
 * `notice` commands it is two-phase, and the order matters:
 *
 *   1. `command.run(params)` is called **synchronously**, so a validation error
 *      (`Missing required parameter: id`) still throws straight out of the
 *      handler — that path is printed by the CLI, and re-wrapping it in a
 *      promise would swallow it into a notice nobody is looking at.
 *   2. The work is left running, and its value or failure is delivered with
 *      `deps.notify`.
 *   3. The ack is returned synchronously, which is the only shape that arrives
 *      (see the module doc).
 *
 * A rejection is delivered too: silence from a command that spent a credit is
 * the one outcome worth avoiding.
 */
export function cliHandlerFor(command: CliCommand, deps: CliCommandDeps): CliHandler {
  if ((command.delivery ?? "stdout") === "stdout") return command.run;
  const ack = command.ack ?? (() => `${command.description} — the result will appear in a notice.`);
  return (params) => {
    const work = command.run(params); // synchronous throws propagate (see above)
    Promise.resolve(work).then(
      (value) => deps.notify(clipNotice(String(value))),
      (err) =>
        deps.notify(
          clipNotice(err instanceof Error ? err.message : `Conceptio: ${String(err)}`),
        ),
    );
    return ack(params);
  };
}

// --------------------------------------------------------------------------- //
// the base command — the door that always opens
// --------------------------------------------------------------------------- //

/** The action names, in help order. */
export function actionNames(commands: ReadonlyArray<CliCommand>): string[] {
  const prefix = "conceptio:";
  return commands
    .filter((command) => command.id.startsWith(prefix))
    .map((command) => command.id.slice(prefix.length))
    .sort();
}

function unknownAction(action: string, commands: ReadonlyArray<CliCommand>): Error {
  return new Error(
    `Unknown action "${action}". Try one of: ${actionNames(commands).join(", ")}` +
      `\nUsage: conceptio [<action>] [key=value …]`,
  );
}

/**
 * The union of every action's flags — the base command's own parameter list.
 *
 * The base command has to accept whatever any action needs, so it declares
 * them all (a parameter the host does not know about is not reliably carried).
 * The one edit is `required`: no flag is required of *every* invocation —
 * `conceptio` alone is the account status, and `conceptio cite id=42` takes no
 * `query` — and the declaration is what the host checks. Requiredness is still
 * enforced, by each action's own handler, where the usage line can name the
 * action that actually wanted it.
 */
export function collectActionFlags(commands: ReadonlyArray<CliCommand>): Record<string, CliFlag> {
  const flags: Record<string, CliFlag> = {};
  for (const command of commands) {
    if (!command.id.startsWith("conceptio:")) continue;
    for (const [name, flag] of Object.entries(command.flags ?? {})) {
      if (name in flags) continue; // same name, same meaning on every action
      const rest: CliFlag = { ...flag };
      delete rest.required;
      flags[name] = rest;
    }
  }
  return flags;
}

/**
 * Which action this invocation means.
 *
 * Two spellings, because `k=v` and bare keys are exactly what Obsidian hands a
 * handler: `action=cite id=42` and the shorter `cite id=42` (a bare key arrives
 * as the string `"true"`). A bare key only counts as an action when it *is* one
 * of ours, so `json` stays a flag.
 */
function resolveAction(
  params: CliParams,
  commands: ReadonlyArray<CliCommand>,
): string | undefined {
  const named = optionalString(params, "action");
  if (named) {
    if (!actionNames(commands).includes(named)) throw unknownAction(named, commands);
    return named;
  }
  const names = actionNames(commands);
  for (const key of Object.keys(params)) {
    if (params[key] === "true" && names.includes(key)) return key;
  }
  return undefined;
}

/**
 * `obsidian conceptio [<action>] [key=value …]` — every operation behind ONE
 * command whose name has no colon.
 *
 * This exists because of a measured property of the CLI, not for looks. On an
 * older Obsidian shell a colon-command with arguments is refused before it ever
 * reaches the plugin (`conceptio:quota json` exits `-1` in ~30ms, the renderer
 * never called — README, "The Obsidian CLI contract, as measured"; Obsidian's
 * own `dev:debug on` behaves identically, so it is the host, not us). A command
 * whose first token has **no** colon carries arguments normally on the same
 * build. So the namespaced commands stay the documented face — and this base
 * command keeps every operation reachable, on every build, without asking a
 * user to reinstall anything.
 *
 * It delegates to the very same handlers as the namespaced commands (through
 * `cliHandlerFor`, so each action keeps its own delivery), which is why the two
 * doors cannot drift apart: there is one implementation of each action.
 */
export function buildCliBaseCommand(
  commands: ReadonlyArray<CliCommand>,
  deps: CliCommandDeps,
): CliCommand {
  const status = commands.find((command) => command.id === "conceptio");
  if (!status) throw new Error("the catalogue has no `conceptio` command to build the base on");
  const names = actionNames(commands);
  const byName = new Map(
    commands
      .filter((command) => command.id.startsWith("conceptio:"))
      .map((command) => [command.id.slice("conceptio:".length), command]),
  );

  return {
    id: "conceptio",
    description: `Run a Conceptio action (${names.join(", ")})`,
    flags: {
      action: { value: "<name>", description: `One of: ${names.join(", ")} (may also be given bare)` },
      ...collectActionFlags(commands),
    },
    // Delivery belongs to the action (see `cliHandlerFor`), so this command is
    // not wrapped itself — it forwards to an already-wrapped handler.
    delivery: "stdout",
    run: (params) => {
      const action = resolveAction(params, commands);
      if (!action) return cliHandlerFor(status, deps)(params); // no action: account status
      const command = byName.get(action);
      if (!command) throw unknownAction(action, commands);
      const rest: CliParams = { ...params };
      delete rest.action;
      delete rest[action];
      return cliHandlerFor(command, deps)(rest);
    },
  };
}

/**
 * Everything the CLI gets: the base command first, then the namespaced ones.
 * Built from one catalogue, so the base cannot fall behind an action.
 */
export function buildCliSurface(deps: CliCommandDeps): CliCommand[] {
  const commands = buildCliCommands(deps);
  return [buildCliBaseCommand(commands, deps), ...commands.filter((c) => c.id !== "conceptio")];
}

/**
 * Register the whole surface. Returns the IDs registered, so `main.ts` can log
 * exactly what the CLI now exposes.
 */
export function installCliCommands(registrar: CliRegistrar, deps: CliCommandDeps): string[] {
  const commands = buildCliSurface(deps);
  for (const command of commands) {
    registrar(command.id, command.description, command.flags, cliHandlerFor(command, deps));
  }
  return commands.map((command) => command.id);
}
