@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo.
echo  === Веха 3: следующий этап расширения ===
echo  Одна сессия = один этап. В конце будет короткий чек-лист для проверки.
echo.
claude "/ext-next"
pause
