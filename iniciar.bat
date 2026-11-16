@echo off
rem Inicia o Deslizae. Na primeira vez, cria o ambiente e instala as dependências.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Preparando o ambiente pela primeira vez...
  python -m venv .venv || goto :erro
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :erro
)

".venv\Scripts\python.exe" -m deslizae %*
goto :eof

:erro
echo.
echo Nao foi possivel preparar o ambiente. Verifique se o Python 3.11+ esta instalado.
pause
