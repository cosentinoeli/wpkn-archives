#!/bin/bash
#
# EC2 User Data Script for Radio Stream Recorder
# This script sets up the radio recorder on Amazon Linux 2023
#

set -e

# Configuration - Replace these with your actual values
STREAM_URL="__YOUR_STREAM_URL__"
S3_BUCKET="__YOUR_BUCKET__"
GITHUB_REPO="https://github.com/your/radio-recorder.git"
OUTPUT_DIR="/mnt/recordings"

# Log all output
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "Starting radio recorder setup at $(date)"

# Update system
echo "Updating system packages..."
dnf update -y

# Install required packages
echo "Installing required packages..."
dnf install -y \
    python3 \
    python3-pip \
    git \
    htop \
    tmux \
    logrotate

# Install FFmpeg - Use static builds for Amazon Linux 2023 ARM64 compatibility
echo "Installing FFmpeg..."
if command -v dnf &> /dev/null; then
    # Try RPM Fusion first
    dnf install -y https://download1.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm || true
    dnf install -y ffmpeg || {
        echo "RPM Fusion installation failed, installing static FFmpeg build..."
        
        # Download static ARM64 FFmpeg build
        cd /tmp
        wget -O ffmpeg-release-amd64-static.tar.xz \
            https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz
        
        # Extract and install
        tar -xf ffmpeg-release-amd64-static.tar.xz
        cd ffmpeg-*-arm64-static
        cp ffmpeg /usr/local/bin/
        cp ffprobe /usr/local/bin/
        chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
        
        # Create symlinks if needed
        ln -sf /usr/local/bin/ffmpeg /usr/bin/ffmpeg || true
        ln -sf /usr/local/bin/ffprobe /usr/bin/ffprobe || true
        
        cd /
        rm -rf /tmp/ffmpeg-*
    }
else
    echo "Package manager not found"
    exit 1
fi

# Verify FFmpeg installation
if ! command -v ffmpeg &> /dev/null; then
    echo "ERROR: FFmpeg installation failed"
    exit 1
fi

# Test FFmpeg MP3 encoding capability
echo "Testing FFmpeg MP3 encoding capability..."
if ! ffmpeg -f lavfi -i "sine=frequency=1000:duration=1" -c:a libmp3lame -f mp3 /dev/null -y 2>/dev/null; then
    echo "ERROR: FFmpeg MP3 encoding not available"
    exit 1
fi

echo "FFmpeg version: $(ffmpeg -version | head -1)"
echo "FFmpeg MP3 encoding: ✅ Available"

# Create recordings directory
echo "Creating recordings directory..."
mkdir -p ${OUTPUT_DIR}
chown ec2-user:ec2-user ${OUTPUT_DIR}
chmod 755 ${OUTPUT_DIR}

# Create directories and copy scripts
echo "Setting up radio recorder application structure..."
mkdir -p /opt/radio-recorder/scripts
cd /opt/radio-recorder

# Clone the repository first
if [ ! -d "/tmp/wpkn-archives" ]; then
    git clone ${GITHUB_REPO} /tmp/wpkn-archives
fi

# Copy the recorder script
cp /tmp/wpkn-archives/recorder.py /opt/radio-recorder/scripts/radio_recorder.py
chmod +x /opt/radio-recorder/scripts/radio_recorder.py

# Create a better requirements.txt with specific versions
cat > /opt/radio-recorder/requirements.txt << EOF
boto3>=1.26.0
botocore>=1.29.0
python-dotenv>=0.19.0
EOF

# Install Python dependencies
echo "Installing Python dependencies..."
cd /opt/radio-recorder
pip3 install -r requirements.txt

# Verify boto3 installation and AWS credentials
echo "Verifying AWS setup..."
python3 -c "import boto3; print('boto3 version:', boto3.__version__)"

