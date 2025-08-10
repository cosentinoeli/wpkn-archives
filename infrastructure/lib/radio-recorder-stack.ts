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

# Apply DNS resolution fix for WPKN stream
echo "Applying stream URL DNS resolution fix..."
STREAM_URL_FIXED="\${streamUrl}"

# Check if stream URL contains ice25.securenetsystems.net and replace with IP
if echo "\$STREAM_URL_FIXED" | grep -q "ice25.securenetsystems.net"; then
    echo "Detected ice25.securenetsystems.net hostname, applying IP address fix..."
    STREAM_URL_FIXED=\$(echo "\$STREAM_URL_FIXED" | sed 's/ice25.securenetsystems.net/162.251.61.22/g')
    echo "Stream URL updated to: \$STREAM_URL_FIXED"
fi

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
Environment="STREAM_URL=\$STREAM_URL_FIXED"
Environment="S3_BUCKET=${bucketName}"
Environment="SEGMENT_MINUTES=${segmentMinutes}"
Environment="OUTPUT_DIR=/mnt/recordings"
Environment="MAX_DISK_USAGE_PERCENT=80"
Environment="LOG_LEVEL=INFO"
Environment="AWS_DEFAULT_REGION=\$(curl -s http://169.254.169.254/latest/meta-data/placement/region)"
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

# Test stream connectivity before starting service
echo "Testing stream connectivity..."
if timeout 10 curl -I "\$STREAM_URL_FIXED" >/dev/null 2>&1; then
    echo "✅ Stream URL is accessible: \$STREAM_URL_FIXED"
else
    echo "⚠️  Warning: Stream URL may not be accessible: \$STREAM_URL_FIXED"
fi

# Test FFmpeg with the actual stream URL
echo "Testing FFmpeg with stream URL..."
if timeout 15 ffmpeg -i "\$STREAM_URL_FIXED" -t 5 -c:a libmp3lame -f mp3 /tmp/test_recording.mp3 -y >/dev/null 2>&1; then
    echo "✅ FFmpeg can successfully record from stream"
    rm -f /tmp/test_recording.mp3
else
    echo "⚠️  Warning: FFmpeg test recording failed"
fi

systemctl start radio-recorder.service

# Wait a moment and check status
sleep 5
if systemctl is-active --quiet radio-recorder.service; then
    echo "✅ Radio recorder service started successfully"
    systemctl status radio-recorder.service --no-pager
    
    # Check if recording starts within 30 seconds
    echo "Waiting for first recording to start..."
    for i in {1..6}; do
        if ls /mnt/recordings/*.tmp >/dev/null 2>&1; then
            echo "✅ Recording has started successfully"
            ls -la /mnt/recordings/
            break
        fi
        sleep 5
    done
    
    if ! ls /mnt/recordings/*.tmp >/dev/null 2>&1; then
        echo "⚠️  Warning: No recording files detected after 30 seconds"
        echo "Recent service logs:"
        journalctl -u radio-recorder.service --no-pager -n 10
    fi
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

echo -e "\\nService Environment Variables:"
systemctl show radio-recorder.service -p Environment --no-pager

echo -e "\\nRecent Logs:"
journalctl -u radio-recorder.service --no-pager -n 15

echo -e "\\nDisk Usage:"
df -h /mnt/recordings

echo -e "\\nCurrent Recording Files:"
ls -la /mnt/recordings/ 2>/dev/null || echo "No files in recordings directory"

echo -e "\\nActive Processes:"
ps aux | grep -E "(ffmpeg|python.*radio)" | grep -v grep || echo "No recording processes found"

echo -e "\\nFFmpeg Version and Capabilities:"
ffmpeg -version | head -1
echo "MP3 encoding available: \$(ffmpeg -codecs 2>/dev/null | grep -q libmp3lame && echo '✅ Yes' || echo '❌ No')"

echo -e "\\nNetwork Connectivity:"
STREAM_URL=\$(systemctl show radio-recorder.service -p Environment --value | grep STREAM_URL | cut -d'=' -f2)
if [ -n "\$STREAM_URL" ]; then
    echo "Testing stream URL: \$STREAM_URL"
    if timeout 10 curl -I "\$STREAM_URL" >/dev/null 2>&1; then
        echo "✅ Stream URL is accessible"
    else
        echo "❌ Stream URL is not accessible"
    fi
else
    echo "⚠️  STREAM_URL not found in service environment"
fi

echo -e "\\nAWS Configuration:"
echo "Region: \$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo 'Unknown')"
echo "Instance ID: \$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo 'Unknown')"
aws sts get-caller-identity 2>/dev/null || echo "AWS credentials not accessible"

echo -e "\\nS3 Bucket Test:"
S3_BUCKET=\$(systemctl show radio-recorder.service -p Environment --value | grep S3_BUCKET | cut -d'=' -f2)
if [ -n "\$S3_BUCKET" ]; then
    echo "Testing S3 bucket: \$S3_BUCKET"
    if aws s3 ls "s3://\$S3_BUCKET/recordings/" >/dev/null 2>&1; then
        echo "✅ S3 bucket is accessible"
        echo "Recent uploads:"
        aws s3 ls "s3://\$S3_BUCKET/recordings/" --recursive | tail -5 || echo "No uploads found"
    else
        echo "❌ S3 bucket is not accessible or empty"
    fi
else
    echo "⚠️  S3_BUCKET not found in service environment"
fi

echo -e "\\n=== Troubleshooting Commands ==="
echo "View live logs: sudo journalctl -u radio-recorder.service -f"
echo "Restart service: sudo systemctl restart radio-recorder.service"
echo "Check service config: sudo systemctl cat radio-recorder.service"
echo "Test stream manually: ffmpeg -i \\\$STREAM_URL -t 10 -c:a libmp3lame /tmp/test.mp3 -y"
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
}
