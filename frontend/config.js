// Configuration - loaded dynamically from API
let CONFIG = {
    // Defaults - will be overridden by API
    API_ENDPOINT: '',
    BUCKET_NAME: '',
    REGION: 'us-east-1',
    IDENTITY_POOL_ID: '',
    DEFAULT_VOLUME: 0.8,
    WAVEFORM_COLOR: '#00ff00',
    WAVEFORM_BG_COLOR: '#000000',
};

// Load configuration from API endpoint
async function loadConfig() {
    try {
        // Use relative path if on same domain, or full URL for local testing
        const configUrl = window.location.hostname === 'localhost' 
            ? 'https://ar0jfyf0bi.execute-api.us-east-1.amazonaws.com/v1/config'
            : '/v1/config';
        
        const response = await fetch(configUrl);
        if (!response.ok) {
            throw new Error('Failed to load config');
        }
        
        const config = await response.json();
        
        // Derive API endpoint from config URL (remove /config, keep /v1)
        const apiEndpoint = configUrl.replace('/config', '');
        
        // Update CONFIG object
        CONFIG.API_ENDPOINT = apiEndpoint;
        CONFIG.BUCKET_NAME = config.bucketName;
        CONFIG.REGION = config.region;
        CONFIG.IDENTITY_POOL_ID = config.identityPoolId;
        CONFIG.DEFAULT_VOLUME = config.defaultVolume || 0.8;
        CONFIG.WAVEFORM_COLOR = config.waveformColor || '#00ff00';
        CONFIG.WAVEFORM_BG_COLOR = config.waveformBgColor || '#000000';
        
        console.log('Configuration loaded successfully');
    } catch (error) {
        console.error('Failed to load configuration:', error);
        alert('Failed to load application configuration. Please refresh the page.');
    }
}

