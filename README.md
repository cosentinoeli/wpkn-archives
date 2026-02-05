# WPKN Radio Archives

An automated radio recording and archiving system for WPKN radio station, built with AWS serverless and container technologies.

## Architecture

### Backend Infrastructure (AWS CDK)

- **ECS Fargate** - Containerized recording tasks (ffmpeg) that run on-demand
- **Lambda Functions** - API Gateway endpoints, schedule management
- **API Gateway** - RESTful API for shows and recordings
- **DynamoDB** - Show and recording metadata storage
- **S3** - Audio file storage with intelligent tiering
- **EventBridge** - Automated scheduling based on Google Calendar
- **Secrets Manager** - Secure API key storage
- **Cognito** - Identity pool for unauthenticated S3 access

### Frontend (Winamp 5-inspired UI)

- Located in `/frontend` directory
- Pure JavaScript (no build step required)
- Dynamically loads configuration from API
- Features:
  - Audio player with waveform visualization
  - Show schedule browser with date picker
  - Show library with search
  - Recordings list per show
  - Mobile-responsive design

## Setup

### Prerequisites

```bash
npm install -g aws-cdk
npm install
```

### AWS Credentials

1. Store Google Calendar API credentials in AWS Secrets Manager:
```bash
aws secretsmanager create-secret \
  --name wpkn/google-calendar \
  --secret-string '{"apiKey":"YOUR_API_KEY","calendarId":"wpkn.cal@gmail.com"}'
```

### Deploy Infrastructure

```bash
cdk bootstrap  # First time only
cdk deploy
```

The deployment will output:
- API Gateway endpoint URL
- S3 bucket name
- Cognito Identity Pool ID
- ECS cluster ARN

### Recording System

The system automatically:
1. Syncs show schedule from Google Calendar (hourly)
2. Creates EventBridge rules for each show
3. Triggers ECS Fargate tasks at scheduled times
4. Records audio with ffmpeg to MP3 (128kbps)
5. Uploads to S3 with metadata
6. Updates DynamoDB with recording details

## Frontend Development

Run locally:
```bash
cd frontend
python -m http.server 8080
```

Visit http://localhost:8080

The frontend automatically fetches configuration from the `/v1/config` API endpoint.

## API Endpoints

- `GET /v1/shows` - List all shows
- `GET /v1/shows/{id}` - Get show details
- `GET /v1/recordings` - List all recordings
- `GET /v1/recordings/{id}` - Get recording details with signed audio URL
- `GET /v1/config` - Get frontend configuration

## Cost Optimization

- **ECS Fargate**: Pay per second only when recording ($~0.049/hour)
- **S3 Intelligent Tiering**: Automatic archival after 30 days
- **Lambda**: Minimal cost for API and scheduling
- **DynamoDB**: On-demand pricing
- **Estimated**: $8-15/month for typical schedule

## Project Structure

```
├── bin/              # CDK app entry point
├── lib/              # CDK stack definition
├── lambda/           # Lambda function code
│   ├── schedule-manager/
│   ├── config/
│   └── [API functions]
├── ecs/              # ECS task definitions
│   └── record-show/  # Recording container (Python + ffmpeg)
├── frontend/         # Winamp 5-inspired web player
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── config.js
├── scripts/          # Deployment and testing scripts
└── tests/            # Integration tests
```

## Deployment Notes

### Building and Pushing Docker Image

```bash
./scripts/build-and-push.sh
```

### Testing a Recording

```bash
./scripts/test-recording.sh "Test Show" 30
```

### Monitoring

- CloudWatch Logs: `/ecs/wpkn-recording`
- ECS Tasks: Monitor in AWS Console
- DynamoDB: Check shows and recordings tables

## Security

- No secrets in repository
- API keys stored in AWS Secrets Manager
- Lambda IAM roles with least privilege
- S3 bucket with CORS for frontend access
- Cognito identity pool for unauthenticated audio access

## License

MIT

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
