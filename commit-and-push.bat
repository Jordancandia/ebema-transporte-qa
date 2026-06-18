@echo off
cd /d "%~dp0"
echo ============================================
echo  EBEMA QA - Commit + Force Push
echo ============================================
echo.

:: Limpiar locks residuales
if exist ".git\HEAD.lock" del /f ".git\HEAD.lock"
if exist ".git\index.lock" del /f ".git\index.lock"
if exist ".git\refs\heads\main.lock" del /f ".git\refs\heads\main.lock"

:: Limpiar multi-pack-index corrupto (causa "improper chunk offset")
if exist ".git\objects\pack\multi-pack-index" del /f ".git\objects\pack\multi-pack-index"

:: Abortar rebase si hay uno en curso
git rebase --abort 2>nul

:: Reset el index (por si hay staged con archivos viejos)
git reset HEAD 2>nul

:: Mostrar estado
git status --short
echo.

:: Agregar archivos JS y HTML
git add js/app.js
git add js/tarifas-transporte.js
git add js/tarifas-clientes.js
git add index.html

:: Commit
git commit -m "feat: normalizarRegion — O'Higgins / Metropolitana / Magallanes para GetAPI"
if %errorlevel% neq 0 (
  echo ERROR en commit.
  pause
  exit /b 1
)

:: Actualizar cache-bust con nuevo hash
for /f %%h in ('git rev-parse --short HEAD') do set HASH=%%h
echo Hash del commit: %HASH%
powershell -Command "(Get-Content index.html) -replace 'app\.js\?v=[a-f0-9]+', ('app.js?v=' + '%HASH%') | Set-Content index.html"
git add index.html
git commit --amend --no-edit

:: Force push
echo.
echo Haciendo force push...
git push --force origin main
if %errorlevel%==0 (
  echo.
  echo OK - Push exitoso
) else (
  echo ERROR en push - codigo: %errorlevel%
)
echo.
pause