# Create systemd service
echo "Creating systemd service..."
cat > /etc/systemd/system/radio-recorder.service << EOF
[Unit]
Description=Radio Stream Recorder
Documentation=https://github.com/your/radio-recorder
After=network.target
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ec2-user
Group=ec2-user
Environment="STREAM_URL=${STREAM_URL}"
Environment="S3_BUCKET=${S3_BUCKET}"
Environment="SEGMENT_MINUTES=5"
Environment="OUTPUT_DIR=${OUTPUT_DIR}"
Environment="MAX_DISK_USAGE_PERCENT=80"
Environment="LOG_LEVEL=INFO"
WorkingDirectory=/opt/radio-recorder/scripts
ExecStart=/usr/bin/python3 /opt/radio-recorder/scripts/radio_recorder.py
ExecReload=/bin/kill -HUP \$MAINPID
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=always
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=60

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${OUTPUT_DIR} /var/log /tmp
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=radio-recorder

[Install]
WantedBy=multi-user.target
EOF

# Set up log rotation
echo "Configuring log rotation..."
cat > /etc/logrotate.d/radio-recorder << EOF
/var/log/radio-recorder.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su ec2-user ec2-user
}
EOF

# Create log file with proper permissions
touch /var/log/radio-recorder.log
chown ec2-user:ec2-user /var/log/radio-recorder.log
chmod 644 /var/log/radio-recorder.log

# Reload systemd and enable service
echo "Enabling radio recorder service..."
systemctl daemon-reload
systemctl enable radio-recorder.service

# Start the service
echo "Starting radio recorder service..."
systemctl start radio-recorder.service

# Check service status
sleep 5
if systemctl is-active --quiet radio-recorder.service; then
    echo "✅ Radio recorder service started successfully"
    systemctl status radio-recorder.service --no-pager
else
    echo "❌ Radio recorder service failed to start"
    systemctl status radio-recorder.service --no-pager
    journalctl -u radio-recorder.service --no-pager -n 20
    exit 1
fi

# Set up CloudWatch agent (optional)
echo "Setting up CloudWatch agent (optional)..."
if command -v amazon-cloudwatch-agent-ctl &> /dev/null; then
    cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << EOF
{
    "logs": {
        "logs_collected": {
            "files": {
                "collect_list": [
                    {
                        "file_path": "/var/log/radio-recorder.log",
                        "log_group_name": "/aws/ec2/radio-recorder",
                        "log_stream_name": "{instance_id}",
                        "timezone": "UTC"
                    }
                ]
            }
        }
    },
    "metrics": {
        "namespace": "RadioRecorder",
        "metrics_collected": {
            "disk": {
                "measurement": [
                    "used_percent"
                ],
                "metrics_collection_interval": 300,
                "resources": [
                    "${OUTPUT_DIR}"
                ]
            },
            "mem": {
                "measurement": [
                    "mem_used_percent"
                ],
                "metrics_collection_interval": 300
            }
        }
    }
}
EOF

    amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
fi

# Create a status check script
echo "Creating status check script..."
cat > /usr/local/bin/radio-recorder-status << 'EOF'
#!/bin/bash
echo "=== Radio Recorder Status ==="
echo "Service Status:"
systemctl status radio-recorder.service --no-pager

echo -e "\nRecent Logs:"
journalctl -u radio-recorder.service --no-pager -n 10

echo -e "\nDisk Usage:"
df -h /mnt/recordings

echo -e "\nRecent Recordings:"
ls -la /mnt/recordings/*.mp3 2>/dev/null | tail -5 || echo "No recordings found"

echo -e "\nFFmpeg Version:"
ffmpeg -version | head -1

echo -e "\nAWS CLI Status:"
aws sts get-caller-identity 2>/dev/null || echo "AWS credentials not configured or accessible"
EOF

chmod +x /usr/local/bin/radio-recorder-status

# Final status report
echo "=== Setup Complete ==="
echo "Stream URL: ${STREAM_URL}"
echo "S3 Bucket: ${S3_BUCKET}"
echo "Output Directory: ${OUTPUT_DIR}"
echo "Service Status: $(systemctl is-active radio-recorder.service)"
echo ""
echo "To check status: /usr/local/bin/radio-recorder-status"
echo "To view logs: journalctl -u radio-recorder.service -f"
echo "To restart: sudo systemctl restart radio-recorder.service"
echo ""
echo "Setup completed at $(date)"
