@echo off
cd /d "%~dp0"

echo Running npm run build...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed. Commit and push were not executed.
  pause
  exit /b 1
)

echo.
set /p COMMIT_MSG=Enter commit message: 

if "%COMMIT_MSG%"=="" (
  set COMMIT_MSG=Update app
)

echo.
echo Running git add...
git add .

echo.
echo Committing: "%COMMIT_MSG%"
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo.
  echo Commit failed.
  pause
  exit /b 1
)

echo.
echo Running git push...
git push
if errorlevel 1 (
  echo.
  echo Push failed.
  pause
  exit /b 1
)

echo.
echo Done.
pause
