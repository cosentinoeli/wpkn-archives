// WPKN Radio Archives - Winamp Style Player
// Main Application

// State
let currentAudio = null;
let allShows = [];
let currentShow = null;
let allRecordings = [];
let filteredRecordings = [];
let currentRecordingIndex = -1;
let isPlaying = false;
let waveformAnimationId = null;

// DOM Elements
const audioPlayer = document.getElementById('audioPlayer');
const trackTitle = document.getElementById('trackTitle');
const currentTime = document.getElementById('currentTime');
const elapsed = document.getElementById('elapsed');
const total = document.getElementById('total');
const progressBar = document.getElementById('progressBar');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const volumeSlider = document.getElementById('volumeSlider');
const waveformCanvas = document.getElementById('waveform');
const waveformCtx = waveformCanvas.getContext('2d');
const showsList = document.getElementById('showsList');
const recordingsList = document.getElementById('recordingsList');
const scheduleList = document.getElementById('scheduleList');
const scheduleDate = document.getElementById('scheduleDate');
const todayBtn = document.getElementById('todayBtn');
const showSearch = document.getElementById('showSearch');
const selectedShowName = document.getElementById('selectedShowName');
const loading = document.getElementById('loading');

// Initialize
init();

async function init() {
    console.log('Initializing WPKN Radio Archives...');
    
    // Load configuration from API
    await loadConfig();
    
    // Set up event listeners
    setupEventListeners();
    
    // Initialize waveform
    initWaveform();
    
    // Set today's date in schedule
    setToday();
    
    // Load data
    await loadShows();
    await loadSchedule(new Date());
    
    console.log('Initialization complete');
}

function setupEventListeners() {
    // Player controls
    playBtn.addEventListener('click', play);
    pauseBtn.addEventListener('click', pause);
    stopBtn.addEventListener('click', stop);
    prevBtn.addEventListener('click', playPrevious);
    nextBtn.addEventListener('click', playNext);
    
    // Volume
    volumeSlider.addEventListener('input', (e) => {
        audioPlayer.volume = e.target.value / 100;
    });
    audioPlayer.volume = CONFIG.DEFAULT_VOLUME;
    volumeSlider.value = CONFIG.DEFAULT_VOLUME * 100;
    
    // Progress bar
    progressBar.addEventListener('input', (e) => {
        const time = (e.target.value / 100) * audioPlayer.duration;
        audioPlayer.currentTime = time;
    });
    
    // Audio events
    audioPlayer.addEventListener('timeupdate', updateProgress);
    audioPlayer.addEventListener('loadedmetadata', onAudioLoaded);
    audioPlayer.addEventListener('ended', onAudioEnded);
    audioPlayer.addEventListener('play', () => isPlaying = true);
    audioPlayer.addEventListener('pause', () => isPlaying = false);
    
    // Schedule
    scheduleDate.addEventListener('change', (e) => {
        loadSchedule(new Date(e.target.value));
    });
    todayBtn.addEventListener('click', () => {
        setToday();
        loadSchedule(new Date());
    });
    
    // Search
    showSearch.addEventListener('input', (e) => {
        filterShows(e.target.value);
    });
}

