# 🎵 WPKN Radio Archive System

An automated radio stream recording system built with AWS CDK that captures live radio streams into organized MP3 archives.

## 🚀 Quick Start

1. **Clone & Configure**
   ```bash
   git clone https://github.com/cosentinoeli/wpkn-archives.git
   cd wpkn-archives
   cp config/deploy-config.sh.example config/deploy-config.sh
   # Edit config/deploy-config.sh with your AWS key pair name
   ```

2. **Deploy**
   ```bash
   npm install
   ./deploy.sh
   ```

3. **Monitor**
   - SSH to instance: `ssh -i keys/your-key.pem ec2-user@<instance-ip>`
   - Check status: `sudo systemctl status radio-recorder.service`
   - View logs: `sudo journalctl -u radio-recorder.service -f`

## 📁 Project Structure

```
📦 wpkn-archives/
├── 📁 config/           # Configuration files
├── 📁 docs/             # Documentation  
├── 📁 infrastructure/   # AWS CDK code
├── 📁 keys/            # SSH keys (gitignored)
├── 📁 scripts/         # Python recorder & deployment scripts
└── 📄 deploy.sh        # Main deployment script
```

## ✨ Features

- **🎯 Continuous Recording**: 24/7 stream capture with auto-restart
- **📦 5-Minute Segments**: Organized MP3 files with timestamps
- **☁️ Auto S3 Upload**: Immediate cloud backup with verification
- **🔧 Self-Healing**: Automatic reconnection with exponential backoff
- **📊 CloudWatch Monitoring**: Logs and custom metrics
- **🛡️ Production Ready**: Encrypted storage, IAM roles, hardened service

## 📖 Documentation

- **[Deployment Guide](docs/README.md)** - Complete setup instructions
- **[Troubleshooting](docs/DEPLOYMENT_FIXES.md)** - Common issues & solutions
- **[Project History](docs/CLEANUP_SUMMARY.md)** - Development notes

## 🔧 Current Configuration

- **Stream**: WPKN Community Radio (Bridgeport, CT)
- **Format**: MP3 128kbps segments every 5 minutes
- **Storage**: S3 with server-side encryption
- **Infrastructure**: ARM64 EC2 (t4g.small) with FFmpeg

## 🏗️ Architecture

```
Radio Stream → EC2 Instance → S3 Bucket
    ↓             ↓              ↓
WPKN AAC     FFmpeg→MP3    Auto-Upload
64kbps       128kbps       Encrypted
```

## 📋 Prerequisites

- AWS Account with CLI configured
- EC2 Key Pair for SSH access  
- Node.js 18+ for CDK deployment

## 🤝 Contributing

This is a specialized radio archiving system for WPKN. For issues or improvements, please open a GitHub issue.

---

**🎵 Built for WPKN Community Radio** | *Preserving community voices since 1963*
