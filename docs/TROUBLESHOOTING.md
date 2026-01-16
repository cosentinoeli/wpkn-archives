# Radio Recorder Troubleshooting Guide

This document contains solutions to common issues encountered during deployment and operation of the radio recorder.

## Quick Status Check

```bash
# SSH into the instance
ssh -i keys/wpkn-radio-recorder.pem ec2-user@<INSTANCE_IP>

# Run comprehensive status check
sudo /usr/local/bin/radio-recorder-status
```

## Common Issues and Solutions

### 1. DNS Resolution Issues

**Problem**: FFmpeg cannot resolve hostname (e.g., `ice25.securenetsystems.net`)
**Error**: `Failed to resolve hostname ice25.securenetsystems.net: System error`

**Solution**: Use IP address instead of hostname
```bash
# Find the IP address
nslookup ice25.securenetsystems.net
# Result: 162.251.61.22

# Update service to use IP address
sudo systemctl stop radio-recorder.service
sudo sed -i 's|Environment="STREAM_URL=https://ice25.securenetsystems.net/WPKN"|Environment="STREAM_URL=http://162.251.61.22/WPKN"|' /etc/systemd/system/radio-recorder.service
sudo systemctl daemon-reload
sudo systemctl start radio-recorder.service
```

**CDK Fix**: The updated stack automatically detects `ice25.securenetsystems.net` and replaces it with the IP address during deployment.

### 2. MP3 Format Recognition Issues

**Problem**: FFmpeg cannot recognize MP3 format for `.tmp` files
**Error**: `Unable to choose an output format for '/path/file.mp3.tmp'`

**Solution**: Explicitly specify MP3 format in FFmpeg command
```python
# In recorder.py, add '-f', 'mp3' to FFmpeg command
def _build_ffmpeg_command(self, output_file: Path) -> list:
    return [
        'ffmpeg',
        '-y',
        '-reconnect', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '30',
        '-i', STREAM_URL,
        '-t', str(SEGMENT_MINUTES * 60),
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-f', 'mp3',  # ← This line fixes the issue
        '-metadata', f'title=Radio Recording {datetime.now(timezone.utc).isoformat()}',
        '-metadata', f'comment=Stream: {STREAM_URL}',
        '-v', 'warning',
        str(output_file)
    ]
```

### 3. AWS Region Configuration

**Problem**: S3 operations fail due to missing region configuration
**Error**: `NoCredentialsError` or region-related errors

**Solution**: Set AWS_DEFAULT_REGION environment variable
```bash
# The updated service configuration automatically sets this:
Environment="AWS_DEFAULT_REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)"
```

### 4. Service Won't Start

**Problem**: Radio recorder service fails to start

**Troubleshooting Steps**:
```bash
# Check service status
sudo systemctl status radio-recorder.service

# View detailed logs
sudo journalctl -u radio-recorder.service -n 50

# Check service configuration
sudo systemctl cat radio-recorder.service

# Verify dependencies
which python3
which ffmpeg
ls -la /opt/radio-recorder/scripts/radio_recorder.py

# Test stream connectivity
curl -I "$(sudo systemctl show radio-recorder.service -p Environment --value | grep STREAM_URL | cut -d'=' -f2)"

# Test FFmpeg manually
STREAM_URL="$(sudo systemctl show radio-recorder.service -p Environment --value | grep STREAM_URL | cut -d'=' -f2)"
ffmpeg -i "$STREAM_URL" -t 10 -c:a libmp3lame -f mp3 /tmp/test.mp3 -y
```

### 5. No Recordings Created

**Problem**: Service runs but no recording files are created

**Troubleshooting**:
```bash
# Check if recordings directory exists and is writable
ls -la /mnt/recordings/
sudo -u ec2-user touch /mnt/recordings/test.txt

# Check for active FFmpeg processes
ps aux | grep ffmpeg

# Monitor live logs
sudo journalctl -u radio-recorder.service -f

# Test manual recording
sudo -u ec2-user ffmpeg -i "$STREAM_URL" -t 30 -c:a libmp3lame -f mp3 /mnt/recordings/manual_test.mp3 -y
```

### 6. S3 Upload Failures

**Problem**: Recordings are created but not uploaded to S3

**Troubleshooting**:
```bash
# Check AWS credentials
aws sts get-caller-identity

# Test S3 access
S3_BUCKET="$(sudo systemctl show radio-recorder.service -p Environment --value | grep S3_BUCKET | cut -d'=' -f2)"
aws s3 ls "s3://$S3_BUCKET/"

# Check IAM permissions in AWS Console:
# - s3:GetObject, s3:PutObject, s3:DeleteObject on bucket
# - s3:ListBucket on bucket
# - cloudwatch:PutMetricData
```

## Deployment Improvements

The CDK stack has been updated to automatically handle these common issues:

1. **DNS Resolution Fix**: Automatically replaces `ice25.securenetsystems.net` with IP `162.251.61.22`
2. **AWS Region**: Automatically sets `AWS_DEFAULT_REGION` from instance metadata
3. **Stream Testing**: Tests stream connectivity during deployment
4. **FFmpeg Validation**: Verifies FFmpeg can record from the stream before starting service
5. **Enhanced Monitoring**: Comprehensive status script for troubleshooting

## Testing New Deployments

After deploying with the updated CDK stack:

1. **Check deployment logs**:
   ```bash
   # View user-data execution logs
   sudo cat /var/log/user-data.log
   ```

2. **Run status check**:
   ```bash
   sudo /usr/local/bin/radio-recorder-status
   ```

3. **Verify first recording**:
   ```bash
   # Should see .tmp file within 1 minute
   ls -la /mnt/recordings/
   
   # Should see completed .mp3 file within 6 minutes
   watch -n 30 'ls -la /mnt/recordings/ && echo "=== S3 ===" && aws s3 ls s3://YOUR_BUCKET/recordings/'
   ```

## Log Locations

- **Service Logs**: `sudo journalctl -u radio-recorder.service`
- **Application Logs**: `/var/log/radio-recorder.log`
- **Deployment Logs**: `/var/log/user-data.log`
- **CloudWatch Logs**: `/aws/ec2/radio-recorder` log group

## Emergency Recovery

If the service is completely broken:

```bash
# Stop the service
sudo systemctl stop radio-recorder.service

# Re-download latest script
cd /opt/radio-recorder
sudo git clone https://github.com/cosentinoeli/wpkn-archives.git /tmp/wpkn-archives-new
sudo cp /tmp/wpkn-archives-new/scripts/recorder.py scripts/radio_recorder.py
sudo chown ec2-user:ec2-user scripts/radio_recorder.py

# Apply DNS fix if needed
sudo sed -i 's|ice25.securenetsystems.net|162.251.61.22|g' /etc/systemd/system/radio-recorder.service

# Restart
sudo systemctl daemon-reload
sudo systemctl start radio-recorder.service
sudo systemctl status radio-recorder.service
```

## Contact Information

For additional support, check:
- GitHub Issues: https://github.com/cosentinoeli/wpkn-archives/issues
- CDK Stack: `infrastructure/lib/radio-recorder-stack.ts`
- Recorder Script: `scripts/recorder.py`
