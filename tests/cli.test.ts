import { describe, expect, it } from "vitest";
import {
  buildCli,
  CliError,
  CliMissingError,
  cliEnv,
  decodeJson,
  DEFAULT_CLI,
  lastLine,
  runCli,
} from "../src/cli.js";
import { summarizeQuota } from "../src/cli.js";
import { enoent, fail, fakeExec, killed, ok } from "./helpers.js";

describe("cliEnv", () => {
  it("passes the endpoint and the API key, stripping a trailing slash", () => {
    const env = cliEnv({ apiBase: "https://example.test/", apiKey: " ckey_live_x " });
    expect(env.CONCEPTIO_API_BASE).toBe("https://example.test");
    expect(env.CONCEPTIO_API_KEY).toBe("ckey_live_x");
    expect(env.CONCEPTIO_LICENSE_KEY).toBeUndefined();
  });

  it("uses the license key only when no API key is set", () => {
    expect(cliEnv({ licenseKey: "CONCEPTIO-1-2-3" }).CONCEPTIO_LICENSE_KEY).toBe("CONCEPTIO-1-2-3");
    const both = cliEnv({ apiKey: "ckey_live_x", licenseKey: "CONCEPTIO-1-2-3" });
    expect(both.CONCEPTIO_API_KEY).toBe("ckey_live_x");
    expect(both.CONCEPTIO_LICENSE_KEY).toBeUndefined();
  });

  it("sets nothing when nothing is configured (the CLI keeps its saved credential)", () => {
    expect(cliEnv({})).toEqual({});
    expect(cliEnv({ apiBase: "  ", apiKey: "", licenseKey: "" })).toEqual({});
  });
});

describe("runCli", () => {
  it("rejects with CliMissingError when the binary is absent", async () => {
    const { exec } = fakeExec(enoent());
    await expect(runCli(["quota"], { exec })).rejects.toBeInstanceOf(CliMissingError);
  });

  it("rejects with a timeout message when the child is killed", async () => {
    const { exec } = fakeExec(killed());
    await expect(runCli(["search", "x"], { exec, timeoutMs: 5_000 })).rejects.toThrow(/timed out after 5s/);
  });

  it("resolves a non-zero exit so the caller can read the CLI's own message", async () => {
    const { exec } = fakeExec(fail(1, "Authentication required — save an API key before searching."));
    const res = await runCli(["search", "x"], { exec });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Authentication required");
  });

  it("uses the configured binary name and passes the env overlay", async () => {
    const { exec, calls } = fakeExec(ok("{}"));
    await runCli(["quota"], { exec, bin: "/opt/venv/bin/conceptio", env: { CONCEPTIO_API_KEY: "k" } });
    expect(calls[0].file).toBe("/opt/venv/bin/conceptio");
    expect(calls[0].env.CONCEPTIO_API_KEY).toBe("k");
    expect(DEFAULT_CLI).toBeTruthy();
  });
});

describe("lastLine / decodeJson", () => {
  it("returns the last non-empty line, ignoring rich-text blank lines", () => {
    expect(lastLine("a\n\n  b  \n")).toBe("b");
    expect(lastLine("")).toBe("");
  });

  it("throws on unreadable output and on an error payload", () => {
    expect(() => decodeJson("{not json")).toThrow(CliError);
    expect(() => decodeJson('{"error":"Rate limit exceeded"}')).toThrow(/Rate limit/);
    expect(decodeJson<{ results: unknown[] }>('{"results":[]}')).toEqual({ results: [] });
  });
});

