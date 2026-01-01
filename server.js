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

                            log(`Audio Metadata: ${JSON.stringify(audio, null, 2)}`);

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

                const startEncodingProcess = (tryDirectMode = false) => {
                    const mode = tryDirectMode ? "DIRECT (Copy)" : "TRANSCODE";
                    log(`Starting HLS for Session ${sessionId}: ${videoUrl} | Mode: ${mode}`);

                    // 1. Probe (Independent of session, just probing URL)
                    const probe = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', videoUrl]);
                    let probeData = '';
                    probe.stdout.on('data', d => probeData += d);

                    probe.on('close', (code) => {
                        let audioStreams = [];
                        let codecName = 'unknown';

                        if (code === 0) {
                            try {
                                const pd = JSON.parse(probeData);
                                codecName = pd.streams.find(s => s.codec_type === 'video')?.codec_name || 'unknown';
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

                        // --- Build Dynamic Filter Complex & Maps ---
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
                            log("No audio streams found. Encoding Video Only.");
                        }

                        if (filterComplex.endsWith(';')) filterComplex = filterComplex.slice(0, -1);

                        let videoCodec = 'libx264';
                        let videoOpts = ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p'];

                        // OVERRIDE FOR DIRECT MODE
                        if (tryDirectMode) {
                            videoCodec = 'copy';
                            videoOpts = []; // Copy mode doesn't accept encode params like preset/crf
                        }

                        // AUDIO CODEC SELECTION (TVs need AC3)
                        let audioCodec = 'aac';
                        let audioSampleRate = []; // Default (keep original)

                        if (isTV) {
                            audioCodec = 'ac3'; // or 'eac3' for DD+
                            audioSampleRate = ['-ar', '48000']; // Enforce 48kHz for AC3
                            log('Device is TV. Switching audio codec to AC3 (48kHz).');
                        } else {
                            log('Device is not TV. Using AAC audio codec.');
                        }


                        // Base Args
                        const ffmpegArgs = [
                            '-y',
                            '-i', videoUrl,
                            '-map', '0:v:0',
                            ...audioMaps,

                            '-c:v', videoCodec,
                            ...videoOpts,
                        ];

                        if (audioStreams.length > 0) {
                            ffmpegArgs.push(
                                '-filter_complex', filterComplex,
                                '-c:a', audioCodec,
                                ...audioSampleRate,
                                '-b:a', '640k',
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

                        // Error Detection Logic
                        let hasError = false;

                        session.process.stderr.on('data', (data) => {
                            const msg = data.toString();
                            // Log only errors or warnings to keep log size manageable, or all for debugging
                            if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
                                log(`[ffmpeg-${sessionId}] [ERR] ${msg.trim()}`);
                            }
                        });

                        session.process.on('close', (code) => {
                            log(`[ffmpeg-${sessionId}] [${mode}] Exited with code ${code}`);
                            session.process = null;
                            session.url = null;

                            // IF Direct Mode Failed unexpectedly (non-zero code), TRY FALLBACK if we haven't responded yet
                            if (tryDirectMode && code !== 0 && !res.headersSent) {
                                log(`[Fallback] Direct Mode failed with code ${code}. Switching to Transcode...`);
                                // Recursive call with false
                                startEncodingProcess(false);
                                return;
                            }

                            if (code !== 0 && !res.headersSent) {
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: `FFmpeg Fatal Error Code: ${code}` }));
                            }
                        });


                        // Poll for MAIN playlist in SESSION DIR
                        let attempts = 0;
                        const maxAttempts = tryDirectMode ? 20 : 240; // Shorter timeout for Direct Mode check (approx 10s)

                        const checkPlaylist = setInterval(() => {
                            attempts++;
                            if (fs.existsSync(path.join(hlsDir, 'main.m3u8'))) {
                                log(`Stream Ready for Session ${sessionId} [${mode}]!`);
                                clearInterval(checkPlaylist);
                                if (!res.headersSent) {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ status: 'started', mode: mode }));
                                }
                            } else if (attempts >= maxAttempts) {
                                clearInterval(checkPlaylist);

                                // Kill current process
                                if (session.process) {
                                    try {
                                        session.process.kill('SIGKILL');
                                    } catch (e) { }
                                    session.process = null;
                                }

                                if (tryDirectMode) {
                                    log(`[Fallback] Direct Mode Timed Out. Switching to Transcode...`);
                                    if (!res.headersSent) startEncodingProcess(false);
                                } else {
                                    if (!res.headersSent) {
                                        res.writeHead(500);
                                        res.end(JSON.stringify({ error: 'Timeout waiting for stream' }));
                                    }
                                }
                            }
                        }, 500);
                    });
                };

                // Determine initial mode based on Device
                startEncodingProcess(isTV); // If TV, tryDirectMode = true

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
                }
                res.writeHead(200);
                res.end('Pong');

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
