#!/bin/bash

# Test ECS recording task
# Usage: ./test-recording.sh

set -e

echo "=== Testing ECS Recording Task ==="

# Get cluster and task definition from CDK outputs
CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name RadioArchivesV2Stack \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsClusterArn`].OutputValue' --output text)

TASK_DEF_ARN=$(aws cloudformation describe-stacks --stack-name RadioArchivesV2Stack \
  --query 'Stacks[0].Outputs[?OutputKey==`TaskDefinitionArn`].OutputValue' --output text)

# Get VPC and subnet information
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "us-east-1")

# Get default VPC subnets
SUBNETS=$(aws ec2 describe-subnets --filters "Name=default-for-az,Values=true" \
  --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')

echo "Cluster: $CLUSTER_ARN"
echo "Task Definition: $TASK_DEF_ARN"
echo "Subnets: $SUBNETS"
echo ""

# Test recording (30 seconds)
TEST_SHOW_ID="test-show-$(date +%s)"
TEST_START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "Starting test recording..."
echo "  Show ID: $TEST_SHOW_ID"
echo "  Duration: 30 seconds"
echo "  Start Time: $TEST_START_TIME"
echo ""

# Run ECS task
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER_ARN" \
  --task-definition "$TASK_DEF_ARN" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],assignPublicIp=ENABLED}" \
  --overrides "{
    \"containerOverrides\": [
      {
        \"name\": \"RecordingContainer\",
        \"environment\": [
          {\"name\": \"SHOW_ID\", \"value\": \"$TEST_SHOW_ID\"},
          {\"name\": \"SHOW_NAME\", \"value\": \"Test Recording\"},
          {\"name\": \"DURATION\", \"value\": \"30\"},
          {\"name\": \"START_TIME\", \"value\": \"$TEST_START_TIME\"}
        ]
      }
    ]
  }" \
  --query 'tasks[0].taskArn' \
  --output text)

echo "✓ Task started: $TASK_ARN"
echo ""
echo "Monitor task:"
echo "  aws ecs describe-tasks --cluster $CLUSTER_ARN --tasks $TASK_ARN"
echo ""
echo "View logs:"
echo "  aws logs tail /ecs/wpkn-recording --follow"
echo ""
echo "Expected recording file:"
echo "  s3://BUCKET_NAME/recordings/$TEST_SHOW_ID/$TEST_SHOW_ID-*.mp3"
