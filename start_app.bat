@echo off
set OLLAMA_KEEP_ALIVE=24h
cd /d "%~dp0"

echo STARTAR OM OLLAMA FÖR ATT AKTIVERA VAKT-LÄGE...
taskkill /F /IM "ollama app.exe" /T >nul 2>&1
taskkill /F /IM "ollama.exe" /T >nul 2>&1
start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
timeout /t 2 /nobreak >nul

echo RENSAR GAMLA PROCESSER...
taskkill /F /IM ffmpeg.exe /T >nul 2>&1
taskkill /F /IM electron.exe /T >nul 2>&1
echo Startar AI-Assistenten (K.I.T.T. Edition)...
npx electron .
pause
