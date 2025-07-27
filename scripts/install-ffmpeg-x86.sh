#!/bin/bash
# Script to install FFmpeg on Amazon Linux 2 using pre-compiled binaries
# Based on the recommended approach from johnvansickle.com

echo "===== Installing FFmpeg on Amazon Linux 2 ====="

# Determine the architecture
echo "1. Detecting system architecture..."
ARCH=$(uname -m)
echo "Detected architecture: $ARCH"

# Map architecture to the appropriate download URL
if [[ "$ARCH" == "x86_64" ]]; then
    FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    ARCH_NAME="amd64"
elif [[ "$ARCH" == "aarch64" ]]; then
    FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
    ARCH_NAME="arm64"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

echo "Using FFmpeg URL: $FFMPEG_URL"

# Create temporary working directory
echo "2. Creating temporary working directory..."
mkdir -p ~/sources
cd ~/sources

# Download FFmpeg
echo "3. Downloading FFmpeg static binary for $ARCH_NAME..."
wget -O ffmpeg-release-static.tar.xz $FFMPEG_URL

# Extract the tarball
echo "4. Extracting FFmpeg..."
tar -xf ffmpeg-release-static.tar.xz
cd ffmpeg-*-static

# Test FFmpeg before installation
echo "5. Testing FFmpeg..."
./ffmpeg -version
if [ $? -ne 0 ]; then
    echo "❌ FFmpeg test failed. Downloaded binary may be corrupted."
    exit 1
fi

# Install FFmpeg to system path
echo "6. Installing FFmpeg to /usr/local/bin..."
sudo mv ffmpeg /usr/local/bin/
sudo mv ffprobe /usr/local/bin/
sudo chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe

# Verify installation
echo "7. Verifying FFmpeg installation..."
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg installed successfully!"
    ffmpeg -version | head -n 1
else
    echo "❌ FFmpeg installation verification failed."
    exit 1
fi

# Cleanup
echo "8. Cleaning up..."
cd ~/ && rm -rf ~/sources

# Make sure Python dependencies are installed
echo "9. Installing Python dependencies..."
sudo pip3 install --upgrade 'urllib3<1.27' boto3 requests

# Check if radio-recorder service exists
echo "10. Checking radio-recorder service..."
if [ -f /etc/systemd/system/radio-recorder.service ]; then
    echo "Radio recorder service found. Checking status..."
    
    # Check if the service is running
    if sudo systemctl is-active --quiet radio-recorder; then
        echo "✅ radio-recorder service is running!"
        sudo systemctl status radio-recorder
    else
        echo "❌ radio-recorder service is not running. Starting it..."
        sudo systemctl daemon-reload
        sudo systemctl enable radio-recorder
        sudo systemctl start radio-recorder
        
        # Check again after starting
        if sudo systemctl is-active --quiet radio-recorder; then
            echo "✅ radio-recorder service started successfully!"
        else
            echo "❌ Failed to start radio-recorder service. Checking logs..."
            sudo journalctl -u radio-recorder -n 20
        fi
    fi
else
    echo "❌ Radio recorder service not found. Checking for the recorder script..."
    
    # Check if the recorder script exists
    if [ -f /opt/radio-recorder/radio_recorder.py ]; then
        echo "✅ Radio recorder script found. Creating service..."
    else
        echo "❌ Radio recorder script not found. Creating directory and downloading from S3..."
        sudo mkdir -p /opt/radio-recorder/
        sudo aws s3 cp s3://radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror/radio_recorder.py /opt/radio-recorder/
        sudo chmod +x /opt/radio-recorder/radio_recorder.py
    fi
    
    # Create service file
    echo "Creating systemd service file..."
    cat << 'EOF' | sudo tee /etc/systemd/system/radio-recorder.service
[Unit]
Description=Radio Recorder Service
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/radio-recorder/radio_recorder.py
Restart=always
User=root
Group=root
Environment=PATH=/usr/bin:/usr/local/bin
Environment=PYTHONUNBUFFERED=1
WorkingDirectory=/opt/radio-recorder

[Install]
WantedBy=multi-user.target
EOF
    
    # Start the service
    sudo systemctl daemon-reload
    sudo systemctl enable radio-recorder
    sudo systemctl start radio-recorder
    
    # Check if the service started successfully
    if sudo systemctl is-active --quiet radio-recorder; then
        echo "✅ radio-recorder service created and started successfully!"
    else
        echo "❌ Failed to start radio-recorder service. Checking logs..."
        sudo journalctl -u radio-recorder -n 20
    fi
fi

echo "===== Installation complete! ====="
echo "You can check the service logs with: sudo journalctl -u radio-recorder -f"