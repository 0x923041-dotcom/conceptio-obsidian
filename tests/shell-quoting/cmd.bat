@echo off
REM The invocation the README documents, written here so it is parsed by cmd.exe
REM exactly as a user would type it (not re-quoted by Node on the way in).
node "%~dp0argv_echo.mjs" conceptio search query="zero trust" source=arxiv
