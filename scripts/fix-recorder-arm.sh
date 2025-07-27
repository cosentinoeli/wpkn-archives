#!/bin/bash
# Comprehensive fix for radio recorder service on ARM architecture
# This script compiles FFmpeg from source for ARM and fixes Python dependencies

echo "====== Radio Recorder Service Fix Script (ARM) ======"
echo "This script will install FFmpeg from source, fix Python dependencies, and restart the service"

# Install build dependencies
echo -e "\n[1/9] Installing build dependencies..."
sudo yum -y update
sudo yum -y groupinstall "Development Tools"
sudo yum -y install autoconf automake bzip2-devel cmake freetype-devel gcc gcc-c++ git libtool make mercurial pkgconfig zlib-devel

# Create a directory for FFmpeg sources
echo -e "\n[2/9] Setting up build environment..."
mkdir -p ~/ffmpeg_sources ~/bin

# Download and install NASM assembler
echo -e "\n[3/9] Installing NASM..."
cd ~/ffmpeg_sources
curl -O -L https://www.nasm.us/pub/nasm/releasebuilds/2.15.05/nasm-2.15.05.tar.bz2
tar xjvf nasm-2.15.05.tar.bz2
cd nasm-2.15.05
./autogen.sh
./configure --prefix="$HOME/ffmpeg_build" --bindir="$HOME/bin"
make -j$(nproc)
make install

# Download and install FFmpeg
echo -e "\n[4/9] Building FFmpeg (this might take some time)..."
cd ~/ffmpeg_sources
curl -O -L https://ffmpeg.org/releases/ffmpeg-snapshot.tar.bz2
tar xjvf ffmpeg-snapshot.tar.bz2
cd ffmpeg
PATH="$HOME/bin:$PATH" PKG_CONFIG_PATH="$HOME/ffmpeg_build/lib/pkgconfig" ./configure \
  --prefix="$HOME/ffmpeg_build" \
  --pkg-config-flags="--static" \
  --extra-cflags="-I$HOME/ffmpeg_build/include" \
  --extra-ldflags="-L$HOME/ffmpeg_build/lib" \
  --extra-libs="-lpthread -lm" \
  --bindir="$HOME/bin" \
  --enable-gpl \
  --enable-nonfree \
  --disable-debug \
  --enable-small

# Compile FFmpeg with lower job count for ARM to avoid memory issues
make -j2
make install

# Make FFmpeg available system-wide
echo -e "\n[5/9] Making FFmpeg available system-wide..."
sudo cp ~/bin/ffmpeg /usr/local/bin/
sudo cp ~/bin/ffprobe /usr/local/bin/

# Verify FFmpeg installation
echo -e "\n[6/9] Verifying FFmpeg installation..."
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg installed successfully!"
    ffmpeg -version | head -n 1
else
    echo "❌ FFmpeg installation failed. This is required for recording."
    exit 1
fi

# Fix Python dependencies
echo -e "\n[7/9] Fixing Python dependencies..."
sudo pip3 uninstall -y boto3 botocore urllib3 requests
sudo pip3 install 'urllib3<1.27' boto3 requests

# Verify Python dependencies
echo -e "\n[8/9] Verifying Python dependencies..."
python3 -c "import boto3, requests, urllib3; print(f'boto3: {boto3.__version__}, requests: {requests.__version__}, urllib3: {urllib3.__version__}')"

# Check if the recording script exists and is executable
if [ -f /opt/radio-recorder/radio_recorder.py ]; then
    sudo chmod +x /opt/radio-recorder/radio_recorder.py
    echo "✅ Recording script found and made executable"
else
    echo "❌ Recording script not found at /opt/radio-recorder/radio_recorder.py"
    exit 1
fi

# Restart the service
echo -e "\n[9/9] Restarting radio-recorder service..."
sudo systemctl daemon-reload
sudo systemctl restart radio-recorder.service
sleep 2

# Check service status
echo -e "\n===== Service Status ====="
sudo systemctl status radio-recorder.service

echo -e "\n===== Live Service Logs (Press Ctrl+C to exit) ====="
sudo journalctl -u radio-recorder.service -f