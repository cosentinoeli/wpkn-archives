#!/bin/bash
# Simpler fix for radio recorder service
# This script uses pre-compiled FFmpeg binaries instead of attempting compilation

echo "====== Radio Recorder Service Fix Script (Simple) ======"
echo "This script will install FFmpeg from pre-compiled binaries, fix Python dependencies, and restart the service"

# Install necessary packages
echo -e "\n[1/6] Installing required packages..."
sudo yum -y update
sudo yum -y install wget tar xz

# Download pre-compiled FFmpeg for ARM
echo -e "\n[2/6] Downloading pre-compiled FFmpeg for ARM architecture..."
cd /tmp
wget -O ffmpeg-arm.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-aarch64-static.tar.xz

# Extract and install FFmpeg
echo -e "\n[3/6] Extracting and installing FFmpeg..."
tar xf ffmpeg-arm.tar.xz
cd ffmpeg-*-aarch64-static
sudo cp ffmpeg ffprobe /usr/local/bin/
sudo chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

# Verify FFmpeg installation
echo -e "\n[4/6] Verifying FFmpeg installation..."
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg installed successfully!"
    ffmpeg -version | head -n 1
else
    echo "❌ FFmpeg installation failed. This is required for recording."
    exit 1
fi

# Fix Python dependencies
echo -e "\n[5/6] Fixing Python dependencies..."
sudo pip3 uninstall -y boto3 botocore urllib3 requests
sudo pip3 install 'urllib3<1.27' boto3 requests

# Verify Python dependencies
echo -e "\n[5/6] Verifying Python dependencies..."
python3 -c "import boto3, requests, urllib3; print(f'boto3: {boto3.__version__}, requests: {requests.__version__}, urllib3: {urllib3.__version__}')"

# Check if the recording script exists and is executable
if [ -f /opt/radio-recorder/radio_recorder.py ]; then
    sudo chmod +x /opt/radio-recorder/radio_recorder.py
    echo "✅ Recording script found and made executable"
else
    echo "❌ Recording script not found at /opt/radio-recorder/radio_recorder.py"
    exit 1
fi

# Restart the service
echo -e "\n[6/6] Restarting radio-recorder service..."
sudo systemctl daemon-reload
sudo systemctl restart radio-recorder.service
sleep 2

# Check service status
echo -e "\n===== Service Status ====="
sudo systemctl status radio-recorder.service

echo -e "\n===== Live Service Logs (Press Ctrl+C to exit) ====="
sudo journalctl -u radio-recorder.service -f