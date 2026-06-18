@echo off
cd /d "%~dp0"
echo Force push a GitHub QA...
git push --force origin main
echo.
if %errorlevel%==0 (echo OK) else (echo ERROR %errorlevel%)
pause
