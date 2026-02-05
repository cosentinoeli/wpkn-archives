FROM public.ecr.aws/lambda/python:3.12

# Install ffmpeg
RUN yum install -y ffmpeg

# Copy recorder script
COPY recorder.py /var/task/

# Install Python dependencies
RUN pip install boto3

# Set the entrypoint
ENTRYPOINT ["python", "/var/task/recorder.py"]
