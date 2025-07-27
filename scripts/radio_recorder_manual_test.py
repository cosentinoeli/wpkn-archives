#!/usr/bin/env python3
import os
import sys
import time
import subprocess
import datetime
import boto3
import requests
import argparse
import logging
from botocore.exceptions import ClientError

# Set environment variables directly in the script for manual testing
os.environ['S3_BUCKET'] = "radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror"
# SNS is optional, so we can leave it as None

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('radio_recorder')

# Parse arguments
parser = argparse.ArgumentParser(description='Radio Stream Recorder')
parser.add_argument('--debug', action='store_true', help='Enable debug logging')
args = parser.parse_args()

if args.debug:
    logger.setLevel(logging.DEBUG)
    logger.debug("Debug logging enabled")

# Configuration
STREAM_URL = "https://wpkn.streamguys1.com/wpkn-high"  # Updated WPKN stream URL
CHUNK_DURATION = 60  # 1 minute in seconds (for testing)
S3_BUCKET = os.environ.get('S3_BUCKET')
SNS_TOPIC_ARN = os.environ.get('SNS_TOPIC_ARN')

# Validate environment
logger.info("Starting Radio Recorder with configuration:")
logger.info(f"Stream URL: {STREAM_URL}")
logger.info(f"Chunk Duration: {CHUNK_DURATION} seconds (1-minute test mode)")
logger.info(f"S3 Bucket: {S3_BUCKET}")
logger.info(f"SNS Topic ARN: {SNS_TOPIC_ARN}")

# Validate environment variables
if not S3_BUCKET:
    logger.error("Environment variable S3_BUCKET is not set")
    sys.exit(1)

# Validate tmp directory exists and is writable
tmp_dir = "/tmp"
if not os.path.exists(tmp_dir):
    tmp_dir = "/home/ec2-user"
    logger.warning(f"/tmp directory not found, using {tmp_dir} instead")

try:
    test_file = f"{tmp_dir}/radio_recorder_test.txt"
    with open(test_file, 'w') as f:
        f.write("test")
    os.remove(test_file)
    logger.info(f"Successfully verified write access to {tmp_dir}")
except Exception as e:
    logger.error(f"Cannot write to {tmp_dir}: {str(e)}")
    sys.exit(1)

def get_stream_url():
    """Extract actual stream URL from playlist if needed."""
    try:
        logger.debug(f"Fetching stream URL from: {STREAM_URL}")
        response = requests.get(STREAM_URL)
        for line in response.text.split('\n'):
            if line.startswith('File1='):
                real_url = line.split('=')[1].strip()
                logger.debug(f"Extracted real stream URL: {real_url}")
                return real_url
    except Exception as e:
        logger.error(f"Failed to get stream URL: {str(e)}")
        return STREAM_URL
    return STREAM_URL

def notify_error(message):
    """Send error notification via SNS."""
    if not SNS_TOPIC_ARN:
        logger.warning("SNS_TOPIC_ARN not set, skipping notification")
        return
        
    try:
        logger.info(f"Sending SNS notification: {message}")
        sns = boto3.client('sns')
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject='Radio Recorder Error',
            Message=message
        )
        logger.debug("SNS notification sent successfully")
    except Exception as e:
        logger.error(f"Failed to send SNS notification: {str(e)}")

def upload_to_s3(file_path, bucket, object_name):
    """Upload recording chunk to S3."""
    logger.info(f"Attempting to upload {file_path} to S3 bucket {bucket} as {object_name}")
    
    # Check if file exists and has content
    if not os.path.exists(file_path):
        error_msg = f"Error: File {file_path} does not exist"
        logger.error(error_msg)
        notify_error(error_msg)
        return False
    
    file_size = os.path.getsize(file_path)
    if file_size == 0:
        error_msg = f"Error: File {file_path} is empty (0 bytes)"
        logger.error(error_msg)
        notify_error(error_msg)
        return False
    
    logger.info(f"File exists with size: {file_size} bytes")
    
    s3_client = boto3.client('s3')
    try:
        logger.debug(f"Starting S3 upload to bucket: {bucket}")
        s3_client.upload_file(file_path, bucket, object_name)
        logger.info(f"Successfully uploaded to s3://{bucket}/{object_name}")
        
        # Verify the upload was successful by checking if the object exists in S3
        try:
            s3_client.head_object(Bucket=bucket, Key=object_name)
            logger.info(f"Verified: Object exists in S3 at s3://{bucket}/{object_name}")
        except ClientError as e:
            error_msg = f"Warning: Upload seemed successful but object verification failed: {str(e)}"
            logger.warning(error_msg)
            notify_error(error_msg)
        
        os.remove(file_path)  # Clean up local file after upload
        logger.debug(f"Removed local file {file_path}")
        return True
    except ClientError as e:
        error_msg = f"Failed to upload {object_name} to S3: {str(e)}"
        logger.error(error_msg)
        notify_error(error_msg)
        return False
    except Exception as e:
        error_msg = f"Unexpected error uploading to S3: {str(e)}"
        logger.error(error_msg)
        notify_error(error_msg)
        return False

