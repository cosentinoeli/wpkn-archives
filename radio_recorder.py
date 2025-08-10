#!/usr/bin/env python3
"""
EC2-based Radio Stream Recorder (Working Version)
Continuously records from audio stream, segments into 5-minute MP3 files,
and uploads to S3 with self-healing capabilities.

This version includes all fixes discovered during troubleshooting:
- Proper FFmpeg codec handling (AAC to MP3 encoding)
- Simplified stream URL handling for direct streams
- Improved error handling and logging
- Robust file management and S3 upload verification
"""

import os
import sys
import time
import logging
import subprocess
import threading
import shutil
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any
import signal
import json

import boto3
from botocore.exceptions import ClientError, NoCredentialsError


# Configuration from environment variables
STREAM_URL = os.getenv('STREAM_URL', 'https://ice25.securenetsystems.net/WPKN')
S3_BUCKET = os.getenv('S3_BUCKET', 'my-radio-archive')
SEGMENT_MINUTES = int(os.getenv('SEGMENT_MINUTES', '5'))
OUTPUT_DIR = os.getenv('OUTPUT_DIR', '/tmp')
MAX_DISK_USAGE_PERCENT = int(os.getenv('MAX_DISK_USAGE_PERCENT', '80'))
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')

# Derived values
CHUNK_DURATION = SEGMENT_MINUTES * 60

# Reconnection settings
INITIAL_RECONNECT_DELAY = 5
MAX_RECONNECT_DELAY = 30
RECONNECT_MULTIPLIER = 2
MAX_RECONNECT_ATTEMPTS = 10

# Setup logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper()),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('/var/log/radio-recorder.log')
    ]
)
logger = logging.getLogger('radio_recorder')


class CloudWatchMetrics:
    """CloudWatch custom metrics publisher"""
    
    def __init__(self):
        try:
            self.cloudwatch = boto3.client('cloudwatch')
            self.namespace = 'RadioRecorder'
        except Exception as e:
            logger.warning(f"CloudWatch metrics not available: {e}")
            self.cloudwatch = None
    
    def put_metric(self, metric_name: str, value: float, unit: str = 'Count', dimensions: Optional[Dict] = None):
        """Put custom metric to CloudWatch"""
        if not self.cloudwatch:
            return
            
        try:
            metric_data = {
                'MetricName': metric_name,
                'Value': value,
                'Unit': unit,
                'Timestamp': datetime.now(timezone.utc)
            }
            
            if dimensions:
                metric_data['Dimensions'] = [
                    {'Name': k, 'Value': v} for k, v in dimensions.items()
                ]
            
            self.cloudwatch.put_metric_data(
                Namespace=self.namespace,
                MetricData=[metric_data]
            )
            logger.debug(f"CloudWatch metric sent: {metric_name}={value}")
        except Exception as e:
            logger.error(f"Failed to send CloudWatch metric {metric_name}: {e}")


class DiskManager:
    """Manages disk space and file cleanup"""
    
    def __init__(self, output_dir: str, max_usage_percent: int):
        self.output_dir = Path(output_dir)
        self.max_usage_percent = max_usage_percent
    
    def get_disk_usage(self) -> float:
        """Get current disk usage percentage"""
        usage = shutil.disk_usage(self.output_dir)
        return (usage.used / usage.total) * 100
    
    def cleanup_old_files(self):
        """Remove oldest files if disk usage exceeds threshold"""
        current_usage = self.get_disk_usage()
        if current_usage < self.max_usage_percent:
            return
        
        logger.warning(f"Disk usage at {current_usage:.1f}%, cleaning up old files")
        
        # Get all MP3 files sorted by creation time
        mp3_files = sorted(
            self.output_dir.glob("*.mp3"),
            key=lambda p: p.stat().st_ctime
        )
        
        # Remove oldest files until usage is below threshold
        for file_path in mp3_files:
            try:
                file_path.unlink()
                logger.info(f"Deleted old file: {file_path.name}")
                
                current_usage = self.get_disk_usage()
                if current_usage < self.max_usage_percent * 0.9:  # 10% buffer
                    break
            except Exception as e:
                logger.error(f"Failed to delete {file_path}: {e}")


