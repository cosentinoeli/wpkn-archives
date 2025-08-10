#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RadioRecorderStack } from '../lib/radio-recorder-stack';

const app = new cdk.App();

// Get configuration from context or environment
const streamUrl = app.node.tryGetContext('streamUrl') || process.env.STREAM_URL || 'https://ice25.securenetsystems.net/WPKN';
const s3BucketName = app.node.tryGetContext('s3BucketName') || process.env.S3_BUCKET_NAME;
const keyPairName = app.node.tryGetContext('keyPairName') || process.env.KEY_PAIR_NAME;
const allowedSshCidr = app.node.tryGetContext('allowedSshCidr') || process.env.ALLOWED_SSH_CIDR || '0.0.0.0/0';
const instanceType = app.node.tryGetContext('instanceType') || process.env.INSTANCE_TYPE || 't4g.small';
const segmentMinutes = app.node.tryGetContext('segmentMinutes') || process.env.SEGMENT_MINUTES || '5';

// Validate required parameters
if (!streamUrl || streamUrl === 'https://ice25.securenetsystems.net/WPKN') {
  // Allow the default WPKN stream, but warn if no custom stream is provided
  console.log('Using default WPKN stream: https://ice25.securenetsystems.net/WPKN');
}

if (!keyPairName) {
  throw new Error('EC2 Key Pair name is required. Set via context: -c keyPairName=<name> or environment variable KEY_PAIR_NAME');
}

new RadioRecorderStack(app, 'RadioRecorderStack', {
  streamUrl,
  s3BucketName,
  keyPairName,
  allowedSshCidr,
  instanceType,
  segmentMinutes: parseInt(segmentMinutes),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'EC2-based radio stream recorder with S3 upload capabilities'
});
