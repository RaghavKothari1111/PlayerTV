document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('urlInput');
    const playBtn = document.getElementById('playBtn');
    const videoPlayer = document.getElementById('videoPlayer');
    const videoContainer = document.getElementById('videoContainer');
    const placeholder = document.getElementById('placeholder');
    const statusMessage = document.getElementById('statusMessage');
    const fullscreenBtn = document.getElementById('fullscreenBtn');

    const audioSelect = document.getElementById('audioSelect');
    const subSelect = document.getElementById('subSelect');

    let hls = null;
    let heartbeatInterval = null;

    // --- Custom Controls Elements ---
    const playPauseBtn = document.getElementById('playPauseBtn');
    const muteBtn = document.getElementById('muteBtn');
    const volumeSlider = document.getElementById('volumeSlider');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressBuffer = document.getElementById('progressBuffer');
    const timeDisplay = document.getElementById('timeDisplay');

    // Initially show subtitle select
    // subSelect.style.display = 'none'; // REMOVED

    // --- Session Management ---
    let sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
        sessionId = 'sess-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('sessionId', sessionId);
    }
    console.log("Client Session ID:", sessionId);

    // --- Auto-Resume from LocalStorage ---
    const savedUrl = localStorage.getItem('lastVideoUrl');
    const savedTime = localStorage.getItem('lastVideoTime');

    if (savedUrl) {
        urlInput.value = savedUrl;
        console.log("Found saved URL. Waiting for user to play.");
        // OPTIONAL: Fetch metadata so options are ready, but DO NOT start stream.
        fetchMetadata();
    }

    // Fetch Metadata when URL changes
    urlInput.addEventListener('blur', fetchMetadata);
    urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            fetchMetadata();
            startStream('enterKey');
        }
    });

    // Play Button (Main)
    playBtn.addEventListener('click', () => {
        startStream('playBtn');
    });

    // Auto-fetch metadata if URL pasted
    urlInput.addEventListener('paste', () => {
        // User requested NO server process on paste. 
        // We will skip fetchMetadata too, or keep it? 
        // "only play stream option runs the stream"
        // Metadata is lightweight (ffprobe) but technicaly a server process.
        // I will keep it commented out to be safe. User can click or blur.
        // setTimeout(fetchMetadata, 100); 
    });

    // --- Custom Control Logic ---

    // Play/Pause Toggle
    playPauseBtn.addEventListener('click', togglePlay);
    videoPlayer.addEventListener('click', togglePlay); // Click video to toggle

    function togglePlay() {
        if (videoPlayer.paused) {
            videoPlayer.play();
            playPauseBtn.innerHTML = '<ion-icon name="pause"></ion-icon>';
            videoContainer.classList.remove('is-paused'); // Remove paused class
            startInactivityTimer(); // Start hiding logic
        } else {
            videoPlayer.pause();
            playPauseBtn.innerHTML = '<ion-icon name="play"></ion-icon>';
            videoContainer.classList.add('is-paused'); // Keep controls visible
            clearTimeout(inactivityTimeout); // Stop hiding logic
            videoContainer.classList.add('user-active'); // Ensure visible
        }
    }

    videoPlayer.addEventListener('play', () => {
        playPauseBtn.innerHTML = '<ion-icon name="pause"></ion-icon>';
        logToServer('[Event] Video Play');
    });

    videoPlayer.addEventListener('pause', () => {
        playPauseBtn.innerHTML = '<ion-icon name="play"></ion-icon>';
        logToServer('[Event] Video Pause');
    });

    videoPlayer.addEventListener('error', (e) => {
        logToServer(`[Error] Video Error: ${videoPlayer.error ? videoPlayer.error.message : 'Unknown'}`);
    });

    videoPlayer.addEventListener('waiting', () => logToServer('[Event] Video Waiting (Buffering)'));
    videoPlayer.addEventListener('playing', () => logToServer('[Event] Video Playing'));
    videoPlayer.addEventListener('ended', () => logToServer('[Event] Video Ended'));

    // Time Update & Progress
    videoPlayer.addEventListener('timeupdate', updateProgress);
    videoPlayer.addEventListener('progress', updateBuffer); // Listen for buffer updates

    let serverDuration = 0; // Store duration from metadata

    // Helper: Get best available duration
    function getDuration() {
        // Native HLS often reports Infinity
        if (videoPlayer.duration && isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
            return videoPlayer.duration;
        }
        return serverDuration;
    }

    function updateProgress() {
        const duration = getDuration();
        if (!duration) return;
        const percent = (videoPlayer.currentTime / duration) * 100;
        progressBar.style.width = `${percent}%`;
        timeDisplay.textContent = `${formatTime(videoPlayer.currentTime)} / ${formatTime(duration)}`;
    }

    function updateBuffer() {
        const duration = getDuration();
        if (!duration) return;

        if (videoPlayer.buffered.length > 0) {
            // Find the buffered range that covers the current time
            const currentTime = videoPlayer.currentTime;
            let bufferedEnd = 0;

            for (let i = 0; i < videoPlayer.buffered.length; i++) {
                const checkStart = videoPlayer.buffered.start(i);
                const checkEnd = videoPlayer.buffered.end(i);

                // If current time is within this range (or close to it)
                if (currentTime >= checkStart && currentTime <= checkEnd + 0.5) {
                    bufferedEnd = checkEnd;
                    break;
                }
            }

            const percent = (bufferedEnd / duration) * 100;
            progressBuffer.style.width = `${percent}%`;
        }
    }

    // Seek
    progressContainer.addEventListener('click', (e) => {
        const duration = getDuration();
        if (!duration) return;

        const rect = progressContainer.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        let targetTime = pos * duration;

        // Clamp to Server Encoded Time
        if (serverEncodedTime > 0 && targetTime > serverEncodedTime) {
            targetTime = serverEncodedTime;
            showStatus('Buffering... (Waiting for Server)', 'info');
        }

        videoPlayer.currentTime = targetTime;
    });

    // Volume
    volumeSlider.addEventListener('input', (e) => {
        videoPlayer.volume = e.target.value;
        videoPlayer.muted = false;
        updateVolumeIcon();
    });

    muteBtn.addEventListener('click', () => {
        videoPlayer.muted = !videoPlayer.muted;
        updateVolumeIcon();
    });

    function updateVolumeIcon() {
        if (videoPlayer.muted || videoPlayer.volume === 0) {
            muteBtn.innerHTML = '<ion-icon name="volume-mute"></ion-icon>';
            volumeSlider.value = 0;
        } else {
            muteBtn.innerHTML = '<ion-icon name="volume-high"></ion-icon>';
            volumeSlider.value = videoPlayer.volume;
        }
    }

    function formatTime(s) {
        if (isNaN(s) || !isFinite(s)) return "0:00"; // Handle Infinity/NaN
        const totalSeconds = Math.floor(s);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);

        if (hours > 0) {
            return `${hours}:${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
        } else {
            return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
        }
    }

    // Audio Change -> Seamless Switch (Netflix Style)
    // HLS.js handles switching without restart if manifest has multiple audio tracks
    // NATIVE PLAYER: uses videoPlayer.audioTracks API
    audioSelect.addEventListener('change', () => {
        // Prevent focus stealing from video
        videoPlayer.focus();

        const newIndex = parseInt(audioSelect.value);
        console.log(`Switching Audio Track to Index: ${newIndex}`);

        if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
            hls.audioTrack = newIndex;
        } else if (videoPlayer.audioTracks) {
            // NATIVE SWITCHING Logic
            // Standard spec: audioTracks is a list. Set 'enabled' on the one we want.
            // Some browsers use index access, others might need iteration.

            for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                if (i === newIndex) {
                    videoPlayer.audioTracks[i].enabled = true;
                    logToServer(`[Audio] Native Track ${i} ENABLED`);
                } else {
                    videoPlayer.audioTracks[i].enabled = false;
                }
            }
        } else {
            console.log("Audio switch requested but no compatible API found.");
        }
    });

    // Subtitle Change -> Seamless Update (No stream restart needed)
    subSelect.addEventListener('change', () => {
        const rawUrl = urlInput.value.trim();
        const subIdx = subSelect.value;
        updateSubtitle(rawUrl, subIdx);
    });

    function updateSubtitle(videoUrl, subIndex) {
        // Clear existing tracks
        const oldTracks = videoPlayer.querySelectorAll('track');
        oldTracks.forEach(t => t.remove());

        if (subIndex != -1) {
            console.log(`Loading Subtitle Track: ${subIndex}`);
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = 'Active Subtitle';
            track.srclang = 'en';
            track.default = true;
            track.src = `/subtitle?url=${encodeURIComponent(videoUrl)}&index=${subIndex}`;

            videoPlayer.appendChild(track);

            // Force show
            track.onload = () => {
                const textTrack = track.track;
                textTrack.mode = 'showing';
            };
            // Fallback if onload doesn't fire immediately
            setTimeout(() => {
                if (track.track) track.track.mode = 'showing';
            }, 100);
        } else {
            console.log("Subtitles Disabled");
        }
    }

    // ... (fetchMetadata logic truncated for brevity, but we need to ensure it doesn't conflict)
    // We will clear audio options in startStream or rely on HLS overwriting them.

    // ... 

    // (Removed incorrect hls.on block)

    async function fetchMetadata() {
        const rawUrl = urlInput.value.trim();
        if (!rawUrl) return;

        try {
            // audioSelect.innerHTML = '<option>Loading...</option>'; 
            // Better UX: Don't clear audio immediately, just let it update or fail.

            const res = await fetch(`/metadata?url=${encodeURIComponent(rawUrl)}`);
            const data = await res.json();

            if (data.duration) {
                serverDuration = data.duration;
                logToServer(`[Metadata] Server Duration: ${serverDuration}s`);
            }

            // Audio Options (Preview from Metadata)
            if (data.audio && data.audio.length > 0) {
                audioSelect.innerHTML = data.audio.map((t, i) =>
                    `<option value="${t.index}">Audio ${i + 1}: ${t.lang} (${t.codec})</option>`
                ).join('');
                audioSelect.value = data.audio[0].index; // Select first by default
            } else {
                audioSelect.innerHTML = '<option value="0">Default Audio</option>';
            }

            // Subtitle Options
            const validSubs = data.subs || [];
            if (validSubs.length > 0) {
                const options = validSubs.map((t, i) =>
                    `<option value="${t.index}">${t.lang} - ${t.title}</option>`
                ).join('');
                // Add "Off" option
                subSelect.innerHTML = '<option value="-1">CC: Off</option>' + options;
            } else {
                subSelect.innerHTML = '<option value="-1">CC: Off</option>';
            }

        } catch (e) {
            console.error("Metadata fetch failed", e);
            audioSelect.innerHTML = '<option value="0">Default Audio</option>';
        }
    }

    fullscreenBtn.addEventListener('click', toggleFullScreen);

    function toggleFullScreen() {
        if (!document.fullscreenElement) {
            if (videoContainer.requestFullscreen) {
                videoContainer.requestFullscreen();
            } else if (videoContainer.webkitRequestFullscreen) {
                videoContainer.webkitRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        }
    }

    let isStreamStarting = false;

    async function startStream(source = 'unknown') {
        if (isStreamStarting) {
            console.log(`startStream blocked: already starting (source: ${source})`);
            return;
        }

        console.log(`startStream called from: ${source}`);
        isStreamStarting = true;

        const rawUrl = urlInput.value.trim();
        const audioIdx = audioSelect.value || 0;
        const subIdx = subSelect.value || -1;
        const forceTranscode = document.getElementById('transcodeCheckbox').checked;

        if (!rawUrl) {
            showStatus('Please enter a valid URL', 'error');
            isStreamStarting = false;
            return;
        }

        // Check for Resume Condition (Before overwriting storage)
        const storedUrl = localStorage.getItem('lastVideoUrl');
        const storedTime = parseFloat(localStorage.getItem('lastVideoTime'));
        let shouldResume = (storedUrl === rawUrl && storedTime > 0);

        // Save to LocalStorage for persistence
        if (source !== 'auto-resume') {
            localStorage.setItem('lastVideoUrl', rawUrl);
        }

        showStatus(`Initializing Stream... (Stability: ${forceTranscode ? 'ON' : 'OFF'})`, 'info');

        // 1. Tell Server to Start Transcoding
        try {
            const startRes = await fetch(`/start?url=${encodeURIComponent(rawUrl)}&audioIndex=${audioIdx}&subIndex=${subIdx}&session=${sessionId}&transcode=${forceTranscode}`);
            if (!startRes.ok) throw new Error('Failed to start stream server');
        } catch (err) {
            console.error(err);
            showStatus('Server Error: ' + err.message, 'error');
            isStreamStarting = false;
            return;
        }

        // Add Subtitle Track manually (Sidecar)
        updateSubtitle(rawUrl, subIdx);


        // Start Heartbeat
        startHeartbeat();

        // 2. Initialize HLS Player with Master Playlist
        // POINT TO SESSION SPECIFIC HLS
        const streamSrc = `/hls/${sessionId}/main.m3u8?t=${Date.now()}`;


        if (typeof Hls === 'undefined') {
            showStatus('Error: HLS library not loaded', 'error');
            return;
        }

        // Check if device is TV to prefer Native HLS (Better for AC3/Passthrough)
        const ua = navigator.userAgent;
        const isTV = /Tizen|WebOS|SmartTV|BRAVIA|Android TV|TV|AppleTV|CrKey|Roku|Viera|Philips|Toshiba|LG|Samsung/i.test(ua);

        // Native HLS Check (Prioritize for TV or Safari)
        const supportsNativeHLS = videoPlayer.canPlayType('application/vnd.apple.mpegurl');

        if (isTV && supportsNativeHLS) {
            console.log("TV detected. Using Native HLS for better Audio/Video support.");
            logToServer(`[Detection] TV User-Agent detected: ${ua}`);
            logToServer(`[Player] Using Native HLS Player (Supports Native HLS: ${supportsNativeHLS})`);

            // Fallthrough to Native Logic
            videoPlayer.src = streamSrc;
            videoPlayer.addEventListener('loadedmetadata', function () {
                videoPlayer.play().catch(e => console.log("Autoplay blocked"));
                showStatus('Playing (Native TV)', 'success');
                logToServer('[Event] Native Player: Metadata Loaded & Playing');
                placeholder.style.opacity = '0';
                startHeartbeat();
                isStreamStarting = false;

                // Try to populate tracks if native player exposes them (WebOS 4+ might)
                if (videoPlayer.audioTracks && videoPlayer.audioTracks.length > 0) {
                    logToServer(`[Audio] Native Audio Tracks found: ${videoPlayer.audioTracks.length}`);

                    // FIXED: We DO NOT populate from Native Player anymore.
                    // We rely strictly on the Server Metadata (fetched via /metadata).
                    // This prevents the TV from overwriting the clean list with jumbled track orders.

                    // We only verify that the indices align.
                    // "Audio 1" in Dropdown (Index 0) -> videoPlayer.audioTracks[0]
                }
            });

        } else if (Hls.isSupported()) {
            logToServer(`[Detection] Standard Browser User-Agent: ${ua}`);
            logToServer(`[Player] Using Hls.js Player`);

            if (hls) {
                hls.destroy();
            }

            hls = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: false,
                // MEMORY OPTIMIZATION FOR TV BROWSERS
                maxBufferLength: 20, // Reduced from 45s to 20s to save RAM
                maxMaxBufferLength: 30, // Reduced from 60s
                backBufferLength: 30, // Limit back buffer to 30s (aggressively flush old segments)
                capLevelToPlayerSize: true,
                subtitleDisplay: true
            });

            showStatus('Loading HLS Playlist...', 'info');
            hls.loadSource(streamSrc);
            hls.attachMedia(videoPlayer);

            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                videoPlayer.play().catch(e => console.log("Autoplay blocked"));

                if (shouldResume) {
                    console.log(`Resuming from ${storedTime}`);
                    videoPlayer.currentTime = storedTime;
                    shouldResume = false; // Reset
                }

                showStatus('Playing (HLS)', 'success');
                placeholder.style.opacity = '0';

                // --- SYNC AUDIO TRACKS ---
                // We prefer the Metadata-populated list because it has codec details.
                // We only overwrite if that list is empty or if HLS gives us something different.

                if (hls.audioTracks && hls.audioTracks.length > 0) {
                    console.log("HLS Audio Tracks active:", hls.audioTracks);
                    // If dropdown is empty or currently "Loading", fill it from HLS
                    if (audioSelect.options.length <= 1 && audioSelect.value === '0') {
                        audioSelect.innerHTML = hls.audioTracks.map((t, i) =>
                            `<option value="${i}">Audio ${i + 1} (${t.lang || 'und'}) - ${t.name || 'Track ' + (i + 1)}</option>`
                        ).join('');
                    }

                    // Sync the active HLS track to the dropdown
                    audioSelect.value = hls.audioTrack;
                    audioSelect.style.display = 'inline-block';

                    // Force update dropdown if it changes externally
                    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (e, data) => {
                        console.log("HLS Audio Switched to", data.id);
                        audioSelect.value = data.id;
                    });
                } else {
                    // If HLS sees no tracks, keep the metadata ones if they exist.
                    // Don't overwrite with "Default Audio" blindly.
                    console.log("HLS reports no specific audio tracks (using default)");
                }
            });

            hls.on(Hls.Events.ERROR, function (event, data) {
                if (data.fatal) {
                    logToServer(`HLS Fatal Error: ${data.type} - ${JSON.stringify(data)}`);
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.log('fatal network error encountered, try to recover');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('fatal media error encountered, try to recover');
                            hls.recoverMediaError();
                            break;
                        default:
                            hls.destroy();
                            break;
                    }
                }
            });

        } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari/Native HLS support
            videoPlayer.src = streamSrc;
            videoPlayer.addEventListener('loadedmetadata', function () {
                videoPlayer.play();
                showStatus('Playing (Native)', 'success');
                placeholder.style.opacity = '0';
                startHeartbeat();
                isStreamStarting = false;
            });
        }

        // Safety timeout in case everything hangs
        setTimeout(() => { isStreamStarting = false; }, 10000);
    }

    let serverEncodedTime = 0; // Tracks how much video is ready on server
    // const progressServer = document.getElementById('progressServer'); // Removed for Dynamic Mode

    function startHeartbeat() {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        // Ping every 1 second for smoother UI growth
        heartbeatInterval = setInterval(() => {
            fetch(`/ping?session=${sessionId}`)
                .then(r => r.json())
                .then(data => {
                    if (data.encodedDuration) {
                        serverEncodedTime = data.encodedDuration;
                        updateServerProgress(); // Update UI immediately
                    }
                })
                .catch(e => console.log("Ping failed"));
        }, 1000);
    }

    function updateServerProgress() {
        // In "Growing Timeline" mode, the duration *IS* the server progress.
        // So triggering updateProgress() is enough to resize the bar if the duration changed.
        updateProgress();
    }

    // Helper: Get Dynamic Duration (The "Loaded" Length)
    function getDuration() {
        // If serverEncodedTime is populated, THAT is our world.
        if (serverEncodedTime > 0) {
            // Ensure we don't report less than current time (just in case)
            return Math.max(serverEncodedTime, videoPlayer.currentTime);
        }

        // Fallback: If native player has a duration (and it's not Infinity), use it.
        if (videoPlayer.duration && isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
            return videoPlayer.duration;
        }

        // Fallback 2: Server metadata total duration (if we somehow have it but no heartbeats yet)
        if (serverDuration > 0) return serverDuration;

        return 0; // Unknown
    }

    function updateProgress() {
        // "Growing Timeline" Logic:
        // Width is percentage of currently loaded content.
        const duration = getDuration();
        if (!duration) {
            progressBar.style.width = '0%';
            timeDisplay.textContent = '0:00 / 0:00';
            return;
        }

        const percent = (videoPlayer.currentTime / duration) * 100;
        progressBar.style.width = `${Math.min(percent, 100)}%`;
        timeDisplay.textContent = `${formatTime(videoPlayer.currentTime)} / ${formatTime(duration)}`;
    }

    function updateBuffer() {
        const duration = getDuration();
        if (!duration) return;

        if (videoPlayer.buffered.length > 0) {
            const currentTime = videoPlayer.currentTime;
            let bufferedEnd = 0;

            for (let i = 0; i < videoPlayer.buffered.length; i++) {
                const checkStart = videoPlayer.buffered.start(i);
                const checkEnd = videoPlayer.buffered.end(i);
                if (currentTime >= checkStart && currentTime <= checkEnd + 0.5) {
                    bufferedEnd = checkEnd;
                    break;
                }
            }
            const percent = (bufferedEnd / duration) * 100;
            progressBuffer.style.width = `${Math.min(percent, 100)}%`;
        }
    }

    // Stop heartbeat on unload
    window.addEventListener('beforeunload', () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
    });

    function logToServer(msg) {
        fetch('/client-log', {
            method: 'POST',
            body: msg
        }).catch(e => { });
    }

    // Save playback position periodically
    videoPlayer.addEventListener('timeupdate', () => {
        if (videoPlayer.currentTime > 5) {
            localStorage.setItem('lastVideoTime', videoPlayer.currentTime);
        }
    });

    function showStatus(msg, type) {
        statusMessage.textContent = msg;
        if (type === 'error') {
            statusMessage.style.color = '#f87171';
            logToServer('Frontend Error: ' + msg);
        }
        else if (type === 'success') statusMessage.style.color = '#4ade80';
        else statusMessage.style.color = '#94a3b8';
    }

    // --- Auto-Hide Controls Logic ---
    let inactivityTimeout;

    function startInactivityTimer() {
        // Clear existing
        clearTimeout(inactivityTimeout);

        // Show controls
        videoContainer.classList.add('user-active');

        // If playing, hide after 3s
        if (!videoPlayer.paused) {
            inactivityTimeout = setTimeout(() => {
                videoContainer.classList.remove('user-active');
            }, 3000);
        }
    }

    // Reset timer on interaction - Bind to DOCUMENT to catch fullscreen events reliably
    const activityEvents = ['mousemove', 'click', 'keydown', 'touchstart'];
    activityEvents.forEach(evt => {
        document.addEventListener(evt, () => {
            // Only logic if we are interacting with the player or in fullscreen
            // (Simple check: always active if page is loaded, as it's the main app)
            if (videoPlayer.paused) {
                videoContainer.classList.add('user-active');
                clearTimeout(inactivityTimeout); // Don't hide if paused
            } else {
                startInactivityTimer();
            }
        });
    });

    // Handle initial state
    videoContainer.classList.add('is-paused');
    videoContainer.classList.add('user-active');

    // --- Keyboard Shortcuts ---
    document.addEventListener('keydown', (e) => {
        // Ignore if user is typing in an input
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;

        switch (e.key) {
            case ' ': // Space: Toggle Play/Pause
            case 'k':
            case 'K':
                e.preventDefault();
                togglePlay();
                // Trigger activity to show controls briefly
                startInactivityTimer();
                break;
            case 'ArrowRight': // Forward 10s
                e.preventDefault();
                // Simple Seek. getDuration() is already dynamic, so we can't seek past it.
                // Math.min ensures we don't go past the "end" (which is the live edge).
                const targetFwd = Math.min(videoPlayer.currentTime + 10, getDuration());
                videoPlayer.currentTime = targetFwd;
                startInactivityTimer();
                break;
            case 'ArrowLeft': // Rewind 10s
                e.preventDefault();
                videoPlayer.currentTime = Math.max(videoPlayer.currentTime - 10, 0);
                startInactivityTimer();
                break;
            case 'f': // Fullscreen
            case 'F':
                e.preventDefault();
                toggleFullScreen();
                break;
            case 'm': // Mute
            case 'M':
                e.preventDefault();
                videoPlayer.muted = !videoPlayer.muted;
                updateVolumeIcon();
                break;
        }
    });
});
