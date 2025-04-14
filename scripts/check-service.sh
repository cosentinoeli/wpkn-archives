#!/bin/bash
# Script to check the status of the radio recorder service and view logs
# Run this script on your EC2 instance

echo "======= Radio Recorder Service Status ======="
sudo systemctl status radio-recorder.service

echo -e "\n\n======= Last 50 Log Lines ======="
sudo journalctl -u radio-recorder.service -n 50

echo -e "\n\n======= Checking S3 Configuration ======="
echo "S3 Bucket configured in environment:"
sudo grep S3_BUCKET /etc/systemd/system/radio-recorder.service

echo -e "\n\n======= Checking AWS Credentials ======="
echo "AWS CLI configured for:"
aws configure list

echo -e "\n\n======= Checking for recordings in S3 ======="
echo "Listing files in S3 bucket:"
aws s3 ls s3://$(grep S3_BUCKET /etc/systemd/system/radio-recorder.service | cut -d= -f2)/recordings/

echo -e "\n\n======= Service Deployment Check ======="
echo "Checking if radio_recorder.py is in the correct location:"
ls -la /opt/radio-recorder/

echo -e "\n\n======= Disk Space Check ======="
echo "Checking available disk space for recordings:"
df -h /tmp

echo -e "\n\n======= Testing Stream Recording ======="
echo "Testing if we can record a few seconds of the stream:"
echo "Attempting to record 5 seconds of audio..."
ffmpeg -y -i https://ice25.securenetsystems.net/WPKN -t 5 -c copy /tmp/test_recording.mp3
if [ $? -eq 0 ]; then
    echo "Recording test successful! Generated file:"
    ls -la /tmp/test_recording.mp3
    echo -e "\nUploading test file to S3..."
    aws s3 cp /tmp/test_recording.mp3 s3://$(grep S3_BUCKET /etc/systemd/system/radio-recorder.service | cut -d= -f2)/test_upload.mp3
    if [ $? -eq 0 ]; then
        echo "Upload test successful!"
    else
        echo "Upload test failed. Check AWS credentials and permissions."
    fi
else
    echo "Recording test failed. Check if ffmpeg is installed and stream URL is accessible."
fi