"""
Record Show Lambda Function

Records audio from radio stream and uploads to S3.
Triggered by EventBridge scheduled events.
"""

import os
import json
import boto3
import subprocess
from datetime import datetime
import logging
from typing import Dict, Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
sns_client = boto3.client('sns')

# Environment variables
STREAM_URL = os.environ.get('STREAM_URL', 'http://stream.wpkn.org:8000/live')
BUCKET_NAME = os.environ['BUCKET_NAME']
RECORDINGS_TABLE = os.environ['RECORDINGS_TABLE']
ALERT_TOPIC_ARN = os.environ.get('ALERT_TOPIC_ARN', '')


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main handler for recording
    
    Event format:
    {
        "showId": "show-id",
        "showName": "Show Name",
        "duration": 3600,  # seconds (max 900 for Lambda)
        "startTime": "2026-02-04T18:00:00Z"
    }
    """
    logger.info(f'Recording triggered: {json.dumps(event)}')
    
    try:
        show_id = event.get('showId')
        show_name = event.get('showName', 'Unknown Show')
        duration = min(int(event.get('duration', 3600)), 840)  # Max 14 min for Lambda
        start_time = event.get('startTime', datetime.utcnow().isoformat() + 'Z')
        recording_date = start_time.split('T')[0]
        
        if not show_id:
            raise ValueError('showId is required')
        
        # Generate recording ID
        recording_id = generate_recording_id(show_id, start_time)
        
        # Create recording entry in DynamoDB
        recordings_table = dynamodb.Table(RECORDINGS_TABLE)
        recording_data = {
            'recordingId': recording_id,
            'recordingDate': recording_date,
            'showId': show_id,
            'showName': show_name,
            'startTime': start_time,
            'duration': duration,
            'status': 'recording',
            'createdAt': datetime.utcnow().isoformat() + 'Z',
            'lastUpdated': datetime.utcnow().isoformat() + 'Z'
        }
        
        recordings_table.put_item(Item=recording_data)
        logger.info(f'Created recording entry: {recording_id}')
        
        # Record audio
        output_file = f'/tmp/{recording_id}.mp3'
        record_audio(STREAM_URL, output_file, duration)
        
        # Upload to S3
        s3_key = f'recordings/{show_id}/{recording_id}.mp3'
        file_size = upload_to_s3(output_file, s3_key, show_id, show_name)
        
        # Update recording as completed
        update_recording_complete(
            recordings_table,
            recording_id,
            recording_date,
            s3_key,
            file_size
        )
        
        logger.info(f'Recording completed: {recording_id}')
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'recordingId': recording_id,
                'status': 'completed',
                's3Key': s3_key
            })
        }
        
    except Exception as e:
        logger.error(f'Recording failed: {str(e)}', exc_info=True)
        
        # Update status to failed
        try:
            if 'recordings_table' in locals() and 'recording_id' in locals():
                update_recording_status(
                    recordings_table,
                    recording_id,
                    recording_date,
                    'failed',
                    str(e)
                )
        except Exception as update_error:
            logger.error(f'Failed to update status: {str(update_error)}')
        
        # Send alert
        if ALERT_TOPIC_ARN:
            try:
                sns_client.publish(
                    TopicArn=ALERT_TOPIC_ARN,
                    Subject=f'Recording Failed: {show_name}',
                    Message=f'Failed to record {show_name}\nError: {str(e)}\nRecording ID: {recording_id}'
                )
            except Exception as sns_error:
                logger.error(f'Failed to send alert: {str(sns_error)}')
        
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }


def record_audio(stream_url: str, output_file: str, duration: int):
    """
    Record audio using ffmpeg
    
    Args:
        stream_url: Radio stream URL
        output_file: Output file path
        duration: Duration in seconds
    """
    logger.info(f'Recording {duration} seconds from {stream_url}')
    
    # Lambda layers extract to /opt
    # Check common paths for ffmpeg
    ffmpeg_paths = ['/opt/bin/ffmpeg', '/opt/ffmpeg/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']
    ffmpeg_path = 'ffmpeg' # default
    
    for path in ffmpeg_paths:
        if os.path.exists(path):
            ffmpeg_path = path
            logger.info(f'Found ffmpeg at: {ffmpeg_path}')
            break
        else:
            logger.debug(f'FFmpeg not found at: {path}')
    
    cmd = [
        ffmpeg_path,
        '-i', stream_url,
        '-t', str(duration),
        '-acodec', 'libmp3lame',
        '-b:a', '128k',
        '-y',  # Overwrite output file
        output_file
    ]
    
    logger.info(f'FFmpeg command: {" ".join(cmd)}')
    
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=duration + 60,  # Add buffer
            check=True
        )
        logger.info(f'Recording completed: {output_file}')
        
        # Check file was created
        if not os.path.exists(output_file):
            raise Exception('Recording file not created')
            
        file_size = os.path.getsize(output_file)
        logger.info(f'Recording size: {file_size} bytes')
        
    except subprocess.TimeoutExpired:
        logger.error('FFmpeg timeout')
        raise Exception('Recording timed out')
    except subprocess.CalledProcessError as e:
        logger.error(f'FFmpeg error: {e.stderr.decode()}')
        raise Exception(f'FFmpeg failed: {e.stderr.decode()[:200]}')


def upload_to_s3(
    local_file: str,
    s3_key: str,
    show_id: str,
    show_name: str
) -> int:
    """
    Upload file to S3
    
    Returns:
        File size in bytes
    """
    logger.info(f'Uploading to S3: s3://{BUCKET_NAME}/{s3_key}')
    
    file_size = os.path.getsize(local_file)
    
    try:
        s3_client.upload_file(
            local_file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={
                'ContentType': 'audio/mpeg',
                'Metadata': {
                    'show-id': show_id,
                    'show-name': show_name
                }
            }
        )
        logger.info(f'Upload completed: {file_size} bytes')
        return file_size
    except Exception as e:
        logger.error(f'S3 upload error: {str(e)}')
        raise


def update_recording_status(
    table,
    recording_id: str,
    recording_date: str,
    status: str,
    error_message: str = None
):
    """Update recording status in DynamoDB"""
    try:
        update_expr = 'SET #status = :status, lastUpdated = :updated'
        expr_values = {
            ':status': status,
            ':updated': datetime.utcnow().isoformat() + 'Z'
        }
        
        if error_message:
            update_expr += ', errorMessage = :error'
            expr_values[':error'] = error_message
        
        table.update_item(
            Key={
                'recordingId': recording_id,
                'recordingDate': recording_date
            },
            UpdateExpression=update_expr,
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues=expr_values
        )
        logger.info(f'Updated recording status: {status}')
    except Exception as e:
        logger.error(f'Error updating DynamoDB: {str(e)}')
        raise


def update_recording_complete(
    table,
    recording_id: str,
    recording_date: str,
    s3_key: str,
    file_size: int
):
    """Update recording with completion details"""
    try:
        table.update_item(
            Key={
                'recordingId': recording_id,
                'recordingDate': recording_date
            },
            UpdateExpression='''
                SET #status = :status,
                    s3Key = :s3key,
                    s3Bucket = :bucket,
                    fileSize = :size,
                    completedAt = :completed,
                    lastUpdated = :updated
            ''',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':status': 'completed',
                ':s3key': s3_key,
                ':bucket': BUCKET_NAME,
                ':size': file_size,
                ':completed': datetime.utcnow().isoformat() + 'Z',
                ':updated': datetime.utcnow().isoformat() + 'Z'
            }
        )
        logger.info('Recording metadata updated')
    except Exception as e:
        logger.error(f'Error updating completion status: {str(e)}')
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
    # Convert ISO timestamp to clean format
    timestamp = start_time.replace(':', '').replace('-', '').replace('T', '-').split('.')[0].split('+')[0].split('Z')[0]
    return f"{show_id}-{timestamp}"
