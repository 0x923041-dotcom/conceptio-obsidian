/** Shared offline test doubles for the Conceptio Obsidian plugin suite. */

import type { ExecFileLike } from "../src/cli.js";
import type { SearchResult } from "../src/types.js";

export interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout: number;
}

export type Responder = (
  call: Call,
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/** A fake `execFile` that records every call and replays responders in order. */
export function fakeExec(...responders: Responder[]): { exec: ExecFileLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const exec: ExecFileLike = (file, args, options, callback) => {
    calls.push({ file, args, env: options.env, timeout: options.timeout });
    const responder = responders[Math.min(index, responders.length - 1)];
    index += 1;
    if (!responder) {
      callback(null, "", "");
      return;
    }
    responder(calls[calls.length - 1], callback);
  };
  return { exec, calls };
}

/** Exit 0 with stdout. */
export function ok(stdout: string): Responder {
  return (_call, callback) => callback(null, stdout, "");
}

/** Non-zero exit, as child_process reports it. */
export function fail(code: number, stderr = "", stdout = ""): Responder {
  return (_call, callback) => {
    const err = Object.assign(new Error(`Command failed with exit code ${code}`), { code });
    callback(err, stdout, stderr);
  };
}

/** The CLI binary is not installed. */
export function enoent(): Responder {
  return (_call, callback) => {
    const err = Object.assign(new Error("spawn conceptio ENOENT"), { code: "ENOENT" });
    callback(err, "", "");
  };
}

/** The child was killed by the timeout. */
export function killed(): Responder {
  return (_call, callback) => {
    const err = Object.assign(new Error("Command timed out"), { killed: true });
    callback(err, "", "");
  };
}

/** A representative `/api/search` result. */
export function sampleDoc(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 7288,
    title: "Attention Is All You Need",
    author: "Ashish Vaswani; Noam Shazeer",
    year: "2017",
    source: "arxiv",
    source_label: "arXiv",
    category: "Computer Science",
    license: "CC-BY-4.0",
    access_level: "public_full_text",
    language: "en",
    url: "https://arxiv.org/abs/1706.03762",
    direct_pdf_url: "https://arxiv.org/pdf/1706.03762",
    description: "The dominant sequence transduction models are based on complex recurrent networks.",
    ...overrides,
  };
}
