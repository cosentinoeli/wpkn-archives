import json
import os

def handler(event, context):
    """
    Returns frontend configuration.
    This endpoint provides public configuration values needed by the frontend.
    The apiEndpoint is derived from the request context by the frontend.
    """
    
    config = {
        'bucketName': os.environ.get('BUCKET_NAME', ''),
        'region': os.environ.get('REGION', 'us-east-1'),
        'identityPoolId': os.environ.get('IDENTITY_POOL_ID', ''),
        'defaultVolume': 0.8,
        'waveformColor': '#00ff00',
        'waveformBgColor': '#000000'
    }
    
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300'  # Cache for 5 minutes
        },
        'body': json.dumps(config)
    }
