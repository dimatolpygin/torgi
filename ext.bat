@echo off
rem Single stage, run by hand (to debug a stall). ASCII-only on purpose.
chcp 65001 > nul
cd /d "%~dp0"
claude "/ext-next"
pause
