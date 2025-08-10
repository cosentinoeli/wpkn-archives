import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import { RadioRecorderStack } from '../lib/radio-recorder-stack';

describe('RadioRecorderStack', () => {
  let app: cdk.App;
  let stack: RadioRecorderStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new RadioRecorderStack(app, 'TestRadioRecorderStack', {
      streamUrl: 'https://ice25.securenetsystems.net/WPKN',
      keyPairName: 'test-keypair',
      s3BucketName: 'test-radio-recordings',
      instanceType: 't4g.micro',
      segmentMinutes: 5,
      env: { account: '123456789012', region: 'us-east-1' }
    });
    template = Template.fromStack(stack);
  });

  test('creates S3 bucket with correct configuration', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'test-radio-recordings',
      VersioningConfiguration: {
        Status: 'Enabled'
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256'
          }
        }]
      }
    });
  });

  test('creates EC2 instance with correct properties', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.micro',
      KeyName: 'test-keypair'
    });
  });

  test('creates IAM role with S3 permissions', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Effect: 'Allow',
          Principal: {
            Service: 'ec2.amazonaws.com'
          },
          Action: 'sts:AssumeRole'
        }]
      }
    });
  });

  test('creates security group with SSH access', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [{
        IpProtocol: 'tcp',
        FromPort: 22,
        ToPort: 22,
        CidrIp: '0.0.0.0/0'
      }]
    });
  });

  test('creates EBS volume for recordings', () => {
    template.hasResourceProperties('AWS::EC2::Volume', {
      Size: 100,
      VolumeType: 'gp3',
      Encrypted: true
    });
  });

  test('creates CloudWatch log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/ec2/radio-recorder',
      RetentionInDays: 30
    });
  });

  test('has correct number of outputs', () => {
    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs)).toHaveLength(6);
  });

  test('user data contains required components', () => {
    const userData = template.findResources('AWS::EC2::Instance');
    const instanceResource = Object.values(userData)[0] as any;
    const userDataValue = instanceResource.Properties.UserData['Fn::Base64'];
    
    expect(userDataValue).toContain('dnf install -y ffmpeg');
    expect(userDataValue).toContain('radio-recorder.service');
    expect(userDataValue).toContain('ice25.securenetsystems.net/WPKN');
    expect(userDataValue).toContain('test-radio-recordings');
  });
});
