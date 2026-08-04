@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo.
echo  === Автопрогон Вехи 3 ===
echo  Этапы идут подряд, тебя не дёргают. Остановится сам там,
echo  где без тебя физически нельзя (боевая ночь / ПК клиентки).
echo  Проверка будет ОДНА: docs\uat\CHECKLIST.md
echo.
node scripts/run-chain.mjs %*
pause
