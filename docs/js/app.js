// Initialize AWS SDK
AWS.config.region = config.region;
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: config.identityPoolId
});

// Environment detection
const isGitHubPages = window.location.hostname.includes('github.io');
console.log(`Running in ${isGitHubPages ? 'GitHub Pages' : 'local'} environment`);

// For GitHub Pages, let's try to prevent caching issues
if (isGitHubPages) {
    AWS.config.httpOptions = { timeout: 30000 };
    console.log("Applied GitHub Pages specific AWS configurations");
}

// Initialize variables
let currentSound = null;
let recordings = [];
let isPlaying = false;

// DOM Elements
const loadingIndicator = document.getElementById('loadingIndicator');
const errorMessage = document.getElementById('errorMessage');
const playlist = document.getElementById('playlist');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const playPauseBtn = document.getElementById('playPauseBtn');
const progressBar = document.getElementById('progressBar');
const progress = document.getElementById('progress');
const currentTimeDisplay = document.getElementById('currentTime');
const durationDisplay = document.getElementById('duration');
const muteBtn = document.getElementById('muteBtn');
const volumeSlider = document.getElementById('volumeSlider');
const nowPlayingText = document.getElementById('nowPlayingText');

// Initialize S3 client with environment-specific options
const s3 = new AWS.S3(config.s3Options || {});
console.log('S3 client initialized with options:', config.s3Options || 'default');

// Display AWS SDK version and configuration status
console.log(`AWS SDK Version: ${AWS.VERSION}`);
console.log(`S3 Endpoint: ${s3.endpoint}`);

// Fetch recordings from S3
async function fetchRecordings() {
    showLoading(true);
    try {
        // Refresh credentials to ensure they're valid
        await new Promise((resolve, reject) => {
            AWS.config.credentials.refresh(err => {
                if (err) {
                    console.error('Error refreshing credentials:', err);
                    reject(err);
                } else {
                    console.log('Credentials refreshed successfully');
                    resolve();
                }
            });
        });
        
        console.log(`Fetching recordings from bucket: ${config.bucketName}`);
        
        // Try to list objects from the primary prefix
        let data = await attemptListObjects(config.recordingsPrefix);
        
        // If no recordings found and we have alternative prefixes, try those
        if ((!data?.Contents || data.Contents.length === 0) && config.alternativePrefixes) {
            console.log('No recordings found in primary location, trying alternatives...');
            
            for (const prefix of config.alternativePrefixes) {
                console.log(`Trying alternative prefix: "${prefix}"`);
                data = await attemptListObjects(prefix);
                if (data?.Contents && data.Contents.length > 0) {
                    console.log(`Found ${data.Contents.length} items in "${prefix}"`);
                    break;
                }
            }
        }
        
        if (!data?.Contents || data.Contents.length === 0) {
            showError('No recordings found. This could be due to permissions, bucket configuration, or an empty bucket.');
            return;
        }

        console.log('Raw list results:', data);
        
        recordings = data.Contents
            .filter(item => item.Key.endsWith('.mp3'))
            .map(item => ({
                key: item.Key,
                name: item.Key.split('/').pop(),
                date: item.LastModified
            }));

        console.log(`Found ${recordings.length} MP3 recordings after filtering`);
        
        if (recordings.length === 0) {
            showError('No MP3 files found in the bucket. Please check that recordings have been uploaded.');
            return;
        }
        
        sortRecordings();
        renderPlaylist();
    } catch (error) {
        console.error('Error fetching recordings:', error);
        showError(`Failed to load recordings: ${error.message}. ${getEnvironmentSpecificErrorInfo(error)}`);
    } finally {
        showLoading(false);
    }
}

// Helper function to attempt listing objects with a specific prefix
async function attemptListObjects(prefix) {
    try {
        const params = {
            Bucket: config.bucketName,
            Prefix: prefix || '',
            MaxKeys: 100
        };
        
        console.log(`Listing objects with params:`, params);
        return await s3.listObjects(params).promise();
    } catch (error) {
        console.warn(`Failed to list with prefix "${prefix}":`, error);
        return null;
    }
}

// Provide additional environment-specific error info
function getEnvironmentSpecificErrorInfo(error) {
    if (isGitHubPages) {
        return "This may be due to CORS restrictions on GitHub Pages or AWS configuration.";
    }
    return "";
}

// Sort recordings based on selected option
function sortRecordings() {
    recordings.sort((a, b) => {
        return sortSelect.value === 'newest' 
            ? b.date - a.date 
            : a.date - b.date;
    });
}

