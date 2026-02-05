"""
Radio Recorder Script for ECS Fargate

Records audio from a streaming radio URL for a specified duration
and uploads to S3.
"""

import os
import sys
import subprocess
import boto3
from datetime import datetime
import logging
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
sns_client = boto3.client('sns')

# Environment variables
RECORDING_ID = os.environ.get('RECORDING_ID')
SHOW_ID = os.environ.get('SHOW_ID')
SHOW_NAME = os.environ.get('SHOW_NAME', 'Unknown Show')
DURATION = int(os.environ.get('DURATION', 3600))
STREAM_URL = os.environ.get('STREAM_URL')
BUCKET_NAME = os.environ.get('BUCKET_NAME')
RECORDINGS_TABLE = os.environ.get('RECORDINGS_TABLE')
ALERT_TOPIC_ARN = os.environ.get('ALERT_TOPIC_ARN')


def main():
    """Main recording function"""
    logger.info(f'Starting recording: {RECORDING_ID}')
    logger.info(f'Show: {SHOW_NAME} ({SHOW_ID})')
    logger.info(f'Duration: {DURATION} seconds')
    logger.info(f'Stream URL: {STREAM_URL}')
    
    if not all([RECORDING_ID, SHOW_ID, STREAM_URL, BUCKET_NAME]):
        logger.error('Missing required environment variables')
        sys.exit(1)
    
    try:
        # Update recording status
        update_recording_status('recording')
        
        # Record audio
        output_file = f'/tmp/{RECORDING_ID}.mp3'
        record_audio(STREAM_URL, output_file, DURATION)
        
        # Upload to S3
        s3_key = f'recordings/{SHOW_ID}/{RECORDING_ID}.mp3'
        upload_to_s3(output_file, s3_key)
        
        # Update recording with S3 location
        update_recording_complete(s3_key)
        
        logger.info(f'Recording completed successfully: {RECORDING_ID}')
        
    except Exception as e:
        logger.error(f'Recording failed: {str(e)}')
        update_recording_status('failed', str(e))
        send_alert(f'Recording failed for {SHOW_NAME}: {str(e)}')
        sys.exit(1)


def record_audio(stream_url: str, output_file: str, duration: int):
    """
    Record audio using ffmpeg
    
    Args:
        stream_url: Radio stream URL
        output_file: Output file path
        duration: Duration in seconds
    """
    logger.info(f'Recording {duration} seconds to {output_file}')
    
    cmd = [
        'ffmpeg',
        '-i', stream_url,
        '-t', str(duration),
        '-acodec', 'libmp3lame',
        '-b:a', '128k',
        '-y',  # Overwrite output file
        output_file
    ]
    
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True
        )
        logger.info('Recording completed')
    except subprocess.CalledProcessError as e:
        logger.error(f'FFmpeg error: {e.stderr.decode()}')
        raise


def upload_to_s3(local_file: str, s3_key: str):
    """
    Upload file to S3
    
    Args:
        local_file: Local file path
        s3_key: S3 object key
    """
    logger.info(f'Uploading to S3: {s3_key}')
    
    try:
        s3_client.upload_file(
            local_file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={
                'ContentType': 'audio/mpeg',
                'Metadata': {
                    'recording-id': RECORDING_ID,
                    'show-id': SHOW_ID,
                    'show-name': SHOW_NAME
                }
            }
        )
        logger.info('Upload completed')
    except Exception as e:
        logger.error(f'S3 upload error: {str(e)}')
        raise


def update_recording_status(status: str, error_message: str = None):
    """Update recording status in DynamoDB"""
    if not RECORDINGS_TABLE:
        return
    
    try:
        table = dynamodb.Table(RECORDINGS_TABLE)
        update_expr = 'SET #status = :status, lastUpdated = :updated'
        expr_values = {
            ':status': status,
            ':updated': datetime.utcnow().isoformat()
        }
        
        if error_message:
            update_expr += ', errorMessage = :error'
            expr_values[':error'] = error_message
        
        table.update_item(
            Key={'recordingId': RECORDING_ID},
            UpdateExpression=update_expr,
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues=expr_values
        )
        logger.info(f'Updated recording status: {status}')
    except Exception as e:
        logger.error(f'Error updating DynamoDB: {str(e)}')


def update_recording_complete(s3_key: str):
    """Update recording with completion details"""
    if not RECORDINGS_TABLE:
        return
    
    try:
        table = dynamodb.Table(RECORDINGS_TABLE)
        file_size = os.path.getsize(f'/tmp/{RECORDING_ID}.mp3')
        
        table.update_item(
            Key={'recordingId': RECORDING_ID},
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
        logger.info('Recording metadata updated')
    except Exception as e:
        logger.error(f'Error updating completion status: {str(e)}')


def send_alert(message: str):
    """Send SNS alert"""
    if not ALERT_TOPIC_ARN:
        return
    
    try:
        sns_client.publish(
            TopicArn=ALERT_TOPIC_ARN,
            Subject=f'Recording Alert: {SHOW_NAME}',
            Message=message
        )
    except Exception as e:
        logger.error(f'Failed to send alert: {str(e)}')


if __name__ == '__main__':
    main()
