@echo off
cd /d "%~dp0"
echo ============================================
echo   SIT EBEMA QA - Configuracion inicial Git
echo ============================================
echo.
echo [1/5] Inicializando repositorio local...
git init
echo.
echo [2/5] Configurando rama principal...
git branch -M main
echo.
echo [3/5] Conectando con GitHub (ebema-transporte-qa)...
git remote remove origin 2>nul
git remote add origin https://github.com/Jordancandia/ebema-transporte-qa.git
git config user.name "Ebema Logistica"
git config user.email "logistica@ebema.cl"
echo.
echo [4/5] Agregando archivos...
git add -A
git commit -m "Version inicial QA"
echo.
echo [5/5] Subiendo a GitHub...
git push -u origin main
echo.
if %errorlevel%==0 (
  echo ============================================
  echo LISTO: repositorio QA configurado y subido.
  echo Desde ahora usa subir-cambios.bat para futuros
  echo cambios en esta carpeta.
  echo ============================================
) else (
  echo Hubo un error. Revisa el mensaje de arriba.
)
pause