// API Functions
async function apiGet(endpoint) {
    try {
        const response = await fetch(`${CONFIG.API_ENDPOINT}${endpoint}`);
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

async function loadShows() {
    showLoading(true);
    try {
        const data = await apiGet('/shows');
        allShows = data.shows || [];
        allShows.sort((a, b) => (a.showName || '').localeCompare(b.showName || ''));
        renderShows(allShows);
    } catch (error) {
        console.error('Failed to load shows:', error);
        alert('Failed to load shows. Please refresh the page.');
    } finally {
        showLoading(false);
    }
}

async function loadRecordings(showId) {
    showLoading(true);
    try {
        const data = await apiGet('/recordings');
        // Filter recordings for this show
        allRecordings = (data.recordings || []).filter(r => r.showId === showId);
        allRecordings.sort((a, b) => new Date(b.recordingDate) - new Date(a.recordingDate));
        filteredRecordings = allRecordings;
        renderRecordings();
    } catch (error) {
        console.error('Failed to load recordings:', error);
        alert('Failed to load recordings.');
    } finally {
        showLoading(false);
    }
}

async function loadSchedule(date) {
    // For now, load shows and display them as schedule
    // In production, you'd have a proper schedule API
    try {
        const data = await apiGet('/shows');
        const shows = data.shows || [];
        renderSchedule(shows, date);
    } catch (error) {
        console.error('Failed to load schedule:', error);
    }
}

// Rendering Functions
function renderShows(shows) {
    showsList.innerHTML = '';
    shows.forEach(show => {
        const item = document.createElement('div');
        item.className = 'show-item';
        item.textContent = show.showName || 'Unknown Show';
        item.dataset.showId = show.showId;
        item.addEventListener('click', () => selectShow(show));
        showsList.appendChild(item);
    });
}

function renderRecordings() {
    recordingsList.innerHTML = '';
    
    if (filteredRecordings.length === 0) {
        recordingsList.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No recordings found</div>';
        return;
    }
    
    filteredRecordings.forEach((recording, index) => {
        const item = document.createElement('div');
        item.className = 'recording-item';
        item.dataset.index = index;
        
        const date = new Date(recording.recordingDate).toLocaleDateString();
        const title = recording.showName || 'Recording';
        const duration = formatDuration(recording.duration || 0);
        const size = formatSize(recording.fileSize || 0);
        
        item.innerHTML = `
            <span class="col-date">${date}</span>
            <span class="col-title">${title}</span>
            <span class="col-dur">${duration}</span>
            <span class="col-size">${size}</span>
        `;
        
        item.addEventListener('dblclick', () => playRecording(index));
        item.addEventListener('click', () => {
            document.querySelectorAll('.recording-item').forEach(r => r.classList.remove('selected'));
            item.classList.add('selected');
        });
        
        recordingsList.appendChild(item);
    });
}

function renderSchedule(shows, date) {
    scheduleList.innerHTML = '';
    
    // Filter shows by selected date
    const targetDate = date || new Date();
    const targetDateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD format
    
    const todaysShows = shows.filter(show => {
        if (!show.startTime) return false;
        const showDate = new Date(show.startTime).toISOString().split('T')[0];
        return showDate === targetDateStr;
    });
    
    // Sort by start time
    todaysShows.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    
    if (todaysShows.length === 0) {
        scheduleList.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No shows scheduled for this date</div>';
        return;
    }
    
    todaysShows.forEach(show => {
        const item = document.createElement('div');
        item.className = 'schedule-item';
        item.dataset.showId = show.showId;
        
        // Parse actual time and duration from API data
        const startTime = new Date(show.startTime);
        const endTime = new Date(show.endTime);
        
        // Format time (12-hour format)
        const timeString = startTime.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit', 
            hour12: true 
        });
        
        // Calculate and format duration
        const durationMs = show.duration * 1000; // duration is in seconds
        const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
        const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        
        let durationString = '';
        if (durationHours > 0) {
            durationString += `${durationHours}h`;
        }
        if (durationMinutes > 0) {
            durationString += `${durationMinutes}m`;
        }
        if (durationString === '') {
            durationString = '0m';
        }
        
        item.innerHTML = `
            <span class="col-time">${timeString}</span>
            <span class="col-show">${show.showName || 'Unknown'}</span>
            <span class="col-duration">${durationString}</span>
        `;
        
        item.addEventListener('click', () => {
            selectShow(show);
            // Scroll to shows panel
            document.querySelector('.shows-panel').scrollIntoView({ behavior: 'smooth' });
        });
        
        scheduleList.appendChild(item);
    });
}

// Show Selection
async function selectShow(show) {
    currentShow = show;
    selectedShowName.textContent = show.showName || 'Unknown Show';
    
    // Highlight selected show
    document.querySelectorAll('.show-item').forEach(item => {
        item.classList.remove('selected');
        if (item.dataset.showId === show.showId) {
            item.classList.add('selected');
        }
    });
    
    // Load recordings for this show
    await loadRecordings(show.showId);
}

