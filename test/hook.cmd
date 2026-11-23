@echo off
rem Test hook: record the event file the bus handed us.
echo %~1>>"%~dp0hook.log"
