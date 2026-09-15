/**
 * Conceptio CLI bridge for the Obsidian plugin.
 *
 * Every archive call is executed by the shared `conceptio` CLI
 * (`pip install conceptio-search`) — the same core the terminal, the MCP
 * server, and the Neovim/Alfred/Raycast/VS Code surfaces use. Auth, retries,
 * rate-limit handling and the Dev-gate upgrade hints live there once; this
 * module only spawns it and decodes `--json`. Arguments are passed as a LIST
 * (never a shell string) and the configured credential travels as an
 * environment variable for that one child process, never written to disk here.
 *
 * Spawning a process is desktop-only, which is why the plugin's manifest sets
 * `isDesktopOnly: true`.
 */

import { execFile } from "node:child_process";
import type { CitationFormat, ResolveResponse, SearchResponse, SearchResult } from "./types.js";

/** CLI binary; override with `CONCEPTIO_CLI` (tests, venv installs). */
export const DEFAULT_CLI = process.env.CONCEPTIO_CLI || "conceptio";
export const SEARCH_TIMEOUT_MS = 45_000;
export const QUICK_TIMEOUT_MS = 30_000;

/** A failure surfaced by the CLI itself (non-zero exit or error payload). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** The `conceptio` binary is not installed / not on PATH. */
export class CliMissingError extends CliError {}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/** Credentials + endpoint the plugin hands to the CLI through the environment. */
export interface CliCredentials {
  apiBase?: string;
  apiKey?: string;
  licenseKey?: string;
  /** CLI executable name or path; falls back to `CONCEPTIO_CLI` / `conceptio`. */
  bin?: string;
}

/** Environment overlay for a CLI child process. Only set values are passed. */
export function cliEnv(creds: CliCredentials): Record<string, string> {
  const env: Record<string, string> = {};
  const apiBase = (creds.apiBase ?? "").trim().replace(/\/+$/, "");
  const apiKey = (creds.apiKey ?? "").trim();
  const licenseKey = (creds.licenseKey ?? "").trim();
  if (apiBase) env.CONCEPTIO_API_BASE = apiBase;
  if (apiKey) env.CONCEPTIO_API_KEY = apiKey;
  else if (licenseKey) env.CONCEPTIO_LICENSE_KEY = licenseKey;
  return env;
}

/**
 * Run one CLI command with a hard timeout. Non-zero exits resolve with the
 * exit code so the caller can read the CLI's own message from stderr.
 */
