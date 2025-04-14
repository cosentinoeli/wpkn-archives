#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RadioRecorderStack } from '../lib/radio-recorder-stack';

const app = new cdk.App();
new RadioRecorderStack(app, 'RadioRecorderStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});