#!/bin/bash
# Script to fix Python dependencies for the radio recorder

echo "===== Fixing Python Dependencies for Radio Recorder ====="

# Uninstall problematic packages
echo "1. Uninstalling problematic packages..."
sudo pip3 uninstall -y urllib3 boto3 botocore requests

# Install compatible versions
echo "2. Installing compatible versions..."
sudo pip3 install 'urllib3<2.0.0' boto3==1.28.65 botocore==1.31.65 requests==2.31.0

# Verify installations
echo "3. Verifying installations..."
echo "urllib3 version:"
python3 -c "import urllib3; print(urllib3.__version__)"

echo "boto3 version:"
python3 -c "import boto3; print(boto3.__version__)"

echo "botocore version:"
python3 -c "import botocore; print(botocore.__version__)"

echo "requests version:"
python3 -c "import requests; print(requests.__version__)"

# Test importing all required modules
echo "4. Testing imports..."
python3 -c "import boto3, botocore, requests, urllib3, datetime, subprocess, time, os, sys, logging; print('All imports successful!')"

echo "===== Python Dependencies Fixed! ====="