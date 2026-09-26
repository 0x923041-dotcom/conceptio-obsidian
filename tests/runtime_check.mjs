#!/usr/bin/env node
/**
 * Runtime check: load the plugin in a REAL Obsidian and drive it through the
 * OFFICIAL Obsidian CLI.
 *
 * Obsidian 1.12+ ships `obsidian`: a thin client that forwards a command to the
 * running app over the per-user pipe (`\\.\pipe\obsidian-cli-<user>` on Windows,
 * `$XDG_RUNTIME_DIR/.obsidian-cli.sock` elsewhere) and streams the answer back.
 * Driving the app that way beats scraping Electron, because the commands are a
 * supported surface — `plugins:restrict`, `plugin:enable`, `eval`,
 * `dev:errors`, `dev:console` — and they cannot rot the way private internals do.
 *
 * It also closes the loop the other way: the plugin registers its own commands
 * (`conceptio:search`, …) into that same catalogue, so this check asserts the
 * plugin is reachable *as a CLI*, not merely that it loaded.
 *
 * With no Conceptio account and no credits it:
 *   1. builds the bundle (never test a stale one)
 *   2. stages a scratch vault with the built plugin and a loopback stub API
 *   3. writes an ISOLATED profile whose obsidian.json turns the CLI on
 *   4. launches Obsidian on that profile and waits for the CLI to answer
 *   5. drives everything through the CLI: restricted mode off, enable the
 *      plugin, then assert activation, the `conceptio:*` catalogue, real
 *      searches/citations/notes through the stub, and a clean console
 *
 * PRECONDITION — no other Obsidian may be running. The CLI pipe is per user,
 * not per profile, so a second instance cannot serve it and a client would
 * silently reach the WRONG app. The check refuses loudly instead of lying.
 *
 * Usage:  node tests/runtime_check.mjs
 * Env:    OBSIDIAN_EXE, CONCEPTIO_CLI, CONCEPTIO_STUB, OBSIDIAN_RUNTIME_DIR
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { userInfo } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const STACK_ROOT = path.resolve(PLUGIN_ROOT, "..");

const OBSIDIAN_EXE =
  process.env.OBSIDIAN_EXE || "C:/Users/g/AppData/Local/Programs/Obsidian/Obsidian.exe";
const CONCEPTIO_CLI =
  process.env.CONCEPTIO_CLI || path.join(STACK_ROOT, "conceptio-cli", ".venv", "Scripts", "conceptio.exe");
const STUB_PY = process.env.CONCEPTIO_STUB || path.join(STACK_ROOT, "conceptio-nvim", "test", "stub_api.py");
const RUN_DIR = process.env.OBSIDIAN_RUNTIME_DIR || path.join(STACK_ROOT, "tmp", "obsidian-runtime");

const VAULT = path.join(RUN_DIR, "vault");
const PROFILE = path.join(RUN_DIR, "profile");
const PLUGIN_DIR = path.join(VAULT, ".obsidian", "plugins", "conceptio");

/**
 * Where the app listens for CLI clients. Per USER, not per profile — which is
 * exactly why the "no other Obsidian" precondition exists.
 */
const CLI_PIPE =
  process.platform === "win32"
    ? `\\\\.\\pipe\\obsidian-cli-${userInfo().username}`
    : path.join(process.env.XDG_RUNTIME_DIR || "/tmp", ".obsidian-cli.sock");

const STUB_ORIGIN = "http://127.0.0.1:8799";
const STUB_KEY = "ckey_live_local_stub";
/** The stub's canned document, and the citation prefix it returns. */
const EXPECTED_TITLE = "Zero Trust Architecture";
const EXPECTED_CITATION = "@misc{conceptio";

/** Every command the plugin should claim, exactly as `obsidian help` lists them. */
const EXPECTED_COMMANDS = [
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
];