class S3Uploader:
    """Handles S3 uploads with multipart support and metadata"""
    
    def __init__(self, bucket_name: str):
        self.bucket_name = bucket_name
        self.s3_client = boto3.client('s3')
        self.metrics = CloudWatchMetrics()
    
    def calculate_md5(self, filepath: Path) -> str:
        """Calculate MD5 checksum of file"""
        hash_md5 = hashlib.md5()
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
    
    def upload_file(self, filepath: Path, start_time: datetime) -> bool:
        """Upload file to S3 with metadata and encryption"""
        try:
            upload_start = time.time()
            
            # Calculate file checksum
            md5_hash = self.calculate_md5(filepath)
            logger.debug(f"Calculated MD5 for {filepath.name}: {md5_hash}")
            
            # Prepare metadata
            metadata = {
                'start-time': start_time.isoformat(),
                'md5-checksum': md5_hash,
                'segment-duration-minutes': str(SEGMENT_MINUTES),
                'stream-url': STREAM_URL
            }
            
            # S3 key (object name)
            s3_key = f"recordings/{filepath.name}"
            
            # Upload parameters
            extra_args = {
                'ContentType': 'audio/mpeg',
                'ContentDisposition': f'attachment; filename="{filepath.name}"',
                'ServerSideEncryption': 'AES256',
                'Metadata': metadata
            }
            
            # Upload file
            file_size = filepath.stat().st_size
            self.s3_client.upload_file(
                str(filepath), self.bucket_name, s3_key,
                ExtraArgs=extra_args
            )
            
            upload_duration = time.time() - upload_start
            logger.info(f"Successfully uploaded {filepath.name} to s3://{self.bucket_name}/{s3_key} in {upload_duration:.1f}s")
            
            # Send CloudWatch metrics
            self.metrics.put_metric('UploadLatency', upload_duration, 'Seconds')
            self.metrics.put_metric('FileSize', file_size, 'Bytes')
            
            return True
            
        except (ClientError, NoCredentialsError) as e:
            logger.error(f"S3 upload failed for {filepath.name}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error uploading {filepath.name}: {e}")
            return False


