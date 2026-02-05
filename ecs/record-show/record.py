"""
ECS Recording Task

Records audio from radio stream and uploads to S3.
Runs as a containerized task with no time limits.
"""

import os
import json
import boto3
import subprocess
from datetime import datetime
import logging
import sys
from typing import Dict, Any

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# AWS clients
s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
sns_client = boto3.client('sns')

# Environment variables (passed from ECS task definition)
STREAM_URL = os.environ.get('STREAM_URL', 'https://ice25.securenetsystems.net/WPKN')
BUCKET_NAME = os.environ['BUCKET_NAME']
RECORDINGS_TABLE = os.environ['RECORDINGS_TABLE']
ALERT_TOPIC_ARN = os.environ.get('ALERT_TOPIC_ARN', '')

# Task-specific parameters (passed as environment overrides)
SHOW_ID = os.environ.get('SHOW_ID')
SHOW_NAME = os.environ.get('SHOW_NAME', 'Unknown Show')
DURATION = int(os.environ.get('DURATION', '3600'))
START_TIME = os.environ.get('START_TIME', datetime.utcnow().isoformat())


def main():
    """Main recording workflow"""
    logger.info('=== ECS Recording Task Started ===')
    logger.info(f'Show: {SHOW_NAME} (ID: {SHOW_ID})')
    logger.info(f'Duration: {DURATION} seconds')
    logger.info(f'Stream: {STREAM_URL}')
    
    try:
        if not SHOW_ID:
            raise ValueError('SHOW_ID environment variable is required')
        
        recording_date = START_TIME.split('T')[0]
        
        # Generate recording ID
        recording_id = generate_recording_id(SHOW_ID, START_TIME)
        logger.info(f'Recording ID: {recording_id}')
        
        # Create recording entry in DynamoDB
        recordings_table = dynamodb.Table(RECORDINGS_TABLE)
        recording_data = {
            'recordingId': recording_id,
            'recordingDate': recording_date,
            'showId': SHOW_ID,
            'showName': SHOW_NAME,
            'startTime': START_TIME,
            'duration': DURATION,
            'status': 'recording',
            'createdAt': datetime.utcnow().isoformat(),
            'lastUpdated': datetime.utcnow().isoformat()
        }
        
        recordings_table.put_item(Item=recording_data)
        logger.info('Created recording entry in DynamoDB')
        
        # Record audio
        output_file = f'/tmp/{recording_id}.mp3'
        logger.info(f'Recording to: {output_file}')
        record_audio(STREAM_URL, output_file, DURATION)
        
        # Upload to S3
        s3_key = f'recordings/{SHOW_ID}/{recording_id}.mp3'
        logger.info(f'Uploading to S3: {s3_key}')
        file_size = upload_to_s3(output_file, s3_key, SHOW_ID, SHOW_NAME)
        
        # Update recording as completed
        update_recording_complete(
            recordings_table,
            recording_id,
            recording_date,
            s3_key,
            file_size
        )
        
        logger.info(f'=== Recording Completed Successfully ===')
        logger.info(f'File: s3://{BUCKET_NAME}/{s3_key}')
        logger.info(f'Size: {file_size} bytes ({file_size / 1024 / 1024:.2f} MB)')
        
        # Clean up temp file
        try:
            os.remove(output_file)
            logger.info('Cleaned up temporary file')
        except Exception as e:
            logger.warning(f'Failed to clean up temp file: {e}')
        
        sys.exit(0)
        
    except Exception as e:
        logger.error(f'Recording failed: {str(e)}', exc_info=True)
        
        # Update status to failed
        try:
            if 'recordings_table' in locals() and recording_id:
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
                    Subject=f'Recording Failed: {SHOW_NAME}',
                    Message=f'''Recording Task Failed
                    
Show: {SHOW_NAME}
Show ID: {SHOW_ID}
Recording ID: {recording_id if 'recording_id' in locals() else 'N/A'}
Duration: {DURATION} seconds
Error: {str(e)}

Check CloudWatch Logs for details.
'''
                )
                logger.info('Sent failure alert via SNS')
            except Exception as sns_error:
                logger.error(f'Failed to send alert: {str(sns_error)}')
        
        sys.exit(1)


def record_audio(stream_url: str, output_file: str, duration: int):
    """
    Record audio using ffmpeg
    
    Args:
        stream_url: Radio stream URL
        output_file: Output file path
        duration: Duration in seconds (no limit for ECS)
    """
    logger.info(f'Starting recording: {duration} seconds from {stream_url}')
    
    # ffmpeg installed via apt in Docker image
    ffmpeg_path = 'ffmpeg'
    
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
        # Run ffmpeg with real-time progress logging
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True
        )
        
        # Log stderr (ffmpeg outputs to stderr)
        for line in process.stderr:
            if line.strip():
                # Log progress periodically (every 10th line to reduce logs)
                if 'time=' in line:
                    logger.debug(line.strip())
        
        return_code = process.wait()
        
        if return_code != 0:
            raise Exception(f'FFmpeg exited with code {return_code}')
        
        logger.info(f'Recording completed: {output_file}')
        
        # Check file was created
        if not os.path.exists(output_file):
            raise Exception('Recording file not created')
            
        file_size = os.path.getsize(output_file)
        logger.info(f'Recording size: {file_size} bytes ({file_size / 1024 / 1024:.2f} MB)')
        
        return file_size
        
    except subprocess.TimeoutExpired:
        logger.error('FFmpeg timeout')
        process.kill()
        raise Exception('Recording timed out')
    except Exception as e:
        logger.error(f'FFmpeg error: {str(e)}')
        raise


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
        # Upload with progress callback
        s3_client.upload_file(
            local_file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={
                'ContentType': 'audio/mpeg',
                'Metadata': {
                    'show-id': show_id,
                    'show-name': show_name,
                    'duration': str(DURATION),
                    'stream-url': STREAM_URL
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
            ':updated': datetime.utcnow().isoformat()
        }
        
        if error_message:
            update_expr += ', errorMessage = :error'
            expr_values[':error'] = error_message[:1000]  # Truncate if too long
        
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
                ':completed': datetime.utcnow().isoformat(),
                ':updated': datetime.utcnow().isoformat()
            }
        )
        logger.info('Recording metadata updated in DynamoDB')
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


if __name__ == '__main__':
    main()