const results = [];
let obsidian = null;
let stub = null;

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(name, fn) {
  try {
    record(name, true, (await fn()) ?? "");
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --------------------------------------------------------------------------- //
// the CLI, as a transport
// --------------------------------------------------------------------------- //

/**
 * The launcher prints these on every invocation; they are not command output.
 *
 * Anchored on CONTENT, not line start: Obsidian prefixes its log lines with a
 * timestamp (`2026-09-15 12:05:01 Loading updated app package …`), so a `^`
 * anchor silently stripped nothing and every later match ran against a line it
 * was not written for. (That single character is why the readiness loop read
 * the version as "never answered" while printing it in the error.)
 */
const NOISE = [
  /Loading (updated|main) app package/,
  /installer is out of date/,
  /^Your Obsidian installer/m,
];

function clean(text) {
  return (text || "")
    .split(/\r?\n/)
    .filter((line) => !NOISE.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
}

/**
 * One CLI invocation against the running app.
 *
 * Running the client with piped stdio (rather than a terminal) is deliberate
 * and measured to be equivalent: the CLI is told whether its stdio is a TTY,
 * so that was checked separately against a real console — a terminal prints the
 * same synchronous values, drops the same slow ones and exits `-1` on the same
 * argv shapes (README → "The Obsidian CLI contract, as measured").
 *
 * `--user-data-dir` is MANDATORY here and is not cosmetic. Electron keys its
 * single-instance lock to the *userData path*, so a client that omits the flag
 * does not find our isolated instance — it satisfies the lock itself and
 * launches a whole new Obsidian on the DEFAULT profile, i.e. the user's real
 * vault. (Bitten live: a startup loop calling this without the flag opened the
 * architect's vault once a second. Every process spawned here is now pinned to
 * the throwaway profile by construction, so the worst case is another app on
 * our own scratch profile rather than a window in someone's real one.)
 */
function cli(args, { timeout = 60_000 } = {}) {
  const proc = spawnSync(OBSIDIAN_EXE, [`--user-data-dir=${PROFILE}`, ...args], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return {
    code: proc.status ?? -1,
    stdout: clean(proc.stdout),
    stderr: clean(proc.stderr),
    text: `${clean(proc.stdout)}\n${clean(proc.stderr)}`.trim(),
  };
}

/**
 * `eval` prefixes its result with `=> `; peel it off, and turn a thrown page
 * error into a real failure so a check can never pass on an error string.
 */
function evalCode(code, timeout = 60_000) {
  const value = cli(["eval", `code=${code}`], { timeout }).stdout.replace(/^=>\s?/, "").trim();
  if (/^Error:|^Uncaught /.test(value)) throw new Error(value.split("\n")[0]);
  return value;
}

/**
 * The oracle for real work.
 *
 * The CLI cannot hand back a slow result (README, "The Obsidian CLI contract,
 * as measured"), so "printed nothing" proves nothing about whether the plugin
 * worked. Instead a tracer is installed over `window.handleCli` — the single
 * entry point Obsidian's own dispatcher uses — and every CALL / RESOLVED /
 * REJECTED lands in a file. That record is produced inside the app, so it
 * cannot be faked by the transport, and it is what these checks assert on.
 */
const TRACE_FILE = path.join(RUN_DIR, "cli_trace.log");

/**
 * The stub's own request log.
 *
 * Started with `CONCEPTIO_STUB_VERBOSE=1` and its stdio pointed at this file,
 * for two reasons. The log is the only place the *query* the archive received
 * is visible — the bridge records the parsed documents, not the request — and
 * writing it to a file rather than a pipe removes a real hazard: a piped
 * stderr that nobody drains fills its buffer and blocks the stub mid-request.
 */
const STUB_LOG = path.join(RUN_DIR, "stub.log");

function installTracer() {
  const code =
    "(function(){var L=" + JSON.stringify(TRACE_FILE) + ";var fs=require('fs');" +
    "function stamp(m){try{fs.appendFileSync(L,m+'\\n')}catch(e){}}" +
    // 1. every dispatch the app makes into the renderer
    "window.__origHandleCli=window.__origHandleCli||window.handleCli;var orig=window.__origHandleCli;" +
    "window.handleCli=function(a){stamp('CALL '+JSON.stringify(a));var p;try{p=orig.apply(this,arguments)}" +
    "catch(e){stamp('THREW '+String(e).slice(0,200));throw e}" +
    "Promise.resolve(p).then(function(v){stamp('RESOLVED '+String(v).slice(0,400).replace(/\\n/g,' \u00b7 '))}," +
    "function(e){stamp('REJECTED '+String(e).slice(0,300).replace(/\\n/g,' '))});return p};" +
    // 2. the bridge — the seam this plugin owns. A notice-delivery command's
    //    answer goes to a Notice (invisible from here), but the archive call
    //    that produced it is right behind `cli()`, so that is what we watch.
    "var plugin=app.plugins.plugins.conceptio;" +
    "if(plugin&&!plugin.__bridgeTraced){plugin.__bridgeTraced=true;var origCli=plugin.cli;" +
    "plugin.cli=function(){var h=origCli.apply(this,arguments);" +
    "['search','resolve','cite','info','proof','status','insertCitation'].forEach(function(k){" +
    "if(typeof h[k]!=='function')return;var f=h[k];" +
    "h[k]=function(){var r=f.apply(h,arguments);" +
    "Promise.resolve(r).then(function(v){stamp('BRIDGE '+k+' RESOLVED '+JSON.stringify(v).slice(0,500))}," +
    "function(e){stamp('BRIDGE '+k+' REJECTED '+String(e).slice(0,300).replace(/\\n/g,' '))});return r};" +
    "});return h}};" +
    "return 'tracer installed: '+(typeof orig)+' / bridge '+!!(plugin&&plugin.__bridgeTraced)})()";
  return evalCode(code);
}

function traceReset() {
  rmSync(TRACE_FILE, { force: true });
}

function traceLines() {
  if (!existsSync(TRACE_FILE)) return [];
  return readFileSync(TRACE_FILE, "utf8").split(/\r?\n/).filter(Boolean);
}

/**
 * Poll the app-side record for a line matching `pattern`.
 *
 * `since` is a line count taken BEFORE the dispatch, and it is required on
 * purpose. A `.find()` over the whole file cheerfully returns a line written by
 * an earlier check, and checks here were passing exactly that way: the trace
 * already held a `BRIDGE search RESOLVED` from a previous dispatch, so a check
 * could report success without its own work having happened. Requiring the mark
 * makes that stale read impossible to write by accident.
 */
async function waitForTrace(pattern, { since, timeout = 30_000, label = String(pattern) } = {}) {
  if (!Number.isInteger(since)) {
    throw new Error(`waitForTrace needs a "since" mark for ${label}: traceLines().length taken before the dispatch`);
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const line = traceLines().slice(since).find((entry) => pattern.test(entry));
    if (line) return line;
    await sleep(500);
  }
  const fresh = traceLines().slice(since);
  throw new Error(`the app never recorded ${label}; trace since the mark: ${fresh.join(" | ") || "(nothing new)"}; full trace so far:\n    ${traceLines().join("\n    ") || "(empty)"}`);
}

/**
 * Run a command through the *renderer's* dispatcher — the same registry, the
 * same handler, the same bridge, a real vault — without the CLI client in the
 * middle. This is what a caller would get once the transport can carry slow
 * results; today it is how the plugin's behaviour stays measurable at all.
 */
function dispatchInApp(argv) {
  return cli(["eval", `code=window.handleCli(${JSON.stringify(argv)}) && 'dispatched'`]);
}

function obsidianRunning() {
  const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq Obsidian.exe"], { encoding: "utf8" });
  return /Obsidian\.exe/i.test(out.stdout || "");
}

// --------------------------------------------------------------------------- //
// staging
// --------------------------------------------------------------------------- //

function buildBundle() {
  const built = spawnSync(process.execPath, ["esbuild.mjs"], { cwd: PLUGIN_ROOT, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`esbuild failed: ${built.stderr || built.stdout}`);
}

function stageVault() {
  rmSync(VAULT, { recursive: true, force: true });
  mkdirSync(PLUGIN_DIR, { recursive: true });
  for (const file of ["manifest.json", "main.js", "styles.css"]) {
    cpSync(path.join(PLUGIN_ROOT, file), path.join(PLUGIN_DIR, file));
  }
  // The plugin hands `apiBase` to the CLI as CONCEPTIO_API_BASE, so the stub is
  // configured here — an environment variable alone would be overridden.
  writeFileSync(
    path.join(PLUGIN_DIR, "data.json"),
    JSON.stringify(
      {
        settings: {
          apiBase: STUB_ORIGIN,
          apiKey: STUB_KEY,
          // Point the plugin's bridge at the venv CLI through SETTINGS, not the
          // environment: `process.env.CONCEPTIO_CLI` is read when the bundle
          // loads, which an app relaunch or a differently-parented process does
          // not guarantee. The setting is unambiguous and travels in the vault.
          cliBin: CONCEPTIO_CLI,
          citationFormat: "bibtex",
          resultLimit: 5,
          noteFolder: "Conceptio",
          frontmatter: true,
          tags: "conceptio, runtime-check",
          readingListNote: "Conceptio Reading List.md",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(VAULT, ".obsidian", "community-plugins.json"), '["conceptio"]');
  // `safeMode` is the vault-level Restricted Mode key Obsidian reads. It is not
  // sufficient on its own (see the `plugins:restrict off` step below).
  writeFileSync(
    path.join(VAULT, ".obsidian", "app.json"),
    JSON.stringify({ safeMode: false }, null, 2),
  );
  writeFileSync(path.join(VAULT, "note.md"), "# Test note\n\nRuntime check target.\n");
}

/**
 * An isolated profile whose obsidian.json does two jobs: point the app at the
 * scratch vault, and turn the CLI on. Both live in that one file — verified
 * against the real thing, where `{"vaults":{…},"cli":true}` is exactly what the
 * app reads and writes.
 */
function stageProfile() {
  // The profile is REUSED, never wiped, and that is deliberate. Wiping it makes
  // the app cold: it re-downloads its ~8 MB app package, saves it and RELAUNCHES
  // itself, which is slow, racy against this check's readiness probe, and was
  // the actual cause of a live "Obsidian keeps restarting" — a cold profile
  // restarts on every run. The VAULT is rebuilt fresh each run instead, which is
  // the part that affects correctness; Electron caches do not.
  mkdirSync(PROFILE, { recursive: true });
  writeFileSync(
    path.join(PROFILE, "obsidian.json"),
    JSON.stringify({
      vaults: {
        conceptioruntime: { path: VAULT.replace(/\//g, "\\"), ts: Date.now(), open: true },
      },
      cli: true,
    }),
  );
  // Every vault in a real profile also has a sibling `<vault-id>.json` holding
  // its window state. Without it the app logs `Ignored: ENOENT …` on startup —
  // non-fatal, but a stray error in the log is indistinguishable from a real
  // one when a check later asserts the log is clean.
  writeFileSync(
    path.join(PROFILE, "conceptioruntime.json"),
    JSON.stringify({ x: 256, y: 12, width: 1024, height: 800, isMaximized: true, devTools: false, zoom: 0 }),
  );
}

function startStub() {
  const log = openSync(STUB_LOG, "a");
  return spawn(process.env.PYTHON || "python", [STUB_PY], {
    cwd: path.dirname(STUB_PY),
    // A file descriptor, not a pipe: see STUB_LOG.
    stdio: ["ignore", log, log],
    env: { ...process.env, CONCEPTIO_STUB_VERBOSE: "1" },
  });
}

/** The stub's request lines, newest last, as the archive actually received them. */
function stubRequests() {
  if (!existsSync(STUB_LOG)) return [];
  return readFileSync(STUB_LOG, "utf8").split(/\r?\n/).filter(Boolean);
}

/**
 * The `q` value inside one stub request line, decoded — `+` is a space in a query.
 *
 * The line is the stub's own `log_message` output, i.e. what its handler
 * received: `"GET /api/search?q=… HTTP/1.1" 200 -`, which is the one place the
 * query the *archive* saw is visible (the bridge records parsed documents).
 */
function requestQuery(line) {
  const target = line.match(/"[A-Z]+ (\S+) /)?.[1] ?? "";
  return new URLSearchParams(target.split("?")[1] ?? "").get("q") ?? "";
}

/**
 * One client invocation through a real SHELL, spelled the way the README spells
 * it.
 *
 * `cli()` spawns the client directly, so a user's quotes reach it literally —
 * which is why every other check here passes a quote-free parameter. A user
 * does not spawn: they type into a shell, and every shell measured on this box
 * (`cmd.exe`, pwsh 7.6.3, Windows PowerShell 5.1 — probe and fixtures in
 * `tests/shell-quoting/`) consumes the quotes and hands `zero trust` as ONE
 * argument. So the documented spelling needs its own proof, through the layer
 * that differs.
 *
 * The harness still has to pin `--user-data-dir`; that token is `--flag=value`
 * with no spaces, so it does not change how the rest of the line is parsed.
 */
function cliThroughShell(args, { timeout = 60_000 } = {}) {
  const windows = process.platform === "win32";
  const script = path.join(RUN_DIR, windows ? "spelling.bat" : "spelling.sh");
  const line = [`"${OBSIDIAN_EXE}"`, `"--user-data-dir=${PROFILE}"`, ...args].join(" ");
  // The line goes into a SCRIPT, not into `cmd /c "<line>"`, and that is not a
  // detail: with `/c`, cmd applies its own rules to a command line whose first
  // token is quoted — it drops the leading quote and the LAST quote on the line,
  // which here is the one closing the query value — so the wrapper would decide
  // the result instead of the shell. A script body is parsed the way an
  // interactive prompt parses a typed line, which is the thing being measured.
  writeFileSync(
    script,
    windows
      ? `@echo off\r\n${line}\r\necho EXIT %ERRORLEVEL%\r\n`
      : `#!/bin/sh\n${line}\necho "EXIT $?"\n`,
  );
  const proc = spawnSync(windows ? "cmd.exe" : "/bin/sh", windows ? ["/c", script] : [script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return {
    code: proc.status ?? -1,
    stdout: clean(proc.stdout),
    stderr: clean(proc.stderr),
    text: `${clean(proc.stdout)}\n${clean(proc.stderr)}`.trim(),
  };
}

async function waitForStub() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${STUB_ORIGIN}/api/search?q=zero`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("the loopback stub never answered");
}

function launchObsidian() {
  return spawn(OBSIDIAN_EXE, [`--user-data-dir=${PROFILE}`, VAULT], {
    stdio: "ignore",
    env: {
      ...process.env,
      CONCEPTIO_API_BASE: STUB_ORIGIN,
      CONCEPTIO_API_KEY: STUB_KEY,
      CONCEPTIO_CLI,
    },
  });
}

/**
 * Is the app's CLI server accepting connections yet?
 *
 * This is the only readiness probe here, and it is deliberately NOT the CLI
 * itself: probing with `Obsidian.exe` before the app is up is not harmlessly
 * noisy — the probe wins the lock itself and starts a second app on this
 * profile, and the two then contend. (Observed live: a churn of start-ups at
 * ~1/s that never answered, and on a wiped profile it never settled, because a
 * cold profile has to re-copy the 25 MB app package before it can serve.) A
 * bare socket connect has no side effects at all.
 */
function pipeReady(timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = connect(CLI_PIPE);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

async function waitForCli() {
  if (!(await pipeReady())) {
    throw new Error(`the CLI pipe never opened — ${CLI_PIPE} (is the CLI enabled in Settings?); ` +
        "see the app's own obsidian.log in the profile");
  }
  let last = "";
  for (let i = 0; i < 20; i++) {
    const out = cli(["version"], { timeout: 20_000 });
    const line = out.stdout.match(/^(\d+\.\d+\.\d+[^\n]*)$/m);
    if (line) return line[1];
    last = out.text;
    await sleep(1500);
  }
  throw new Error(`the Obsidian CLI never answered — last output: ${last.slice(0, 200)}`);
}

function teardown() {
  if (obsidian?.pid) {
    spawnSync("taskkill", ["/PID", String(obsidian.pid), "/T", "/F"], { stdio: "ignore" });
  }
  // Sweep anything else this check started on the scratch profile: a pre-ready
  // probe can start an app of its own, and that one is untracked. It is also
  // unmistakable, because its command line carries the scratch profile path —
  // matching on that means a real Obsidian is never touched.
  const sweep =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Obsidian.exe' -and " +
    `$_.CommandLine -like '*${PROFILE}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  spawnSync("powershell", ["-NoProfile", "-Command", sweep], { stdio: "ignore" });
  if (stub?.pid) {
    spawnSync("taskkill", ["/PID", String(stub.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

// --------------------------------------------------------------------------- //

async function main() {
  if (!existsSync(OBSIDIAN_EXE)) throw new Error(`Obsidian not found at ${OBSIDIAN_EXE}`);
  if (!existsSync(CONCEPTIO_CLI)) throw new Error(`conceptio CLI not found at ${CONCEPTIO_CLI}`);
  if (!existsSync(STUB_PY)) throw new Error(`loopback stub not found at ${STUB_PY}`);
  if (obsidianRunning()) {
    throw new Error(
      "another Obsidian is already running. The CLI pipe is per user, not per " +
        "profile, so this check cannot claim it safely — close Obsidian and re-run.",
    );
  }

  mkdirSync(RUN_DIR, { recursive: true });
  log("\n◆ Obsidian runtime check (via the official CLI)");
  log(`  plugin   ${PLUGIN_ROOT}`);
  log(`  vault    ${VAULT}`);
  log(`  profile  ${PROFILE}  (isolated — your vault list is untouched)`);
  log(`  cli      ${CONCEPTIO_CLI}\n`);

  buildBundle();
  stageVault();
  stageProfile();
  stub = startStub();
  await waitForStub();
  log(`  stub     listening on ${STUB_ORIGIN}`);

  obsidian = launchObsidian();
  const version = await waitForCli();
  log(`  obsidian ${version} — CLI answering\n`);

  // Hard identity gate, and it is placed BEFORE any command that writes. This
  // check exists because it was violated for real: a flag-less client launched
  // an app on the default profile, so the CLI was answering from the
  // architect's own vault — where `conceptio:note` would have written files.
  // The scratch vault's folder name is the cheapest unforgeable answer.
  const expectedVault = path.basename(VAULT);
  const answeredVault = evalCode("app.vault.getName()");
  if (answeredVault !== expectedVault) {
    throw new Error(
      `refusing to continue: the CLI answered as vault "${answeredVault}", not ` +
        `"${expectedVault}" — that is not the instance this check launched, and ` +
        `commands below write to the vault.`,
    );
  }
  log(`  vault     "${answeredVault}" (confirmed — not a real vault)\n`);

  // ------------------------------------------------------------- activation

  await check("the plugin is enabled, not merely present", async () => {
    // Both of the CLI calls this used to make — `plugins:restrict off` and
    // `plugin:enable id=… filter=…` — are colon commands with arguments, which
    // this build never dispatches (see the contract pin below). They were
    // silently doing nothing; the equivalent renderer calls do the work.
    //
    // `plugins:restrict off` is the vault-level switch, and it is necessary but
    // NOT sufficient: the real gate is the app's own `enable-plugin-<appId>`
    // flag, which `setEnable` writes — the very call the Settings toggle makes.
    // Without it the plugin sits in community-plugins.json forever and never
    // instantiates, which is exactly how this failed before this line existed.
    evalCode("app.plugins.setEnable(true)");
    await sleep(1500);

    // `plugin id=` is the authoritative per-plugin view (`plugins:enabled`
    // reports an empty body for a freshly enabled community plugin here, which
    // is a listing quirk, not an activation failure — the next check proves
    // activation directly).
    const info = cli(["plugin", "id=conceptio"]);
    assert(info.text.includes("conceptio"), `no plugin info: ${info.text.slice(0, 200)}`);
    const enabled = evalCode("app.plugins.enabledPlugins.has('conceptio') ? 'yes' : 'no'");
    assert(enabled === "yes", "conceptio is not in the enabled set");
    return info.text.replace(/\s+/g, " ").slice(0, 70);
  });

  await check("it activated at the version its manifest declares", async () => {
    const expected = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, "manifest.json"), "utf8"),
    ).version;
    const version = evalCode("app.plugins.plugins.conceptio.manifest.version");
    assert(version === expected, `running v${version}, manifest declares v${expected}`);
    return `v${version} in vault "${answeredVault}"`;
  });

  // The oracle for everything that waits on the archive (see `waitForTrace`).
  //
  // Installed HERE, after activation, and never before it: the tracer wraps
  // `app.plugins.plugins.conceptio`, and that object does not exist until
  // `setEnable` above instantiates the plugin. Installed earlier, the bridge
  // half attached to nothing (`bridge false`) and every BRIDGE assertion below
  // failed as "the bridge never reaches the shared CLI" — ten failures with one
  // cause, describing the instrument rather than the plugin. The assertion on
  // the install line is what keeps that from returning quietly: a tracer that
  // did not attach must fail here, where it says so, not ten checks later.
  traceReset();
  const tracer = installTracer();
  log(`  trace    ${tracer}\n`);
  assert(tracer.includes("bridge true"), `the tracer's bridge half did not attach: ${tracer}`);

  // ----------------------------------------------- the CLI command catalogue

  await check("every conceptio command is registered in the CLI catalogue", async () => {
    const help = cli(["help"]).stdout;
    // Deliberately not `\s` after the id: the help pads names into a column,
    // and the longest name collides with it, printing
    // `conceptio:reading-list[Conceptio]: …` with no space at all. The negative
    // lookahead also stops `conceptio:search` from matching
    // `conceptio:search:context`-style neighbours.
    const missing = EXPECTED_COMMANDS.filter(
      (id) => !new RegExp(`^\\s+${id}(?![-a-z0-9:])`, "m").test(help),
    );
    if (missing.length) {
      const saw = (help.match(/^\s+conceptio[^\s]*/gm) || []).map((s) => s.trim()).join(" ");
      throw new Error(`missing from help: ${missing.join(", ")} — help showed: ${saw || "(none)"}`);
    }
    return `${EXPECTED_COMMANDS.length} commands listed`;
  });

  await check("the plugin's own help text is carried into the CLI", async () => {
    const help = cli(["help"]).stdout;
    assert(/Conceptio/i.test(help), "no Conceptio description in the catalogue");
    const line = help.split("\n").find((l) => l.trim().startsWith("conceptio:search")) ?? "";
    return line.trim() || "descriptions present";
  });

  // ------------------------------------------------------- optional diagnosis
  // `RUNTIME_DIAG=1` asks the APP what its own process API looks like. Kept in
  // the file because "the bridge never settles" is indistinguishable, from the
  // outside, from a spawn that has no callback and a child that never closes.
  if (process.env.RUNTIME_DIAG === "1") {
    const cliPath = JSON.stringify(CONCEPTIO_CLI);
    const spawnProbe =
      "new Promise(function(res){ try {" +
      "  if (typeof require !== 'function') return res('no require in this context');" +
      "  var cp = require('child_process');" +
      `  var p = cp.execFile(${cliPath}, ['--version'], {timeout: 8000}, function(e, so, se){` +
      "    res('callback after ' + (Date.now()-t0) + 'ms | err=' + (e && e.code) + ' | out=' + String(so).slice(0,40) + ' | errout=' + String(se).slice(0,60));" +
      "  });" +
      "  var t0 = Date.now();" +
      "  p.on('error', function(e){ res('spawn error event: ' + e.message); });" +
      "  p.on('exit', function(c, s){ /* exit is not close */ });" +
      "  setTimeout(function(){ res('NO CALLBACK after 20s (pid=' + p.pid + ', exitCode=' + p.exitCode + ', killed=' + p.killed + ')'); }, 20000);" +
      "} catch (e) { res('probe threw: ' + e.message); } })";
    const probes = {
      "typeof require": "typeof require",
      "execFile type": "typeof require('child_process').execFile",
      "settings.apiBase": "String(app.plugins.plugins.conceptio.settings.apiBase)",
      "settings.apiKey": "String(app.plugins.plugins.conceptio.settings.apiKey).slice(0,14)",
      "direct execFile of the CLI": spawnProbe,
    };
    log("  --- RUNTIME_DIAG ---");
    for (const [label, code] of Object.entries(probes)) {
      log(`  ${label}: ${evalCode(code, 90_000) || "(no output)"}`);
    }
    log("  --- end diag ---\n");
  }

  // -------------------------------------------- real work, through the app
  // See `dispatchInApp` / `waitForTrace`: the transport cannot return these
  // values on this Obsidian build, so the app's own record is the evidence.

  await check("the plugin's bridge reaches the shared conceptio CLI", async () => {
    const mark = traceLines().length;
    dispatchInApp(["conceptio:quota"]);
    const line = await waitForTrace(/^BRIDGE status RESOLVED/, {
      since: mark,
      label: "the bridge's status call (it spawns the CLI, which answers from the stub)",
    });
    return line.replace(/^BRIDGE status RESOLVED\s*/, "").slice(0, 80);
  });

  let docId = null;

  await check("a search reaches the archive and returns documents", async () => {
    // No quotes in the value: this path goes through `eval` and the renderer's
    // own dispatcher, where quotes are four literal characters (see the shell
    // check below for what a shell does with them).
    const mark = traceLines().length;
    dispatchInApp(["conceptio:search", "query=zero trust"]);
    const line = await waitForTrace(new RegExp(`^BRIDGE search RESOLVED.*${EXPECTED_TITLE}`), {
      since: mark,
      label: `a search result containing "${EXPECTED_TITLE}"`,
    });
    // The bridge answers with the archive's own JSON, so the id is right there —
    // which is how the note and insert checks below get a real document.
    const match = line.match(/"id"\s*:\s*(\d+)/);
    assert(match, `no document id in the bridge's answer: ${line.slice(0, 200)}`);
    docId = Number.parseInt(match[1], 10);
    return `"${EXPECTED_TITLE}", id ${docId}`;
  });

  await check("the same search answers the CLI, and says where the answer went", async () => {
    const out = cli(["conceptio:search", 'query="zero trust"']);
    // On this installer a colon command with parameters never dispatches (see
    // the contract checks below), so the *only* correct expectation here is
    // that nothing pretends to be a result.
    assert(!/ReferenceError|TypeError/.test(out.text), `a crash leaked: ${out.text.slice(0, 160)}`);
    return out.stdout.trim().slice(0, 60) || "no dispatch on this Obsidian build";
  });

  await check("a missing parameter is reported the way core commands report it", async () => {
    const out = cli(["conceptio:cite"]);
    assert(
      /Missing required parameter: id/.test(out.text),
      `unexpected error: ${out.text.slice(0, 160)}`,
    );
    return "Missing required parameter: id";
  });

  // ------------------------------------------------ the base command (the fix)
  // A colon command *with an argument* is refused before it reaches the plugin
  // (the pin further down measures that), which would leave every namespaced
  // parameterized invocation unreachable on a machine that simply has an older
  // Obsidian installed. The base `conceptio` command's first token has no
  // colon, it carries arguments, and it routes to the very same action
  // handlers — so these checks exist to prove the surface stays usable, and to
  // fail loudly if a future build makes them unnecessary.

  await check("the base command names its actions in the catalogue", async () => {
    const help = cli(["help"]).stdout;
    const line = help.split("\n").find((entry) => /^\s+conceptio(?![-:a-z0-9])/.test(entry)) ?? "";
    assert(line, "the base `conceptio` command is not listed in help");
    for (const action of ["search", "cite", "note", "reading-list"]) {
      assert(line.includes(action), `help does not name the "${action}" action: ${line.trim()}`);
    }
    return line.trim().slice(0, 78);
  });

  await check("the base command dispatches an action the namespaced form cannot carry", async () => {
    // The decisive one. `conceptio quota` is a bare action and this build's CLI
    // carries it, while `conceptio:quota json` never reaches the renderer at
    // all (the pin below). Same handler behind both.
    const before = traceLines().length;
    const out = cli(["conceptio", "quota"]);
    const line = await waitForTrace(/^BRIDGE status RESOLVED/, {
      since: before,
      label: "the base command's `quota` action reaching the shared CLI",
    });
    assert(traceLines().length > before, "the base command never reached the renderer");
    return line.replace(/^BRIDGE status RESOLVED\s*/, "").slice(0, 60) || out.stdout.trim().slice(0, 60);
  });

  await check("a parameterized action runs through the base command, end to end", async () => {
    // A real archive call, a real parameter, through the real CLI client — the
    // path a user on an older installer actually has.
    const before = traceLines().length;
    const out = cli(["conceptio", "search", "query=zero"]);
    const line = await waitForTrace(new RegExp(`^BRIDGE search RESOLVED.*${EXPECTED_TITLE}`), {
      since: before,
      label: `a search containing "${EXPECTED_TITLE}", started from the CLI`,
    });
    return line.replace(/^BRIDGE search RESOLVED\s*/, "").slice(0, 60) || out.stdout.trim().slice(0, 60);
  });

  await check("the spelling the README documents survives a real shell", async () => {
    // The one user-facing invocation nobody had tested: a parameter with a
    // SPACE, quoted the way a person types it. The harness passes every other
    // parameter quote-free because it spawns without a shell, so this is the
    // check that says whether the documented spelling is real. Confirmed at the
    // archive, not at the terminal: the stub logs the request line it receives.
    // Nonsense words on purpose: the stub's request log is the only place the
    // query the archive *received* is visible, and a phrase no other check uses
    // is what makes "this request" unambiguous — a reused query happily matches
    // a line an earlier check wrote.
    const stubMark = stubRequests().length;
    const traceMark = traceLines().length;
    const out = cliThroughShell(["conceptio", "search", 'query="zebra quokka"']);
    let query = "";
    for (let i = 0; i < 40 && !query; i++) {
      query = stubRequests().slice(stubMark).map(requestQuery).find((value) => value.includes("zebra")) ?? "";
      if (!query) await sleep(250);
    }
    const said = out.text.slice(0, 200) || `(no output; exit ${out.code})`;
    assert(query, `the shell never got a search to the archive. The client said: ${said}`);
    assert(
      query.includes("zebra quokka"),
      `the space did not survive to the archive — it received "${query}". The client said: ${said}`,
    );
    // …and the plugin really ran the action, rather than falling back to the
    // account status, which is what an unrecognised first word would do.
    await waitForTrace(/^BRIDGE search RESOLVED/, {
      since: traceMark,
      label: "a search the shell-started invocation asked for",
    });
    return `archive received "${query}"`;
  });

  await check("a local action still answers on stdout through the base door", async () => {
    // Routing must not cost the one delivery shape that does print.
    const out = cli(["conceptio", "reading-list"]);
    assert(
      /Reading list exported:/.test(out.stdout),
      `the base door lost stdout delivery: ${out.text.slice(0, 160) || "(nothing)"}`,
    );
    return out.stdout.trim().slice(0, 60);
  });

  await check("validation is still synchronous through the base door", async () => {
    const out = cli(["conceptio", "cite"]);
    assert(
      /Missing required parameter: id/.test(out.text),
      `unexpected result: ${out.text.slice(0, 160) || "(nothing)"}`,
    );
    return "Missing required parameter: id";
  });

  await check("an unknown action is answered with the list, not with silence", async () => {
    const out = cli(["conceptio", "action=teleport"]);
    assert(
      /Unknown action "teleport"\. Try one of: cite/.test(out.text),
      `unexpected result: ${out.text.slice(0, 160) || "(nothing)"}`,
    );
    return out.stdout.trim().split("\n")[0].slice(0, 70);
  });

  await check("the base command alone is still the account status", async () => {
    const before = traceLines().length;
    cli(["conceptio"]);
    const line = await waitForTrace(/^BRIDGE status RESOLVED/, {
      since: before,
      label: "the account status for a bare `conceptio`",
    });
    assert(traceLines().length > before, "a bare `conceptio` did not reach the renderer");
    return line.replace(/^BRIDGE status RESOLVED\s*/, "").slice(0, 60);
  });

  // Everything after this point must be clean: the rejection above was asked
  // for, so the cleanliness check starts its scan here.
  const deliberateErrors = traceLines().length;

  await check("a citation round-trips through the plugin and the CLI", async () => {
    assert(docId != null, "no document id from the search");
    const mark = traceLines().length;
    dispatchInApp(["conceptio:cite", `id=${docId}`, "format=bibtex"]);
    const line = await waitForTrace(new RegExp(`^BRIDGE cite RESOLVED.*${EXPECTED_CITATION}`), {
      since: mark,
      label: "a BibTeX citation",
    });
    return line.replace(/^BRIDGE cite RESOLVED\s*/, "").replace(/\\n/g, " ").slice(0, 60);
  });

  await check("the account status is rendered by the plugin", async () => {
    const mark = traceLines().length;
    dispatchInApp(["conceptio:quota"]);
    const line = await waitForTrace(/^BRIDGE status RESOLVED.*tier/i, {
      since: mark,
      label: "a tier summary from the bridge",
    });
    assert(!/not found|Error:/i.test(line), `an error, not a status: ${line.slice(0, 160)}`);
    return line.replace(/^BRIDGE status RESOLVED\s*/, "").replace(/\s+/g, " ").slice(0, 70);
  });

  await check("creating a note writes a frontmattered file into the vault", async () => {
    assert(docId != null, "no document id from the search");
    dispatchInApp(["conceptio:note", `id=${docId}`]);
    const folder = path.join(VAULT, "Conceptio");
    for (let i = 0; i < 40; i++) {
      if (existsSync(folder)) {
        const files = readdirSync(folder).filter((file) => file.endsWith(".md"));
        if (files.length) {
          const body = readFileSync(path.join(folder, files[0]), "utf8");
          assert(body.startsWith("---"), "the note has no frontmatter block");
          assert(body.includes("conceptio_id"), "frontmatter has no conceptio_id");
          return `${files[0]} (${body.length} bytes)`;
        }
      }
      await sleep(250);
    }
    throw new Error("no note was written to Conceptio/");
  });

  await check("inserting puts the citation into the active note", async () => {
    assert(docId != null, "no document id from the search");
    // `path=` is exact and takes the raw value: embedding quotes makes them
    // part of the filename, which is how this failed with
    // `REJECTED File ""note.md"" not found.`
    const opened = cli(["open", "path=note.md"]);
    if (/not found/i.test(opened.text)) throw new Error(`could not open note.md: ${opened.text.slice(0, 120)}`);
    await sleep(1500);
    dispatchInApp(["conceptio:insert", `id=${docId}`, "format=bibtex"]);
    const notePath = path.join(VAULT, "note.md");
    for (let i = 0; i < 40; i++) {
      if (readFileSync(notePath, "utf8").includes(EXPECTED_CITATION)) return "note.md carries the citation";
      await sleep(250);
    }
    // Say what happened, not just that the file did not change: the trace is
    // the app's own account of the dispatch, and an editor-gate refusal lands
    // in it as a resolved acknowledgement rather than an error.
    throw new Error(
      "note.md on disk never received the citation. Tabs: " +
        `${evalCode("app.workspace.getLeavesOfType('markdown').length")} · ` +
        `active leaf: ${evalCode("app.workspace.activeLeaf && app.workspace.activeLeaf.view && app.workspace.activeLeaf.view.getViewType()")} · ` +
        `trace tail: ${traceLines().slice(-5).join(" | ").slice(0, 300)}`,
    );
  });

  await check("the reading list exports to a note", async () => {
    cli(["conceptio:reading-list"]);
    const target = path.join(VAULT, "Conceptio Reading List.md");
    for (let i = 0; i < 40; i++) {
      if (existsSync(target)) return `${path.basename(target)} (${readFileSync(target, "utf8").length} bytes)`;
      await sleep(250);
    }
    throw new Error("the reading list note was never written");
  });

  // ------------------------------------------------- the platform's contract
  // These two pin Obsidian's own behaviour, not the plugin's. They are here
  // because a future Obsidian (or a current installer — the client says a
  // newer one "includes better CLI support") may fix either, and then the
  // plugin should stop working around them. Failing loudly is the signal.

  await check("a synchronous value still arrives on stdout", async () => {
    // The positive control for the pin below: local work is fast enough for
    // the CLI to carry, and it does.
    const out = cli(["conceptio:reading-list"]);
    assert(
      /Reading list exported:/.test(out.stdout),
      `a fast result did not arrive: ${out.text.slice(0, 160) || "(nothing)"}`,
    );
    return out.stdout.trim().slice(0, 60);
  });

  await check("an archive answer cannot ride stdout on this build", async () => {
    const out = cli(["conceptio:quota"]);
    assert(
      /notice/.test(out.stdout),
      `expected the acknowledgement to arrive: ${out.text.slice(0, 160) || "(nothing)"}`,
    );
    assert(
      !/credits used/.test(out.stdout),
      `the summary arrived on stdout — the workaround is no longer needed: ${out.stdout.slice(0, 160)}`,
    );
    return "acknowledged synchronously (see the trace for the answer)";
  });

  await check("a colon command with an argument does not dispatch on this build", async () => {
    const before = traceLines().length;
    const out = cli(["conceptio:quota", "json"]);
    const implausible = traceLines().length > before;
    if (!implausible && out.code === 0 && out.stdout.trim()) {
      throw new Error(
        "Obsidian forwarded `conceptio:quota json`, which means this build no " +
          "longer needs the parameterless-command workaround: update README " +
          "(\"The Obsidian CLI contract\") and the delivery note in " +
          "src/cliCommands.ts, then make the commands return their values again.",
      );
    }
    assert(
      out.code === -1 || !out.stdout.trim(),
      `unexpected result: code ${out.code}, stdout ${out.stdout.slice(0, 120) || "(empty)"}`,
    );
    return `exit code ${out.code}, renderer never called`;
  });

  // ------------------------------------------------------------- cleanliness

  await check("nothing threw while loading", async () => {
    const errors = cli(["dev:errors"]).stdout;
    assert(!errors || /no errors|^$/i.test(errors), `errors captured: ${errors.slice(0, 200)}`);
    return errors || "no errors captured";
  });

  await check("the app recorded no rejected dispatches", async () => {
    // `dev:console level=error` would be the direct check, but it is a colon
    // command with arguments — unreachable on this build (the pin above). The
    // tracer's record covers the same ground for the commands that ran.
    const scanned = traceLines().slice(deliberateErrors);
    const failures = scanned.filter((line) => /^REJECTED|^THREW|^BRIDGE .* REJECTED/.test(line));
    assert(!failures.length, `rejections: ${failures.join(" | ").slice(0, 200)}`);
    const bridgeCalls = scanned.filter((line) => /^BRIDGE .* RESOLVED/.test(line)).length;
    return `${scanned.length} dispatches and ${bridgeCalls} bridge answers, none rejected`;
  });
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  record("harness completed", false, err instanceof Error ? err.message : String(err));
} finally {
  teardown();
}

const failed = results.filter((r) => !r.ok);
log("");
log(`  ${results.length - failed.length}/${results.length} checks passed`);
if (failure) log(`  ${failure.message}\n`);
process.exit(failed.length === 0 && !failure ? 0 : 1);
