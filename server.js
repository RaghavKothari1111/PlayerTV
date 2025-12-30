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
                // audioIndex is ignored as we now map ALL audios
                // subIndex is unused for HLS gen now, but good to know

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
                    console.log(`Starting HLS (Multi-Audio) for: ${videoUrl}`);

                    // 1. Probe for All Streams
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

                        if (audioStreams.length === 0) {
                            audioStreams.push({ index: 1, streamIndex: 0, lang: 'und', title: 'Default' });
                        }

                        const isLGTV = true;
                        let videoCodec = 'libx264';
                        let videoOpts = ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18', '-pix_fmt', 'yuv420p'];

                        if (isLGTV && (codecName === 'h264' || codecName === 'hevc')) {
                            videoCodec = 'copy';
                            videoOpts = ['-bsf:v', `${codecName}_mp4toannexb`];
                        }

                        // --- Build Dynamic Filter Complex & Maps ---
                        let filterComplex = '';
                        let audioMaps = [];
                        // We will use ONE video stream (v:0) and MULTIPLE audio streams (a:0, a:1...)
                        // var_stream_map: "v:0,agroup:audio a:0,agroup:audio,language:eng a:1,agroup:audio,language:hin"
                        let varStreamMap = 'v:0,agroup:audio';

                        audioStreams.forEach((audio, i) => {
                            // Unique Filter Chain for EACH audio track
                            // We construct unique IDs for the filter nodes to ensure no collision
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

                            // Map the output of the filter
                            audioMaps.push('-map', `[outa${i}]`);

                            // Add to HLS Stream Map
                            // Use sanitize title for NAME
                            // Fix: Replace spaces with underscores because var_stream_map uses space as delimiter
                            // Also remove quotes as they seem to break the keyval parser
                            const safeTitle = (audio.title || `Audio_${i + 1}`).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || `Audio_${i + 1}`;
                            varStreamMap += ` a:${i},agroup:audio,language:${audio.lang},name:${safeTitle}`;
                        });

                        // Fix: Remove trailing semicolon from filterComplex to avoid "No such filter: ''" error
                        if (filterComplex.endsWith(';')) {
                            filterComplex = filterComplex.slice(0, -1);
                        }

                        // Standard Args
                        const ffmpegArgs = [
                            '-y',
                            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            '-i', videoUrl,
                            '-map', '0:v:0', // Output Stream #0 implies the FIRST mapped stream -> Video
                            ...audioMaps,    // Output Stream #1..N -> Audios

                            '-c:v', videoCodec,
                            ...videoOpts,

                            '-filter_complex', filterComplex,

                            '-c:a', 'aac',
                            '-b:a', '640k',
                            '-ac', '6',

                            '-max_muxing_queue_size', '4096',
                            '-f', 'hls',
                            '-hls_time', '4',
                            '-hls_list_size', '0',
                            '-hls_playlist_type', 'event', // Important: Tells player playlist will grow
                            '-hls_flags', 'program_date_time', // Removed delete_segments for VOD-style history
                            '-hls_allow_cache', '1',
                            '-start_number', '0',
                            '-master_pl_name', 'main.m3u8', // FFmpeg generates the MASTER playlist linking all variants
                            '-var_stream_map', varStreamMap,
                            '-hls_segment_filename', path.join(hlsDir, 'stream_%v_%d.ts'), // %v = variant index
                            path.join(hlsDir, 'stream_%v.m3u8')
                        ];

                        console.log("DEBUG: Launching FFmpeg Multi-Audio");
                        ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

                        ffmpegProcess.stderr.on('data', (data) => console.log(`ffmpeg: ${data}`));
                        ffmpegProcess.on('close', (code) => {
                            console.log(`FFmpeg exited with code ${code}`);
                            if (code !== 0 && !res.headersSent) {
                                res.writeHead(500);
                                res.end(JSON.stringify({ error: `FFmpeg Fatal Error Code: ${code}` }));
                            }
                        });


                        // Poll for MAIN playlist
                        let attempts = 0;
                        const maxAttempts = 240;
                        if (global.checkPlaylist) clearInterval(global.checkPlaylist);

                        const checkPlaylist = setInterval(() => {
                            attempts++;
                            // Check for Master Playlist (ffmpeg creates it now)
                            if (fs.existsSync(path.join(hlsDir, 'main.m3u8'))) {
                                console.log("Stream Ready!");
                                clearInterval(checkPlaylist);
                                if (!res.headersSent) {
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
