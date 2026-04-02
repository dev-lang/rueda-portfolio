#!/usr/bin/env bash
# Removes all __pycache__ directories and .pyc/.pyo files
find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null
find . -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null
echo "Pycache limpiado."
