@echo off
cd /d "%~dp0"
set /p commitMessage="Enter commit message: "

git add .
git commit -m "%commitMessage%"
git push

if %errorlevel% neq 0 (
    echo "Git operation failed. Please check for errors."
) else (
    echo "Git operation successful."
)

pause