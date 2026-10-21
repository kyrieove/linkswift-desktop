@echo off
chcp 65001 >nul
title Unidownload
cd /d "%~dp0"
echo 正在启动 Unidownload...
npm start
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 启动遇到错误，请按任意键退出...
    pause >nul
)
