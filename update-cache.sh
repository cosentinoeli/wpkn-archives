#!/bin/bash
# Cache Buster Update Script
# Updates version parameters in HTML files to force browser cache refresh

# Get current timestamp
TIMESTAMP=$(date +%s)

# Update HTML files - handle both ?v=number and ?v=number-suffix formats
find docs/ -name "*.html" -type f -exec sed -i "s/\?v=[0-9]\+\(-[0-9]\+\)\?/?v=$TIMESTAMP/g" {} \;

echo "Cache-busting parameters updated to timestamp: $TIMESTAMP"