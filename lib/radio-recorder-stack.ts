import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as path from 'path';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

export interface RadioRecorderStackProps extends cdk.StackProps {
  alertEmail?: string;
}

export class RadioRecorderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: RadioRecorderStackProps) {
    super(scope, id, props);

    // Create S3 bucket for storing recordings
    const recordingsBucket = new s3.Bucket(this, 'RadioRecordings', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // Create SNS topic for alerts
    const alertTopic = new sns.Topic(this, 'RadioRecorderAlerts');

    // Add email subscription if provided
    if (props?.alertEmail) {
      alertTopic.addSubscription(
        new subscriptions.EmailSubscription(props.alertEmail)
      );
    }

    // Create VPC
    const vpc = new ec2.Vpc(this, 'RadioRecorderVPC', {
      maxAzs: 2,
      natGateways: 1,
    });

    // Create EC2 role
    const ec2Role = new iam.Role(this, 'RadioRecorderEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    // Add permissions to role
    ec2Role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );
    recordingsBucket.grantReadWrite(ec2Role);
    alertTopic.grantPublish(ec2Role);

    // Create assets for deployment
    const recorderScript = new Asset(this, 'RecorderScript', {
      path: path.join(__dirname, '../scripts/radio_recorder.py'),
    });

    const serviceFile = new Asset(this, 'ServiceFile', {
      path: path.join(__dirname, '../scripts/radio-recorder.service'),
    });

    // Create EC2 instance
    const instance = new ec2.Instance(this, 'RadioRecorderInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: new ec2.AmazonLinuxImage({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      role: ec2Role,
    });

    // Grant read permissions for the assets
    recorderScript.grantRead(instance.role);
    serviceFile.grantRead(instance.role);

    // Add user data script to set up the recording service
    instance.addUserData(
      'yum update -y',
      'yum install -y ffmpeg python3-pip',
      'pip3 install boto3 requests',
      
      // Create service directory
      'mkdir -p /opt/radio-recorder',
      
      // Download deployment assets
      `aws s3 cp ${recorderScript.s3ObjectUrl} /opt/radio-recorder/radio_recorder.py`,
      `aws s3 cp ${serviceFile.s3ObjectUrl} /etc/systemd/system/radio-recorder.service`,
      
      // Set permissions
      'chmod +x /opt/radio-recorder/radio_recorder.py',
      
      // Configure and start service
      'sed -i "s/\\${S3_BUCKET}/' + recordingsBucket.bucketName + '/g" /etc/systemd/system/radio-recorder.service',
      'sed -i "s/\\${SNS_TOPIC_ARN}/' + alertTopic.topicArn + '/g" /etc/systemd/system/radio-recorder.service',
      'systemctl enable radio-recorder',
      'systemctl start radio-recorder'
    );

    // Output important information
    new cdk.CfnOutput(this, 'RecordingsBucketName', {
      value: recordingsBucket.bucketName,
      description: 'Name of the S3 bucket storing radio recordings',
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'ARN of the SNS topic for alerts',
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'ID of the EC2 instance running the recorder',
    });
  }
}