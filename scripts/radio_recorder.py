#!/usr/bin/env python3
import os
import sys
import time
import subprocess
import datetime
import boto3
import requests
from botocore.exceptions import ClientError

# Configuration
STREAM_URL = "https://ice25.securenetsystems.net/WPKN"  # WPKN direct stream URL
CHUNK_DURATION = 7200  # 2 hours in seconds
S3_BUCKET = os.environ.get('S3_BUCKET')
SNS_TOPIC_ARN = os.environ.get('SNS_TOPIC_ARN')

def get_stream_url():
    """Extract actual stream URL from playlist if needed."""
    try:
        response = requests.get(STREAM_URL)
        for line in response.text.split('\n'):
            if line.startswith('File1='):
                return line.split('=')[1].strip()
    except Exception as e:
        notify_error(f"Failed to get stream URL: {str(e)}")
        return STREAM_URL
    return STREAM_URL

def notify_error(message):
    """Send error notification via SNS."""
    try:
        sns = boto3.client('sns')
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject='Radio Recorder Error',
            Message=message
        )
    except Exception as e:
        print(f"Failed to send SNS notification: {str(e)}", file=sys.stderr)

def upload_to_s3(file_path, bucket, object_name):
    """Upload recording chunk to S3."""
    s3_client = boto3.client('s3')
    try:
        s3_client.upload_file(file_path, bucket, object_name)
        os.remove(file_path)  # Clean up local file after upload
        return True
    except ClientError as e:
        notify_error(f"Failed to upload {object_name} to S3: {str(e)}")
        return False

def record_stream():
    """Record stream in chunks and upload to S3."""
    stream_url = get_stream_url()
    
    while True:
        try:
            timestamp = datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
            output_file = f"/tmp/recording_{timestamp}.mp3"
            
            # FFmpeg command to record stream for specified duration
            cmd = [
                'ffmpeg', '-y',
                '-i', stream_url,
                '-t', str(CHUNK_DURATION),
                '-c', 'copy',
                '-v', 'warning',
                output_file
            ]
            
            # Start recording
            process = subprocess.Popen(cmd)
            process.wait()
            
            if process.returncode == 0:
                # Upload successful recording
                s3_object_name = f"recordings/recording_{timestamp}.mp3"
                upload_to_s3(output_file, S3_BUCKET, s3_object_name)
            else:
                notify_error(f"FFmpeg recording failed with return code {process.returncode}")
                
        except Exception as e:
            notify_error(f"Recording error: {str(e)}")
            time.sleep(5)  # Wait before retrying

if __name__ == "__main__":
    if not all([S3_BUCKET, SNS_TOPIC_ARN]):
        print("Error: Required environment variables not set", file=sys.stderr)
        sys.exit(1)
    
    record_stream()