import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { Construct } from 'constructs';

export interface RadioArchivesV2StackProps extends cdk.StackProps {
  alertEmail?: string;
  googleCalendarId?: string;
}

export class RadioArchivesV2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: RadioArchivesV2StackProps) {
    super(scope, id, props);

    // CloudFormation parameters
    const alertEmailParam = new cdk.CfnParameter(this, 'alertEmail', {
      type: 'String',
      description: 'Email address for error notifications',
      default: props?.alertEmail || '',
    });

    const calendarIdParam = new cdk.CfnParameter(this, 'googleCalendarId', {
      type: 'String',
      description: 'Google Calendar ID for show schedules',
      default: props?.googleCalendarId || '',
    });

    // ============================================================================
    // STORAGE LAYER
    // ============================================================================

    // S3 bucket for recordings
    const recordingsBucket = new s3.Bucket(this, 'RecordingsBucketV2', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'], // Restrict in production
          exposedHeaders: ['ETag', 'Content-Length'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // ============================================================================
    // DATABASE LAYER
    // ============================================================================

    // DynamoDB table for Shows
    const showsTable = new dynamodb.Table(this, 'ShowsTable', {
      partitionKey: { name: 'showId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // Add GSI for querying by calendar event ID
    showsTable.addGlobalSecondaryIndex({
      indexName: 'calendarEventIndex',
      partitionKey: { name: 'calendarEventId', type: dynamodb.AttributeType.STRING },
    });

    // DynamoDB table for Recordings
    const recordingsTable = new dynamodb.Table(this, 'RecordingsTable', {
      partitionKey: { name: 'recordingId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordingDate', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // Add GSI for querying recordings by show
    recordingsTable.addGlobalSecondaryIndex({
      indexName: 'showIdIndex',
      partitionKey: { name: 'showId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recordingDate', type: dynamodb.AttributeType.STRING },
    });

    // Add GSI for querying recordings by date
    recordingsTable.addGlobalSecondaryIndex({
      indexName: 'dateIndex',
      partitionKey: { name: 'dateKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startTime', type: dynamodb.AttributeType.STRING },
    });

    // ============================================================================
    // NOTIFICATIONS
    // ============================================================================

    const alertTopic = new sns.Topic(this, 'ArchivesAlertsV2');
    if (alertEmailParam.valueAsString) {
      alertTopic.addSubscription(
        new subscriptions.EmailSubscription(alertEmailParam.valueAsString)
      );
    }

    // ============================================================================
    // LAMBDA FUNCTIONS - API HANDLERS
    // ============================================================================

    // Shared Lambda execution role
    const lambdaRole = new iam.Role(this, 'ApiLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    showsTable.grantReadWriteData(lambdaRole);
    recordingsTable.grantReadWriteData(lambdaRole);
    recordingsBucket.grantRead(lambdaRole);
    alertTopic.grantPublish(lambdaRole);

    // Environment variables for Lambdas
    const lambdaEnvironment = {
      SHOWS_TABLE: showsTable.tableName,
      RECORDINGS_TABLE: recordingsTable.tableName,
      BUCKET_NAME: recordingsBucket.bucketName,
      ALERT_TOPIC_ARN: alertTopic.topicArn,
    };

    // API Lambda: List Shows
    const listShowsLambda = new lambda.Function(this, 'ListShowsFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
        const { unmarshall } = require('@aws-sdk/util-dynamodb');
        
        exports.handler = async (event) => {
          const client = new DynamoDBClient({});
          
          try {
            const command = new ScanCommand({
              TableName: process.env.SHOWS_TABLE,
            });
            
            const response = await client.send(command);
            const shows = response.Items.map(item => unmarshall(item));
            
            return {
              statusCode: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
              body: JSON.stringify({ shows }),
            };
          } catch (error) {
            console.error('Error:', error);
            return {
              statusCode: 500,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
              body: JSON.stringify({ error: 'Failed to fetch shows' }),
            };
          }
        };
      `),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
    });

    // API Lambda: Get Show Details
    const getShowLambda = new lambda.Function(this, 'GetShowFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
        const { unmarshall } = require('@aws-sdk/util-dynamodb');
        
        exports.handler = async (event) => {
          const client = new DynamoDBClient({});
          const showId = event.pathParameters?.id;
          
          if (!showId) {
            return {
              statusCode: 400,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: JSON.stringify({ error: 'Show ID required' }),
            };
          }
          
          try {
            const command = new GetItemCommand({
              TableName: process.env.SHOWS_TABLE,
              Key: { showId: { S: showId } },
            });
            
            const response = await client.send(command);
            
            if (!response.Item) {
              return {
                statusCode: 404,
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ error: 'Show not found' }),
              };
            }
            
            return {
              statusCode: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
              body: JSON.stringify(unmarshall(response.Item)),
            };
          } catch (error) {
            console.error('Error:', error);
            return {
              statusCode: 500,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: JSON.stringify({ error: 'Failed to fetch show' }),
            };
          }
        };
      `),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
    });

    // API Lambda: List Recordings
    const listRecordingsLambda = new lambda.Function(this, 'ListRecordingsFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, QueryCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
        const { unmarshall } = require('@aws-sdk/util-dynamodb');
        
        exports.handler = async (event) => {
          const client = new DynamoDBClient({});
          const showId = event.queryStringParameters?.showId;
          const date = event.queryStringParameters?.date;
          
          try {
            let command;
            
            if (showId) {
              // Query by show ID
              command = new QueryCommand({
                TableName: process.env.RECORDINGS_TABLE,
                IndexName: 'showIdIndex',
                KeyConditionExpression: 'showId = :showId',
                ExpressionAttributeValues: {
                  ':showId': { S: showId },
                },
                ScanIndexForward: false, // Most recent first
                Limit: 50,
              });
            } else if (date) {
              // Query by date
              command = new QueryCommand({
                TableName: process.env.RECORDINGS_TABLE,
                IndexName: 'dateIndex',
                KeyConditionExpression: 'dateKey = :date',
                ExpressionAttributeValues: {
                  ':date': { S: date },
                },
              });
            } else {
              // Scan all (with limit)
              command = new ScanCommand({
                TableName: process.env.RECORDINGS_TABLE,
                Limit: 50,
              });
            }
            
            const response = await client.send(command);
            const recordings = response.Items.map(item => unmarshall(item));
            
            return {
              statusCode: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
              body: JSON.stringify({ recordings }),
            };
          } catch (error) {
            console.error('Error:', error);
            return {
              statusCode: 500,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: JSON.stringify({ error: 'Failed to fetch recordings' }),
            };
          }
        };
      `),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
    });

    // API Lambda: Get Recording Details
    const getRecordingLambda = new lambda.Function(this, 'GetRecordingFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
        const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
        const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
        const { unmarshall } = require('@aws-sdk/util-dynamodb');
        
        exports.handler = async (event) => {
          const dynamoClient = new DynamoDBClient({});
          const s3Client = new S3Client({});
          const recordingId = event.pathParameters?.id;
          
          if (!recordingId) {
            return {
              statusCode: 400,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: JSON.stringify({ error: 'Recording ID required' }),
            };
          }
          
          try {
            const command = new GetItemCommand({
              TableName: process.env.RECORDINGS_TABLE,
              Key: { recordingId: { S: recordingId } },
            });
            
            const response = await dynamoClient.send(command);
            
            if (!response.Item) {
              return {
                statusCode: 404,
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ error: 'Recording not found' }),
              };
            }
            
            const recording = unmarshall(response.Item);
            
            // Generate presigned URL for audio file if s3Key exists
            if (recording.s3Key) {
              const signedUrl = await getSignedUrl(s3Client, new HeadObjectCommand({
                Bucket: process.env.BUCKET_NAME,
                Key: recording.s3Key,
              }), { expiresIn: 3600 });
              
              recording.audioUrl = signedUrl.replace('HeadObject', 'GetObject');
            }
            
            return {
              statusCode: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
              body: JSON.stringify(recording),
            };
          } catch (error) {
            console.error('Error:', error);
            return {
              statusCode: 500,
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: JSON.stringify({ error: 'Failed to fetch recording' }),
            };
          }
        };
      `),
      environment: lambdaEnvironment,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30),
    });

    // API Lambda: Config endpoint
    const configLambda = new lambda.Function(this, 'ConfigFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/config'),
      environment: {
        BUCKET_NAME: recordingsBucket.bucketName,
        IDENTITY_POOL_ID: '', // Will be set after identity pool is created
        REGION: this.region,
      },
      timeout: cdk.Duration.seconds(10),
    });

    // ============================================================================
    // API GATEWAY
    // ============================================================================

    const api = new apigateway.RestApi(this, 'RadioArchivesApi', {
      restApiName: 'Radio Archives API',
      description: 'API for WPKN Radio Archives',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
    });

    // API Resources and Methods
    const showsResource = api.root.addResource('shows');
    showsResource.addMethod('GET', new apigateway.LambdaIntegration(listShowsLambda));

    const showResource = showsResource.addResource('{id}');
    showResource.addMethod('GET', new apigateway.LambdaIntegration(getShowLambda));

    const recordingsResource = api.root.addResource('recordings');
    recordingsResource.addMethod('GET', new apigateway.LambdaIntegration(listRecordingsLambda));

    const recordingResource = recordingsResource.addResource('{id}');
    recordingResource.addMethod('GET', new apigateway.LambdaIntegration(getRecordingLambda));

    // Config endpoint for frontend
    const configResource = api.root.addResource('config');
    configResource.addMethod('GET', new apigateway.LambdaIntegration(configLambda));

    // ============================================================================
    // SCHEDULE MANAGER - Google Calendar Integration
    // ============================================================================

    // Import Google Calendar secret from Secrets Manager
    const googleCalendarSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoogleCalendarSecret',
      'wpkn/google-calendar'
    );

    // Dedicated role for schedule manager with EventBridge permissions
    const scheduleManagerRole = new iam.Role(this, 'ScheduleManagerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    showsTable.grantReadWriteData(scheduleManagerRole);
    recordingsTable.grantReadWriteData(scheduleManagerRole);
    alertTopic.grantPublish(scheduleManagerRole);
    googleCalendarSecret.grantRead(scheduleManagerRole);

    // Grant EventBridge permissions
    scheduleManagerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'events:PutRule',
        'events:PutTargets',
        'events:DeleteRule',
        'events:RemoveTargets',
        'events:DescribeRule',
      ],
      resources: ['*'],
    }));

    // Grant ECS permissions for triggering recording tasks
    scheduleManagerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecs:RunTask',
        'ecs:DescribeTasks',
        'iam:PassRole',
      ],
      resources: ['*'],
    }));

    const scheduleManagerLambda = new lambda.Function(this, 'ScheduleManagerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/schedule-manager'),
      environment: {
        ...lambdaEnvironment,
        GOOGLE_CALENDAR_SECRET_ARN: googleCalendarSecret.secretArn,
      },
      role: scheduleManagerRole,
      timeout: cdk.Duration.minutes(5),
    });

    // Schedule the sync to run every hour
    const scheduleRule = new events.Rule(this, 'ScheduleSyncRule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Sync Google Calendar every hour',
    });

    scheduleRule.addTarget(new targets.LambdaFunction(scheduleManagerLambda));

    // ============================================================================
    // RECORDING SERVICE - ECS FARGATE
    // ============================================================================

    // Use default VPC (or create one if needed)
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });

    // ECS Cluster for recording tasks
    const ecsCluster = new ecs.Cluster(this, 'RecordingCluster', {
      vpc,
      clusterName: 'wpkn-recording-cluster',
    });

    // ECR Repository for recording container
    const recordingRepo = new ecr.Repository(this, 'RecordingRepo', {
      repositoryName: 'wpkn-recording',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
    });

    // CloudWatch Log Group for recording tasks
    const recordingLogGroup = new logs.LogGroup(this, 'RecordingLogs', {
      logGroupName: '/ecs/wpkn-recording',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Execution Role (for pulling images, writing logs)
    const taskExecutionRole = new iam.Role(this, 'RecordingTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task Role (for actual recording: S3, DynamoDB, SNS)
    const taskRole = new iam.Role(this, 'RecordingTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Grant permissions
    recordingsBucket.grantReadWrite(taskRole);
    showsTable.grantReadData(taskRole);
    recordingsTable.grantReadWriteData(taskRole);
    alertTopic.grantPublish(taskRole);

    // Task Definition
    const recordingTask = new ecs.FargateTaskDefinition(this, 'RecordingTask', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole,
      executionRole: taskExecutionRole,
    });

    // Container Definition (will use image from ECR after build)
    const recordingContainer = recordingTask.addContainer('RecordingContainer', {
      image: ecs.ContainerImage.fromEcrRepository(recordingRepo, 'latest'),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'recording',
        logGroup: recordingLogGroup,
      }),
      environment: {
        STREAM_URL: 'https://ice25.securenetsystems.net/WPKN',
        BUCKET_NAME: recordingsBucket.bucketName,
        RECORDINGS_TABLE: recordingsTable.tableName,
        ALERT_TOPIC_ARN: alertTopic.topicArn,
      },
    });

    // Store ECS configuration for schedule manager
    scheduleManagerLambda.addEnvironment('CLUSTER_ARN', ecsCluster.clusterArn);
    scheduleManagerLambda.addEnvironment('TASK_DEFINITION_ARN', recordingTask.taskDefinitionArn);
    scheduleManagerLambda.addEnvironment('SUBNET_IDS', vpc.publicSubnets.map(s => s.subnetId).join(','));
    scheduleManagerLambda.addEnvironment('ACCOUNT_ID', cdk.Stack.of(this).account);

    // ============================================================================
    // COGNITO - User Authentication (optional)
    // ============================================================================

    const identityPool = new cognito.CfnIdentityPool(this, 'ArchivesIdentityPool', {
      allowUnauthenticatedIdentities: true,
    });

    const unauthRole = new iam.Role(this, 'CognitoUnauthRole', {
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

    recordingsBucket.grantRead(unauthRole);

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        unauthenticated: unauthRole.roleArn,
      },
    });

    // Update config lambda with identity pool ID
    configLambda.addEnvironment('IDENTITY_POOL_ID', identityPool.ref);

    // ============================================================================
    // OUTPUTS
    // ============================================================================

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint URL',
    });

    new cdk.CfnOutput(this, 'RecordingsBucketName', {
      value: recordingsBucket.bucketName,
      description: 'S3 bucket for recordings',
    });

    new cdk.CfnOutput(this, 'ShowsTableName', {
      value: showsTable.tableName,
      description: 'DynamoDB table for shows',
    });

    new cdk.CfnOutput(this, 'RecordingsTableName', {
      value: recordingsTable.tableName,
      description: 'DynamoDB table for recordings',
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      description: 'Cognito Identity Pool ID',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: recordingRepo.repositoryUri,
      description: 'ECR repository URI for recording container',
    });

    new cdk.CfnOutput(this, 'EcsClusterArn', {
      value: ecsCluster.clusterArn,
      description: 'ECS cluster ARN for recordings',
    });

    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: recordingTask.taskDefinitionArn,
      description: 'ECS task definition ARN',
    });
  }
}
