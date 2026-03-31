# Google Calendar Configuration

## Configured Credentials

- **Calendar ID**: `wpkn.cal@gmail.com`
- **API Key**: Configured in Lambda environment variables
- **Calendar Type**: Public calendar

## How It Works

The Schedule Manager Lambda function automatically syncs events from the WPKN Google Calendar every hour:

1. Fetches upcoming events (next 7 days) from the calendar
2. Parses show information (name, start/end times, description)
3. **Normalizes all times to UTC** (Google Calendar returns times in Eastern Time)
4. Stores/updates shows in DynamoDB ShowsTable with UTC timestamps
5. Schedules recording jobs for each show using EventBridge cron expressions (in UTC)

## Testing the Integration

After deployment, you can manually trigger the sync:

```bash
# Invoke the Schedule Manager Lambda
aws lambda invoke \
  --function-name RadioArchivesV2Stack-ScheduleManagerFunction-XXXXX \
  --payload '{}' \
  output.json

# View the output
cat output.json
```

## Monitoring

Check CloudWatch Logs for the Schedule Manager function:

```bash
aws logs tail /aws/lambda/RadioArchivesV2Stack-ScheduleManagerFunction-XXXXX --follow
```

## Configuration Details

The Lambda function uses:
- `GOOGLE_API_KEY`: For authenticating with Google Calendar API (public calendar access)
- `CALENDAR_ID`: wpkn.cal@gmail.com
- `SHOWS_TABLE`: DynamoDB table name (from CDK)
- `RECORDINGS_TABLE`: DynamoDB table name (from CDK)

## What Events Are Synced

The function will capture:
- Event summary (used as show name)
- Event description
- Start and end times (converted from calendar's timezone to UTC)
- Recurrence pattern (if applicable)
- Event ID (for deduplication)

Each unique show gets an ID generated from the show name (e.g., "Morning Show" → "morning-show").

**Timezone Handling**: Google Calendar events are in Eastern Time (WPKN's location), but all times are automatically converted to UTC (Coordinated Universal Time) with 'Z' suffix before storage. This ensures:
- Recordings are scheduled at the correct time regardless of server location
- Frontend can display times in user's local timezone
- Consistent timestamp format across all services

## Next Steps

After deployment, the sync will run automatically every hour. You can also:

1. Manually invoke to test immediately
2. Check DynamoDB ShowsTable for synced shows
3. Verify recordings are scheduled in RecordingsTable
