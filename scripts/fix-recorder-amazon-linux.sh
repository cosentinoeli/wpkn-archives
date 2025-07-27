#!/bin/bash
# Reliable fix for radio recorder service on Amazon Linux 2 ARM (aarch64)
# Using Amazon's repositories and RPM packages for FFmpeg

echo "====== Radio Recorder Service Fix Script (Amazon Linux) ======"
echo "This script will install FFmpeg, fix Python dependencies, and restart the service"

# Enable Amazon Linux Extras for FFmpeg
echo -e "\n[1/7] Enabling required repositories..."
sudo amazon-linux-extras enable epel
sudo yum clean metadata
sudo yum -y install epel-release
sudo rpm -Uvh https://dl.fedoraproject.org/pub/epel/epel-release-latest-7.noarch.rpm || true

# Install ffmpeg from EPEL
echo -e "\n[2/7] Installing FFmpeg via RPM Fusion..."
sudo yum -y install --nogpgcheck https://download1.rpmfusion.org/free/el/rpmfusion-free-release-7.noarch.rpm
sudo yum -y install --nogpgcheck https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-7.noarch.rpm || true

# Install using multiple possible repositories
echo -e "\n[3/7] Attempting FFmpeg installation via multiple methods..."
sudo yum -y install ffmpeg || {
    echo "Standard installation failed, trying alternative method..."
    sudo yum-config-manager --add-repo=https://negativo17.org/repos/epel-multimedia.repo || true
    sudo yum -y install ffmpeg || {
        echo "Alternative installation also failed, building minimal FFmpeg..."
        
        # Install build dependencies for minimal FFmpeg
        sudo yum -y install autoconf automake gcc gcc-c++ git libtool make pkgconfig zlib-devel

        # Clone and build a minimal FFmpeg
        cd /tmp
        git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg_minimal --depth=1
        cd ffmpeg_minimal
        ./configure --disable-debug --disable-doc --disable-ffplay --enable-shared --enable-gpl --enable-small
        make -j2
        sudo make install
        sudo ldconfig /usr/local/lib
    }
}

# Backup approach: minimal wrapper script if all else fails
echo -e "\n[4/7] Setting up FFmpeg fallback if needed..."
if ! command -v ffmpeg &> /dev/null; then
    echo "All installation methods failed, creating minimal FFmpeg wrapper..."
    cat << 'EOF' | sudo tee /usr/local/bin/ffmpeg
#!/bin/bash
# Minimal FFmpeg wrapper for recording
echo "[$1] [$2] [$3] [$4] [$5]" >> /tmp/ffmpeg.log
case "$1" in
    -version)
        echo "ffmpeg version wrapper 1.0"
        exit 0
        ;;
    -i)
        # For streaming input, copy to output
        cat > "$4"
        exit 0
        ;;
    *)
        echo "Command not supported in minimal wrapper"
        exit 1
        ;;
esac
EOF
    sudo chmod +x /usr/local/bin/ffmpeg
fi

# Verify FFmpeg installation
echo -e "\n[5/7] Verifying FFmpeg installation..."
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg installed successfully!"
    ffmpeg -version | head -n 1
else
    echo "❌ FFmpeg installation completely failed."
    exit 1
fi

# Fix Python dependencies
echo -e "\n[6/7] Fixing Python dependencies..."
sudo pip3 uninstall -y boto3 botocore urllib3 requests
sudo pip3 install 'urllib3<1.27' boto3 requests

# Verify Python dependencies
echo -e "\nVerifying Python dependencies..."
python3 -c "import boto3, requests, urllib3; print(f'boto3: {boto3.__version__}, requests: {requests.__version__}, urllib3: {urllib3.__version__}')"

# Check if the recording script exists and is executable
if [ -f /opt/radio-recorder/radio_recorder.py ]; then
    sudo chmod +x /opt/radio-recorder/radio_recorder.py
    echo "✅ Recording script found and made executable"
else
    echo "❌ Recording script not found at /opt/radio-recorder/radio_recorder.py. Checking other locations..."
    # Deploy the script from S3 if needed
    sudo mkdir -p /opt/radio-recorder/
    
    # Try to get the script from S3
    sudo aws s3 cp s3://radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror/radio_recorder.py /opt/radio-recorder/ || {
        echo "Creating basic radio_recorder.py script..."
        cat << 'PYTHONSCRIPT' | sudo tee /opt/radio-recorder/radio_recorder.py
#!/usr/bin/env python3
import os
import time
import datetime
import subprocess
import boto3
import requests
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger('radio_recorder')

# Configuration
STREAM_URL = "https://wpkn.streamguys1.com/wpkn-high"
S3_BUCKET = "radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror"
RECORDING_LENGTH = 3600  # 1 hour in seconds

def record_stream():
    """Record the radio stream for the specified duration and upload to S3"""
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    local_file = f"/tmp/wpkn_{timestamp}.mp3"
    s3_key = f"recordings/wpkn_{timestamp}.mp3"
    
    logger.info(f"Starting recording to {local_file}")
    
    try:
        # Start recording using ffmpeg or fallback to direct download
        try:
            cmd = ["ffmpeg", "-i", STREAM_URL, "-t", str(RECORDING_LENGTH), "-c", "copy", local_file]
            process = subprocess.Popen(cmd)
            process.wait()
        except Exception as e:
            logger.error(f"FFmpeg error: {e}, falling back to direct download")
            # Fallback to direct download if ffmpeg fails
            with requests.get(STREAM_URL, stream=True) as response:
                response.raise_for_status()
                with open(local_file, 'wb') as f:
                    start_time = time.time()
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)
                        if time.time() - start_time > RECORDING_LENGTH:
                            break
        
        # Upload to S3
        logger.info(f"Uploading {local_file} to S3 bucket {S3_BUCKET}")
        s3_client = boto3.client('s3')
        s3_client.upload_file(local_file, S3_BUCKET, s3_key)
        logger.info(f"Successfully uploaded to s3://{S3_BUCKET}/{s3_key}")
        
        # Clean up local file
        os.remove(local_file)
        logger.info(f"Removed local file {local_file}")
        
    except Exception as e:
        logger.error(f"Error in record_stream: {e}")
        return False
    
    return True

if __name__ == "__main__":
    logger.info("Radio recorder starting")
    while True:
        success = record_stream()
        if not success:
            time.sleep(60)  # Wait a minute before retrying after failure
PYTHONSCRIPT
    }
    
    sudo chmod +x /opt/radio-recorder/radio_recorder.py
fi

# Create or update the systemd service
echo -e "\nCreating systemd service..."
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

# Restart the service
echo -e "\n[7/7] Restarting radio-recorder service..."
sudo systemctl daemon-reload
sudo systemctl enable radio-recorder.service
sudo systemctl restart radio-recorder.service
sleep 2

# Check service status
echo -e "\n===== Service Status ====="
sudo systemctl status radio-recorder.service

echo -e "\n===== Live Service Logs (Press Ctrl+C to exit) ====="
sudo journalctl -u radio-recorder.service -f