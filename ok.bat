@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo.
echo  === Итог проверки ===
echo  Ты прошёл docs\uat\CHECKLIST.md.
echo  Напиши "ок" если всё сошлось, либо коротко что именно не так.
echo.
set /p VERDICT=Итог:
if "%VERDICT%"=="" set VERDICT=ок
claude "/ext-done %VERDICT%"
pause
