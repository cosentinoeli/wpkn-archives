#!/bin/bash

# WPKN Radio Recorder - Main Deployment Script
# This is a convenience wrapper that calls the actual deployment script

set -e

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo -e "${BLUE}🎵 WPKN Radio Recorder Deployment${NC}"
echo "=================================="
echo ""

# Check if config exists
if [ -f "config/deploy-config.sh" ]; then
    echo -e "${GREEN}Loading configuration from config/deploy-config.sh${NC}"
    source config/deploy-config.sh
else
    echo "Configuration file not found. Creating from template..."
    if [ -f "config/deploy-config.sh.example" ]; then
        cp config/deploy-config.sh.example config/deploy-config.sh
        echo "Please edit config/deploy-config.sh with your settings, then run this script again."
        exit 1
    else
        echo "No configuration template found. Please check the config/ directory."
        exit 1
    fi
fi

# Execute the actual deployment script
echo "Starting deployment..."
exec ./scripts/deploy.sh "$@"