describe("buildCli", () => {
  it("passes the documented argument contract to search", async () => {
    const { exec, calls } = fakeExec(ok('{"results":[{"id":1,"title":"A"}]}'));
    const cli = buildCli({ apiKey: "ckey_live_x" }, exec);
    const results = await cli.search("zero trust", 10);
    expect(calls[0].args).toEqual(["search", "zero trust", "--json", "-l", "10"]);
    expect(calls[0].env.CONCEPTIO_API_KEY).toBe("ckey_live_x");
    expect(results).toHaveLength(1);
  });

  it("adds --license for the commercial-ok filter", async () => {
    const { exec, calls } = fakeExec(ok('{"results":[]}'));
    const cli = buildCli({}, exec);
    await cli.search("source:nist", 5, "commercial-ok");
    expect(calls[0].args).toEqual(["search", "source:nist", "--json", "-l", "5", "--license", "commercial-ok"]);
  });

  it("surfaces a CLI exit as CliError with the CLI's own line", async () => {
    const { exec } = fakeExec(fail(1, "", "Dev plan required for the REST API"));
    const cli = buildCli({}, exec);
    await expect(cli.search("x", 3)).rejects.toThrow("Dev plan required for the REST API");
  });

  it("surfaces an error payload as CliError", async () => {
    const { exec } = fakeExec(ok('{"error":"Monthly credit allowance exhausted"}'));
    const cli = buildCli({}, exec);
    await expect(cli.search("x", 3)).rejects.toThrow(/allowance exhausted/);
  });

  it("resolves an identifier through `resolve --json -l`", async () => {
    const { exec, calls } = fakeExec(ok('{"kind":"rfc","identifier":"RFC 2119","results":[{"id":2,"title":"RFC 2119"}]}'));
    const cli = buildCli({}, exec);
    const results = await cli.resolve("RFC 2119", 4);
    expect(calls[0].args).toEqual(["resolve", "RFC 2119", "--json", "-l", "4"]);
    expect(results[0].id).toBe(2);
  });

  it("returns trimmed citation text", async () => {
    const { exec, calls } = fakeExec(ok("@article{vaswani2017,\n  title={Attention}\n}\n"));
    const cli = buildCli({}, exec);
    const citation = await cli.cite(7288, "bibtex");
    expect(calls[0].args).toEqual(["cite", "7288", "-f", "bibtex"]);
    expect(citation).toBe("@article{vaswani2017,\n  title={Attention}\n}");
  });

  it("fetches the proof bundle", async () => {
    const { exec, calls } = fakeExec(ok('{"content_hash":"abc"}'));
    const cli = buildCli({}, exec);
    await expect(cli.proof(7)).resolves.toEqual({ content_hash: "abc" });
    expect(calls[0].args).toEqual(["proof", "7", "--json"]);
  });

  it("prefers the structured status report and names the tier", async () => {
    const { exec, calls } = fakeExec(
      ok(
        JSON.stringify({
          tier: "dev",
          monthly_credit_limit: 3500,
          monthly_credit_used: 2,
          monthly_credit_remaining: 3498,
          monthly_reset_at: "2026-10-01T00:00:00Z",
        }),
      ),
    );
    const status = await buildCli({}, exec).status();
    expect(calls.map((call) => call.args)).toEqual([["quota", "--json"]]);
    expect(status.tier).toBe("dev");
    expect(status.summary).toBe(
      "Conceptio — dev tier · 2 of 3,500 credits used (3,498 remaining) · resets 2026-10-01",
    );
  });

  it("falls back to the CLI's own report when the CLI predates quota --json", async () => {
    const { exec, calls } = fakeExec(
      fail(2, "conceptio: error: unrecognized arguments: --json"),
      ok("Tier: dev\n  Dev plan: 2 of 3500 monthly credits used (3498 remaining).\n"),
    );
    const status = await buildCli({}, exec).status();
    expect(calls.map((call) => call.args)).toEqual([["quota", "--json"], ["quota"]]);
    expect(status.tier).toBeNull();
    expect(status.summary).toContain("3498 remaining");
  });

  it("falls back when the structured body is unreadable, and reports a failed fallback", async () => {
    const unreadable = fakeExec(ok("{not json"), ok("Tier: pro\n"));
    await expect(buildCli({}, unreadable.exec).status()).resolves.toMatchObject({ summary: "Tier: pro" });

    const broken = fakeExec(ok("{not json"), fail(1, "API unreachable"));
    await expect(buildCli({}, broken.exec).status()).rejects.toThrow("API unreachable");
  });

  it("propagates a missing CLI through every call", async () => {
    const { exec } = fakeExec(enoent());
    const cli = buildCli({}, exec);
    await expect(cli.status()).rejects.toBeInstanceOf(CliMissingError);
    await expect(cli.cite(1, "apa")).rejects.toBeInstanceOf(CliMissingError);
  });
});

describe("summarizeQuota", () => {
  it("renders the monthly meter and the reset date", () => {
    expect(
      summarizeQuota({
        tier: "dev",
        monthly_credit_limit: 3500,
        monthly_credit_used: 2,
        monthly_credit_remaining: 3498,
        monthly_reset_at: "2026-10-01T00:00:00Z",
      }),
    ).toBe("Conceptio — dev tier · 2 of 3,500 credits used (3,498 remaining) · resets 2026-10-01");
  });

  it("reads the weekly aliases older payloads carry", () => {
    expect(summarizeQuota({ tier: "pro", weekly_search_limit: 1000, weekly_search_used: 10 })).toBe(
      "Conceptio — pro tier · 10 of 1,000 credits used",
    );
  });

  it("says what a free account has left", () => {
    expect(summarizeQuota({ tier: "public", trial_remaining: 12 })).toBe(
      "Conceptio — public tier · 12 free browser credits left",
    );
    expect(summarizeQuota({ tier: "public", trial_remaining: 0 })).toBe(
      "Conceptio — public tier · 0 free browser credits left",
    );
  });

  it("invents no figure for a shape it does not recognise", () => {
    expect(summarizeQuota({})).toBe("Conceptio — unknown tier");
    expect(summarizeQuota({ tier: "enterprise" })).toBe("Conceptio — enterprise tier");
    expect(summarizeQuota({ tier: "dev", monthly_credit_remaining: 5 })).toBe(
      "Conceptio — dev tier · 5 credits remaining",
    );
  });
});