// Search/Filter
function filterShows(searchTerm) {
    const term = searchTerm.toLowerCase().trim();
    const filtered = allShows.filter(show => 
        (show.showName || '').toLowerCase().includes(term)
    );
    renderShows(filtered);
}

// Playback Functions
async function playRecording(index) {
    if (index < 0 || index >= filteredRecordings.length) return;
    
    currentRecordingIndex = index;
    const recording = filteredRecordings[index];
    
    try {
        // Get recording details with presigned URL
        const recordingDetails = await apiGet(`/recordings/${recording.recordingId}`);
        
        if (!recordingDetails.audioUrl) {
            throw new Error('No audio URL available for this recording');
        }
        
        const audioUrl = recordingDetails.audioUrl;
        console.log('Playing:', audioUrl);
        
        // Update player
        audioPlayer.src = audioUrl;
        trackTitle.textContent = `${recording.showName} - ${new Date(recording.recordingDate).toLocaleDateString()}`;
        
        // Highlight playing recording
        document.querySelectorAll('.recording-item').forEach((item, idx) => {
            item.classList.remove('playing');
            if (idx === index) {
                item.classList.add('playing', 'selected');
            }
        });
        
        // Play
        await audioPlayer.play();
        
    } catch (error) {
        console.error('Playback error:', error);
        alert('Failed to play recording. The file may not be accessible or may have failed to record.');
    }
}

function play() {
    if (audioPlayer.src) {
        audioPlayer.play();
    } else if (filteredRecordings.length > 0) {
        playRecording(0);
    }
}

function pause() {
    audioPlayer.pause();
}

function stop() {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    stopWaveform();
}

function playPrevious() {
    if (currentRecordingIndex > 0) {
        playRecording(currentRecordingIndex - 1);
    }
}

function playNext() {
    if (currentRecordingIndex < filteredRecordings.length - 1) {
        playRecording(currentRecordingIndex + 1);
    }
}

function onAudioLoaded() {
    total.textContent = formatTime(audioPlayer.duration);
    progressBar.max = 100;
}

function onAudioEnded() {
    // Auto-play next
    playNext();
}

function updateProgress() {
    if (audioPlayer.duration) {
        const percent = (audioPlayer.currentTime / audioPlayer.duration) * 100;
        progressBar.value = percent;
        elapsed.textContent = formatTime(audioPlayer.currentTime);
        currentTime.textContent = formatTime(audioPlayer.currentTime);
    }
}

// Waveform Visualization
function initWaveform() {
    waveformCtx.fillStyle = CONFIG.WAVEFORM_BG_COLOR;
    waveformCtx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    startWaveform();
}

function startWaveform() {
    function draw() {
        // Clear canvas
        waveformCtx.fillStyle = CONFIG.WAVEFORM_BG_COLOR;
        waveformCtx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
        
        if (isPlaying) {
            // Draw waveform bars
            const barCount = 32;
            const barWidth = waveformCanvas.width / barCount;
            waveformCtx.fillStyle = CONFIG.WAVEFORM_COLOR;
            
            for (let i = 0; i < barCount; i++) {
                // Random height for demo (in production, use Web Audio API)
                const height = Math.random() * waveformCanvas.height * 0.8;
                const x = i * barWidth;
                const y = (waveformCanvas.height - height) / 2;
                
                waveformCtx.fillRect(x + 2, y, barWidth - 4, height);
            }
        }
        
        waveformAnimationId = requestAnimationFrame(draw);
    }
    
    draw();
}

function stopWaveform() {
    if (waveformAnimationId) {
        cancelAnimationFrame(waveformAnimationId);
        waveformAnimationId = null;
    }
    initWaveform();
}

// Utility Functions
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDuration(seconds) {
    if (!seconds) return '--:--';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
}

function formatSize(bytes) {
    if (!bytes) return '--';
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setToday() {
    const today = new Date().toISOString().split('T')[0];
    scheduleDate.value = today;
}

function showLoading(show) {
    loading.classList.toggle('hidden', !show);
}

// Initialize on load
console.log('WPKN Radio Archives loaded');
console.log('API Endpoint:', CONFIG.API_ENDPOINT);