def record_stream():
    """Record stream in chunks and upload to S3."""
    stream_url = get_stream_url()
    logger.info(f"Starting recording process using stream URL: {stream_url}")
    logger.info(f"Recordings will be uploaded to S3 bucket: {S3_BUCKET}")
    logger.info(f"Each recording will be approximately {CHUNK_DURATION/60} minute(s) long (TEST MODE)")
    
    recording_count = 0
    
    while True:
        try:
            timestamp = datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
            output_file = f"{tmp_dir}/recording_{timestamp}.mp3"
            s3_object_name = f"recordings/test_recording_{timestamp}.mp3"  # Add 'test_' prefix
            
            logger.info(f"\n--- Starting new recording #{recording_count+1} at {datetime.datetime.now()} ---")
            logger.info(f"Output file: {output_file}")
            logger.info(f"Target S3 location: s3://{S3_BUCKET}/{s3_object_name}")
            
            # FFmpeg command to record stream for specified duration
            cmd = [
                'ffmpeg', '-y',
                '-i', stream_url,
                '-t', str(CHUNK_DURATION),
                '-c', 'copy',
                '-v', 'warning',
                output_file
            ]
            
            logger.debug(f"Executing command: {' '.join(cmd)}")
            
            # Check if ffmpeg is available
            try:
                subprocess.run(['ffmpeg', '-version'], check=True, capture_output=True)
                logger.debug("ffmpeg is available")
            except (subprocess.SubprocessError, FileNotFoundError) as e:
                logger.error(f"ffmpeg not available: {str(e)}")
                notify_error(f"ffmpeg not available: {str(e)}")
                sys.exit(1)
            
            # Start recording
            start_time = time.time()
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, stderr = process.communicate()
            return_code = process.returncode
            duration = time.time() - start_time
            
            if stderr:
                logger.debug(f"FFmpeg stderr: {stderr.decode('utf-8', errors='ignore')}")
            
            logger.info(f"FFmpeg process completed with return code {return_code} after {duration:.1f} seconds")
            
            if return_code == 0:
                # Check if file was created and has content before uploading
                if os.path.exists(output_file) and os.path.getsize(output_file) > 0:
                    logger.info(f"Recording successful! File size: {os.path.getsize(output_file)} bytes")
                    # Upload successful recording
                    upload_success = upload_to_s3(output_file, S3_BUCKET, s3_object_name)
                    if upload_success:
                        recording_count += 1
                        logger.info(f"Successfully completed recording #{recording_count}")
                    else:
                        logger.error(f"Failed to upload recording to S3")
                else:
                    error_msg = f"FFmpeg process completed but output file is missing or empty: {output_file}"
                    logger.error(error_msg)
                    notify_error(error_msg)
            else:
                error_msg = f"FFmpeg recording failed with return code {return_code}: {stderr.decode('utf-8', errors='ignore')}"
                logger.error(error_msg)
                notify_error(error_msg)
                
            # Add a small delay before starting the next recording to avoid overlap
            logger.debug("Waiting 1 second before starting next recording")
            time.sleep(1)
                
        except Exception as e:
            error_msg = f"Recording error: {str(e)}"
            logger.error(error_msg)
            notify_error(error_msg)
            logger.info("Waiting 30 seconds before retry after error")
            time.sleep(30)  # Wait longer before retrying after an error

if __name__ == "__main__":
    try:
        logger.info("Radio Recorder Manual Test starting")
        record_stream()
    except KeyboardInterrupt:
        logger.info("Radio Recorder stopped by user")
    except Exception as e:
        logger.error(f"Unhandled exception: {str(e)}")
        notify_error(f"Radio Recorder crashed with unhandled exception: {str(e)}")
        sys.exit(1)