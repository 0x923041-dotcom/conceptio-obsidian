# Conceptio for Obsidian

**Search the [Conceptio Open Knowledge Archive](https://conceptio.app) from inside your vault** — papers, standards, textbooks, case law, regulations, and technical documents — then insert a citation, write a cited note, or keep the paper for later.

A thin presenter over the public [`conceptio`](https://github.com/0x923041-dotcom/conceptio-cli) CLI (`pip install conceptio-search`). The CLI owns auth, retries, rate-limit handling, and upgrade hints, so this plugin, the terminal, the MCP server, and the Neovim/VS Code surfaces share **one core** — there is no duplicated search, resolve, or citation logic. No credentials are embedded: the CLI resolves them from `conceptio auth`, `$CONCEPTIO_API_KEY`, or the plugin's settings, and requests go only to the configured API origin.

## Requirements

The `conceptio` CLI, **0.3.1 or newer** (`pip install -U conceptio-search`) —
the structured status report the account panel renders arrived in 0.3.1
(measured: 0.3.0 refuses `quota --json`; 0.3.1 accepts every call this plugin
makes), and on an older CLI the plugin degrades to the CLI's own human text. The CLI is where
auth, retries and the archive wire contract live; this plugin never talks to the
API directly.

- Obsidian **1.4+** on **desktop** (the plugin runs the CLI as a subprocess, so it is desktop-only by design)
- Obsidian **1.12.2+** for the [Obsidian CLI commands](#obsidian-cli) — on older apps the plugin simply registers the palette commands only
- The **`conceptio` CLI** on `PATH` — `pip install conceptio-search`
- A Conceptio **API key** (`ckey_live_…`), or a credential already saved with `conceptio auth`

The **Dev plan is the agent tier** for the CLI and every surface that rides it (REST, MCP, batch). Free keys are for the browser pool and cannot call the API.

## Install

Build it from the source you have and install it into a vault:

```bash
cd conceptio-obsidian && npm install && npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/conceptio/` and enable **Conceptio** in *Settings → Community plugins*.

### From the release (no build needed)

[`0x923041-dotcom/conceptio-obsidian`](https://github.com/0x923041-dotcom/conceptio-obsidian) is the public home — the same tree this directory builds from, and the repo the community listing is submitted from. Take the three assets from its **[latest release](https://github.com/0x923041-dotcom/conceptio-obsidian/releases/latest)** (tag == `manifest.json`'s version) into `<vault>/.obsidian/plugins/conceptio/`, or point **BRAT** at this repository and let it do the same.

Obsidian, the community directory and BRAT all install from a **tagged release** rather than the repo root, because `main.js` is a build artifact here and is not committed. What the release publishes is byte-identical to what `npm run build` produces from this tree; that is checked, not assumed.

The CLI itself:

```bash
pip install conceptio-search
conceptio auth ckey_live_...     # or set the key in the plugin's settings
```

## Commands

| Command (palette) | What it does |
| ----------------- | ------------ |
| **Conceptio: Search the archive** | Suggest-modal search with `source:` / `lang:` / `category:` directives; pick a document to act on it. Also on the ribbon. |
| **Conceptio: Resolve an identifier** | `RFC 2119`, `doi:10.1145/3290605.3300333`, `2604.08499`, `PMID 41961061`, `410 U.S. 113`, `NIST FIPS 199` — an exact match acts immediately, several matches open the picker. |
| **Conceptio: Insert citation for the last document** | Renders the configured format and inserts it at the cursor (BibTeX into LaTeX stays verbatim — Obsidian is not a LaTeX editor). |
| **Conceptio: Insert citation — choose format** | The same, after picking one of the 11 formats. |
| **Conceptio: Create a note for the last document** | Writes a note (frontmatter + proof link + citation) into the configured folder. **Never overwrites** a note you already have. |
| **Conceptio: Open the last document in the browser** | Opens the Conceptio record page. |
| **Conceptio: Open the reading list** | Browse what you saved in this vault; pick one to act on it. |
| **Conceptio: Export the reading list to a note** | Writes/updates `Conceptio Reading List.md` as a checkbox list with links. |
| **Conceptio: Show the account status** | Runs `conceptio quota --json` and renders the tier, the credit meter and the reset date; on a CLI older than 0.3.1 it falls back to the CLI's own human report. |

Pick a document and Conceptio offers: insert citation · append a cited section to the current note · create a note · save/remove from the reading list · copy citation · copy markdown link · open the record · open the PDF.

## Obsidian CLI

Obsidian 1.12.2+ ships an `obsidian` command line interface, and a plugin can claim namespaced commands in it. Conceptio claims one per operation, **mirroring the shared `conceptio` CLI's own sub-commands**, so the same vocabulary works from either door:

```bash
conceptio search "zero trust source:arxiv" --json
obsidian conceptio:search query="zero trust" source=arxiv json   # namespaced
obsidian conceptio search query="zero trust" source=arxiv json    # base command
```

### Two spellings, and the base one is what always carries arguments

A measured property of the CLI (documented in full below) is that an `obsidian <plugin>:<action>` invocation **with any parameter** is refused before it reaches the plugin, while a command whose first token has no colon is handed its arguments normally. The plugin therefore also claims the plain **`conceptio`** command, which takes the action as its first word and routes to the very same handlers:

```bash
obsidian conceptio                                  # account status
obsidian conceptio quota                            # tier and credit usage
obsidian conceptio search query="zero trust" source=arxiv
obsidian conceptio cite id=7288 format=bibtex
obsidian conceptio note id=7288
obsidian conceptio reading-list
```

**Quoting, measured rather than assumed.** In a shell, `query="zero trust"` is *syntax*: the shell consumes the quotes and hands `zero trust` as one argument, so the space reaches the archive intact. That was verified end to end — through `cmd.exe`, pwsh 7.6.3 and Windows PowerShell 5.1 (all three parse it identically; fixtures in `tests/shell-quoting/`, run by `npm test`) and then live, at the archive itself. The opposite is true when a process spawns the client with no shell: the quotes are then four literal characters *inside* the value, which is why `tests/runtime_check.mjs` passes its parameters quote-free.

**Nothing has to be reinstalled for this to work.** The namespaced commands stay the documented face — they are what `help` shows and what a current build carries — and the base command keeps every operation reachable on the build you already have. Both doors are built from one catalogue and delegate to one handler per action, so they cannot drift apart; a parameter the host does not know about is never silently dropped, because the base command declares the union of every action's parameters.

| Obsidian CLI | Mirrors | Notes |
| ------------ | ------- | ----- |
| `conceptio` | `conceptio quota` | The default command: account status. `json` for the structured form. It also takes an action — `conceptio <action> …` — see above. |
| `conceptio:quota` | `conceptio quota` | Tier and credit usage. |
| `conceptio:search` | `conceptio search` | `query` (required), `limit`, `source`, `lang`, `category`, `license=commercial-ok`, `json`. Filters are folded into the query as the CLI's own directives. |
| `conceptio:resolve` | — | `identifier` (required), `limit`, `json`. |
| `conceptio:cite` | `conceptio cite` | `id` (required), `format`, `json`. |
| `conceptio:info` | `conceptio info` | `id` (required), `json`. |
| `conceptio:proof` | `conceptio proof` | `id` (required). Always JSON. |
| `conceptio:insert` | — | `id` (required), `format`. Inserts into the active note. |
| `conceptio:note` | — | `id` (required). Writes a cited note into the vault. |
| `conceptio:saved` | — | The vault reading list; `json` for the structured form. |
| `conceptio:reading-list` | — | Export the reading list to its note. |

Turn the CLI on in *Settings → General → Command line interface*, then register it. `obsidian help` lists everything the plugin exposes.

**Obsidian has to be running — the CLI is a thin client to it.** With no instance open, `obsidian <command>` does not queue or error: it **launches Obsidian** (opening your last vault) and *discards the command*, so all you see is a window. Obsidian's own code makes that explicit — when the app takes the primary-instance path, command-line arguments are read for `--enable-features` and nothing else; the CLI-forwarding path only runs when a lock is already held by a live instance. Start Obsidian first, then run the command. (Measured 2026-09-15, from a Windows terminal with the app closed: the prompt returns immediately, the app logs `Loading updated app package …`, a vault window opens, and the command produces no output.)

`auth`, `download`, `save`, `search-job` and `mcp` are deliberately **not** mirrored: they are terminal concerns (a credential write, a file fetch, a Zotero hand-off, async job polling, a stdio server), not operations inside a vault.

### The Obsidian CLI contract, as measured

Everything below was measured against a live app (**Obsidian 1.13.7, installer 1.5.12, Windows**) by patching `window.handleCli` inside the renderer and comparing the app's own accounting with what the caller received. `tests/runtime_check.mjs` re-runs the whole matrix; the numbers are reproducible, not inferred.

**It holds at a real console too.** The rigour here is deliberate: the automated harness invokes the CLI with pipes for stdio, and Obsidian is told whether its stdio is a terminal — so a hand-driven check was done with stdout attached to a genuine console (`GetConsoleMode` confirmed the TTY, and a console echo was read back through `ReadConsoleOutputCharacter` before anything was believed). A terminal changes **nothing**: `version` and a synchronous `eval` print, a promise resolving at t+1s or t+5s prints **nothing**, `conceptio:quota` prints its acknowledgement, and `conceptio:quota json` still exits `-1`. The instrument is `tmp/obsidian-runtime/tty_probe.py`.

**1. A handler's return value arrives only if it settles within tens of milliseconds.**

| handler resolves | caller receives |
| ---------------- | --------------- |
| `Promise.resolve()` / a synchronous body (~1ms) | the value |
| a 25ms timer | the value |
| a 50ms timer, and everything slower | **nothing** |
| the shared `conceptio` CLI (a spawn, ~670ms — the app resolved with the correct text) | **nothing** |

The client process exits ~270ms after it connects, so a slow answer is written into a closed socket. This is a property of the CLI, not of this plugin: the same is true of `eval` with a timer, and it is why Obsidian's own async commands cannot print either.

This is a ceiling on `stdout`, and the base command does not raise it — its actions use the same two-step delivery as their namespaced twins, because they are the same handlers.

**2. A colon-command with an extra argument never dispatches at all.** `obsidian dev:errors x` exits with code `-1` in ~32ms and the renderer is never called (the instrumented `window.handleCli` records no call). The rule as measured: *any* `conceptio:<action>` invoked with at least one parameter fails this way, while `version x y` (no colon) dispatches normally. Zero-argument commands — `obsidian conceptio:quota` — do dispatch.

> **You do not need to reinstall anything.** The client does print *"Your Obsidian installer is out of date. Please download the latest installer which includes better CLI support"*, and the shell on the machine these numbers came from is from a 2024-era installer (Electron 28.2.3, app package 1.13.7), which is the likeliest cause of both behaviours. The plugin does not wait on that being fixed: the base **`conceptio <action>`** command (above) carries arguments and routes to the same handlers, so the parameterized operations work on that build today — verified through the real CLI client, not from inside the app. Should an update change either behaviour, `node tests/runtime_check.mjs` fails loudly and names the code to touch (`delivery` in `src/cliCommands.ts`).

**What that means for these commands.** Commands whose work is local — `conceptio:saved`, `conceptio:reading-list` — return their value on stdout, because that value *does* arrive. Commands that wait on the archive cannot, so they **acknowledge synchronously** and deliver the real result as an in-app `Notice`: the archive call, the credits it spends and the note it writes are all unchanged, and the ack is honest about where the answer went.

```bash
$ obsidian conceptio:reading-list
Reading list exported: Conceptio Reading List.md

$ obsidian conceptio:quota
Checking the current tier and credit usage — the result will appear in a notice.
```

Local work answers on stdout through either door (`obsidian conceptio reading-list` behaves exactly like `obsidian conceptio:reading-list`), and archive work acknowledges through either door — the difference is only which spelling the host agrees to carry parameters on.

A malformed invocation is still a printed error, exactly as core commands report it, because validation runs **synchronously before** the ack:

```bash
$ obsidian conceptio:cite
Error: Missing required parameter: id=<doc-id>
Usage: conceptio:cite id=<doc-id> [format=<format>] [json]
```

**For scripting, use the `conceptio` CLI.** It is the surface built for it (`conceptio search … --json`), it does not depend on a running vault, and it is where async results have always gone. The Obsidian CLI commands are the *in-app* door: the same operations, invocable from a terminal, with their answers delivered where a vault can show them.

## What a note looks like

```markdown
---
title: "Attention Is All You Need"
author: "Ashish Vaswani; Noam Shazeer"
year: "2017"
source: "arXiv"
license: "CC-BY-4.0"
access: "Full text"
language: "en"
conceptio_id: "7288"
conceptio_url: "https://www.conceptio.app/document/7288"
source_url: "https://arxiv.org/abs/1706.03762"
pdf_url: "https://arxiv.org/pdf/1706.03762"
accessed: "2026-09-14"
tags: ["conceptio"]
---

# Attention Is All You Need

> Ashish Vaswani; Noam Shazeer · 2017 · arXiv

The dominant sequence transduction models are based on complex recurrent networks.

**Provenance:** [Conceptio record](https://www.conceptio.app/document/7288) · [Source document](https://arxiv.org/abs/1706.03762) · [PDF](https://arxiv.org/pdf/1706.03762)

**Access:** Full text · License: CC-BY-4.0

## Citation (apa)

```
Vaswani, A., & Shazeer, N. (2017). Attention Is All You Need.
```

<!-- conceptio:doc:7288 -->
```

The trailing marker is how a later insert recognises the same document. The **proof link** is the Conceptio record page, which carries the source, license, content hash, and retrieval date; the machine-readable evidence bundle stays at `/api/document/{id}/proof` for programmatic use.

## Settings

| Setting | Default | Notes |
| ------- | ------- | ----- |
| API key | *(empty)* | `ckey_live_…`. Empty means "use the credential `conceptio auth` already saved". |
| Pro license key | *(empty)* | Used only when no API key is set. |
| API origin | `https://www.conceptio.app` | Change only for a self-hosted deployment. |
| CLI executable | *(empty)* | For a CLI that is not on `PATH`. |
| Citation format | `apa` | Applied to the citation commands and new notes. |
| Results per search | `10` | 1–100. |
| Note folder | `Conceptio` | Where new document notes are written. |
| Frontmatter in new notes | on | Turn off for a plain body. |
| Frontmatter tags | `conceptio` | Comma-separated. |
| Reading-list note | `Conceptio Reading List.md` | The note the export writes and updates. |
| **Check** | — | Runs `conceptio quota` and reports the tier this credential grants. |

## Privacy

The plugin talks to Conceptio **only** through the `conceptio` CLI. It stores your settings and reading list in `<vault>/.obsidian/plugins/conceptio/data.json` — inside the vault, so the reading list travels with it when you sync the vault. Nothing else leaves your machine, and there is no telemetry.

## Reading list

Saving a document adds it to a list kept with the vault (newest first). Export it any time to get a checkbox note you can work through; the export rewrites the note, so the list is the source of truth. This is deliberately **not** the browser reading list — the web app keeps that in browser storage, and no server-side list exists to sync against.

## Development

```bash
npm install
npm run check     # typecheck → suite → bundle → suite again
```

The suite is offline: an injected `execFile` stands in for the CLI (`tests/helpers.ts`) so every argument contract, error path, and payload shape is asserted without network access, and `tests/stubs/obsidian.ts` stands in for the Obsidian runtime. The build artifact is `main.js` (esbuild, `obsidian` and Electron external).

There is also a **live loopback check**, off by default, that drives the plugin's bridge through the real `conceptio` binary against a canned API on `127.0.0.1`: a fake `execFile` can only prove the strings we meant to send, never that the CLI accepts them.

```bash
CONCEPTIO_INTEGRATION=1 npm run test    # CONCEPTIO_LIVE_CLI / CONCEPTIO_LIVE_STUB / CONCEPTIO_PYTHON to override paths
```

`check` runs the suite twice on purpose: `main.js` lands next to `main.ts`, and Vite's default extension order would let the bundle shadow the source for any test importing it. `vitest.config.ts` pins source-first resolution, and the second run covers the bundled order too.

**Coverage:** TypeScript strict; the offline suite covers the plugin, the CLI command catalogue, and formatting; the loopback rows drive the real `conceptio` CLI and are skipped unless `CONCEPTIO_INTEGRATION=1`. The bundle builds to `main.js` (`obsidian` and Electron external).

`tests/runtime_check.mjs` drives a **real Obsidian** through the **official Obsidian CLI** — `plugins:restrict off`, `plugin:enable`, `eval`, `dev:errors`, `dev:console` — on an isolated profile, then asserts the plugin's own command surface.

```bash
node tests/runtime_check.mjs   # requires Obsidian installed and NOT already running
```

It **refuses to run while another Obsidian is up**: the CLI's pipe is per user, not per profile, so a second instance cannot serve it and a client would silently reach the wrong app. For the same reason every invocation it makes carries `--user-data-dir=<scratch>`, and it aborts before any write unless `app.vault.getName()` answers with the scratch vault.

The check asserts that the isolated app attaches over the CLI and the vault identity is confirmed; that the plugin activates at the version its manifest declares, and all 11 `conceptio:*` commands plus the base `conceptio <action>` appear in `obsidian help` with their descriptions; that a malformed invocation reports `Missing required parameter: id` exactly as a core command does; that a search reaches the archive and a citation round-trips through the plugin and the CLI; that creating a note writes a frontmattered file, inserting puts the citation into the open note, and the reading-list export writes its note; that the console and error buffers stay clean; and that the two client limits stated above are pinned as checks that fail loudly should they ever change.

## License

MIT — see [LICENSE](LICENSE).