export function runCli(
  args: string[],
  opts: {
    env?: Record<string, string>;
    timeoutMs?: number;
    exec?: ExecFileLike;
    bin?: string;
  } = {},
): Promise<CliResult> {
  const { timeoutMs = QUICK_TIMEOUT_MS } = opts;
  const exec: ExecFileLike = opts.exec ?? execFile;
  const bin = (opts.bin ?? "").trim() || DEFAULT_CLI;
  return new Promise((resolve, reject) => {
    exec(
      bin,
      args,
      { env: { ...process.env, ...(opts.env ?? {}) }, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as { code?: string | number; killed?: boolean };
          if (e.code === "ENOENT") {
            reject(
              new CliMissingError(
                "conceptio CLI not found — install it with: pip install conceptio-search",
              ),
            );
          } else if (e.killed) {
            reject(new CliError(`conceptio CLI timed out after ${timeoutMs / 1000}s — try again.`));
          } else if (typeof e.code === "number") {
            resolve({ code: e.code, stdout: stdout ?? "", stderr: stderr ?? "" });
          } else {
            reject(new CliError(`conceptio CLI failed: ${err.message}`));
          }
          return;
        }
        resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** Last non-empty line of stderr/stdout — the CLI's human error message. */
export function lastLine(text: string): string {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Decode a CLI `--json` body, surfacing an `error` payload as a CliError. */
export function decodeJson<T>(stdout: string): T {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new CliError("The CLI returned unreadable output.");
  }
  if (typeof data === "object" && data !== null && (data as Record<string, unknown>).error) {
    throw new CliError(String((data as Record<string, unknown>).error));
  }
  return data as T;
}

/**
 * The account status a surface renders.
 *
 * `summary` is one line safe to show in a Notice; `text` is the CLI's own
 * human report (used verbatim when the CLI is older than `quota --json`);
 * `tier` is only known when the structured form was available.
 */
export interface QuotaStatus {
  summary: string;
  text: string;
  tier: string | null;
}

/** Number with thousands separators, falling back to the raw value. */
function group(value: unknown): string {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(value ?? "");
}

/**
 * One-line summary of a `quota --json` payload. Presentation only — the
 * numbers and the tier come from the CLI, and an unrecognised shape degrades
 * to the tier alone rather than inventing a figure.
 */
export function summarizeQuota(data: Record<string, unknown>): string {
  const tier = typeof data.tier === "string" && data.tier ? data.tier : "unknown";
  const limit = data.monthly_credit_limit ?? data.weekly_search_limit;
  const used = data.monthly_credit_used ?? data.weekly_search_used;
  const remaining = data.monthly_credit_remaining ?? data.weekly_search_remaining;
  const parts = [`Conceptio — ${tier} tier`];
  if (limit != null && used != null) {
    const tail = remaining != null ? ` (${group(remaining)} remaining)` : "";
    parts.push(`${group(used)} of ${group(limit)} credits used${tail}`);
  } else if (remaining != null) {
    parts.push(`${group(remaining)} credits remaining`);
  } else if (used != null) {
    parts.push(`${group(used)} credits used`);
  } else if (data.trial_remaining != null) {
    parts.push(`${group(data.trial_remaining)} free browser credits left`);
  }
  const resetAt = data.monthly_reset_at ?? data.weekly_reset_at;
  if (typeof resetAt === "string" && resetAt) parts.push(`resets ${resetAt.slice(0, 10)}`);
  return parts.join(" · ");
}

/** The operations the plugin uses. Kept as an interface so tests can fake it. */
export interface CliHandle {
  search(query: string, limit: number, license?: string): Promise<SearchResult[]>;
  resolve(identifier: string, limit?: number): Promise<SearchResult[]>;
  cite(docId: number, format: CitationFormat): Promise<string>;
  proof(docId: number): Promise<Record<string, unknown>>;
  /** `conceptio info` — full metadata for one document. */
  info(docId: number): Promise<SearchResult>;
  /** Tier/quota, structured when the CLI supports it and verbatim otherwise. */
  status(): Promise<QuotaStatus>;
}

/** Build the CLI handle from plugin settings. */
export function buildCli(creds: CliCredentials, exec?: ExecFileLike): CliHandle {
  const env = cliEnv(creds);
  const bin = (creds.bin ?? "").trim() || DEFAULT_CLI;

  async function json<T>(args: string[], timeoutMs = SEARCH_TIMEOUT_MS): Promise<T> {
    const res = await runCli(args, { env, timeoutMs, exec, bin });
    if (res.code !== 0) {
      throw new CliError(lastLine(res.stderr || res.stdout) || "conceptio CLI failed.");
    }
    return decodeJson<T>(res.stdout);
  }

  return {
    async search(query: string, limit: number, license?: string): Promise<SearchResult[]> {
      const args = ["search", query, "--json", "-l", String(limit)];
      if (license) args.push("--license", license);
      const data = await json<SearchResponse>(args);
      return data.results ?? [];
    },
    async resolve(identifier: string, limit = 10): Promise<SearchResult[]> {
      const data = await json<ResolveResponse>(["resolve", identifier, "--json", "-l", String(limit)]);
      return data.results ?? [];
    },
    async cite(docId: number, format: CitationFormat): Promise<string> {
      const res = await runCli(["cite", String(docId), "-f", format], {
        env,
        exec,
        bin,
        timeoutMs: QUICK_TIMEOUT_MS,
      });
      if (res.code !== 0) {
        throw new CliError(lastLine(res.stderr || res.stdout) || "Citation failed.");
      }
      return res.stdout.trim();
    },
    async proof(docId: number): Promise<Record<string, unknown>> {
      return json<Record<string, unknown>>(["proof", String(docId), "--json"]);
    },
    async info(docId: number): Promise<SearchResult> {
      return json<SearchResult>(["info", String(docId), "--json"], QUICK_TIMEOUT_MS);
    },
    async status(): Promise<QuotaStatus> {
      // Preferred: the structured form (`quota --json`, CLI 0.3.1+), so the
      // surface can present the tier itself. A CLI older than that fails this
      // call — it must degrade to the human report, never to an error, because
      // an out-of-date CLI is not a broken account.
      try {
        const data = await json<Record<string, unknown>>(["quota", "--json"], QUICK_TIMEOUT_MS);
        const tier = typeof data.tier === "string" ? data.tier : null;
        return { summary: summarizeQuota(data), text: summarizeQuota(data), tier };
      } catch (err) {
        if (err instanceof CliMissingError) throw err;
      }
      const res = await runCli(["quota"], { env, exec, bin, timeoutMs: QUICK_TIMEOUT_MS });
      if (res.code !== 0) {
        throw new CliError(lastLine(res.stderr || res.stdout) || "Could not read the account status.");
      }
      const text = (res.stdout || res.stderr).trim();
      return { summary: text, text, tier: null };
    },
  };
}
