"""
Recording Service Lambda Function

This function is triggered by EventBridge to record a specific show.
It starts an ECS Fargate task that runs the actual recording.
"""

import os
import json
import boto3
from datetime import datetime
import logging
from typing import Dict, Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ecs_client = boto3.client('ecs')
dynamodb = boto3.resource('dynamodb')
recordings_table = dynamodb.Table(os.environ['RECORDINGS_TABLE'])
sns_client = boto3.client('sns')

# Configuration from environment variables
STREAM_URL = os.environ.get('STREAM_URL', 'http://stream.wpkn.org:8080/listen.pls')
ECS_CLUSTER = os.environ.get('ECS_CLUSTER', '')
ECS_TASK_DEFINITION = os.environ.get('ECS_TASK_DEFINITION', '')
ECS_SUBNET_IDS = os.environ.get('ECS_SUBNET_IDS', '').split(',')
BUCKET_NAME = os.environ['BUCKET_NAME']
ALERT_TOPIC_ARN = os.environ['ALERT_TOPIC_ARN']


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main handler for recording service
    
    Event format:
    {
        "showId": "show-id",
        "showName": "Show Name",
        "duration": 3600,  # seconds
        "startTime": "2026-02-04T18:00:00Z"
    }
    """
    logger.info(f'Recording service triggered: {json.dumps(event)}')
    
    try:
        show_id = event.get('showId')
        show_name = event.get('showName', 'Unknown Show')
        duration = event.get('duration', 3600)
        start_time = event.get('startTime', datetime.utcnow().isoformat() + 'Z')
        
        if not show_id:
            raise ValueError('showId is required')
        
        # Generate recording ID
        recording_id = generate_recording_id(show_id, start_time)
        
        # Create recording entry in DynamoDB
        recording_data = {
            'recordingId': recording_id,
            'showId': show_id,
            'showName': show_name,
            'recordingDate': start_time.split('T')[0],
            'startTime': start_time,
            'duration': duration,
            'status': 'scheduled',
            'dateKey': start_time.split('T')[0],  # For GSI
            'createdAt': datetime.utcnow().isoformat() + 'Z'
        }
        
        recordings_table.put_item(Item=recording_data)
        logger.info(f'Created recording entry: {recording_id}')
        
        # Start ECS Fargate task to perform the recording
        if ECS_CLUSTER and ECS_TASK_DEFINITION:
            task_response = start_recording_task(
                recording_id, show_id, show_name, duration
            )
            logger.info(f'Started ECS task: {task_response}')
        else:
            logger.warning('ECS not configured, recording task not started')
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'recordingId': recording_id,
                'status': 'started'
            })
        }
        
    except Exception as e:
        logger.error(f'Error in recording service: {str(e)}')
        
        # Send alert
        try:
            sns_client.publish(
                TopicArn=ALERT_TOPIC_ARN,
                Subject='Recording Service Error',
                Message=f'Failed to start recording: {str(e)}\nEvent: {json.dumps(event)}'
            )
        except Exception as sns_error:
            logger.error(f'Failed to send SNS alert: {str(sns_error)}')
        
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e)
            })
        }


def start_recording_task(
    recording_id: str,
    show_id: str,
    show_name: str,
    duration: int
) -> Dict[str, Any]:
    """
    Start ECS Fargate task to record audio
    
    Args:
        recording_id: Unique recording identifier
        show_id: Show identifier
        show_name: Show name
        duration: Recording duration in seconds
        
    Returns:
        ECS task response
    """
    try:
        response = ecs_client.run_task(
            cluster=ECS_CLUSTER,
            taskDefinition=ECS_TASK_DEFINITION,
            launchType='FARGATE',
            networkConfiguration={
                'awsvpcConfiguration': {
                    'subnets': ECS_SUBNET_IDS,
                    'assignPublicIp': 'ENABLED'
                }
            },
            overrides={
                'containerOverrides': [
                    {
                        'name': 'recorder',
                        'environment': [
                            {'name': 'RECORDING_ID', 'value': recording_id},
                            {'name': 'SHOW_ID', 'value': show_id},
                            {'name': 'SHOW_NAME', 'value': show_name},
                            {'name': 'DURATION', 'value': str(duration)},
                            {'name': 'STREAM_URL', 'value': STREAM_URL},
                            {'name': 'BUCKET_NAME', 'value': BUCKET_NAME},
                        ]
                    }
                ]
            }
        )
        
        return response
        
    except Exception as e:
        logger.error(f'Error starting ECS task: {str(e)}')
        raise


def generate_recording_id(show_id: str, start_time: str) -> str:
    """
    Generate unique recording ID
    
    Args:
        show_id: Show identifier
        start_time: Start time (ISO format)
        
    Returns:
        Unique recording ID
    """
    timestamp = start_time.replace(':', '').replace('-', '').replace('T', '-').replace('Z', '')
    return f"{show_id}-{timestamp}"