class RadioRecorder:
    """Main stream recorder with self-healing capabilities"""
    
    def __init__(self):
        self.output_dir = Path(OUTPUT_DIR)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.s3_uploader = S3Uploader(S3_BUCKET)
        self.disk_manager = DiskManager(OUTPUT_DIR, MAX_DISK_USAGE_PERCENT)
        self.metrics = CloudWatchMetrics()
        
        self.running = True
        self.current_process: Optional[subprocess.Popen] = None
        
        # Verify write access to output directory
        test_file = self.output_dir / 'test_write.tmp'
        try:
            test_file.write_text('test')
            test_file.unlink()
            logger.info(f"Successfully verified write access to {OUTPUT_DIR}")
        except Exception as e:
            logger.error(f"Cannot write to {OUTPUT_DIR}: {e}")
            sys.exit(1)
        
        # Setup signal handlers for graceful shutdown
        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        logger.info(f"Received signal {signum}, shutting down gracefully...")
        self.running = False
        if self.current_process:
            self.current_process.terminate()
    
    def get_stream_url(self):
        """Get stream URL - simplified for direct streams like WPKN"""
        return STREAM_URL
    
    def _build_ffmpeg_command(self, output_file: Path) -> list:
        """Build FFmpeg command with proper MP3 encoding"""
        return [
            'ffmpeg',
            '-y',  # Overwrite output files
            '-reconnect', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '30',
            '-i', self.get_stream_url(),
            '-t', str(CHUNK_DURATION),
            '-c:a', 'libmp3lame',  # Force MP3 encoding
            '-b:a', '128k',  # 128kbps bitrate
            '-metadata', f'title=Radio Recording {datetime.now(timezone.utc).isoformat()}',
            '-metadata', f'comment=Stream: {STREAM_URL}',
            '-v', 'warning',  # Reduce verbose output
            str(output_file)
        ]
    
    def _record_segment(self) -> Optional[tuple[Path, datetime]]:
        """Record a single segment"""
        start_time = datetime.now(timezone.utc)
        filename = f"recording_{start_time.strftime('%Y-%m-%d_%H-%M-%S')}.mp3"
        temp_file = self.output_dir / f"{filename}.tmp"
        final_file = self.output_dir / filename
        
        logger.info(f"Starting recording segment: {filename}")
        
        # Build FFmpeg command
        cmd = self._build_ffmpeg_command(temp_file)
        logger.debug(f"Executing command: {' '.join(cmd)}")
        
        try:
            # Start FFmpeg process
            self.current_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            # Wait for process with timeout
            timeout = CHUNK_DURATION + 60  # Add 60s buffer
            try:
                stdout, stderr = self.current_process.communicate(timeout=timeout)
                return_code = self.current_process.returncode
            except subprocess.TimeoutExpired:
                logger.warning("FFmpeg process timed out, terminating...")
                self.current_process.terminate()
                try:
                    self.current_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.current_process.kill()
                return None
            
            # Check if recording was successful
            if return_code == 0 and temp_file.exists() and temp_file.stat().st_size > 0:
                # Atomic move from temp to final location
                temp_file.rename(final_file)
                
                actual_duration = time.time() - start_time.timestamp()
                file_size = final_file.stat().st_size
                logger.info(f"Recording completed: {filename} (duration: {actual_duration:.1f}s, size: {file_size} bytes)")
                
                # Send CloudWatch metric
                self.metrics.put_metric('SegmentDuration', actual_duration, 'Seconds')
                self.metrics.put_metric('RecordingSuccess', 1, 'Count')
                
                return final_file, start_time
            else:
                logger.error(f"Recording failed with return code {return_code}")
                if stderr:
                    logger.error(f"FFmpeg stderr: {stderr}")
                
                # Send failure metric
                self.metrics.put_metric('RecordingFailure', 1, 'Count')
                
                # Cleanup temp file
                if temp_file.exists():
                    temp_file.unlink()
                
                return None
                
        except Exception as e:
            logger.error(f"Exception during recording: {e}")
            if temp_file.exists():
                temp_file.unlink()
            return None
        finally:
            self.current_process = None
    
    def _handle_completed_segment(self, filepath: Path, start_time: datetime):
        """Handle a completed recording segment"""
        try:
            logger.info(f"Attempting to upload {filepath.name} to S3 bucket {self.s3_uploader.bucket_name}")
            logger.info(f"File exists with size: {filepath.stat().st_size} bytes")
            
            # Upload to S3
            upload_success = self.s3_uploader.upload_file(filepath, start_time)
            
            if upload_success:
                # Verify upload by checking if file exists in S3
                try:
                    self.s3_uploader.s3_client.head_object(
                        Bucket=self.s3_uploader.bucket_name, 
                        Key=f"recordings/{filepath.name}"
                    )
                    logger.info(f"Verified: Object exists in S3 at s3://{self.s3_uploader.bucket_name}/recordings/{filepath.name}")
                    
                    # Delete local file after successful upload and verification
                    filepath.unlink()
                    logger.info(f"Deleted local file after successful upload: {filepath.name}")
                except Exception as verify_error:
                    logger.error(f"S3 verification failed: {verify_error}")
                    logger.warning(f"Keeping local file due to verification failure: {filepath.name}")
            else:
                logger.warning(f"Upload failed, keeping local file: {filepath.name}")
            
            # Cleanup old files if needed
            self.disk_manager.cleanup_old_files()
            
        except Exception as e:
            logger.error(f"Error handling completed segment {filepath.name}: {e}")
    
    def run(self):
        """Main recording loop with self-healing"""
        logger.info("Radio Recorder starting")
        logger.info(f"Starting recording process using stream URL: {STREAM_URL}")
        logger.info(f"Recordings will be uploaded to S3 bucket: {S3_BUCKET}")
        logger.info(f"Each recording will be approximately {SEGMENT_MINUTES/60} hours long")
        
        consecutive_failures = 0
        recording_number = 1
        
        while self.running:
            try:
                logger.info(f"\n--- Starting new recording #{recording_number} at {datetime.now(timezone.utc)} ---")
                
                # Record segment
                result = self._record_segment()
                
                if result:
                    filepath, start_time = result
                    consecutive_failures = 0
                    
                    logger.info(f"Output file: {filepath}")
                    logger.info(f"Target S3 location: s3://{S3_BUCKET}/recordings/{filepath.name}")
                    
                    # Handle completed segment in background thread
                    upload_thread = threading.Thread(
                        target=self._handle_completed_segment,
                        args=(filepath, start_time),
                        daemon=True
                    )
                    upload_thread.start()
                    
                    logger.info(f"Successfully completed recording #{recording_number}")
                    
                    # Send heartbeat
                    self.metrics.put_metric('StreamDowntime', 0, 'Seconds')
                    
                else:
                    # Recording failed
                    consecutive_failures += 1
                    logger.error(f"Recording failed (attempt {consecutive_failures})")
                    
                    # Calculate reconnect delay with exponential backoff
                    delay = min(
                        INITIAL_RECONNECT_DELAY * (RECONNECT_MULTIPLIER ** (consecutive_failures - 1)),
                        MAX_RECONNECT_DELAY
                    )
                    
                    if consecutive_failures >= MAX_RECONNECT_ATTEMPTS:
                        logger.critical("Max reconnection attempts reached, resetting counter")
                        consecutive_failures = 0
                        delay = MAX_RECONNECT_DELAY
                    
                    logger.info(f"Waiting {delay}s before retry...")
                    
                    # Send downtime metric
                    self.metrics.put_metric('StreamDowntime', delay, 'Seconds')
                    
                    # Wait before retry
                    time.sleep(delay)
                
                recording_number += 1
                
            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received, shutting down...")
                break
            except Exception as e:
                logger.error(f"Unexpected error in main loop: {e}")
                time.sleep(10)
        
        logger.info("Radio stream recorder stopped")


