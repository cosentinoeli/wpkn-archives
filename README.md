# Radio Recorder AWS CDK Stack

This AWS CDK (TypeScript) stack deploys a comprehensive radio stream recording solution on EC2 with automatic S3 upload capabilities.

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Radio Stream   │───▶│   EC2 Instance   │───▶│   S3 Bucket     │
│                 │    │                  │    │                 │
│ HTTP/HTTPS      │    │ ┌──────────────┐ │    │ ┌─────────────┐ │
│ Audio Stream    │    │ │   FFmpeg     │ │    │ │ 5-min MP3   │ │
└─────────────────┘    │ │   Recorder   │ │    │ │ Files       │ │
                       │ └──────────────┘ │    │ └─────────────┘ │
                       │ ┌──────────────┐ │    └─────────────────┘
                       │ │  Python      │ │              │
                       │ │  Controller  │ │              │
                       │ └──────────────┘ │              ▼
                       │ ┌──────────────┐ │    ┌─────────────────┐
                       │ │  Systemd     │ │───▶│   CloudWatch    │
                       │ │  Service     │ │    │   Logs/Metrics  │
                       │ └──────────────┘ │    └─────────────────┘
                       └──────────────────┘
```

## Features

- **Continuous Recording**: 24/7 audio stream recording
- **Automatic Segmentation**: 5-minute MP3 files with UTC timestamps
- **S3 Upload**: Automatic upload with metadata and encryption
- **Self-Healing**: Auto-reconnect with exponential backoff
- **Monitoring**: CloudWatch logs and custom metrics
- **Security**: IAM roles, security groups, encrypted storage
- **Scalability**: Easy configuration and deployment

## Prerequisites

### Required Software

- **Node.js** 18.x or later
- **npm** (comes with Node.js)
- **AWS CLI** v2
- **AWS CDK CLI** (will be installed automatically if missing)

### AWS Requirements

- AWS account with appropriate permissions
- AWS CLI configured with credentials
- EC2 Key Pair for SSH access

### Installation

```bash
# Install Node.js (if not installed)
# Visit https://nodejs.org/ for installation instructions

# Install AWS CLI v2
# Visit https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

# Configure AWS credentials
aws configure

# Install AWS CDK CLI (optional - script will install if missing)
npm install -g aws-cdk
```

## Quick Start

### 1. Clone and Setup

```bash
git clone <repository-url>
cd wpkn-archives
npm install
```

### 2. Configure Environment

```bash
# Required parameters
export KEY_PAIR_NAME="your-ec2-keypair"

# Optional parameters (with defaults shown)
export STREAM_URL="https://ice25.securenetsystems.net/WPKN"  # Default: WPKN Radio
export S3_BUCKET_NAME="my-radio-recordings"                  # Auto-generated if not set
export INSTANCE_TYPE="t4g.small"                             # Default: t4g.small (ARM)
export ALLOWED_SSH_CIDR="10.0.0.0/8"                       # Default: 0.0.0.0/0
export SEGMENT_MINUTES="5"                                   # Default: 5
export AWS_REGION="us-east-1"                               # Default: us-east-1
```

### 3. Deploy

```bash
# Make deploy script executable
chmod +x deploy.sh

# Deploy with default WPKN stream (only KEY_PAIR_NAME required)
export KEY_PAIR_NAME="your-ec2-keypair"
./deploy.sh

# Deploy with custom stream
export STREAM_URL="http://custom-stream.com/live"
export KEY_PAIR_NAME="your-ec2-keypair"
./deploy.sh
```

### 4. Alternative CDK Commands

```bash
# Build the project
npm run build

# Deploy with CDK directly
cdk deploy -c streamUrl="http://stream.example.com/live" -c keyPairName="my-keypair"

# View what will be deployed
cdk synth

