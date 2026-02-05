import os
import json
import boto3
from datetime import datetime, timedelta
from typing import Dict, Any, List
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
dynamodb_client = boto3.client('dynamodb')
secretsmanager_client = boto3.client('secretsmanager')
shows_table = dynamodb.Table(os.environ['SHOWS_TABLE'])
shows_table_name = os.environ['SHOWS_TABLE']
recordings_table = dynamodb.Table(os.environ['RECORDINGS_TABLE'])

# Cache for Google Calendar credentials
_google_calendar_credentials = None

def get_google_calendar_credentials():
    """
    Fetch Google Calendar credentials from AWS Secrets Manager.
    Uses caching to avoid repeated calls within the same Lambda execution.
    
    Returns:
        dict: Credentials with 'apiKey' and 'calendarId'
    """
    global _google_calendar_credentials
    
    if _google_calendar_credentials is not None:
        return _google_calendar_credentials
    
    secret_arn = os.environ.get('GOOGLE_CALENDAR_SECRET_ARN')
    if not secret_arn:
        logger.error('GOOGLE_CALENDAR_SECRET_ARN not configured')
        return None
    
    try:
        response = secretsmanager_client.get_secret_value(SecretId=secret_arn)
        _google_calendar_credentials = json.loads(response['SecretString'])
        logger.info('Successfully fetched Google Calendar credentials from Secrets Manager')
        return _google_calendar_credentials
    except Exception as e:
        logger.error(f'Failed to fetch Google Calendar credentials: {str(e)}')
        return None

