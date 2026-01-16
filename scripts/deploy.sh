#!/bin/bash

# AWS CDK Deployment Script for Radio Recorder
# This script deploys the radio recorder infrastructure using AWS CDK

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
AWS_REGION=${AWS_REGION:-"us-east-1"}
STACK_NAME=${STACK_NAME:-"RadioRecorderStack"}
DEFAULT_STREAM_URL="https://ice25.securenetsystems.net/WPKN"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if required tools are installed
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed. Please install Node.js 18.x or later."
        exit 1
    fi
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed. Please install npm."
        exit 1
    fi
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        print_error "AWS CLI is not installed. Please install AWS CLI v2."
        exit 1
    fi
    
    # Check CDK
    if ! command -v cdk &> /dev/null; then
        print_warning "AWS CDK CLI is not installed globally. Installing..."
        npm install -g aws-cdk
    fi
    
    print_success "Prerequisites check completed"
}

# Function to validate AWS credentials
check_aws_credentials() {
    print_status "Checking AWS credentials..."
    
    if ! aws sts get-caller-identity &> /dev/null; then
        print_error "AWS credentials not configured or invalid."
        print_error "Please run 'aws configure' or set up AWS credentials."
        exit 1
    fi
    
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    print_success "AWS credentials validated for account: $ACCOUNT_ID"
}

# Function to install dependencies
install_dependencies() {
    print_status "Installing dependencies..."
    npm install
    print_success "Dependencies installed"
}

# Function to build the project
build_project() {
    print_status "Building TypeScript project..."
    npm run build
    print_success "Project built successfully"
}

# Function to bootstrap CDK if needed
bootstrap_cdk() {
    print_status "Checking CDK bootstrap status..."
    
    # Try to describe the bootstrap stack
    if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region $AWS_REGION &> /dev/null; then
        print_warning "CDK not bootstrapped in region $AWS_REGION. Bootstrapping..."
        cdk bootstrap aws://$ACCOUNT_ID/$AWS_REGION
        print_success "CDK bootstrap completed"
    else
        print_success "CDK already bootstrapped"
    fi
}

# Function to validate required parameters
validate_parameters() {
    print_status "Validating deployment parameters..."
    
    if [ -z "$STREAM_URL" ]; then
        print_warning "STREAM_URL not set, using default WPKN stream"
        export STREAM_URL="$DEFAULT_STREAM_URL"
    fi
    
    if [ -z "$KEY_PAIR_NAME" ]; then
        print_error "KEY_PAIR_NAME environment variable is required"
        print_error "Example: export KEY_PAIR_NAME='my-ec2-keypair'"
        exit 1
    fi
    
    # Validate that the key pair exists
    if ! aws ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --region $AWS_REGION &> /dev/null; then
        print_error "Key pair '$KEY_PAIR_NAME' does not exist in region $AWS_REGION"
        print_error "Please create the key pair first or specify an existing one"
        exit 1
    fi
    
    print_success "Parameters validated"
}

# Function to deploy the stack
deploy_stack() {
    print_status "Deploying CDK stack: $STACK_NAME"
    
    # Build context parameters
    CONTEXT_PARAMS=""
    CONTEXT_PARAMS="$CONTEXT_PARAMS -c streamUrl='$STREAM_URL'"
    CONTEXT_PARAMS="$CONTEXT_PARAMS -c keyPairName='$KEY_PAIR_NAME'"
    
    # Optional parameters
    if [ -n "$S3_BUCKET_NAME" ]; then
        CONTEXT_PARAMS="$CONTEXT_PARAMS -c s3BucketName='$S3_BUCKET_NAME'"
    fi
    
    if [ -n "$ALLOWED_SSH_CIDR" ]; then
        CONTEXT_PARAMS="$CONTEXT_PARAMS -c allowedSshCidr='$ALLOWED_SSH_CIDR'"
    fi
    
    if [ -n "$INSTANCE_TYPE" ]; then
        CONTEXT_PARAMS="$CONTEXT_PARAMS -c instanceType='$INSTANCE_TYPE'"
    else
        # Default to ARM-based instance for better price/performance
        CONTEXT_PARAMS="$CONTEXT_PARAMS -c instanceType='t4g.small'"
    fi
    
    if [ -n "$SEGMENT_MINUTES" ]; then
        CONTEXT_PARAMS="$CONTEXT_PARAMS -c segmentMinutes='$SEGMENT_MINUTES'"
    else
        # Default to 5-minute segments
        CONTEXT_PARAMS="$CONTEXT_PARAMS -c segmentMinutes='5'"
    fi
    
    # Deploy with parameters
    eval "cdk deploy $CONTEXT_PARAMS --require-approval never"
    
    print_success "Stack deployment completed"
}

# Function to show deployment outputs
show_outputs() {
    print_status "Fetching stack outputs..."
    
    OUTPUTS=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $AWS_REGION --query 'Stacks[0].Outputs' --output table 2>/dev/null || echo "")
    
    if [ -n "$OUTPUTS" ]; then
        echo ""
        print_success "Deployment outputs:"
        echo "$OUTPUTS"
    fi
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Environment Variables (Required):"
    echo "  STREAM_URL        - URL of the radio stream to record"
    echo "  KEY_PAIR_NAME     - Name of existing EC2 key pair for SSH access"
    echo ""
    echo "Environment Variables (Optional):"
    echo "  S3_BUCKET_NAME    - Custom S3 bucket name (auto-generated if not set)"
    echo "  ALLOWED_SSH_CIDR  - CIDR block for SSH access (default: 0.0.0.0/0)"
    echo "  INSTANCE_TYPE     - EC2 instance type (default: t3.small)"
    echo "  SEGMENT_MINUTES   - Recording segment duration (default: 5)"
    echo "  AWS_REGION        - AWS region (default: us-east-1)"
    echo "  STACK_NAME        - CloudFormation stack name (default: RadioRecorderStack)"
    echo ""
    echo "Examples:"
    echo "  # Basic deployment"
    echo "  export STREAM_URL='http://stream.example.com/live'"
    echo "  export KEY_PAIR_NAME='my-keypair'"
    echo "  $0"
    echo ""
    echo "  # Custom configuration"
    echo "  export STREAM_URL='http://stream.example.com/live'"
    echo "  export KEY_PAIR_NAME='my-keypair'"
    echo "  export S3_BUCKET_NAME='my-radio-recordings'"
    echo "  export INSTANCE_TYPE='t3.medium'"
    echo "  export ALLOWED_SSH_CIDR='10.0.0.0/8'"
    echo "  $0"
}

# Main execution
main() {
    echo "======================================"
    echo "   Radio Recorder CDK Deployment"
    echo "======================================"
    echo ""
    
    # Check for help flag
    if [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
        show_usage
        exit 0
    fi
    
    # Run deployment steps
    check_prerequisites
    check_aws_credentials
    validate_parameters
    install_dependencies
    build_project
    bootstrap_cdk
    deploy_stack
    show_outputs
    
    echo ""
    print_success "Radio Recorder deployment completed successfully!"
    echo ""
    print_status "Next steps:"
    echo "1. Wait for the EC2 instance to complete initialization (5-10 minutes)"
    echo "2. SSH to the instance to check status: ssh -i $KEY_PAIR_NAME.pem ec2-user@<instance-ip>"
    echo "3. Check service status: sudo systemctl status radio-recorder.service"
    echo "4. View logs: sudo journalctl -u radio-recorder.service -f"
    echo "5. Run health check: /usr/local/bin/radio-recorder-status"
}

# Run main function
main "$@"
