# The invocation the README documents, parsed by Windows PowerShell 5.1 — the
# version that re-quotes arguments handed to a native command, so if any shell
# were going to mangle `query="zero trust"`, it is this one.
node "$PSScriptRoot/argv_echo.mjs" conceptio search query="zero trust" source=arxiv
