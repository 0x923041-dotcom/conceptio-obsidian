# The invocation the README documents, parsed by PowerShell 7.
# pwsh 7 passes native arguments through unchanged, which is why it is worth
# checking separately from Windows PowerShell 5.1 below.
node "$PSScriptRoot/argv_echo.mjs" conceptio search query="zero trust" source=arxiv
