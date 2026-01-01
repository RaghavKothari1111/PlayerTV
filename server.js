const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');

// --- Configuration ---
const VIDEO_DIR = '/app/data';
const HLS_DIR_NAME = 'hls';
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Global State (Replaced by Session Manager) ---
// const ffmpegProcess = null; // OLD
// const currentStreamUrl = null; // OLD

// --- Session Manager ---
const sessions = new Map();
// Structure:
// sessionId -> {
//   id: string,
//   process: ChildProcess | null,
//   url: string | null,
//   lastPing: number (timestamp),
//   dir: string (path)
// }

// --- Setup Directories ---
const hlsBaseDir = path.join(PUBLIC_DIR, HLS_DIR_NAME);
if (!fs.existsSync(hlsBaseDir)) {
    fs.mkdirSync(hlsBaseDir, { recursive: true });
} else {
    // Cleanup ALL stale sessions on startup (Hard Reset)
    try {
        fs.rmSync(hlsBaseDir, { recursive: true, force: true });
        fs.mkdirSync(hlsBaseDir, { recursive: true });
        console.log('Cleaned HLS directory on startup.');
    } catch (e) {
        console.error('Error cleaning HLS directory:', e);
    }
}

// --- Session Cleanup Job (Every 5 Minutes) ---
setInterval(() => {
    const now = Date.now();
    const TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 Hours

    console.log(`[SessionManager] Running Cleanup. Active Sessions: ${sessions.size}`);

    for (const [sid, session] of sessions.entries()) {
        if (now - session.lastPing > TIMEOUT_MS) {
            console.log(`[SessionManager] Session ${sid} expired (2h inactivity). Cleaning up.`);

            // 1. Kill Process
            if (session.process) {
                try {
                    session.process.kill('SIGKILL');
                } catch (e) { }
            }

            // 2. Remove Files
            try {
                if (fs.existsSync(session.dir)) {
                    fs.rmSync(session.dir, { recursive: true, force: true });
                }
            } catch (e) {
                console.error(`Failed to clean dir for ${sid}`, e);
            }

            // 3. Delete from Map
            sessions.delete(sid);
        }
    }
}, 5 * 60 * 1000); // Check every 5 mins

