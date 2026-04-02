#!/usr/bin/env bash
# Removes all rotated log files and empties the current app.log
rm -f logs/app.log.*
truncate -s 0 logs/app.log 2>/dev/null || > logs/app.log
echo "Logs limpiados."
