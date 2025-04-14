const isGitHubPages = window.location.hostname.includes('github.io');

// Define environment-specific configurations
const environments = {
    local: {
        region: 'us-east-1',
        bucketName: 'radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror',
        identityPoolId: 'us-east-1:5d67a507-3899-4c17-bcaa-1d70bf21b30d'
    },
    githubPages: {
        region: 'us-east-1',
        bucketName: 'radiorecorderstack-radiorecordings3d118ea0-ypnp78o0qror',
        identityPoolId: 'us-east-1:5d67a507-3899-4c17-bcaa-1d70bf21b30d',
        // Adding specific endpoint options for GitHub Pages
        s3ForcePathStyle: true, // Force path style URLs for S3
        credentials: {
            // Default role with permissions
            roleArn: undefined, // Will use the default role associated with the identity pool
            roleSessionName: 'github-pages-session'
        }
    }
};

// Select configuration based on environment
const config = isGitHubPages ? environments.githubPages : environments.local;

// Log which configuration we're using
console.log(`Using ${isGitHubPages ? 'GitHub Pages' : 'local'} configuration`);
console.log('Config:', JSON.stringify(config, null, 2));