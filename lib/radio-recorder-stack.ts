import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

export interface RadioRecorderStackProps extends cdk.StackProps {
  alertEmail?: string;
}

export class RadioRecorderStack extends cdk.Stack {
  public readonly identityPoolId: string;

  constructor(scope: Construct, id: string, props?: RadioRecorderStackProps) {
    super(scope, id, props);

    // Add alertEmail as a CloudFormation parameter
    const alertEmailParam = new cdk.CfnParameter(this, 'alertEmail', {
      type: 'String',
      description: 'Email address for error notifications',
    });

    // Create S3 bucket for storing recordings with CORS
    const recordingsBucket = new s3.Bucket(this, 'RadioRecordings', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'], // In production, restrict to your GitHub Pages domain
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
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

    // Add email subscription using the parameter
    alertTopic.addSubscription(
      new subscriptions.EmailSubscription(alertEmailParam.valueAsString)
    );

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
      'yum install -y python3-pip wget tar xz',
      
      // Install FFmpeg using pre-compiled binaries
      'mkdir -p ~/sources && cd ~/sources',
      'ARCH=$(uname -m)',
      'if [[ "$ARCH" == "x86_64" ]]; then',
      '  FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"',
      'else',
      '  FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"',
      'fi',
      'wget -O ffmpeg-release-static.tar.xz $FFMPEG_URL',
      'tar -xf ffmpeg-release-static.tar.xz',
      'cd ffmpeg-*-static',
      'mv ffmpeg ffprobe /usr/local/bin/',
      'chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe',
      'cd ~/ && rm -rf ~/sources',
      
      // Install Python dependencies
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

    // Create Cognito Identity Pool
    const identityPool = new cognito.CfnIdentityPool(this, 'RadioRecorderIdentityPool', {
      allowUnauthenticatedIdentities: true,
    });

    // Create IAM role for unauthenticated users
    const unauthRole = new iam.Role(this, 'CognitoDefaultUnauthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'unauthenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
    });

    // Grant read access to the S3 bucket for unauthenticated users
    recordingsBucket.grantRead(unauthRole);

    // Attach roles to identity pool
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        unauthenticated: unauthRole.roleArn,
      },
    });

    // Save identity pool ID for use in the frontend
    this.identityPoolId = identityPool.ref;

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

    // Add Identity Pool ID to outputs
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: this.identityPoolId,
      description: 'ID of the Cognito Identity Pool for web player',
    });
  }
}