@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在创建桌面快捷方式...
node tools/create-shortcut.js
echo.
echo 已完成，按任意键关闭本窗口...
pause >nul
