@echo off
set RUN_MANAGER_FLIGHT_LIVE=1
npx tsx tests/live/manager-flight-realistic-conversations.ts %*
