# Radio Recorder Deployment Checklist

Use this checklist to ensure smooth deployments without troubleshooting.

## Pre-Deployment

### 1. Prerequisites Check
- [ ] AWS CLI configured with appropriate credentials
- [ ] AWS CDK installed and bootstrapped
- [ ] SSH key pair created in AWS EC2 console
- [ ] Verify stream URL is accessible: `curl -I <STREAM_URL>`

### 2. Configuration Review
- [ ] Update `config/deployment.json` with correct values:
  - [ ] `streamUrl`: Verify it's accessible
  - [ ] `keyPairName`: Must exist in AWS EC2
  - [ ] `allowedSshCidr`: Restrict as needed
  - [ ] `segmentMinutes`: Usually 5 minutes
- [ ] Check CDK stack parameters in deploy command

### 3. Code Validation
- [ ] Latest `scripts/recorder.py` includes MP3 format fix (`-f mp3`)
- [ ] CDK stack includes all troubleshooting fixes
- [ ] No syntax errors in TypeScript: `npm run build`

## Deployment Process

### 1. Deploy Infrastructure
```bash
cd infrastructure
npm install
npm run build
npm run deploy
```

### 2. Verify Deployment
- [ ] CDK deployment completes successfully
- [ ] EC2 instance is running
- [ ] S3 bucket is created
- [ ] Security groups allow SSH access

### 3. Initial Validation (within 5 minutes)
```bash
# SSH into instance
ssh -i keys/YOUR_KEY.pem ec2-user@<INSTANCE_IP>

# Check deployment logs
sudo tail -f /var/log/user-data.log
# Wait for "Setup completed at..." message
```

### 4. Service Validation (within 10 minutes)
```bash
# Run comprehensive status check
sudo /usr/local/bin/radio-recorder-status

# Verify these items show ✅:
# - Service Status: active (running)
# - FFmpeg version found
# - MP3 encoding available
# - Stream URL accessible
# - S3 bucket accessible
```

### 5. Recording Validation (within 15 minutes)
```bash
# Check for active recording
ls -la /mnt/recordings/
# Should show: recording_YYYY-MM-DD_HH-MM-SS.mp3.tmp

# Monitor file growth
watch -n 10 'ls -lh /mnt/recordings/'
# File size should increase every 10 seconds
```

### 6. S3 Upload Validation (within 10 minutes after first segment)
```bash
# Wait for first 5-minute segment to complete
aws s3 ls s3://YOUR_BUCKET_NAME/recordings/
# Should show: recording_YYYY-MM-DD_HH-MM-SS.mp3
```

## Post-Deployment

### 1. Performance Monitoring
- [ ] CloudWatch metrics are being published
- [ ] Log group `/aws/ec2/radio-recorder` receiving logs
- [ ] Disk usage is reasonable (<80%)

### 2. Long-term Validation
- [ ] Multiple segments recorded and uploaded
- [ ] Service survives instance reboot
- [ ] Log rotation working properly

### 3. Documentation
- [ ] Update deployment notes with any customizations
- [ ] Record instance IP and connection details
- [ ] Note any stream-specific configurations

## Common Deployment Issues

### Issue: User Data Size Limit
**Solution**: Already fixed in current CDK stack using S3 bootstrap approach

### Issue: DNS Resolution Fails
**Solution**: CDK stack automatically applies IP address fix for `ice25.securenetsystems.net`

### Issue: MP3 Format Not Recognized
**Solution**: Recorder script includes explicit `-f mp3` flag

### Issue: Service Won't Start
**Check**: 
- [ ] Stream URL is accessible
- [ ] FFmpeg is installed with MP3 support
- [ ] AWS credentials are working
- [ ] Recordings directory is writable

### Issue: No S3 Uploads
**Check**:
- [ ] IAM role has S3 permissions
- [ ] S3 bucket exists and is accessible
- [ ] AWS region is correctly set

## Emergency Commands

If deployment fails or service doesn't work:

```bash
# Check deployment status
sudo cat /var/log/user-data.log | tail -50

# Check service logs
sudo journalctl -u radio-recorder.service -n 50

# Restart service
sudo systemctl restart radio-recorder.service

# Manual stream test
curl -I "$(sudo systemctl show radio-recorder.service -p Environment --value | grep STREAM_URL | cut -d'=' -f2)"

# Manual FFmpeg test
ffmpeg -i "$STREAM_URL" -t 10 -c:a libmp3lame -f mp3 /tmp/test.mp3 -y
```

## Success Criteria

A successful deployment should achieve:
- [ ] Service status: `active (running)`
- [ ] Recording file created within 2 minutes
- [ ] File size growing every 10 seconds
- [ ] First MP3 uploaded to S3 within 7 minutes
- [ ] No error messages in logs
- [ ] Status script shows all ✅ checks

## Rollback Plan

If deployment fails critically:
1. Stop the service: `sudo systemctl stop radio-recorder.service`
2. Destroy CDK stack: `npm run destroy`
3. Check AWS console for any remaining resources
4. Review troubleshooting guide before re-deployment

## Support Resources

- **Troubleshooting Guide**: `docs/TROUBLESHOOTING.md`
- **CDK Stack**: `infrastructure/lib/radio-recorder-stack.ts` 
- **Recorder Script**: `scripts/recorder.py`
- **Configuration**: `config/deployment.json`
