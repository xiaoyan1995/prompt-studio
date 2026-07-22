@echo off
setlocal
cd /d "%~dp0"
if not exist data mkdir data
echo Prompt Studio feedback site: http://127.0.0.1:8788/
echo Admin: http://127.0.0.1:8788/admin.html
node server.js
endlocal
