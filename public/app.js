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

    // Initially hide subtitle select
    subSelect.style.display = 'none';

    // Fetch Metadata when URL changes
    urlInput.addEventListener('blur', fetchMetadata);
    urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            fetchMetadata();
            startStream();
        }
    });

    playBtn.addEventListener('click', () => {
        startStream();
    });

    // Auto-fetch metadata if URL pasted
    urlInput.addEventListener('paste', () => {
        setTimeout(fetchMetadata, 100);
    });

    // Audio Change -> Seamless Switch (Netflix Style)
    // HLS.js handles switching without restart if manifest has multiple audio tracks
    audioSelect.addEventListener('change', () => {
        if (hls && hls.audioTracks.length > 1) {
            const newIndex = parseInt(audioSelect.value);
            console.log(`Switching Audio Track to Index: ${newIndex}`);
            hls.audioTrack = newIndex;
        } else {
            // Fallback for native or single track (requires restart if using old method, but we want seamless)
            // If native, safari handles it via system controls usually.
            console.log("Audio switch requested but HLS not controlling multiple tracks.");
        }
    });

    // Subtitle Change -> Restart Stream (Sidecar)
    subSelect.addEventListener('change', () => {
        if (!videoPlayer.paused || hls) {
            startStream();
        }
    });

    // ... (fetchMetadata logic truncated for brevity, but we need to ensure it doesn't conflict)
    // We will clear audio options in startStream or rely on HLS overwriting them.

    // ... 

    // (Removed incorrect hls.on block)

    async function fetchMetadata() {
        const rawUrl = urlInput.value.trim();
        if (!rawUrl) return;

        try {
            audioSelect.innerHTML = '<option>Loading...</option>';
            // Do NOT show "Loading..." for subtitles, keep hidden

            const res = await fetch(`/metadata?url=${encodeURIComponent(rawUrl)}`);
            const data = await res.json();

            // Audio Options
            // Audio Options will be handled by HLS manifest once playing
            // For now, show "Ready" or similar
            audioSelect.innerHTML = '<option value="0">Audio (Loading...)</option>';

            // Subtitle Options
            const validSubs = data.subs || [];
            if (validSubs.length > 0) {
                const options = validSubs.map((t, i) =>
                    `<option value="${t.index}">${t.lang} - ${t.title}</option>`
                ).join('');
                // Add "Off" option
                subSelect.innerHTML = '<option value="-1">Subtitles: Off</option>' + options;
                subSelect.style.display = 'inline-block'; // Show it now
            } else {
                subSelect.innerHTML = '<option value="-1">Subtitles: Off</option>';
                subSelect.style.display = 'none'; // Keep hidden
            }

        } catch (e) {
            console.error("Metadata fetch failed", e);
            audioSelect.innerHTML = '<option value="0">Default Audio</option>';
            subSelect.style.display = 'none';
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

    async function startStream() {
        const rawUrl = urlInput.value.trim();
        const audioIdx = audioSelect.value || 0;
        const subIdx = subSelect.value || -1;

        if (!rawUrl) {
            showStatus('Please enter a valid URL', 'error');
            return;
        }

        showStatus(`Initializing Stream...`, 'info');

        // Clear existing tracks
        const oldTracks = videoPlayer.querySelectorAll('track');
        oldTracks.forEach(t => t.remove());

        // 1. Tell Server to Start Transcoding
        try {
            const startRes = await fetch(`/start?url=${encodeURIComponent(rawUrl)}&audioIndex=${audioIdx}&subIndex=${subIdx}`);
            if (!startRes.ok) throw new Error('Failed to start stream server');
        } catch (err) {
            console.error(err);
            showStatus('Server Error: ' + err.message, 'error');
            return;
        }

        // Add Subtitle Track manually (Sidecar)
        if (subIdx != -1) {
            console.log("Adding sidecar subtitle track...");
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = 'Active Subtitle';
            track.srclang = 'en';
            track.default = true;
            track.src = `/subtitle?url=${encodeURIComponent(rawUrl)}&index=${subIdx}`;
            videoPlayer.appendChild(track);

            // Force show
            track.onload = () => {
                const textTrack = track.track;
                textTrack.mode = 'showing';
            };
        }

        // Start Heartbeat
        startHeartbeat();

        // 2. Initialize HLS Player with Master Playlist
        const streamSrc = `/hls/main.m3u8?t=${Date.now()}`;


        if (typeof Hls === 'undefined') {
            showStatus('Error: HLS library not loaded', 'error');
            return;
        }

        if (Hls.isSupported()) {
            if (hls) {
                hls.destroy();
            }

            hls = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: false,
                maxBufferLength: 45, // Increased to 45s as requested
                maxMaxBufferLength: 60,
                backBufferLength: 0,
                capLevelToPlayerSize: true,
                subtitleDisplay: true
            });

            showStatus('Loading HLS Playlist...', 'info');
            hls.loadSource(streamSrc);
            hls.attachMedia(videoPlayer);

            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                videoPlayer.play().catch(e => console.log("Autoplay blocked"));
                showStatus('Playing (HLS)', 'success');
                placeholder.style.opacity = '0';

                // --- POPULATE AUDIO TRACKS FROM HLS MANIFEST ---
                if (hls.audioTracks && hls.audioTracks.length > 0) {
                    console.log("HLS Audio Tracks found:", hls.audioTracks);
                    audioSelect.innerHTML = hls.audioTracks.map((t, i) =>
                        `<option value="${i}">Audio ${i + 1} (${t.lang || 'und'}) - ${t.name || 'Track ' + (i + 1)}</option>`
                    ).join('');

                    // Set current selected
                    audioSelect.value = hls.audioTrack;
                    audioSelect.style.display = 'inline-block';

                    // Force update dropdown if it changes externally
                    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (e, data) => {
                        audioSelect.value = data.id;
                    });
                } else {
                    audioSelect.innerHTML = '<option value="0">Default Audio</option>';
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
            });
        }
    }

    function startHeartbeat() {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        // Ping every 5 seconds
        heartbeatInterval = setInterval(() => {
            fetch('/ping').catch(e => console.log("Ping failed"));
        }, 5000);
    }

    // Stop heartbeat on unload
    window.addEventListener('beforeunload', () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        // Try to stop immediately
        navigator.sendBeacon('/stop');
    });

    function logToServer(msg) {
        fetch('/client-log', {
            method: 'POST',
            body: msg
        }).catch(e => { });
    }

    function showStatus(msg, type) {
        statusMessage.textContent = msg;
        if (type === 'error') {
            statusMessage.style.color = '#f87171';
            logToServer('Frontend Error: ' + msg);
        }
        else if (type === 'success') statusMessage.style.color = '#4ade80';
        else statusMessage.style.color = '#94a3b8';
    }
});
