document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('urlInput');
    const playBtn = document.getElementById('playBtn');
    const videoPlayer = document.getElementById('videoPlayer');
    const videoContainer = document.getElementById('videoContainer');
    const placeholder = document.getElementById('placeholder');
    const statusMessage = document.getElementById('statusMessage');
    const fullscreenBtn = document.getElementById('fullscreenBtn');

    const audioSelect = document.getElementById('audioSelect');

    let hls = null;
    let heartbeatInterval = null;

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

    async function fetchMetadata() {
        const rawUrl = urlInput.value.trim();
        if (!rawUrl) return;

        try {
            audioSelect.innerHTML = '<option>Loading...</option>';

            const res = await fetch(`/metadata?url=${encodeURIComponent(rawUrl)}`);
            const data = await res.json();

            if (data.audio) {
                audioSelect.innerHTML = data.audio.map((t, i) =>
                    `<option value="${t.index}">Audio ${i + 1}: ${t.lang} (${t.codec})</option>`
                ).join('');
            } else {
                audioSelect.innerHTML = '<option value="0">Default Audio</option>';
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

    async function startStream() {
        const rawUrl = urlInput.value.trim();
        const audioIdx = audioSelect.value || 0;

        if (!rawUrl) {
            showStatus('Please enter a valid URL', 'error');
            return;
        }

        showStatus('Initializing Stream...', 'info');

        // 1. Tell Server to Start Transcoding (Video/Audio Only)
        try {
            const startRes = await fetch(`/start?url=${encodeURIComponent(rawUrl)}&audioIndex=${audioIdx}`);
            if (!startRes.ok) throw new Error('Failed to start stream server');
        } catch (err) {
            console.error(err);
            showStatus('Server Error: ' + err.message, 'error');
            return;
        }

        // Start Heartbeat
        startHeartbeat();

        // 2. Initialize HLS Player
        const streamSrc = `/hls/stream.m3u8?t=${Date.now()}`;


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
                backBufferLength: 90
            });

            showStatus('Loading HLS Playlist...', 'info');
            hls.loadSource(streamSrc);
            hls.attachMedia(videoPlayer);

            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                // 1. Play Video IMMEDIATELY
                videoPlayer.play().catch(e => console.log("Autoplay blocked"));
                showStatus('Playing (HLS) - Loading Subs...', 'success');
                placeholder.style.opacity = '0';

                // 2. Fetch subtitles in background
                fetchSubtitles();
            });

            async function fetchSubtitles() {
                try {
                    // showStatus('Extracting subtitles...', 'info'); // Don't overwrite playing status
                    const subsRes = await fetch(`/extract-subtitles?url=${encodeURIComponent(rawUrl)}`);
                    const subsData = await subsRes.json();

                    // Cleanup old tracks
                    const oldTracks = videoPlayer.getElementsByTagName('track');
                    while (oldTracks.length > 0) oldTracks[0].remove();

                    // Add all subtitle tracks
                    if (subsData.subtitles && subsData.subtitles.length > 0) {
                        console.log(`Embedding ${subsData.subtitles.length} subtitle tracks`);
                        subsData.subtitles.forEach((sub, index) => {
                            const track = document.createElement('track');
                            track.kind = 'subtitles';
                            track.label = sub.title || `${sub.lang} (Track ${index + 1})`;
                            track.srclang = sub.lang;
                            track.src = sub.file;
                            if (index === 0) {
                                track.default = true;
                            }
                            videoPlayer.appendChild(track);
                        });

                        // Force showing first track
                        setTimeout(() => {
                            if (videoPlayer.textTracks.length > 0) {
                                videoPlayer.textTracks[0].mode = 'showing';
                            }
                        }, 100);
                    }
                } catch (err) {
                    console.error('Failed to extract subtitles:', err);
                } finally {
                    // Always clear the "Loading Subs" message
                    showStatus('Playing', 'success');
                    // Hide placeholder if still there
                    placeholder.style.opacity = '0';
                }

                // videoPlayer.play() is already called in MANIFEST_PARSED
            }


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
