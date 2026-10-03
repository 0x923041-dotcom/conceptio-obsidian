/**
 * What the shells do to the documented Obsidian CLI spelling.
 *
 * `tests/runtime_check.mjs` spawns the Obsidian client with no shell, so a
 * quote it passes reaches the client literally — which is why every parameter
 * in that harness is quote-free. A user does not spawn: they type into a shell.
 * The README's examples are written for that person (`query="zero trust"`), and
 * a documented invocation that was never run through a shell is a claim, not a
 * measurement.
 *
 * So each fixture under `shell-quoting/` holds that exact line, written in a
 * file so the shell parses it as typed — Node never re-quotes it on the way in.
 * The expectation is the same for all of them: the shell CONSUMES the quotes and
 * hands the space through as one argument, so the value is `zero trust` and not
 * `"zero trust"`.
 *
 * The distinction matters in both directions, and both have bitten: through a
 * shell the quotes are syntax; through `spawn` they are four literal characters
 * in the value (which is how `path="note.md"` failed in the runtime check).
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURES = path.join(__dirname, "shell-quoting");

/** The documented invocation, as the shell ultimately hands it to the program. */
const EXPECTED = ["conceptio", "search", "query=zero trust", "source=arxiv"];

const onWindows = process.platform === "win32";

/** Is this shell on this box? (A missing pwsh 7 must skip, not fail.) */
function available(shell: string, args: string[]): boolean {
  const probe = spawnSync(shell, args, { stdio: "ignore" });
  return !probe.error;
}

function argvFrom(shell: string, args: string[]): string[] {
  const out = spawnSync(shell, args, { encoding: "utf8" });
  if (out.error) throw out.error;
  return JSON.parse(out.stdout.trim());
}

describe("the shells a user types into", () => {
  it("cmd.exe consumes the quotes and keeps the space in one argument", () => {
    if (!onWindows) return; // cmd.exe is Windows-only; nothing to assert here.
    expect(argvFrom("cmd.exe", ["/c", path.join(FIXTURES, "cmd.bat")])).toEqual(EXPECTED);
  });

  it("PowerShell 7 does the same", () => {
    if (!onWindows || !available("pwsh", ["-NoProfile", "-Command", "exit"])) return;
    const argv = argvFrom("pwsh", ["-NoProfile", "-File", path.join(FIXTURES, "pwsh7.ps1")]);
    expect(argv).toEqual(EXPECTED);
  });

  it("Windows PowerShell 5.1 does the same, despite its native-arg re-quoting", () => {
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (!onWindows || !available(powershell, ["-NoProfile", "-Command", "exit"])) return;
    const argv = argvFrom(powershell, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(FIXTURES, "ps5.ps1"),
    ]);
    expect(argv).toEqual(EXPECTED);
  });
});
