#!/bin/bash
# AWS Configuration Verification Script

BUCKET="radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror"
IDENTITY_POOL="us-east-1:5d67a507-3899-4c17-bcaa-1d70bf21b30d"

echo "===== S3 Bucket Verification ====="
echo "Checking if bucket exists..."
aws s3api head-bucket --bucket $BUCKET && echo "✅ Bucket exists!" || echo "❌ Bucket does not exist or you don't have access."

echo -e "\nListing top-level bucket contents:"
aws s3 ls s3://$BUCKET/ --human-readable

echo -e "\nChecking recordings/ directory:"
aws s3 ls s3://$BUCKET/recordings/ --human-readable

echo -e "\nChecking recordings/samples/ directory:"
aws s3 ls s3://$BUCKET/recordings/samples/ --human-readable

echo -e "\n===== CORS Configuration ====="
aws s3api get-bucket-cors --bucket $BUCKET || echo "❌ No CORS configuration found!"

echo -e "\n===== Cognito Identity Pool ====="
aws cognito-identity describe-identity-pool --identity-pool-id $IDENTITY_POOL || echo "❌ Identity pool not found or you don't have access."

echo -e "\n===== Done ====="
