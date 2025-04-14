const isGitHubPages = window.location.hostname.includes('github.io');

// Define environment-specific configurations with multiple options to try
const environments = {
    local: {
        region: 'us-east-1',
        bucketName: 'radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror',
        identityPoolId: 'us-east-1:5d67a507-3899-4c17-bcaa-1d70bf21b30d',
        // Look in recordings/ folder first, then samples
        recordingsPrefix: 'recordings/',
        alternativePrefixes: ['recordings/samples/', '', 'test_recordings/'],
        s3Options: {} // Default options for local
    },
    githubPages: {
        region: 'us-east-1',
        bucketName: 'radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror',
        identityPoolId: 'us-east-1:5d67a507-3899-4c17-bcaa-1d70bf21b30d',
        // Look in recordings/ folder first, then samples
        recordingsPrefix: 'recordings/',
        alternativePrefixes: ['recordings/samples/', '', 'test_recordings/'],
        
        // S3 options specifically tuned for GitHub Pages
        s3Options: {
            s3ForcePathStyle: true,
            signatureVersion: 'v4',
            correctClockSkew: true,
            endpoint: 's3://radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror/recordings/',
            httpOptions: { timeout: 60000 }
        }
    }
};

// Select configuration based on environment
const config = isGitHubPages ? environments.githubPages : environments.local;

// Add some helpful debug info
console.log(`Using ${isGitHubPages ? 'GitHub Pages' : 'local'} configuration`);
console.log('Config:', config);