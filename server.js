const http = require('http');
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

                console.log(`Fetching metadata for: ${videoUrl}`);
                const ffprobe = spawn('ffprobe', [
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_streams',
                    videoUrl
                ]);

                let output = '';
                ffprobe.stdout.on('data', (data) => output += data);
                ffprobe.stderr.on('data', (data) => console.error(`ffprobe error: ${data}`));

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
                                .map((s, i) => ({
                                    index: s.index,
                                    lang: s.tags?.language || 'und',
                                    title: s.tags?.title || `Track ${i + 1}`,
                                    codec: s.codec_name
                                }));

                            const audio = data.streams
                                .filter(s => s.codec_type === 'audio')
                                .map((s, i) => ({
                                    index: i,
                                    lang: s.tags?.language || 'und',
                                    codec: s.codec_name
                                }));

                            console.log("Audio Metadata:", JSON.stringify(audio, null, 2));

                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ audio, subs }));

                        } catch (e) {
                            res.writeHead(500);
                            res.end(JSON.stringify({ error: 'Parse Error' + e.message }));
                        }
                    } else {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Probe Failed' }));
                    }
                });

            } else if (parsedUrl.pathname === '/start') {
                const videoUrl = parsedUrl.query.url;
                const sessionId = parsedUrl.query.session; // Mandatory
                const forceTranscode = parsedUrl.query.force === 'true'; // New UI Flag

                if (!videoUrl || !sessionId) {
                    res.writeHead(400);
                    res.end('Missing URL or Session ID');
                    return;
                }

                console.log(`[Start] Request from Session: ${sessionId} (Force Transcode: ${forceTranscode})`);

                // 1. Get or Create Session
                let session = sessions.get(sessionId);
                if (!session) {
                    session = {
                        id: sessionId,
                        process: null,
                        url: null,
                        lastPing: Date.now(),
                        dir: path.join(hlsBaseDir, sessionId),
                        forceTranscode: false
                    };
                    sessions.set(sessionId, session);

                    // Create Session Directory
                    if (!fs.existsSync(session.dir)) {
                        fs.mkdirSync(session.dir, { recursive: true });
                    }
                } else {
                    session.lastPing = Date.now(); // Update activity
                }

                if (forceTranscode) {
                    session.forceTranscode = true;
                    console.log(`[Smart] User forced transcoding for session ${sessionId}`);
                }

                // If this is a NEW request (url mismatch), we must reset the Fallback flag.
                if (session.url !== videoUrl && !forceTranscode) {
                    session.forceTranscode = false;
                }

                const hlsDir = session.dir; // Use SESSION SPECIFIC dir

                // SMART CHECK: If same URL is already playing IN THIS SESSION
                if (session.process && session.url === videoUrl) {
                    console.log(`Stream already active for session ${sessionId}. Reusing.`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'resumed' }));
                    return;
                }

                // Cleanup previous stream (Different URL provided for this session)
                if (session.process) {
                    console.log(`Stopping previous stream for session ${sessionId}...`);
                    try {
                        session.process.kill('SIGKILL');
                    } catch (e) { }
                    session.process = null;
                    session.url = null;
                }

                // Reset Fallback Flag for NEW video if not forced
                if (!forceTranscode) {
                    session.forceTranscode = false;
                }


                // Clear Session Directory (Fresh Start)
                try {
                    const files = fs.readdirSync(hlsDir);
                    for (const file of files) {
                        fs.unlinkSync(path.join(hlsDir, file));
                    }
                } catch (e) { }

                // User Agent to impersonate a standard browser (Fixes 400 Bad Request)
                const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

                const startEncodingProcess = () => {
                    console.log(`Starting HLS for Session ${sessionId}: ${videoUrl}`);

                    // 1. DEVICE DETECTION (Moved Up for Hybrid Audio Logic)
                    const userAgent = req.headers['user-agent'] || '';
                    const isTV = /Web0S|Tizen|SMART-TV|SmartTV|Large Screen|GoogleTV|AndroidTV|HbbTV|Bravia|NetCast/i.test(userAgent);
                    const isMobile = /Android|iPhone|iPad|Mobile/i.test(userAgent) && !isTV;
                    console.log(`[Smart] Device: ${isTV ? 'TV' : isMobile ? 'Mobile' : 'Desktop'} (${userAgent})`);

                    // 1. Probe (Independent of session, just probing URL)
                    const probe = spawn('ffprobe', [
                        '-user_agent', USER_AGENT,
                        '-v', 'quiet',
                        '-print_format', 'json',
                        '-show_streams',
                        videoUrl
                    ]);
                    let probeData = '';
                    probe.stdout.on('data', d => probeData += d);

                    probe.on('close', (code) => {
                        let audioStreams = [];
                        let pd = null;

                        // 1. AUDIO & PROBE PARSING (Restored)
                        if (code === 0) {
                            try {
                                pd = JSON.parse(probeData);
                                audioStreams = pd.streams
                                    .filter(s => s.codec_type === 'audio')
                                    .map((s, i) => ({
                                        index: s.index,
                                        streamIndex: i,
                                        lang: s.tags?.language || 'und',
                                        title: s.tags?.title || `Track ${i + 1}`
                                    }));
                            } catch (e) {
                                console.error("Probe parse error", e);
                            }
                        }

                        // 2. BUILD AUDIO FILTER COMPLEX
                        // 2. BUILD AUDIO MAPS (Simplified for Stability)
                        let audioMaps = [];
                        let varStreamMap = '';
                        // Simple Audio Filter Chain (Applied via -af)
                        // Treble Boost (5kHz & 6kHz) + Volume Boost
                        let audioFilterGraph = 'volume=1.5,treble=g=5:f=5000:w=0.5,treble=g=5:f=6000:w=0.5';

                        if (audioStreams.length > 0) {
                            varStreamMap = 'v:0,agroup:audio';
                            audioStreams.forEach((audio, i) => {
                                // Direct Map (Filter applied globally via -af)
                                audioMaps.push('-map', `0:${audio.index}`);

                                const safeTitle = (audio.title || `Audio_${i + 1}`).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || `Audio_${i + 1}`;
                                varStreamMap += ` a:${i},agroup:audio,language:${audio.lang},name:${safeTitle}`;
                            });
                        } else {
                            varStreamMap = 'v:0';
                            console.log("No audio streams found. Encoding Video Only.");
                        }

                        // 3. DEVICE & CODEC LOGIC (Variables already defined above)
                        // const userAgent ... (Moved up)
                        // const isTV ... (Moved up)

                        let videoCodec = 'libx264';
                        let codecName = 'unknown';

                        if (session.forceTranscode) {
                            console.log(`[Smart] Session ${sessionId} is in FALLBACK mode. Forcing Transcode.`);
                            videoCodec = 'libx264';
                        } else {
                            if (pd && pd.streams) {
                                try {
                                    codecName = pd.streams.find(s => s.codec_type === 'video')?.codec_name || 'unknown';

                                    if (codecName === 'h264') {
                                        videoCodec = 'copy';
                                        console.log("[Smart] Source is H.264. Using Direct Copy.");
                                    }
                                    else if (codecName === 'hevc' || codecName === 'h265') {
                                        if (isTV) {
                                            videoCodec = 'copy';
                                            console.log("[Smart] Source is HEVC & Device is TV. Using Direct Copy.");
                                        } else {
                                            videoCodec = 'libx264';
                                            console.log("[Smart] Source is HEVC but Device is Not TV. Transcoding.");
                                        }
                                    }
                                    else {
                                        console.log(`[Smart] Source is ${codecName}. Transcoding.`);
                                    }

                                } catch (e) {
                                    console.error("Probe parse error (video)", e);
                                }
                            } else {
                                console.log("[Smart] Probe failed or no data. Defaulting to Transcode.");
                            }
                        }

                        let videoOpts = [];
                        if (videoCodec === 'libx264') {
                            videoOpts = ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p'];
                        } else if (videoCodec === 'copy') {
                            // Critical for HLS on TV: Apply correct bitstream filter based on codec
                            if (codecName === 'hevc' || codecName === 'h265') {
                                console.log("[Smart] Applying HEVC Bitstream Filter for HLS");
                                videoOpts = ['-bsf:v', 'hevc_mp4toannexb'];
                            } else {
                                console.log("[Smart] Applying H.264 Bitstream Filter for HLS");
                                videoOpts = ['-bsf:v', 'h264_mp4toannexb'];
                            }
                        } else {
                            videoOpts = [];
                        }

                        // Base Args
                        const ffmpegArgs = [
                            '-user_agent', USER_AGENT,
                            '-y',
                            '-fflags', '+genpts',          // Generate Presentation Timestamps
                            '-avoid_negative_ts', 'make_zero', // Fix negative timestamps by resetting to 0
                            '-i', videoUrl,
                            '-map', '0:v:0',
                            ...audioMaps,

                            '-c:v', videoCodec,
                            ...videoOpts,
                            '-max_interleave_delta', '0', // Force tight audio/video interleaving
                        ];

                        if (audioStreams.length > 0) {
                            ffmpegArgs.push(
                                '-af', audioFilterGraph,
                                '-c:a', isTV ? 'ac3' : 'aac',
                                '-b:a', '640k',
                                '-ar', '48000', // Force 48kHz for stability
                                '-ac', '6'
                            );
                        }

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

                        session.url = videoUrl; // Track URL
                        session.process = spawn('ffmpeg', ffmpegArgs); // Store process

                        session.process.stderr.on('data', (data) => console.log(`[ffmpeg-${sessionId}]: ${data}`));
                        session.process.on('close', (code) => {
                            console.log(`[ffmpeg-${sessionId}] Exited with code ${code}`);
                            session.process = null;
                            session.url = null;

                            if (code !== 0 && !res.headersSent) {
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: `FFmpeg Fatal Error Code: ${code}` }));
                            }
                        });


                        // Poll for MAIN playlist in SESSION DIR
                        let attempts = 0;
                        const maxAttempts = 240;
                        const checkPlaylist = setInterval(() => {
                            attempts++;
                            if (fs.existsSync(path.join(hlsDir, 'main.m3u8'))) {
                                console.log(`Stream Ready for Session ${sessionId}!`);
                                clearInterval(checkPlaylist);
                                if (!res.headersSent) {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ status: 'started' }));
                                }
                            } else if (attempts >= maxAttempts) {
                                clearInterval(checkPlaylist);
                                if (session.process) session.process.kill('SIGKILL');
                                if (!res.headersSent) {
                                    res.writeHead(500);
                                    res.end(JSON.stringify({ error: 'Timeout waiting for stream' }));
                                }
                            }
                        }, 500);
                    });
                };

                startEncodingProcess();

            } else if (parsedUrl.pathname === '/subtitle') {
                const videoUrl = parsedUrl.query.url;
                const subIndex = parsedUrl.query.index;

                if (!videoUrl || !subIndex) {
                    res.writeHead(400);
                    res.end('Missing URL or Index');
                    return;
                }
                const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

                console.log(`Streaming Subtitles: ${videoUrl} (Track ${subIndex})`);
                res.writeHead(200, {
                    'Content-Type': 'text/vtt',
                    'Access-Control-Allow-Origin': '*'
                });
                const ffmpegSub = spawn('ffmpeg', [
                    '-user_agent', USER_AGENT, // Fix: Add User Agent
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

            } else if (parsedUrl.pathname === '/fallback') {
                const sessionId = parsedUrl.query.session;

                if (sessionId && sessions.has(sessionId)) {
                    const s = sessions.get(sessionId);
                    console.log(`[Fallback] Received error from Session ${sessionId}. Switching to Transcode Mode.`);

                    // 1. Set Flag
                    s.forceTranscode = true;

                    // 2. Kill current process (if any)
                    if (s.process) {
                        s.process.kill('SIGKILL');
                        s.process = null;
                        s.url = null; // Clearing URL forces /start to re-run the logic
                    }
                    // 3. Clear Files
                    try {
                        const files = fs.readdirSync(s.dir);
                        for (const file of files) fs.unlinkSync(path.join(s.dir, file));
                    } catch (e) { }

                    res.writeHead(200);
                    res.end('Fallback Enabled');
                } else {
                    res.writeHead(404);
                    res.end('Session Not Found');
                }

            } else if (parsedUrl.pathname === '/ping') {
                const sessionId = parsedUrl.query.session;
                if (sessionId && sessions.has(sessionId)) {
                    sessions.get(sessionId).lastPing = Date.now();
                }
                res.writeHead(200);
                res.end('Pong');
            }

        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
