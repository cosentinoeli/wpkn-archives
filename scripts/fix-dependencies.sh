#!/bin/bash
# Script to fix Python dependencies for the radio recorder service
# This script will downgrade urllib3 to a version compatible with older OpenSSL

echo "==== Python Dependencies Fix Script ===="
echo "This script will install compatible versions of Python packages"

# Checking Python version
echo -e "\nPython version:"
python3 --version

# Checking pip
echo -e "\nChecking pip installation..."
pip3 --version || { 
    echo "Installing pip..."
    sudo yum install -y python3-pip
}

# Uninstalling incompatible packages
echo -e "\nRemoving incompatible packages..."
sudo pip3 uninstall -y urllib3 requests boto3 botocore

# Installing compatible versions
echo -e "\nInstalling compatible package versions..."
sudo pip3 install 'urllib3<2.0' requests boto3

# Verifying installation
echo -e "\nVerifying installations:"
pip3 list | grep -E 'urllib3|requests|boto3|botocore'

echo -e "\nChecking if we can import boto3..."
python3 -c "import boto3; print('✓ boto3 import successful!')"

echo -e "\nChecking if S3 operations work..."
python3 -c "
import boto3
try:
    s3 = boto3.client('s3')
    print('✓ boto3.client(\"s3\") successful!')
    buckets = s3.list_buckets()
    print(f'✓ Successfully listed buckets! Found {len(buckets[\"Buckets\"])} buckets')
except Exception as e:
    print(f'Error: {str(e)}')
"

echo -e "\nRestarting radio-recorder service..."
sudo systemctl daemon-reload
sudo systemctl restart radio-recorder.service
sleep 2
sudo systemctl status radio-recorder.service

echo -e "\nDone! Check service status above for results."