// --- Logging Helper ---
const logFile = path.join(__dirname, 'server.log');
function log(msg) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${msg}`;
    console.log(logMsg);
    try {
        fs.appendFileSync(logFile, logMsg + '\n');
    } catch (e) {
        console.error("Failed to write to log file:", e);
    }
}

const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);

    // --- Serve Static Files ---
    let filePath = path.join(PUBLIC_DIR, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);

    fs.stat(filePath, (err, stats) => {
        if (!err && stats.isFile()) {
            const ext = path.extname(filePath);
            const contentType = {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.m3u8': 'application/vnd.apple.mpegurl',
                '.ts': 'video/mp2t',
                '.vtt': 'text/vtt'
            }[ext] || 'application/octet-stream';

            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        } else {
            // --- API Endpoints ---
            if (parsedUrl.pathname === '/metadata') {
                const videoUrl = parsedUrl.query.url;
                if (!videoUrl) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Missing URL' }));
                    return;
                }

                log(`Fetching metadata for: ${videoUrl}`);
                const ffprobe = spawn('ffprobe', [
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_streams',
                    '-show_format',
                    videoUrl
                ]);

                let output = '';
                ffprobe.stdout.on('data', (data) => output += data);
                ffprobe.stderr.on('data', (data) => log(`[ffprobe] ${data.toString().trim()}`));

                ffprobe.on('close', async (code) => {
                    if (code === 0) {
                        try {
                            const data = JSON.parse(output);

                            const textSubtitleCodecs = [
                                'subrip', 'webvtt', 'ass', 'ssa', 'mov_text', 'mpl2', 'text'
                            ];

                            const subs = data.streams
                                .filter(s => s.codec_type === 'subtitle')
                                .filter(s => textSubtitleCodecs.includes(s.codec_name))
                                .sort((a, b) => a.index - b.index) // Ensure consistent order
                                .map((s, i) => ({
                                    index: s.index,
                                    lang: s.tags?.language || 'und',
                                    title: s.tags?.title || `Track ${i + 1}`,
                                    codec: s.codec_name
                                }));

                            const audio = data.streams
                                .filter(s => s.codec_type === 'audio')
                                .sort((a, b) => a.index - b.index) // Ensure consistent order
                                .map((s, i) => ({
                                    index: i,
                                    lang: s.tags?.language || 'und',
                                    codec: s.codec_name
                                }));

                            log(`Audio Metadata: ${JSON.stringify(audio, null, 2)}`);

                            const duration = data.format ? parseFloat(data.format.duration || 0) : 0;

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ audio, subs, duration }));

                        } catch (e) {
                            res.writeHead(500);
                            res.end(JSON.stringify({ error: 'Parse Error' + e.message }));
                        }
                    } else {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Probe Failed' }));
                    }
                });

            } else if (parsedUrl.pathname === '/direct-stream') {
                const videoUrl = parsedUrl.query.url;
                if (!videoUrl) {
                    res.writeHead(400);
                    res.end('Missing URL');
                    return;
                }

                log(`[Direct Stream] Proxying: ${videoUrl} | Method: ${req.method}`);

                // --- PART C: Hardened Byte-Range Proxy ---
                const lib = videoUrl.startsWith('https') ? https : http;
                const options = url.parse(videoUrl);
                options.method = req.method; // Support HEAD requests
                options.headers = {};

                // Forward essential headers
                if (req.headers.range) {
                    options.headers['Range'] = req.headers.range;
                }
                if (req.headers['user-agent']) {
                    options.headers['User-Agent'] = req.headers['user-agent'];
                }

                const proxyReq = lib.request(options, (proxyRes) => {
                    // Build response headers
                    const headers = {
                        'Cache-Control': 'no-store',           // Prevent caching issues
                        'Connection': 'keep-alive',            // Maintain connection
                        'Access-Control-Allow-Origin': '*'
                    };

                    // Forward content headers from upstream
                    if (proxyRes.headers['content-type']) headers['Content-Type'] = proxyRes.headers['content-type'];
                    if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
                    if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];
                    if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

                    res.writeHead(proxyRes.statusCode, headers);

                    // For HEAD requests, don't pipe body
                    if (req.method === 'HEAD') {
                        res.end();
                        return;
                    }

                    proxyRes.pipe(res);
                });

                // Abort upstream if client disconnects (prevent memory leaks)
                req.on('close', () => {
                    proxyReq.destroy();
                });

                proxyReq.on('error', (e) => {
                    log(`[Direct Stream] Error: ${e.message}`);
                    if (!res.headersSent) {
                        res.writeHead(502); // Bad Gateway
                        res.end('Upstream Error');
                    }
                });

                proxyReq.end();

            } else if (parsedUrl.pathname === '/start') {
                const videoUrl = parsedUrl.query.url;
                const sessionId = parsedUrl.query.session; // Mandatory

                if (!videoUrl || !sessionId) {
                    res.writeHead(400);
                    res.end('Missing URL or Session ID');
                    return;
                }

                // --- Device Detection ---
                const userAgent = req.headers['user-agent'] || '';
                const isTV = /Tizen|WebOS|SmartTV|BRAVIA|Android TV|TV|AppleTV|CrKey|Roku|Viera|Philips|Toshiba|LG|Samsung/i.test(userAgent) || parsedUrl.query.device === 'tv';

                log(`[Start] Request from Session: ${sessionId} | User-Agent: ${userAgent} | isTV: ${isTV}`);

                // 1. Get or Create Session
                let session = sessions.get(sessionId);
                if (!session) {
                    session = {
                        id: sessionId,
                        process: null,
                        url: null,
                        lastPing: Date.now(),
                        dir: path.join(hlsBaseDir, sessionId)
                    };
                    sessions.set(sessionId, session);

                    // Create Session Directory
                    if (!fs.existsSync(session.dir)) {
                        fs.mkdirSync(session.dir, { recursive: true });
                    }
                } else {
                    session.lastPing = Date.now(); // Update activity
                }

                const hlsDir = session.dir; // Use SESSION SPECIFIC dir

                // SMART CHECK: If same URL is already playing IN THIS SESSION
                if (session.process && session.url === videoUrl) {
                    log(`Stream already active for session ${sessionId}. Reusing.`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'resumed' }));
                    return;
                }

                // Cleanup previous stream (Different URL provided for this session)
                if (session.process) {
                    log(`Stopping previous stream for session ${sessionId}...`);
                    try {
                        session.process.kill('SIGKILL');
                    } catch (e) { }
                    session.process = null;
                    session.url = null;
                }

                // Clear Session Directory (Fresh Start)
                try {
                    const files = fs.readdirSync(hlsDir);
                    for (const file of files) {
                        fs.unlinkSync(path.join(hlsDir, file));
                    }
                } catch (e) { }

                // --- MODES ---
                const MODE = {
                    NATIVE_DIRECT: 'NATIVE_DIRECT',       // No FFmpeg, Proxy only
                    AUDIO_ONLY: 'AUDIO_PROCESS_ONLY',     // Video Copy, Audio Transcode (Filter)
                    FULL_TRANSCODE: 'FULL_TRANSCODE'      // Video Transcode, Audio Transcode
                };

                // --- PART D: Device Capability Matrix ---
                // Different TV platforms have different codec support
                // NOTE: HEVC uses different level numbering than H.264:
                //   - H.264 Level 5.1 = 51
                //   - HEVC Level 4.0 = 120, Level 5.1 = 153
                // So we use codec-specific max levels
                const TV_CAPABILITIES = {
                    samsung: {
                        video: ['h264', 'hevc'],
                        maxH264Level: 51,   // H.264 Level 5.1 (4K)
                        maxHevcLevel: 153,  // HEVC Level 5.1 (4K HDR)
                        audio: ['aac', 'ac3', 'eac3', 'mp3'],
                        profiles: ['baseline', 'main', 'high', 'main 10']
                    },
                    lg: {
                        video: ['h264', 'hevc'],
                        maxH264Level: 51,   // H.264 Level 5.1 (4K)
                        maxHevcLevel: 153,  // HEVC Level 5.1 (4K HDR)
                        audio: ['aac', 'ac3', 'eac3', 'mp3'],
                        profiles: ['baseline', 'main', 'high', 'main 10']
                    },
                    android_tv: {
                        video: ['h264', 'hevc', 'vp9'],
                        maxH264Level: 52,   // H.264 Level 5.2
                        maxHevcLevel: 156,  // HEVC Level 5.2
                        audio: ['aac', 'ac3', 'eac3', 'opus', 'mp3'],
                        profiles: ['baseline', 'main', 'high', 'main 10', 'high10']
                    },
                    generic: {
                        video: ['h264', 'hevc'],  // Be lenient for generic
                        maxH264Level: 51,
                        maxHevcLevel: 153,
                        audio: ['aac', 'ac3', 'eac3', 'mp3'],
                        profiles: ['baseline', 'main', 'high', 'main 10']
                    }
                };

                // Detect TV brand from User-Agent
                const detectTVBrand = (ua) => {
                    if (/Tizen|Samsung/i.test(ua)) return 'samsung';
                    if (/WebOS|LG|NetCast/i.test(ua)) return 'lg';
                    if (/Android TV|Chromecast|CrKey|BRAVIA/i.test(ua)) return 'android_tv';
                    return 'generic';
                };

                const tvBrand = isTV ? detectTVBrand(userAgent) : 'generic';
                const tvCaps = TV_CAPABILITIES[tvBrand];
                log(`[Device] Brand: ${tvBrand} | Caps: ${JSON.stringify(tvCaps)}`);

                // Enhanced Video Compatibility Check (validates profile/level)
                const checkVideoCompatibility = (probeData) => {
                    try {
                        const pd = JSON.parse(probeData);
                        const video = pd.streams.find(s => s.codec_type === 'video');
                        if (!video) return false;

                        // Check codec is supported by this device
                        const codecOk = tvCaps.video.includes(video.codec_name);
                        if (!codecOk) {
                            log(`[Compat] Codec ${video.codec_name} not in ${tvCaps.video}`);
                            return false;
                        }

                        // Check profile (if available) - be lenient
                        const profile = (video.profile || '').toLowerCase();
                        const profileOk = !profile || tvCaps.profiles.some(p => profile.includes(p));

                        // Check level using codec-specific limits
                        // HEVC levels: 4.0=120, 4.1=123, 5.0=150, 5.1=153, 5.2=156
                        // H.264 levels: 4.0=40, 4.1=41, 5.0=50, 5.1=51, 5.2=52
                        const level = parseInt(video.level) || 0;
                        const maxLevel = (video.codec_name === 'hevc') ? tvCaps.maxHevcLevel : tvCaps.maxH264Level;
                        const levelOk = (level === 0) || (level <= maxLevel); // 0 = unknown, be lenient

                        log(`[Compat] Video: ${video.codec_name} Profile:${profile} Level:${level} MaxLevel:${maxLevel} -> Codec:${codecOk} Profile:${profileOk} Level:${levelOk}`);
                        return codecOk && profileOk && levelOk;
                    } catch (e) { return false; }
                };

                // Full Native Compatibility (Video + Audio for direct stream)
                const checkNativeCompatibility = (probeData) => {
                    try {
                        const pd = JSON.parse(probeData);
                        const video = pd.streams.find(s => s.codec_type === 'video');
                        const audio = pd.streams.find(s => s.codec_type === 'audio');
                        if (!video) return false;

                        const validVideo = checkVideoCompatibility(probeData);
                        const validAudio = !audio || tvCaps.audio.includes(audio.codec_name);

                        log(`[Compat] Native: Video:${validVideo} Audio:${validAudio}`);
                        return validVideo && validAudio;
                    } catch (e) { return false; }
                };

                const startEncodingProcess = (fallbackMode = null) => {
                    log(`Starting Session ${sessionId}: ${videoUrl}`);

                    const probe = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', videoUrl]);
                    let probeData = '';
                    probe.stdout.on('data', d => probeData += d);

                    probe.on('close', (code) => {
                        let isVideoCompatible = false;
                        let isNativeCompatible = false;

                        if (code === 0) {
                            isVideoCompatible = checkVideoCompatibility(probeData);
                            isNativeCompatible = checkNativeCompatibility(probeData);
                        }

                        // --- DECISION LOGIC ---
                        // SIMPLIFIED FOR TV: Enhanced Audio is ALWAYS ON (treble boost mandatory)
                        // TV Default: AUDIO_ONLY (video copy + treble-boosted AC3)
                        // TV + Force Transcode: FULL_TRANSCODE (transcode video + treble-boosted AC3)
                        const userForceTranscode = parsedUrl.query.transcode === 'true';

                        let selectedMode = MODE.FULL_TRANSCODE; // Default

                        if (fallbackMode) {
                            selectedMode = fallbackMode;
                            log(`[Decision] Using Fallback Mode: ${selectedMode}`);
                        } else if (isTV) {
                            // TV MODE: Enhanced Audio is COMPULSORY
                            // Default: Video Copy + Treble-Boosted Audio
                            // Force Transcode: Full Transcode + Treble-Boosted Audio
                            if (userForceTranscode) {
                                selectedMode = MODE.FULL_TRANSCODE;
                            } else if (isVideoCompatible) {
                                selectedMode = MODE.AUDIO_ONLY; // Video Copy + Audio Transcode
                            } else {
                                selectedMode = MODE.FULL_TRANSCODE; // Incompatible video, must transcode
                            }
                        } else {
                            // Non-TV: Always full transcode for browser compatibility
                            selectedMode = MODE.FULL_TRANSCODE;
                        }

                        log(`[Decision] TV: ${isTV} | ForceTranscode: ${userForceTranscode} | VideoCompat: ${isVideoCompatible} -> ${selectedMode}`);

                        // 1. NATIVE DIRECT
                        if (selectedMode === MODE.NATIVE_DIRECT) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            const directStreamUrl = `/direct-stream?url=${encodeURIComponent(videoUrl)}`;
                            res.end(JSON.stringify({ status: 'started', mode: MODE.NATIVE_DIRECT, streamUrl: directStreamUrl }));
                            return;
                        }

                        // 2. FFmpeg Modes
                        let audioStreams = [];
                        if (code === 0) {
                            try {
                                const pd = JSON.parse(probeData);
                                audioStreams = pd.streams
                                    .filter(s => s.codec_type === 'audio')
                                    .map((s, i) => ({
                                        index: s.index,
                                        streamIndex: i,
                                        lang: s.tags?.language || 'und',
                                        title: s.tags?.title || `Track ${i + 1}`,
                                        codec: s.codec_name
                                    }))
                                    .sort((a, b) => a.index - b.index);
                            } catch (e) { }
                        }

                        let filterComplex = '';
                        let audioMaps = [];
                        let varStreamMap = '';

                        if (audioStreams.length > 0) {
                            varStreamMap = 'v:0,agroup:audio';
                            audioStreams.forEach((audio, i) => {
                                const fc =
                                    `[0:${audio.index}]aformat=channel_layouts=5.1[a51_${i}];` +
                                    `[a51_${i}]channelsplit=channel_layout=5.1[FL_${i}][FR_${i}][FC_${i}][LFE_${i}][SL_${i}][SR_${i}];` +
                                    `[FC_${i}]equalizer=f=5000:t=q:w=1:g=4,equalizer=f=8000:t=q:w=1:g=3[eFC_orig_${i}];` +
                                    `[FL_${i}]equalizer=f=6000:t=q:w=1:g=4[eFL_${i}];` +
                                    `[FR_${i}]equalizer=f=6000:t=q:w=1:g=4[eFR_${i}];` +
                                    `[eFC_orig_${i}]asplit=3[eFC1_${i}][eFC2_${i}][eFC3_${i}];` +
                                    `[eFL_${i}][eFC1_${i}]amix=inputs=2:weights='0.70 0.30'[nFL_${i}];` +
                                    `[eFR_${i}][eFC2_${i}]amix=inputs=2:weights='0.70 0.30'[nFR_${i}];` +
                                    `[eFC3_${i}]volume=1.5[nFC_${i}];` +
                                    `[nFL_${i}][nFR_${i}][nFC_${i}][LFE_${i}][SL_${i}][SR_${i}]join=inputs=6:channel_layout=5.1[outa${i}];`;

                                filterComplex += fc;
                                audioMaps.push('-map', `[outa${i}]`);
                                const safeTitle = (audio.title || `Audio_${i + 1}`).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || `Audio_${i + 1}`;
                                varStreamMap += ` a:${i},agroup:audio,language:${audio.lang},name:${safeTitle}`;
                            });
                        } else {
                            varStreamMap = 'v:0';
                        }

                        if (filterComplex.endsWith(';')) filterComplex = filterComplex.slice(0, -1);

                        // --- VIDEO CODEC SELECTION ---
                        let videoCodec = 'libx264';
                        let videoOpts = ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p'];

                        if (selectedMode === MODE.AUDIO_ONLY) {
                            videoCodec = 'copy';
                            videoOpts = [];
                            log('[FFmpeg] Video Copy Mode Enabled');
                        }

                        // --- AUDIO CODEC SELECTION (TVs need AC3) ---
                        let audioCodec = 'aac';
                        let audioSampleRate = [];

                        if (isTV || selectedMode === MODE.AUDIO_ONLY) {
                            audioCodec = 'ac3';
                            audioSampleRate = ['-ar', '48000'];
                        }

                        // ============================================
                        // CRITICAL FIX: FFmpeg Argument Order
                        // ============================================
                        // FFmpeg requires: -filter_complex BEFORE -map [label]
                        // Previous code had: -map [outa0] BEFORE -filter_complex
                        // This caused "Output pad not found" errors (silent failures)
                        // ============================================

                        const ffmpegArgs = ['-y', '-i', videoUrl];

                        // STEP 1: Add filter_complex FIRST if audio processing is needed
                        // WHY: Filter labels like [outa0] must exist before -map [outa0]
                        if (audioStreams.length > 0 && filterComplex) {
                            ffmpegArgs.push('-filter_complex', filterComplex);
                        }

                        // STEP 2: Map video stream
                        // WHY: Video always comes from input stream 0:v:0
                        ffmpegArgs.push('-map', '0:v:0');

                        // STEP 3: Map audio outputs (NOW filter labels exist)
                        // WHY: audioMaps contains ['-map', '[outa0]', '-map', '[outa1]', ...]
                        if (audioMaps.length > 0) {
                            ffmpegArgs.push(...audioMaps);
                        } else if (audioStreams.length > 0) {
                            // FALLBACK: If filter failed, map raw audio
                            log('[FFmpeg] WARNING: No audio filter maps. Using raw audio.');
                            ffmpegArgs.push('-map', '0:a:0');
                        }

                        // STEP 4: Video codec settings
                        ffmpegArgs.push('-c:v', videoCodec, ...videoOpts);

                        // STEP 5: Audio codec settings (only if we have audio)
                        if (audioStreams.length > 0) {
                            ffmpegArgs.push(
                                '-c:a', audioCodec,
                                ...audioSampleRate,
                                '-b:a', '640k',
                                '-ac', '6'
                            );
                        }

                        // STEP 6: HLS output settings
                        ffmpegArgs.push(
                            '-max_muxing_queue_size', '4096',
                            '-f', 'hls',
                            '-hls_time', '6',
                            '-hls_list_size', '0',
                            '-hls_playlist_type', 'event',
                            '-hls_allow_cache', '1',
                            '-start_number', '0',
                            '-master_pl_name', 'main.m3u8',
                            '-var_stream_map', varStreamMap,
                            '-hls_segment_filename', path.join(hlsDir, 'stream_%v_%d.ts'),
                            path.join(hlsDir, 'stream_%v.m3u8')
                        );

                        // --- DEFENSIVE CHECK: Validate before spawn ---
                        if (!ffmpegArgs.includes('-map')) {
                            log('[FFmpeg] ABORT: No valid mappings. Cannot proceed.');
                            res.writeHead(500);
                            res.end(JSON.stringify({ error: 'No valid stream mappings' }));
                            return;
                        }

                        log(`[FFmpeg] Args: ${ffmpegArgs.join(' ')}`);

                        session.url = videoUrl;
                        session.process = spawn('ffmpeg', ffmpegArgs);

                        session.process.stderr.on('data', (data) => {
                            const msg = data.toString();
                            if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
                                // log(`[ffmpeg-${sessionId}] ${msg.trim()}`);
                            }
                        });

                        session.process.on('close', (code) => {
                            log(`[ffmpeg-${sessionId}] [${selectedMode}] Exited with code ${code}`);
                            session.process = null;
                            session.url = null;

                            if (code !== 0 && !res.headersSent) {
                                if (selectedMode === MODE.AUDIO_ONLY) {
                                    log('[Fallback] Audio Only mode failed. Retrying with Full Transcode...');
                                    startEncodingProcess(MODE.FULL_TRANSCODE);
                                    return;
                                }
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: `FFmpeg Error ${code}` }));
                            }
                        });


                        let attempts = 0;
                        const checkPlaylist = setInterval(() => {
                            attempts++;
                            if (fs.existsSync(path.join(hlsDir, 'main.m3u8'))) {
                                log(`Stream Ready for Session ${sessionId} [${selectedMode}]!`);
                                clearInterval(checkPlaylist);
                                if (!res.headersSent) {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ status: 'started', mode: selectedMode }));
                                }
                            } else if (attempts >= 100) {
                                clearInterval(checkPlaylist);
                                if (session.process) session.process.kill('SIGKILL');

                                if (selectedMode === MODE.AUDIO_ONLY && !res.headersSent) {
                                    log('[Fallback] Timeout. Retrying with Full Transcode...');
                                    startEncodingProcess(MODE.FULL_TRANSCODE);
                                } else if (!res.headersSent) {
                                    res.writeHead(500);
                                    res.end(JSON.stringify({ error: 'Timeout' }));
                                }
                            }
                        }, 500);
                    });
                };

                startEncodingProcess();

            } else if (parsedUrl.pathname === '/subtitle') {
                // ... Subtitle can stay global-ish or use session if needed, 
                // but usually subtitles are direct FFMPEG extracts.
                // It's cleaner to keep it stateless as it pipes directly.
                // Logic below is fine.
                const videoUrl = parsedUrl.query.url;
                const subIndex = parsedUrl.query.index;

                if (!videoUrl || !subIndex) {
                    res.writeHead(400);
                    res.end('Missing URL or Index');
                    return;
                }
                // ... (Original Code for Subtitle) ...
                log(`Streaming Subtitles: ${videoUrl} (Track ${subIndex})`);
                res.writeHead(200, {
                    'Content-Type': 'text/vtt',
                    'Access-Control-Allow-Origin': '*'
                });
                const ffmpegSub = spawn('ffmpeg', [
                    '-y',
                    '-i', videoUrl,
                    '-map', `0:${subIndex}`,
                    '-c:s', 'webvtt',
                    '-f', 'webvtt',
                    '-'
                ]);
                ffmpegSub.stdout.pipe(res);

            } else if (parsedUrl.pathname === '/stop') {
                const sessionId = parsedUrl.query.session;
                if (sessionId && sessions.has(sessionId)) {
                    const s = sessions.get(sessionId);
                    if (s.process) s.process.kill('SIGKILL');
                    s.process = null;
                    s.url = null;
                }
                res.writeHead(200);
                res.end('Stopped');

            } else if (parsedUrl.pathname === '/ping') {
                const sessionId = parsedUrl.query.session;
                if (sessionId && sessions.has(sessionId)) {
                    sessions.get(sessionId).lastPing = Date.now();

                    // --- Calculate Real-Time HLS Duration ---
                    let encodedDuration = 0;
                    try {
                        const m3u8Path = path.join(sessions.get(sessionId).dir, 'main.m3u8');
                        if (fs.existsSync(m3u8Path)) {
                            const content = fs.readFileSync(m3u8Path, 'utf8');
                            // Sum all #EXTINF:duration, lines
                            const matches = content.match(/#EXTINF:([\d.]+),/g);
                            if (matches) {
                                encodedDuration = matches.reduce((acc, val) => {
                                    return acc + parseFloat(val.split(':')[1].replace(',', ''));
                                }, 0);
                            }
                        }
                    } catch (e) { }

                    // --- PART B: Live Edge Control ---
                    // liveEdgeTime = how far the player can safely seek without buffering
                    // Safety margin of 8 seconds ensures segments are fully written
                    const SAFETY_MARGIN = 8;
                    const liveEdgeTime = Math.max(0, encodedDuration - SAFETY_MARGIN);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'active', encodedDuration, liveEdgeTime }));
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ status: 'invalid_session' }));
                }

            } else if (parsedUrl.pathname === '/client-log' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    log(`[CLIENT] ${body.trim()}`);
                    res.writeHead(200);
                    res.end('Logged');
                });
            }

        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