// Render playlist items
function renderPlaylist() {
    const searchTerm = searchInput.value.toLowerCase();
    const filteredRecordings = recordings.filter(recording => 
        recording.name.toLowerCase().includes(searchTerm)
    );

    playlist.innerHTML = filteredRecordings.map(recording => `
        <li data-key="${recording.key}" class="playlist-item">
            ${formatRecordingName(recording.name)}
            <span class="recording-date">${formatDate(recording.date)}</span>
        </li>
    `).join('');

    // Add click handlers
    document.querySelectorAll('.playlist-item').forEach(item => {
        item.addEventListener('click', () => playRecording(item.dataset.key));
    });
}

// Format recording name for display
function formatRecordingName(name) {
    return name.replace(/recording_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.mp3/, 
        (_, date, time) => `${date} ${time.replace(/-/g, ':')}`);
}

// Format date for display
function formatDate(date) {
    return new Date(date).toLocaleString();
}

// Play selected recording
async function playRecording(key) {
    showLoading(true);
    try {
        // Stop current playback if any
        if (currentSound) {
            currentSound.unload();
        }

        // Generate presigned URL
        const url = await getSignedUrl(key);

        // Create new Howl instance
        currentSound = new Howl({
            src: [url],
            html5: true,
            onplay: () => {
                isPlaying = true;
                updatePlayPauseButton();
                nowPlayingText.textContent = formatRecordingName(key.split('/').pop());
            },
            onpause: () => {
                isPlaying = false;
                updatePlayPauseButton();
            },
            onend: () => {
                isPlaying = false;
                updatePlayPauseButton();
            },
            onloaderror: (_, error) => {
                showError('Error loading audio: ' + error);
            }
        });

        currentSound.play();
        updateActiveItem(key);
    } catch (error) {
        showError('Failed to play recording: ' + error.message);
    } finally {
        showLoading(false);
    }
}

// Generate presigned URL for S3 object
async function getSignedUrl(key) {
    console.log(`Generating signed URL for key: ${key}`);
    const params = {
        Bucket: config.bucketName,
        Key: key,
        Expires: 3600 // URL expires in 1 hour
    };

    return await new Promise((resolve, reject) => {
        s3.getSignedUrl('getObject', params, (error, url) => {
            if (error) {
                console.error('Error generating signed URL:', error);
                reject(error);
            } else {
                console.log('Successfully generated signed URL');
                resolve(url);
            }
        });
    });
}

// Update active playlist item
function updateActiveItem(key) {
    document.querySelectorAll('.playlist-item').forEach(item => {
        item.classList.toggle('active', item.dataset.key === key);
    });
}

// Update play/pause button state
function updatePlayPauseButton() {
    playPauseBtn.textContent = isPlaying ? 'Pause' : 'Play';
}

// Show/hide loading indicator
function showLoading(show) {
    loadingIndicator.classList.toggle('hidden', !show);
}

// Show/hide error message with more informative guidance
function showError(message) {
    console.error(message);
    errorMessage.innerHTML = `${message}<br>
        <small>If you're seeing this on GitHub Pages, ensure AWS credentials and CORS settings are properly configured.</small>`;
    errorMessage.classList.remove('hidden');
    // Keep error message visible longer to give users time to read it
    setTimeout(() => errorMessage.classList.add('hidden'), 8000);
}

// Event Listeners
playPauseBtn.addEventListener('click', () => {
    if (currentSound) {
        if (isPlaying) {
            currentSound.pause();
        } else {
            currentSound.play();
        }
    }
});

progressBar.addEventListener('click', (e) => {
    if (currentSound) {
        const percent = e.offsetX / progressBar.offsetWidth;
        const duration = currentSound.duration();
        currentSound.seek(duration * percent);
    }
});

volumeSlider.addEventListener('input', (e) => {
    if (currentSound) {
        const volume = parseInt(e.target.value) / 100;
        currentSound.volume(volume);
        muteBtn.textContent = volume === 0 ? '🔇' : '🔊';
    }
});

muteBtn.addEventListener('click', () => {
    if (currentSound) {
        const isMuted = currentSound.volume() === 0;
        currentSound.volume(isMuted ? 1 : 0);
        volumeSlider.value = isMuted ? 100 : 0;
        muteBtn.textContent = isMuted ? '🔊' : '🔇';
    }
});

searchInput.addEventListener('input', renderPlaylist);
sortSelect.addEventListener('change', () => {
    sortRecordings();
    renderPlaylist();
});

// Update progress bar and time displays
setInterval(() => {
    if (currentSound && isPlaying) {
        const seek = currentSound.seek() || 0;
        const duration = currentSound.duration() || 0;
        const progress = (seek / duration) * 100;
        
        document.getElementById('progress').style.width = `${progress}%`;
        currentTimeDisplay.textContent = formatTime(seek);
        durationDisplay.textContent = formatTime(duration);
    }
}, 100);

// Format time in MM:SS
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Initial load
fetchRecordings();