# Compare with deployed version
cdk diff
```

## Configuration Options

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KEY_PAIR_NAME` | ✅ | - | Name of existing EC2 key pair |
| `STREAM_URL` | ❌ | `https://ice25.securenetsystems.net/WPKN` | HTTP/HTTPS URL of the radio stream |
| `S3_BUCKET_NAME` | ❌ | Auto-generated | S3 bucket name for recordings |
| `INSTANCE_TYPE` | ❌ | `t4g.small` | EC2 instance type (ARM-based) |
| `ALLOWED_SSH_CIDR` | ❌ | `0.0.0.0/0` | CIDR block for SSH access |
| `SEGMENT_MINUTES` | ❌ | `5` | Recording segment duration |
| `AWS_REGION` | ❌ | `us-east-1` | AWS deployment region |

### CDK Context Parameters

You can also pass parameters via CDK context:

```bash
cdk deploy \
  -c keyPairName="my-keypair" \
  -c streamUrl="http://custom-stream.example.com/live" \
  -c s3BucketName="my-recordings" \
  -c instanceType="t4g.medium" \
  -c allowedSshCidr="10.0.0.0/8" \
  -c segmentMinutes="30"
```

## Infrastructure Components

### EC2 Instance

- **AMI**: Latest Amazon Linux 2023 (ARM64)
- **Instance Type**: Configurable (default: t4g.small)
- **Architecture**: ARM64 (Graviton2 processors)
- **Storage**: 100GB encrypted EBS volume
- **Security**: Hardened systemd service with minimal privileges
- **Monitoring**: CloudWatch agent for logs and metrics
- **FFmpeg**: ARM64-compatible static build with MP3 encoding support

### S3 Bucket

- **Encryption**: S3-managed encryption (AES-256)
- **Versioning**: Enabled
- **Lifecycle**: 365-day retention, 30-day non-current version cleanup
- **Access**: Private with IAM role-based access
- **Structure**: `recordings/recording_YYYY-MM-DD_HH-MM-SS.mp3`

### IAM Role

- **S3 Permissions**: Read/write access to recordings bucket
- **CloudWatch Permissions**: Logs and custom metrics
- **EC2 Permissions**: CloudWatch agent operations

### Security Group

- **Inbound**: SSH (port 22) from specified CIDR
- **Outbound**: All traffic (for stream access and S3 uploads)

### CloudWatch

- **Log Group**: `/aws/ec2/radio-recorder`
- **Metrics**: Custom metrics for recording health
- **Retention**: 30 days

## Post-Deployment

### 1. Instance Initialization

The EC2 instance takes 5-10 minutes to fully initialize:

- System package updates
- FFmpeg installation (ARM64 static build with MP3 support)
- Python application setup
- Service configuration and startup

### 2. Verification Steps

```bash
# Get instance IP from CDK outputs
INSTANCE_IP=$(aws cloudformation describe-stacks --stack-name RadioRecorderStack --query 'Stacks[0].Outputs[?OutputKey==`InstancePublicIP`].OutputValue' --output text)

# SSH to the instance
ssh -i your-keypair.pem ec2-user@$INSTANCE_IP

# Check service status
sudo systemctl status radio-recorder.service

# View logs
sudo journalctl -u radio-recorder.service -f

# Run health check
/usr/local/bin/radio-recorder-status

# Check recordings directory
ls -la /mnt/recordings/

# Verify FFmpeg MP3 encoding
ffmpeg -f lavfi -i "sine=frequency=1000:duration=1" -c:a libmp3lame -f mp3 /dev/null -y
```

### 3. Monitoring

```bash
# View CloudWatch logs
aws logs tail /aws/ec2/radio-recorder --follow

# Check S3 uploads
aws s3 ls s3://your-bucket-name/recordings/

# View CloudWatch metrics
aws cloudwatch get-metric-statistics \
  --namespace RadioRecorder \
  --metric-name SegmentDuration \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 \
  --statistics Average
```

## Management Commands

### Service Management

```bash
# Start/stop/restart service
sudo systemctl start radio-recorder.service
sudo systemctl stop radio-recorder.service
sudo systemctl restart radio-recorder.service

# Enable/disable auto-start
sudo systemctl enable radio-recorder.service
sudo systemctl disable radio-recorder.service

# Check service status
sudo systemctl status radio-recorder.service
```

### File Management

