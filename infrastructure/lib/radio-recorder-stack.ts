import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface RadioRecorderStackProps extends cdk.StackProps {
  streamUrl: string;
  s3BucketName?: string;
  keyPairName: string;
  allowedSshCidr?: string;
  instanceType?: string;
  segmentMinutes?: number;
  env?: cdk.Environment;
}

export class RadioRecorderStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly instance: ec2.Instance;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: RadioRecorderStackProps) {
    super(scope, id, props);

    const {
      streamUrl,
      s3BucketName,
      keyPairName,
      allowedSshCidr = '0.0.0.0/0',
      instanceType = 't4g.small',
      segmentMinutes = 5
    } = props;

    // Create S3 bucket for recordings
    this.bucket = new s3.Bucket(this, 'RecordingsBucket', {
      bucketName: s3BucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteOldRecordings',
          enabled: true,
          expiration: cdk.Duration.days(365),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create CloudWatch Log Group
    this.logGroup = new logs.LogGroup(this, 'RadioRecorderLogGroup', {
      logGroupName: '/aws/ec2/radio-recorder',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Get default VPC
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // Create security group
    const securityGroup = new ec2.SecurityGroup(this, 'RadioRecorderSecurityGroup', {
      vpc,
      description: 'Security group for radio recorder EC2 instance',
      allowAllOutbound: true,
    });

    // Allow SSH access
    securityGroup.addIngressRule(
      ec2.Peer.ipv4(allowedSshCidr),
      ec2.Port.tcp(22),
      'SSH access'
    );

    // Create IAM role for EC2 instance
    const ec2Role = new iam.Role(this, 'RadioRecorderRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for radio recorder EC2 instance',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    // Add S3 permissions
    this.bucket.grantReadWrite(ec2Role);

    // Add CloudWatch permissions
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: ['*'],
    }));

    // Create instance profile
    const instanceProfile = new iam.CfnInstanceProfile(this, 'RadioRecorderInstanceProfile', {
      roles: [ec2Role.roleName],
    });

    // Get the latest Amazon Linux 2023 AMI for ARM64
    const ami = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });

    // Create EBS volume for recordings
    const recordingsVolume = new ec2.Volume(this, 'RecordingsVolume', {
      availabilityZone: vpc.availabilityZones[0],
      size: cdk.Size.gibibytes(100),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
    });

    // Generate user data script
    const userDataScript = this.generateUserDataScript({
      streamUrl,
      bucketName: this.bucket.bucketName,
      segmentMinutes,
      logGroupName: this.logGroup.logGroupName,
    });

    // Create EC2 instance
    this.instance = new ec2.Instance(this, 'RadioRecorderInstance', {
      vpc,
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ami,
      securityGroup,
      keyName: keyPairName,
      role: ec2Role,
      userData: ec2.UserData.custom(userDataScript),
      detailedMonitoring: true,
      availabilityZone: vpc.availabilityZones[0],
    });

    // Attach the EBS volume
    new ec2.CfnVolumeAttachment(this, 'RecordingsVolumeAttachment', {
      device: '/dev/xvdf',
      instanceId: this.instance.instanceId,
      volumeId: recordingsVolume.volumeId,
    });