def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Schedule Manager Lambda Function
    
    This function syncs show schedules from Google Calendar to DynamoDB
    and schedules recording jobs.
    
    Triggered by: EventBridge (hourly)
    """
    logger.info('Schedule Manager Lambda invoked')
    
    try:
        # Get Google Calendar credentials from Secrets Manager
        credentials = get_google_calendar_credentials()
        
        if not credentials:
            logger.warning('No Google Calendar credentials configured')
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'No calendar credentials configured',
                    'synced': 0
                })
            }
        
        calendar_id = credentials.get('calendarId', '')
        if not calendar_id:
            logger.warning('No Google Calendar ID in credentials')
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'No calendar ID configured',
                    'synced': 0
                })
            }
        
        # Sync calendar events
        synced_count = sync_calendar_events(credentials)
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Calendar sync completed',
                'synced': synced_count
            })
        }
        
    except Exception as e:
        logger.error(f'Error syncing calendar: {str(e)}')
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': 'Failed to sync calendar',
                'details': str(e)
            })
        }


def sync_calendar_events(credentials: dict) -> int:
    """
    Sync events from Google Calendar
    
    Args:
        credentials: Dictionary with 'apiKey' and 'calendarId'
        
    Returns:
        Number of events synced
    """
    calendar_id = credentials.get('calendarId', '')
    api_key = credentials.get('apiKey', '')
    
    logger.info(f'Syncing calendar: {calendar_id}')
    
    try:
        # Import here to avoid issues if module not available
        from google_calendar import GoogleCalendarClient
        
        if not api_key:
            logger.warning('No Google Calendar API key in credentials')
            return 0
        
        # Initialize client with REST API
        client = GoogleCalendarClient(
            calendar_id=calendar_id,
            api_key=api_key
        )
        
        # Fetch upcoming events (next 7 days)
        events = client.fetch_upcoming_events(days_ahead=7)
        
        synced_count = 0
        for event in events:
            # Parse event to show format
            show_data = client.parse_event_to_show(event)
            
            # Store in DynamoDB
            create_show_in_dynamodb(show_data)
            
            # Schedule recording job
            schedule_recording_job(
                show_data['showId'],
                show_data['startTime'],
                show_data['endTime']
            )
            
            synced_count += 1
        
        logger.info(f'Successfully synced {synced_count} events')
        return synced_count
        
    except Exception as e:
        logger.error(f'Error syncing calendar: {str(e)}', exc_info=True)
        raise


def create_show_in_dynamodb(show_data: Dict[str, Any]) -> None:
    """
    Create or update a show in DynamoDB
    
    Args:
        show_data: Show information from calendar event
    """
    try:
        shows_table.put_item(Item=show_data)
        logger.info(f'Stored show: {show_data.get("showName")}')
    except Exception as e:
        logger.error(f'Error storing show: {str(e)}')
        raise


def schedule_recording_job(show_id: str, start_time: str, end_time: str) -> None:
    """
    Create EventBridge rule to trigger ECS recording task at show time
    
    Args:
        show_id: Unique show identifier
        start_time: Show start time (ISO format)
        end_time: Show end time (ISO format)
    """
    try:
        from datetime import datetime, timedelta
        
        # Get ECS configuration from environment
        cluster_arn = os.environ.get('CLUSTER_ARN')
        task_definition_arn = os.environ.get('TASK_DEFINITION_ARN')
        subnet_ids = os.environ.get('SUBNET_IDS', '').split(',')
        
        if not cluster_arn or not task_definition_arn:
            logger.warning('ECS configuration not set, skipping scheduling')
            return
        
        # Parse times and calculate duration
        start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
        duration = int((end_dt - start_dt).total_seconds())
        
        # Convert to UTC for scheduling
        start_utc = start_dt.astimezone(datetime.now().astimezone().tzinfo).astimezone(None)
        if start_dt.tzinfo:
            # If timezone-aware, convert to UTC
            from datetime import timezone
            start_utc = start_dt.astimezone(timezone.utc)
        else:
            # If naive, assume UTC
            start_utc = start_dt
        
        # Only schedule if in the future
        from datetime import timezone
        now = datetime.now(timezone.utc)
        if start_utc <= now:
            logger.info(f'Show {show_id} already started or in past (start: {start_utc}, now: {now}), skipping scheduling')
            return
        
        # Create EventBridge rule to trigger at show start time
        events_client = boto3.client('events')
        
        # Rule name (sanitized) - use UTC time
        rule_name = f'record-{show_id}-{start_utc.strftime("%Y%m%d-%H%M")}'[:64]
        
        # Schedule expression (one-time event) - MUST be in UTC
        schedule_expression = f"cron({start_utc.minute} {start_utc.hour} {start_utc.day} {start_utc.month} ? {start_utc.year})"
        
        # Create rule
        events_client.put_rule(
            Name=rule_name,
            ScheduleExpression=schedule_expression,
            State='ENABLED',
            Description=f'Record show: {show_id}'
        )
        
        # Get show name from DynamoDB
        try:
            show_response = dynamodb_client.get_item(
                TableName=shows_table_name,
                Key={'showId': {'S': show_id}}
            )
            show_name = show_response.get('Item', {}).get('showName', {}).get('S', 'Unknown Show')
        except:
            show_name = 'Unknown Show'
        
        # Get AWS region and account
        region = os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')
        account_id = os.environ.get('ACCOUNT_ID', '')
        
        # Get task execution role ARN from task definition
        ecs_client = boto3.client('ecs')
        task_def = ecs_client.describe_task_definition(taskDefinition=task_definition_arn)
        execution_role_arn = task_def['taskDefinition']['executionRoleArn']
        task_role_arn = task_def['taskDefinition']['taskRoleArn']
        
        # Add ECS task as target
        events_client.put_targets(
            Rule=rule_name,
            Targets=[
                {
                    'Id': '1',
                    'Arn': cluster_arn,
                    'RoleArn': execution_role_arn,
                    'EcsParameters': {
                        'TaskDefinitionArn': task_definition_arn,
                        'TaskCount': 1,
                        'LaunchType': 'FARGATE',
                        'NetworkConfiguration': {
                            'awsvpcConfiguration': {
                                'Subnets': subnet_ids,
                                'AssignPublicIp': 'ENABLED'
                            }
                        }
                    },
                    'Input': json.dumps({
                        'containerOverrides': [
                            {
                                'name': 'RecordingContainer',
                                'environment': [
                                    {'name': 'SHOW_ID', 'value': show_id},
                                    {'name': 'SHOW_NAME', 'value': show_name},
                                    {'name': 'DURATION', 'value': str(duration)},
                                    {'name': 'START_TIME', 'value': start_time}
                                ]
                            }
                        ]
                    })
                }
            ]
        )
        
        logger.info(f'Scheduled ECS recording: {rule_name} at {start_time} (duration: {duration}s)')
        
    except Exception as e:
        logger.error(f'Error scheduling recording: {str(e)}', exc_info=True)
        # Don't raise - continue with other shows
