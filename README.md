# Radio Stream Recorder

An AWS-based solution for recording 24/7 internet radio streams, automatically splitting audio into 2-hour chunks and saving to S3.

## Features

- Continuous recording of internet radio streams
- Automatic splitting into 2-hour MP3 chunks
- Immediate upload to Amazon S3
- Automatic archival to Glacier after 30 days
- Error handling with SNS notifications
- Cost-optimized using ARM-based EC2 instances
- Self-healing systemd service

## Prerequisites

- Node.js 16 or later
- AWS CLI configured with appropriate credentials
- AWS CDK CLI installed (`npm install -g aws-cdk`)

## Deployment

1. Install dependencies:
   ```bash
   npm install
   ```

2. Bootstrap CDK in your AWS account (if not done before):
   ```bash
   cdk bootstrap
   ```

3. Deploy the stack:
   ```bash
   cdk deploy --parameters alertEmail=your.email@example.com
   ```

## Architecture

- **EC2**: ARM-based t4g.small instance running the recorder service
- **S3**: Storage for recorded audio chunks
- **SNS**: Error notifications and alerts
- **IAM**: Least-privilege security roles
- **VPC**: Isolated network environment

## Configuration

The radio stream URL can be configured in `scripts/radio_recorder.py`:
```python
STREAM_URL = "http://stream.wpkn.org:8080/listen.pls"  # Replace with your stream URL
```

## Monitoring

- Check CloudWatch Logs for the EC2 instance
- Monitor SNS notifications for any errors
- View recordings in the S3 bucket
- Check systemd service status: `systemctl status radio-recorder`

## Cost Optimization

- Uses ARM-based EC2 instances for better price/performance
- Automatic archival to Glacier after 30 days
- Minimal NAT Gateway usage (1 per VPC)

## Troubleshooting

1. Check the service status:
   ```bash
   sudo systemctl status radio-recorder
   ```

2. View service logs:
   ```bash
   sudo journalctl -u radio-recorder
   ```

3. Check S3 bucket for recordings
4. Verify SNS topic subscriptions