def check_dependencies():
    """Check if required dependencies are available"""
    # Check FFmpeg
    try:
        subprocess.run(['ffmpeg', '-version'], 
                      stdout=subprocess.DEVNULL, 
                      stderr=subprocess.DEVNULL, 
                      check=True)
        logger.info("FFmpeg found")
        
        # Test MP3 encoding capability
        try:
            subprocess.run([
                'ffmpeg', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
                '-c:a', 'libmp3lame', '-f', 'mp3', '/dev/null', '-y'
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            logger.info("FFmpeg MP3 encoding capability verified")
        except subprocess.CalledProcessError:
            logger.error("FFmpeg MP3 encoding not available")
            return False
            
    except (subprocess.CalledProcessError, FileNotFoundError):
        logger.error("FFmpeg not found. Please install FFmpeg with MP3 support.")
        return False
    
    # Check AWS credentials
    try:
        boto3.client('s3').list_buckets()
        logger.info("AWS credentials found")
    except NoCredentialsError:
        logger.error("AWS credentials not found. Please configure IAM role or credentials.")
        return False
    except Exception as e:
        logger.warning(f"AWS check failed (may be OK): {e}")
    
    return True


def main():
    """Main entry point"""
    logger.info("Radio Stream Recorder starting up...")
    
    # Log configuration
    logger.info(f"Configuration:")
    logger.info(f"  STREAM_URL: {STREAM_URL}")
    logger.info(f"  S3_BUCKET: {S3_BUCKET}")
    logger.info(f"  SEGMENT_MINUTES: {SEGMENT_MINUTES}")
    logger.info(f"  OUTPUT_DIR: {OUTPUT_DIR}")
    logger.info(f"  SNS Topic ARN: {os.getenv('SNS_TOPIC_ARN', 'None')}")
    
    # Validate configuration
    if not STREAM_URL:
        logger.error("STREAM_URL environment variable not set")
        sys.exit(1)
    
    if not S3_BUCKET:
        logger.error("S3_BUCKET environment variable not set")
        sys.exit(1)
    
    # Check dependencies
    if not check_dependencies():
        sys.exit(1)
    
    # Create and run recorder
    recorder = RadioRecorder()
    try:
        recorder.run()
    except Exception as e:
        logger.critical(f"Fatal error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
