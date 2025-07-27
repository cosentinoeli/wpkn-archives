#!/bin/bash
# Comprehensive fix for the radio recorder service
# This script will install FFmpeg, fix Python dependencies, and ensure the service runs properly

echo "====== Radio Recorder Service Fix Script ======"
echo "This script will fix all dependencies and restart the service"

# Enable EPEL repository (required for FFmpeg)
echo -e "\n[1/7] Enabling EPEL repository..."
sudo amazon-linux-extras install epel -y

# Install FFmpeg
echo -e "\n[2/7] Installing FFmpeg..."
sudo yum install -y ffmpeg

# Check if FFmpeg was installed correctly
if ! command -v ffmpeg &> /dev/null; then
    echo "FFmpeg installation failed, trying alternative method..."
    sudo yum install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-7.noarch.rpm
    sudo yum install -y ffmpeg ffmpeg-devel
fi

# Verify FFmpeg installation
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg installed successfully!"
    ffmpeg -version | head -n 1
else
    echo "❌ FFmpeg installation failed. This is required for recording."
    exit 1
fi

# Fix Python dependencies
echo -e "\n[3/7] Fixing Python dependencies..."
sudo pip3 uninstall -y boto3 botocore urllib3 requests
sudo pip3 install 'urllib3<1.27' boto3 requests

# Verify Python dependencies
echo -e "\n[4/7] Verifying Python dependencies..."
python3 -c "import boto3, requests, urllib3; print(f'boto3: {boto3.__version__}, requests: {requests.__version__}, urllib3: {urllib3.__version__}')"

# Ensure the radio_recorder.py script exists and is executable
echo -e "\n[5/7] Checking radio_recorder.py script..."
if [ -f /opt/radio-recorder/radio_recorder.py ]; then
    sudo chmod +x /opt/radio-recorder/radio_recorder.py
    echo "✅ Script found and set as executable"
else
    echo "❌ Script not found at /opt/radio-recorder/radio_recorder.py"
    exit 1
fi

# Restart the service
echo -e "\n[6/7] Restarting radio-recorder service..."
sudo systemctl daemon-reload
sudo systemctl restart radio-recorder.service
sleep 2

# Check service status
echo -e "\n[7/7] Checking service status..."
sudo systemctl status radio-recorder.service

# Monitor logs to verify it's working
echo -e "\n===== Live service logs (Ctrl+C to exit) ====="
echo "Showing the last few log entries to verify the service is recording properly:"
sudo journalctl -u radio-recorder.service -f