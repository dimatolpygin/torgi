@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo.
echo  === Итог проверки этапа ===
echo  Напиши "ок" если всё сошлось, либо коротко что именно не так.
echo  (номер этапа можно не писать — он берётся из STATUS)
echo.
set /p VERDICT=Итог:
if "%VERDICT%"=="" set VERDICT=ок
claude "/ext-done %VERDICT%"
pause
