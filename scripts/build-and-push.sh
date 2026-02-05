#!/bin/bash

# Build and push recording container to ECR
# Usage: ./build-and-push.sh

set -e

echo "=== Building Recording Container ==="

# Get AWS account and region
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "us-east-1")

# ECR repository name
REPO_NAME="wpkn-recording"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}"

echo "Account: $ACCOUNT_ID"
echo "Region: $REGION"
echo "ECR URI: $ECR_URI"

# Authenticate Docker to ECR
echo ""
echo "=== Authenticating to ECR ==="
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_URI

# Build Docker image
echo ""
echo "=== Building Docker image ==="
cd ecs/record-show
docker build -t $REPO_NAME:latest .

# Tag image
echo ""
echo "=== Tagging image ==="
docker tag $REPO_NAME:latest $ECR_URI:latest

# Push to ECR
echo ""
echo "=== Pushing to ECR ==="
docker push $ECR_URI:latest

echo ""
echo "✓ Successfully pushed image: $ECR_URI:latest"
echo ""
echo "Next steps:"
echo "  1. Deploy CDK stack: cdk deploy"
echo "  2. Trigger a test recording via schedule manager"
