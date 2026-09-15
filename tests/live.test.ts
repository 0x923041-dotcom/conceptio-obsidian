/**
 * The live loopback check — the plugin's CLI bridge driven through the REAL
 * `conceptio` CLI against a canned API on 127.0.0.1.
 *
 * Offline by default: this file only runs with `CONCEPTIO_INTEGRATION=1`, and
 * skips cleanly when the CLI or the loopback stub is not on this machine. It
 * exists because an argument contract asserted against a fake `execFile` is
 * a claim about our own strings — the real binary is what says whether the
 * CLI accepts them (`--json -l`, `--license`, `-f`, and the env credential
 * this plugin hands over).
 *
 *   CONCEPTIO_INTEGRATION=1 npm run test
 *
 * Override the paths when the checkout is elsewhere:
 *   CONCEPTIO_LIVE_CLI=/path/to/conceptio
 *   CONCEPTIO_LIVE_STUB=/path/to/stub_api.py
 *   CONCEPTIO_PYTHON=python3
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCli } from "../src/cli.js";

const PORT = 8799;
const API_BASE = `http://127.0.0.1:${PORT}`;
const INTEGRATION = process.env.CONCEPTIO_INTEGRATION === "1";

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const repoRoot = path.resolve(__dirname, "..");
const cliBin = firstExisting([
  process.env.CONCEPTIO_LIVE_CLI ?? "",
  path.resolve(repoRoot, "../conceptio-cli/.venv/Scripts/conceptio.exe"),
  path.resolve(repoRoot, "../conceptio-cli/.venv/bin/conceptio"),
]);
const stubPath = firstExisting([
  process.env.CONCEPTIO_LIVE_STUB ?? "",
  path.resolve(repoRoot, "../conceptio-nvim/test/stub_api.py"),
]);
const python = process.env.CONCEPTIO_PYTHON || "python";

const canRun = INTEGRATION && Boolean(cliBin) && Boolean(stubPath);
const suite = canRun ? describe : describe.skip;

if (INTEGRATION && !canRun) {
  // Loud, not silent: an integration run that quietly asserts nothing is worse
  // than no run at all.
  // eslint-disable-next-line no-console
  console.warn(
    `[live] skipped — need CONCEPTIO_LIVE_CLI (found: ${cliBin ?? "none"}) and CONCEPTIO_LIVE_STUB (found: ${stubPath ?? "none"})`,
  );
}

let stub: ChildProcess | null = null;

async function waitForStub(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/search?q=ping`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`stub API never came up on ${API_BASE}`);
}

suite("live loopback check (real CLI)", () => {
  beforeAll(async () => {
    stub = spawn(python, [stubPath as string], { stdio: "ignore" });
    await waitForStub();
  });

  afterAll(() => {
    stub?.kill();
  });

  const cli = () =>
    buildCli({
      apiBase: API_BASE,
      apiKey: "ckey_live_local_stub",
      bin: cliBin as string,
    });

  it("search: the real CLI accepts the plugin's argument list and returns results", async () => {
    const results = await cli().search("source:nist zero trust", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("Zero Trust Architecture");
    expect(results[0].source_label).toBe("NIST");
  });

  it("search --license: the real CLI accepts the commercial-ok filter", async () => {
    const results = await cli().search("zero trust", 3, "commercial-ok");
    expect(results.length).toBeGreaterThan(0);
  });

  it("resolve: an identifier lands on the expected document", async () => {
    const results = await cli().resolve("RFC 2119", 3);
    expect(results[0].title).toContain("RFCs");
  });

  it("cite: the citation text comes back from the CLI", async () => {
    const citation = await cli().cite(7288, "apa");
    expect(citation).toContain("conceptio7288");
  });

  it("status: the structured tier report comes back parsed", async () => {
    const status = await cli().status();
    expect(status.tier).toBe("dev");
    expect(status.summary).toContain("Conceptio — dev tier");
    expect(status.summary).toContain("3,498 remaining");
  });

  // The status FALLBACK (a CLI older than `quota --json`) is deliberately NOT
  // tested here: an old binary cannot be staged from this machine, and a live
  // test that re-runs the same successful path would assert nothing while
  // looking like coverage. It is covered offline in tests/cli.test.ts, where a
  // refused `--json` and a verbatim human report are both reproducible.

  // An unreachable origin costs the CLI its whole retry budget (~5s, measured),
  // which is the default vitest timeout — so it is given its own budget rather
  // than being left to race the runner's.
  it(
    "an unreachable origin is reported, not swallowed",
    async () => {
      const failing = buildCli({
        apiBase: "http://127.0.0.1:9",
        apiKey: "ckey_live_local_stub",
        bin: cliBin as string,
      });
      await expect(failing.search("zero trust", 1)).rejects.toThrow();
    },
    30_000,
  );
});