    // Add tags
    cdk.Tags.of(this.instance).add('Name', 'radio-recorder');
    cdk.Tags.of(this.instance).add('Purpose', 'stream-recording');
    cdk.Tags.of(recordingsVolume).add('Name', 'radio-recorder-storage');

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'ID of the radio recorder EC2 instance',
    });

    new cdk.CfnOutput(this, 'InstancePublicIP', {
      value: this.instance.instancePublicIp,
      description: 'Public IP address of the EC2 instance',
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: this.bucket.bucketName,
      description: 'Name of the S3 bucket for recordings',
    });

    new cdk.CfnOutput(this, 'SSHCommand', {
      value: `ssh -i ${keyPairName}.pem ec2-user@${this.instance.instancePublicIp}`,
      description: 'SSH command to connect to the instance',
    });

    new cdk.CfnOutput(this, 'LogsCommand', {
      value: 'sudo journalctl -u radio-recorder.service -f',
      description: 'Command to view service logs',
    });

    new cdk.CfnOutput(this, 'StatusCommand', {
      value: 'sudo systemctl status radio-recorder.service',
      description: 'Command to check service status',
    });
  }

  private generateUserDataScript(config: {
    streamUrl: string;
    bucketName: string;
    segmentMinutes: number;
    logGroupName: string;
  }): string {
    const { streamUrl, bucketName, segmentMinutes, logGroupName } = config;

    return `#!/bin/bash
set -e

# Log all output
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "Starting radio recorder setup at $(date)"

# Update system
echo "Updating system packages..."
dnf update -y

# Install required packages
echo "Installing required packages..."
dnf install -y \\
    python3 \\
    python3-pip \\
    git \\
    htop \\
    tmux \\
    logrotate

# Install FFmpeg - Use static builds for Amazon Linux 2023 ARM64 compatibility
echo "Installing FFmpeg..."
dnf install -y https://download1.rpmfusion.org/free/el/rpmfusion-free-release-\$(rpm -E %rhel).noarch.rpm || true
dnf install -y ffmpeg || {
    echo "RPM Fusion installation failed, installing static FFmpeg build..."
    
    # Download static ARM64 FFmpeg build
    cd /tmp
    wget -O ffmpeg-release-arm64-static.tar.xz \\
        https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz
    
    # Extract and install
    tar -xf ffmpeg-release-arm64-static.tar.xz
    cd ffmpeg-*-arm64-static
    cp ffmpeg /usr/local/bin/
    cp ffprobe /usr/local/bin/
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
    
    # Create symlinks
    ln -sf /usr/local/bin/ffmpeg /usr/bin/ffmpeg || true
    ln -sf /usr/local/bin/ffprobe /usr/bin/ffprobe || true
    
    cd /
    rm -rf /tmp/ffmpeg-*
}

# Verify FFmpeg installation and MP3 encoding
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

echo "FFmpeg version: \$(ffmpeg -version | head -1)"
echo "FFmpeg MP3 encoding: ✅ Available"

# Format and mount additional storage
echo "Setting up storage..."
while [ ! -e /dev/xvdf ]; do sleep 1; done
file -s /dev/xvdf | grep -q "data" && mkfs.ext4 /dev/xvdf
mkdir -p /mnt/recordings
mount /dev/xvdf /mnt/recordings
echo '/dev/xvdf /mnt/recordings ext4 defaults,nofail 0 2' >> /etc/fstab
chown ec2-user:ec2-user /mnt/recordings

# Clone repository and install Python app
echo "Setting up radio recorder application..."
mkdir -p /opt/radio-recorder/scripts
cd /opt/radio-recorder

# Clone the latest version from GitHub
git clone https://github.com/cosentinoeli/wpkn-archives.git /tmp/wpkn-archives
cp /tmp/wpkn-archives/scripts/recorder.py /opt/radio-recorder/scripts/radio_recorder.py
chmod +x /opt/radio-recorder/scripts/radio_recorder.py

# Create the Python recorder script embedded version as backup
cat > /opt/radio-recorder/recorder_embedded.py << 'PYTHON_SCRIPT_EOF'
${this.getPythonRecorderScript()}
PYTHON_SCRIPT_EOF

# Create requirements.txt
cat > requirements.txt << 'REQ_EOF'
boto3>=1.26.0
botocore>=1.29.0
python-dotenv>=0.19.0
REQ_EOF

# Install Python dependencies
pip3 install -r requirements.txt

# Set ownership
chown -R ec2-user:ec2-user /opt/radio-recorder

# Create systemd service
echo "Creating systemd service..."
cat > /etc/systemd/system/radio-recorder.service << 'SERVICE_EOF'
[Unit]
Description=Radio Stream Recorder
Documentation=https://github.com/radio-recorder
After=network.target
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ec2-user
Group=ec2-user
Environment="STREAM_URL=${streamUrl}"
Environment="S3_BUCKET=${bucketName}"
Environment="SEGMENT_MINUTES=${segmentMinutes}"
Environment="OUTPUT_DIR=/mnt/recordings"
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
ReadWritePaths=/mnt/recordings /var/log /tmp
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
SERVICE_EOF

# Set up log rotation
echo "Configuring log rotation..."
cat > /etc/logrotate.d/radio-recorder << 'LOGROTATE_EOF'
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
LOGROTATE_EOF

# Create log file
touch /var/log/radio-recorder.log
chown ec2-user:ec2-user /var/log/radio-recorder.log
chmod 644 /var/log/radio-recorder.log

# Install and configure CloudWatch agent
echo "Setting up CloudWatch agent..."
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
rpm -U ./amazon-cloudwatch-agent.rpm

# Configure CloudWatch agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CW_CONFIG_EOF'
{
    "logs": {
        "logs_collected": {
            "files": {
                "collect_list": [
                    {
                        "file_path": "/var/log/radio-recorder.log",
                        "log_group_name": "${logGroupName}",
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
                    "/mnt/recordings"
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
CW_CONFIG_EOF

# Start CloudWatch agent
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Enable and start the radio recorder service
echo "Starting radio recorder service..."
systemctl daemon-reload
systemctl enable radio-recorder.service
systemctl start radio-recorder.service

# Wait a moment and check status
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

# Create status check script
cat > /usr/local/bin/radio-recorder-status << 'STATUS_SCRIPT_EOF'
#!/bin/bash
echo "=== Radio Recorder Status ==="
echo "Service Status:"
systemctl status radio-recorder.service --no-pager

echo -e "\\nRecent Logs:"
journalctl -u radio-recorder.service --no-pager -n 10

echo -e "\\nDisk Usage:"
df -h /mnt/recordings

echo -e "\\nRecent Recordings:"
ls -la /mnt/recordings/*.mp3 2>/dev/null | tail -5 || echo "No recordings found"

echo -e "\\nFFmpeg Version:"
ffmpeg -version | head -1

echo -e "\\nAWS CLI Status:"
aws sts get-caller-identity 2>/dev/null || echo "AWS credentials not configured or accessible"
STATUS_SCRIPT_EOF

chmod +x /usr/local/bin/radio-recorder-status

echo "=== Setup Complete ==="
echo "Stream URL: ${streamUrl}"
echo "S3 Bucket: ${bucketName}"
echo "Output Directory: /mnt/recordings"
echo "Service Status: \$(systemctl is-active radio-recorder.service)"
echo ""
echo "To check status: /usr/local/bin/radio-recorder-status"
echo "To view logs: journalctl -u radio-recorder.service -f"
echo "To restart: sudo systemctl restart radio-recorder.service"
echo ""
echo "Setup completed at \$(date)"
`;
  }

  private getPythonRecorderScript(): string {
    // Return the full working recorder script
    return `#!/usr/bin/env python3
"""
EC2-based Radio Stream Recorder
Continuously records from audio stream, segments into 5-minute MP3 files,
and uploads to S3 with self-healing capabilities.
"""

import os
import sys
import time
import logging
import subprocess
import threading
import shutil
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any
import signal
import json

import boto3
from botocore.exceptions import ClientError, NoCredentialsError


# Configuration from environment variables
STREAM_URL = os.getenv('STREAM_URL', 'https://ice25.securenetsystems.net/WPKN')
S3_BUCKET = os.getenv('S3_BUCKET', 'my-radio-archive')
SEGMENT_MINUTES = int(os.getenv('SEGMENT_MINUTES', '5'))
OUTPUT_DIR = os.getenv('OUTPUT_DIR', '/tmp')
MAX_DISK_USAGE_PERCENT = int(os.getenv('MAX_DISK_USAGE_PERCENT', '80'))
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')

# Derived values
CHUNK_DURATION = SEGMENT_MINUTES * 60

# Setup logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper()),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('/var/log/radio-recorder.log')
    ]
)
logger = logging.getLogger('radio_recorder')


class RadioRecorder:
    """Main stream recorder class"""
    
    def __init__(self):
        self.s3_client = boto3.client('s3')
        self.running = True
        self.current_process: Optional[subprocess.Popen] = None
        
        # Ensure output directory exists
        Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
        
        # Verify write access
        test_file = Path(OUTPUT_DIR) / 'test_write.tmp'
        try:
            test_file.write_text('test')
            test_file.unlink()
            logger.info(f"Successfully verified write access to {OUTPUT_DIR}")
        except Exception as e:
            logger.error(f"Cannot write to {OUTPUT_DIR}: {e}")
            sys.exit(1)
        
        # Setup signal handlers
        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        logger.info(f"Received signal {signum}, shutting down gracefully...")
        self.running = False
        if self.current_process:
            self.current_process.terminate()
    
    def get_stream_url(self):
        """Get stream URL - simplified for direct streams"""
        return STREAM_URL
    
    def record_chunk(self, output_file: str, stream_url: str) -> bool:
        """Record a single chunk"""
        cmd = [
            'ffmpeg', '-y',
            '-i', stream_url,
            '-t', str(CHUNK_DURATION),
            '-c:a', 'libmp3lame', '-b:a', '128k',
            '-v', 'warning',
            output_file
        ]
        
        logger.debug(f"Executing command: {' '.join(cmd)}")
        
        try:
            self.current_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            stdout, stderr = self.current_process.communicate(timeout=CHUNK_DURATION + 60)
            
            if self.current_process.returncode == 0:
                return True
            else:
                logger.error(f"FFmpeg failed with return code {self.current_process.returncode}")
                if stderr:
                    logger.error(f"FFmpeg stderr: {stderr}")
                return False
                
        except subprocess.TimeoutExpired:
            logger.warning("FFmpeg process timed out")
            if self.current_process:
                self.current_process.terminate()
            return False
        except Exception as e:
            logger.error(f"Error running FFmpeg: {e}")
            return False
        finally:
            self.current_process = None
    
    def upload_to_s3(self, local_file: str, s3_key: str) -> bool:
        """Upload file to S3"""
        try:
            self.s3_client.upload_file(
                local_file, 
                S3_BUCKET, 
                s3_key,
                ExtraArgs={
                    'ContentType': 'audio/mpeg',
                    'ServerSideEncryption': 'AES256'
                }
            )
            logger.info(f"Successfully uploaded to s3://{S3_BUCKET}/{s3_key}")
            return True
        except Exception as e:
            logger.error(f"S3 upload failed: {e}")
            return False
    
    def cleanup_local_file(self, file_path: str):
        """Remove local file after successful upload"""
        try:
            os.remove(file_path)
            logger.info(f"Removed local file: {file_path}")
        except Exception as e:
            logger.error(f"Failed to remove local file {file_path}: {e}")
    
    def run(self):
        """Main recording loop"""
        logger.info("Radio Recorder starting")
        logger.info(f"Stream URL: {STREAM_URL}")
        logger.info(f"S3 Bucket: {S3_BUCKET}")
        logger.info(f"Segment Duration: {SEGMENT_MINUTES} minutes")
        
        recording_number = 1
        
        while self.running:
            try:
                timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d_%H-%M-%S')
                filename = f"recording_{timestamp}.mp3"
                output_file = os.path.join(OUTPUT_DIR, filename)
                
                logger.info(f"\\n--- Starting new recording #{recording_number} at {datetime.now(timezone.utc)} ---")
                logger.info(f"Output file: {output_file}")
                logger.info(f"Target S3 location: s3://{S3_BUCKET}/recordings/{filename}")
                
                # Get stream URL
                stream_url = self.get_stream_url()
                
                # Record chunk
                if self.record_chunk(output_file, stream_url):
                    logger.info(f"Recording completed successfully")
                    
                    # Upload to S3
                    s3_key = f"recordings/{filename}"
                    if self.upload_to_s3(output_file, s3_key):
                        # Verify upload
                        try:
                            self.s3_client.head_object(Bucket=S3_BUCKET, Key=s3_key)
                            logger.info(f"Verified: Object exists in S3 at s3://{S3_BUCKET}/{s3_key}")
                            self.cleanup_local_file(output_file)
                            logger.info(f"Successfully completed recording #{recording_number}")
                        except Exception as e:
                            logger.error(f"S3 verification failed: {e}")
                    else:
                        logger.warning(f"Upload failed, keeping local file: {output_file}")
                else:
                    logger.error(f"Recording failed for #{recording_number}")
                    # Clean up failed recording file
                    if os.path.exists(output_file):
                        self.cleanup_local_file(output_file)
                
                recording_number += 1
                
            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received")
                break
            except Exception as e:
                logger.error(f"Unexpected error: {e}")
                time.sleep(10)
        
        logger.info("Radio Recorder stopped")


def check_dependencies():
    """Check if required dependencies are available"""
    # Check FFmpeg
    try:
        subprocess.run(['ffmpeg', '-version'], 
                      stdout=subprocess.DEVNULL, 
                      stderr=subprocess.DEVNULL, 
                      check=True)
        logger.info("FFmpeg found")
    except (subprocess.CalledProcessError, FileNotFoundError):
        logger.error("FFmpeg not found. Please install FFmpeg.")
        return False
    
    # Check AWS credentials
    try:
        boto3.client('s3').list_buckets()
        logger.info("AWS credentials found")
    except NoCredentialsError:
        logger.error("AWS credentials not found. Please configure IAM role or credentials.")
        return False
    except Exception as e:
        logger.warning(f"AWS check failed (may be OK): {e}")
    
    return True


def main():
    """Main entry point"""
    logger.info("Radio Stream Recorder starting up...")
    
    # Log configuration
    logger.info(f"Configuration:")
    logger.info(f"  STREAM_URL: {STREAM_URL}")
    logger.info(f"  S3_BUCKET: {S3_BUCKET}")
    logger.info(f"  SEGMENT_MINUTES: {SEGMENT_MINUTES}")
    logger.info(f"  OUTPUT_DIR: {OUTPUT_DIR}")
    
    # Validate configuration
    if not STREAM_URL:
        logger.error("STREAM_URL environment variable not set")
        sys.exit(1)
    
    if not S3_BUCKET:
        logger.error("S3_BUCKET environment variable not set")
        sys.exit(1)
    
    # Check dependencies
    if not check_dependencies():
        sys.exit(1)
    
    # Create and run recorder
    recorder = RadioRecorder()
    try:
        recorder.run()
    except Exception as e:
        logger.critical(f"Fatal error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()`;
  }
}