```bash
# List recordings
ls -la /mnt/recordings/

# Check disk usage
df -h /mnt/recordings

# Manual cleanup (files older than 7 days)
find /mnt/recordings -name "*.mp3" -mtime +7 -delete
```

### Configuration Updates

```bash
# Edit service configuration
sudo systemctl edit radio-recorder.service

# Reload and restart after changes
sudo systemctl daemon-reload
sudo systemctl restart radio-recorder.service
```

## Scaling and Customization

### Instance Types

Choose based on stream quality and processing requirements:

- **t4g.nano**: Testing and very low-bitrate streams (ARM)
- **t4g.micro**: Light testing and low-bitrate streams (ARM)
- **t4g.small**: Standard deployment - recommended (ARM)
- **t4g.medium**: High-bitrate streams or multiple streams (ARM)
- **c6g.large**: CPU-intensive processing or transcoding (ARM)
- **t3.small**: Alternative x86 option if ARM compatibility issues

### Storage

Adjust EBS volume size based on retention requirements:

```typescript
// In lib/radio-recorder-stack.ts
const recordingsVolume = new ec2.Volume(this, 'RecordingsVolume', {
  size: cdk.Size.gibibytes(500), // Increase as needed
  volumeType: ec2.EbsDeviceVolumeType.GP3,
});
```

### Multiple Streams

Deploy multiple stacks for different streams:

```bash
# Deploy for different streams
STREAM_URL="http://stream1.com/live" STACK_NAME="RadioRecorder1" ./deploy.sh
STREAM_URL="http://stream2.com/live" STACK_NAME="RadioRecorder2" ./deploy.sh
```

## Troubleshooting

### Common Issues

1. **Deployment Fails**
   ```bash
   # Check AWS credentials
   aws sts get-caller-identity
   
   # Verify key pair exists
   aws ec2 describe-key-pairs --key-names your-keypair
   
   # Check CDK bootstrap
   aws cloudformation describe-stacks --stack-name CDKToolkit
   ```

2. **Service Won't Start**
   ```bash
   # Check service logs
   sudo journalctl -u radio-recorder.service --no-pager
   
   # Verify FFmpeg installation
   ffmpeg -version
   
   # Test stream connectivity
   curl -I "$STREAM_URL"
   ```

3. **No S3 Uploads**
   ```bash
   # Check IAM permissions
   aws sts get-caller-identity
   
   # Test S3 access
   aws s3 ls s3://your-bucket-name/
   
   # Check local files
   ls -la /mnt/recordings/
   ```

### Log Analysis

```bash
# Error patterns
sudo journalctl -u radio-recorder.service | grep -i error

# Upload activity
sudo journalctl -u radio-recorder.service | grep "Successfully uploaded"

# Reconnection events
sudo journalctl -u radio-recorder.service | grep "reconnect"
```

## Cost Optimization

### Estimated Monthly Costs (us-east-1)

- **t4g.small EC2**: ~$13/month (ARM-based, more cost-effective)
- **100GB EBS GP3**: ~$8/month
- **S3 Standard**: ~$0.023/GB stored
- **CloudWatch Logs**: ~$0.50/GB ingested
- **Data Transfer**: Variable based on stream bitrate

> **Note**: ARM-based t4g instances provide up to 40% better price performance compared to equivalent t3 instances.

### Cost Reduction Tips

1. **Use Spot Instances** (for non-critical recording)
2. **Implement S3 Intelligent Tiering**
3. **Adjust log retention periods**
4. **Use reserved instances for long-term deployment**

## Security Best Practices

1. **Restrict SSH Access**: Use specific IP ranges instead of 0.0.0.0/0
2. **Regular Updates**: Keep the system updated
3. **Monitor Access**: Enable CloudTrail for API logging
4. **Backup Keys**: Securely store EC2 key pairs
5. **IAM Policies**: Use least-privilege access

## Support

For issues and support:

1. Check the troubleshooting section
2. Review service logs: `sudo journalctl -u radio-recorder.service`
3. Run health check: `/usr/local/bin/radio-recorder-status`
4. Open an issue with:
   - CDK version
   - Deployment logs
   - Service status
   - Error messages
