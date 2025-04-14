<<<<<<< HEAD
# WPKN Radio Archives

This project consists of two main components:

1. **Radio Recording Infrastructure** (AWS CDK)
   - Automatically records WPKN radio streams
   - Stores recordings in S3
   - Sends notifications via SNS
   - Uses EC2 for recording process

2. **Web Player** (GitHub Pages)
   - Browse and play archived recordings
   - Search and sort functionality
   - Mobile-friendly interface
   - Visit the player: [https://cosentinoeli.github.io/wpkn-archives/](https://cosentinoeli.github.io/wpkn-archives/)

## Infrastructure Setup

1. Install dependencies:
   ```bash
   npm install
   pip install -r requirements.txt
   ```

2. Deploy AWS infrastructure:
   ```bash
   cdk deploy --parameters alertEmail=your.email@example.com
   ```

## Web Player Development

The web player is hosted using GitHub Pages from the `/docs` directory. To test locally:

1. Navigate to the docs directory
2. Run a local server: `python -m http.server 8000`
3. Visit `http://localhost:8000` in your browser

## Configuration

After deploying the CDK stack, update `/docs/js/config.js` with:
- Your S3 bucket name
- Cognito Identity Pool ID
- AWS region

=======
>>>>>>> e2c93d0277bea1414b8fc7850e170ae517f4fe69
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

## Testing

The project includes integration tests to verify core functionality:

- Stream URL accessibility
- FFmpeg recording capability
- S3 upload functionality
- SNS notification system

### Running Tests

1. Install test dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run the tests:
   ```bash
   pytest tests/integration/test_radio_recorder.py -v
   ```

Note: Some tests use mocked AWS services (via moto), while others require FFmpeg to be installed locally.

### Test Coverage

- `test_stream_url_accessibility`: Verifies the WPKN stream URL is accessible
- `test_ffmpeg_recording`: Tests FFmpeg's ability to record from the stream
- `test_s3_upload`: Verifies S3 upload functionality (using mocked S3)
- `test_sns_notification`: Tests the notification system (using mocked SNS)
- `test_integration_short_recording`: Full integration test of the recording process
