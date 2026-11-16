@echo off
rem Inicia o Deslizae a partir do código-fonte.
rem Na primeira vez, cria o ambiente e instala as dependências.
rem Para usar sem Python, baixe o Deslizae.exe em:
rem https://github.com/dvarakaki/deslizae/releases/latest
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Deslizae

if exist ".venv\Scripts\python.exe" goto :run

rem --- Procura um Python 3.11+ (lançador "py" primeiro, depois "python") ---
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY goto :sem_python

echo.
echo   Preparando o Deslizae pela primeira vez (pode levar alguns minutos)...
echo.
%PY% -m venv .venv || goto :erro
".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r requirements.txt || goto :erro

:run
".venv\Scripts\python.exe" -m deslizae %*
if errorlevel 1 pause
goto :eof

:sem_python
echo.
echo   Nao encontrei o Python 3.11 ou mais novo neste computador.
echo.
echo   Opcao 1 (mais facil): baixe o Deslizae.exe, que nao precisa de Python:
echo     https://github.com/dvarakaki/deslizae/releases/latest
echo.
echo   Opcao 2: instale o Python em https://www.python.org/downloads/
echo     IMPORTANTE: na primeira tela do instalador, marque
echo     "Add python.exe to PATH". Depois, abra este arquivo de novo.
echo.
pause
exit /b 1

:erro
echo.
echo   Nao foi possivel preparar o ambiente. Verifique sua conexao com a
echo   internet e tente de novo. Se persistir, apague a pasta .venv.
echo.
if exist ".venv" rmdir /s /q ".venv"
pause
exit /b 1
