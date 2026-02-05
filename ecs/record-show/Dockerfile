# Use Python base image with ffmpeg
FROM python:3.12-slim

# Install ffmpeg and dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir \
    boto3 \
    requests

# Copy recording script
COPY record.py /app/record.py

# Set working directory
WORKDIR /app

# Run the recording script
CMD ["python", "record.py"]
