#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RadioArchivesV2Stack } from '../lib/radio-archives-v2-stack';

const app = new cdk.App();

// V2 Stack - WPKN Radio Archives
new RadioArchivesV2Stack(app, 'RadioArchivesV2Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});