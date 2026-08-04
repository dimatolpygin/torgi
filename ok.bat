@echo off
rem Verdict prompt lives in node: cmd.exe mangles UTF-8 and drops quotes in args.
chcp 65001 > nul
cd /d "%~dp0"
node scripts/ask-verdict.mjs
pause
