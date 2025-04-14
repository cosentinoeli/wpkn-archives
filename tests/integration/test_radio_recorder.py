import os
import pytest
import tempfile
import time
import subprocess
from unittest.mock import patch
import boto3
import requests
from pydub import AudioSegment
import sys

# Add the scripts directory to the Python path
sys.path.append(os.path.join(os.path.dirname(__file__), '../../scripts'))
from radio_recorder import get_stream_url, notify_error, upload_to_s3, record_stream

# Configuration for deployed environment
STREAM_URL = "https://ice25.securenetsystems.net/WPKN"
TEST_DURATION = 10  # Test with 10 seconds of recording
S3_BUCKET = "radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror"
SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:016770890611:RadioRecorderStack-RadioRecorderAlertsD79C7172-irKoRbJg8itx"
AWS_REGION = "us-east-1"

# Set up AWS clients
s3_client = boto3.client('s3', region_name=AWS_REGION)
sns_client = boto3.client('sns', region_name=AWS_REGION)

def test_stream_url_accessibility():
    """Test that the radio stream URL is accessible."""
    response = requests.get(STREAM_URL, stream=True)
    assert response.status_code == 200
    response.close()

@pytest.mark.timeout(15)  # Allow 15 seconds for the test
def test_ffmpeg_recording(tmp_path):
    """Test that FFmpeg can record from the stream."""
    output_file = str(tmp_path / "test_recording.mp3")
    
    # Record for TEST_DURATION seconds with proper stream format handling
    cmd = [
        'ffmpeg', '-y',
        '-i', STREAM_URL,
        '-t', str(TEST_DURATION),
        '-acodec', 'libmp3lame',  # Use libmp3lame encoder
        '-ab', '128k',  # Set bitrate
        '-v', 'warning',
        output_file
    ]
    
    import subprocess
    process = subprocess.Popen(cmd)
    process.wait()
    
    assert process.returncode == 0
    assert os.path.exists(output_file)
    
    # Verify the recording is valid audio
    audio = AudioSegment.from_mp3(output_file)
    assert len(audio) > 0  # Length in milliseconds
    
    # Upload test recording to S3
    test_key = f"test_recordings/test_{int(time.time())}.mp3"
    s3_client.upload_file(output_file, S3_BUCKET, test_key)
    
    # Verify upload
    response = s3_client.head_object(Bucket=S3_BUCKET, Key=test_key)
    assert response['ContentLength'] > 0

def test_s3_upload():
    """Test S3 upload functionality with the deployed bucket."""
    # Create a small test file
    with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as tmp:
        tmp.write(b'test audio content')
        tmp_path = tmp.name
    
    test_key = f"test_uploads/test_{int(time.time())}.mp3"
    
    # Test upload
    s3_client.upload_file(tmp_path, S3_BUCKET, test_key)
    
    # Verify file exists in S3
    response = s3_client.head_object(Bucket=S3_BUCKET, Key=test_key)
    assert response['ContentLength'] > 0

def test_sns_notification():
    """Test SNS notification system with the deployed topic."""
    test_message = f"Test notification {int(time.time())}"
    
    # Publish test message
    response = sns_client.publish(
        TopicArn=SNS_TOPIC_ARN,
        Message=test_message,
        Subject='Integration Test'
    )
    
    assert 'MessageId' in response

def test_integration_recording():
    """Integration test that performs a short recording and upload."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        timestamp = int(time.time())
        output_file = os.path.join(tmp_dir, f"recording_{timestamp}.mp3")
        
        # Record for TEST_DURATION seconds
        cmd = [
            'ffmpeg', '-y',
            '-i', STREAM_URL,
            '-t', str(TEST_DURATION),
            '-acodec', 'libmp3lame',
            '-ab', '128k',
            '-v', 'warning',
            output_file
        ]
        
        process = subprocess.Popen(cmd)
        process.wait()
        
        assert process.returncode == 0
        assert os.path.exists(output_file)
        
        # Upload to S3
        test_key = f"integration_test/recording_{timestamp}.mp3"
        s3_client.upload_file(output_file, S3_BUCKET, test_key)
        
        # Verify upload
        response = s3_client.head_object(Bucket=S3_BUCKET, Key=test_key)
        assert response['ContentLength'] > 0
        
        # Send notification
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Message=f"Integration test recording completed: {test_key}",
            Subject='Integration Test Complete'
        )

if __name__ == '__main__':
    pytest.main([__file__, '-v'])