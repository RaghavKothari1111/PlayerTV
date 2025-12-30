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
                const audioIndex = parseInt(parsedUrl.query.audioIndex) || 0;
                // subIndex is unused for HLS gen now, but good to know
                const subIndex = parseInt(parsedUrl.query.subIndex) || -1;

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

                const startEncodingProcess = () => {
                    console.log(`Starting HLS (Video Only) for: ${videoUrl} | Audio: ${audioIndex}`);

                    // 1. Probe for Codec
                    const probe = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', videoUrl]);
                    let probeData = '';
                    probe.stdout.on('data', d => probeData += d);

                    probe.on('close', (code) => {
                        let codecName = 'unknown';
                        if (code === 0) {
                            try { codecName = JSON.parse(probeData).streams[0].codec_name; } catch (e) { }
                        }

                        const isLGTV = true;
                        let videoCodec = 'libx264';
                        let videoOpts = ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18', '-pix_fmt', 'yuv420p'];

                        if (isLGTV && (codecName === 'h264' || codecName === 'hevc')) {
                            videoCodec = 'copy';
                            videoOpts = ['-bsf:v', `${codecName}_mp4toannexb`];
                        }

                        // --- Build FFmpeg Arguments (Video Only) ---
                        const ffmpegArgs = [
                            '-y',
                            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            '-i', videoUrl,
                            '-map', '0:v:0', // Video
                            '-map', '[outa]', // Audio (from filter)
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
                            '-hls_segment_filename', path.join(hlsDir, 'video_%d.ts'),
                            path.join(hlsDir, 'video.m3u8')
                        ];

                        console.log("DEBUG: Launching FFmpeg (Video Only)");
                        ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

                        ffmpegProcess.stderr.on('data', (data) => console.log(`ffmpeg: ${data}`));
                        ffmpegProcess.on('close', (code) => {
                            console.log(`FFmpeg exited with code ${code}`);
                            if (code !== 0 && !res.headersSent) {
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: `FFmpeg Fatal Error Code: ${code}` }));
                            }
                        });


                        // --- Generate MAIN.m3u8 Manually (Simple Pointer) ---
                        const mainM3u8Path = path.join(hlsDir, 'main.m3u8');
                        const masterPlaylistContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nvideo.m3u8\n';
                        fs.writeFileSync(mainM3u8Path, masterPlaylistContent);

                        // Poll for VIDEO playlist
                        let attempts = 0;
                        const maxAttempts = 240;
                        if (global.checkPlaylist) clearInterval(global.checkPlaylist);

                        const checkPlaylist = setInterval(() => {
                            attempts++;
                            // Check for VIDEO Playlist
                            if (fs.existsSync(path.join(hlsDir, 'video.m3u8'))) {
                                console.log("Stream Ready!");
                                clearInterval(checkPlaylist);
                                if (!res.headersSent) {
                                    // Return SUCCESS
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ status: 'started' }));
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
                        global.checkPlaylist = checkPlaylist;
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

                console.log(`Streaming Subtitles: ${videoUrl} (Track ${subIndex})`);

                res.writeHead(200, {
                    'Content-Type': 'text/vtt',
                    'Access-Control-Allow-Origin': '*'
                });

                const ffmpegSub = spawn('ffmpeg', [
                    '-y',
                    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    '-i', videoUrl,
                    '-map', `0:${subIndex}`,
                    '-c:s', 'webvtt',
                    '-f', 'webvtt',
                    '-'
                ]);

                ffmpegSub.stdout.pipe(res);

                ffmpegSub.stderr.on('data', d => {
                    // console.log(`Sub ffmpeg: ${d}`);
                });

                ffmpegSub.on('close', (code) => {
                    console.log(`Subtitle Stream ended: ${code}`);
                });

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
