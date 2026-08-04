@echo off
rem Keep this file ASCII-only: cmd.exe mangles UTF-8 text and splits it into
rem bogus commands ("... is not recognized"). All Russian output lives in node.
chcp 65001 > nul
cd /d "%~dp0"
node scripts/run-chain.mjs %*
pause
