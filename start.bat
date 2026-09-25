@echo off
rem Startet den Server und oeffnet die Seite im Browser.
rem Fenster offen lassen - beim Schliessen wird der Server beendet.
cd /d "%~dp0"
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
npm start
pause
