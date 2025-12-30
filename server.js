const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');

// --- Configuration ---
const VIDEO_DIR = '/app/data';
const HLS_DIR_NAME = 'hls';
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Global State ---
let ffmpegProcess = null;
let watchdogTimer = null;

// --- Setup Directories ---
const hlsDir = path.join(PUBLIC_DIR, HLS_DIR_NAME);
if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
}

// --- Watchdog Logic (Auto-Stop on Inactivity) ---
function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
        console.log("Watchdog: No activity for 10 minutes. Stopping FFmpeg.");
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
            ffmpegProcess = null;
        }
    }, 10 * 60 * 1000); // 10 Minutes
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

                            // Define Allowed Text-Based Codecs
                            const textSubtitleCodecs = [
                                'subrip',
                                'webvtt',
                                'ass',
                                'ssa',
                                'mov_text',
                                'mpl2',
                                'text'
                            ];

                            const subs = data.streams
                                .filter(s => s.codec_type === 'subtitle')
                                .filter(s => {
                                    const isText = textSubtitleCodecs.includes(s.codec_name);
                                    if (!isText) {
                                        console.log(`Skipping unsupported subtitle codec: ${s.codec_name} (Index ${s.index})`);
                                    }
                                    return isText;
                                })
                                .map((s, i) => ({
                                    index: s.index, // Absolute index from ffprobe
                                    lang: s.tags?.language || 'und',
                                    title: s.tags?.title || `Track ${i + 1}`,
                                    codec: s.codec_name
                                }));

                            const audio = data.streams
                                .filter(s => s.codec_type === 'audio')
                                .map((s, i) => ({
                                    index: i, // Relative Index for 0:a:i selection
                                    lang: s.tags?.language || 'und',
                                    codec: s.codec_name
                                }));

                            console.log("Audio Metadata:", JSON.stringify(audio, null, 2));

                            if (subs.length === 0) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ audio, subs: [] }));
                                return;
                            }

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
                const audioIndex = parseInt(parsedUrl.query.audioIndex) || 0;
                let subIndex = parseInt(parsedUrl.query.subIndex) || -1;

                if (!videoUrl) {
                    res.writeHead(400);
                    res.end('Missing URL');
                    return;
                }

                // Cleanup previous stream
                if (ffmpegProcess) {
                    try {
                        ffmpegProcess.stdin.write('q');
                        ffmpegProcess.kill('SIGKILL');
                    } catch (e) { }
                    ffmpegProcess = null;
                }

                // Clear HLS directory
                try {
                    const files = fs.readdirSync(hlsDir);
                    for (const file of files) {
                        fs.unlinkSync(path.join(hlsDir, file));
                    }
                } catch (e) { }

                // --- REFACTORED: Start Process Wrapper for Retry Logic ---
                const startEncodingProcess = (currentSubIndex, isRetry) => {
                    console.log(`Starting HLS for: ${videoUrl} | Audio: ${audioIndex} | Sub: ${currentSubIndex} | Retry: ${isRetry}`);

                    // 1. Probe for Codec
                    const probe = spawn('ffprobe', [
                        '-v', 'quiet',
                        '-print_format', 'json',
                        '-show_streams',
                        '-select_streams', 'v:0',
                        videoUrl
                    ]);

                    let probeData = '';
                    probe.stdout.on('data', d => probeData += d);

                    probe.on('close', (code) => {
                        let codecName = 'unknown';
                        if (code === 0) {
                            try {
                                const pd = JSON.parse(probeData);
                                if (pd.streams && pd.streams.length > 0) {
                                    codecName = pd.streams[0].codec_name;
                                }
                            } catch (e) { }
                        }
                        console.log(`Detected Codec: ${codecName}`);

                        const isLGTV = true;
                        let videoCodec = 'libx264';
                        let videoOpts = ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18', '-pix_fmt', 'yuv420p'];

                        if (isLGTV) {
                            if (codecName === 'h264') {
                                videoCodec = 'copy';
                                videoOpts = ['-bsf:v', 'h264_mp4toannexb'];
                            } else if (codecName === 'hevc') {
                                videoCodec = 'copy';
                                videoOpts = ['-bsf:v', 'hevc_mp4toannexb'];
                            }
                        }

                        // Base Args
                        const ffmpegArgs = [
                            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            '-i', videoUrl,
                            '-map', '0:v:0',
                            '-map', '[outa]',
                        ];

                        let varStreamMap = "v:0,a:0";

                        if (currentSubIndex !== -1) {
                            ffmpegArgs.push('-map', `0:${currentSubIndex}`);
                            ffmpegArgs.push('-c:s', 'webvtt');
                            varStreamMap += " s:0";
                        }

                        ffmpegArgs.push(
                            '-c:v', videoCodec,
                            ...videoOpts,
                            '-filter_complex',
                            `[0:a:${audioIndex}]aformat=channel_layouts=5.1[a51];` +
                            `[a51]channelsplit=channel_layout=5.1[FL][FR][FC][LFE][SL][SR];` +
                            `[FC]equalizer=f=5000:t=q:w=1:g=4,equalizer=f=8000:t=q:w=1:g=3[eFC_orig];` +
                            `[FL]equalizer=f=6000:t=q:w=1:g=4[eFL];` +
                            `[FR]equalizer=f=6000:t=q:w=1:g=4[eFR];` +
                            `[eFC_orig]asplit=3[eFC1][eFC2][eFC3];` +
                            `[eFL][eFC1]amix=inputs=2:weights='0.70 0.30'[nFL];` +
                            `[eFR][eFC2]amix=inputs=2:weights='0.70 0.30'[nFR];` +
                            `[eFC3]volume=1.5[nFC];` +
                            `[nFL][nFR][nFC][LFE][SL][SR]join=inputs=6:channel_layout=5.1[outa]`,
                            '-c:a', 'aac',
                            '-b:a', '640k',
                            '-ac', '6',
                            '-max_muxing_queue_size', '4096',
                            '-f', 'hls',
                            '-hls_time', '4',
                            '-hls_list_size', '0',
                            '-hls_flags', 'program_date_time',
                            '-start_number', '0',
                            '-master_pl_name', 'main.m3u8',
                            '-var_stream_map', varStreamMap,
                            path.join(hlsDir, 'stream_%v.m3u8')
                        );

                        ffmpegArgs.unshift('-y');

                        console.log("DEBUG: Launching FFmpeg");
                        ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

                        ffmpegProcess.stderr.on('data', (data) => {
                            // console.log(`ffmpeg: ${data}`); // Verbose
                        });

                        ffmpegProcess.on('close', (code) => {
                            console.log(`FFmpeg exited with code ${code}`);
                            if (code !== 0 && !res.headersSent) {
                                // --- FALLBACK LOGIC ---
                                if (currentSubIndex !== -1) {
                                    console.log("⚠️ Subtitle failed. Retrying without subtitles...");
                                    clearInterval(checkPlaylist); // Stop waiting for this attempt
                                    startEncodingProcess(-1, true); // Retry with no subs
                                } else {
                                    // Already failed without subs, or genuine error
                                    clearInterval(checkPlaylist);
                                    res.writeHead(500);
                                    res.end(JSON.stringify({ error: `FFmpeg Fatal Error Code: ${code}` }));
                                }
                            }
                        });


                        // Poll for playlist
                        let attempts = 0;
                        const maxAttempts = 240;

                        if (global.checkPlaylist) clearInterval(global.checkPlaylist); // Clear any old timer

                        const checkPlaylist = setInterval(() => {
                            attempts++;
                            // Check for Master Playlist
                            if (fs.existsSync(path.join(hlsDir, 'main.m3u8'))) {
                                console.log("Stream Ready!");
                                clearInterval(checkPlaylist);
                                if (!res.headersSent) {
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ status: 'started', fallback: isRetry })); // Inform client if fallback happened
                                }
                                resetWatchdog();
                            } else if (attempts >= maxAttempts) {
                                clearInterval(checkPlaylist);
                                if (ffmpegProcess) ffmpegProcess.kill('SIGKILL');
                                if (!res.headersSent) {
                                    res.writeHead(500);
                                    res.end(JSON.stringify({ error: 'Timeout waiting for stream' }));
                                }
                            }
                        }, 500);

                        // expose to outer scope for cleanup if needed (hacky but functional for recursive retry)
                        global.checkPlaylist = checkPlaylist;
                    });
                };

                // Trigger Initial Start
                startEncodingProcess(subIndex, false);

            } else if (parsedUrl.pathname === '/stop') {
                if (ffmpegProcess) {
                    ffmpegProcess.kill('SIGKILL');
                    ffmpegProcess = null;
                }
                res.writeHead(200);
                res.end('Stopped');

            } else if (parsedUrl.pathname === '/ping') {
                resetWatchdog();
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
