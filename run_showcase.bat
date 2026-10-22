@echo off
rem Starts the LSTM showcase. The browser opens once the models have loaded.
cd /d "%~dp0"
"..\Starting_Model\.venv\Scripts\python.exe" app.py --open
pause
