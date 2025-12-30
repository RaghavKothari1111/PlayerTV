const http = require('http');
const { spawn } = require('child_process');
const url = require('url');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 3000;
let ffmpegProcess = null;
let watchdogTimer = null;

// Ensure HLS dir exists
const hlsDir = path.join(__dirname, 'public', 'hls');
if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
}

function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    // Kill process if no ping for 15 seconds
    watchdogTimer = setTimeout(() => {
        if (ffmpegProcess) {
            console.log("Watchdog: No heartbeat, killing ffmpeg...");
            ffmpegProcess.kill('SIGKILL');
            ffmpegProcess = null;

            // Optional: Clean HLS dir
            try {
                const files = fs.readdirSync(hlsDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(hlsDir, file));
                }
            } catch (e) { }
        }
    }, 60000); // 60s Timeout (Better for TV browsers)
}

const server = http.createServer((req, res) => {
    // Handling CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);

    // Serve Static Files
    let filePath = path.join(__dirname, 'public', parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);

    // Check if file exists (basic static file server)
    fs.stat(filePath, (err, stats) => {
        if (!err && stats.isFile()) {
            const ext = path.extname(filePath);
            const contentTypes = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'text/javascript',
                '.m3u8': 'application/vnd.apple.mpegurl',
                '.ts': 'video/mp2t'
            };
            const contentType = contentTypes[ext] || 'application/octet-stream';

            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        // Custom API Endpoints
        if (parsedUrl.pathname === '/metadata') {
            const videoUrl = parsedUrl.query.url;
            if (!videoUrl) {
                res.writeHead(400);
                res.end('Missing URL');
                return;
            }

            // Probe with ffprobe
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoUrl
            ]);

            let output = '';
            ffprobe.stdout.on('data', chunk => output += chunk);

            ffprobe.on('close', code => {
                if (code === 0) {
                    try {
                        const data = JSON.parse(output);
                        const metadata = {
                            audio: data.streams.filter(s => s.codec_type === 'audio').map((s, i) => ({
                                index: i, // Relative audio index
                                lang: s.tags?.language || 'und',
                                title: s.tags?.title || `Track ${i + 1}`,
                                codec: s.codec_name
                            })),
                            subs: data.streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({
                                index: i, // Relative subtitle index
                                lang: s.tags?.language || 'und',
                                title: s.tags?.title || `Track ${i + 1}`,
                                codec: s.codec_name
                            }))
                        };
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(metadata));
                    } catch (e) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Parse Error' }));
                    }
                } else {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Probe Failed' }));
                }
            });

        } else if (parsedUrl.pathname === '/subtitles') {
            const videoUrl = parsedUrl.query.url;
            const subIndex = parsedUrl.query.index;

            if (!videoUrl || !subIndex) {
                res.writeHead(400);
                res.end('Missing params');
                return;
            }

            console.log(`Extracting Subtitles: ${subIndex} from ${videoUrl}`);

            res.writeHead(200, {
                'Content-Type': 'text/vtt',
                'Access-Control-Allow-Origin': '*'
            });

            // Stream subs directly to client
            const subProcess = spawn('ffmpeg', [
                '-i', videoUrl,
                '-map', `0:s:${subIndex}`,
                '-c:s', 'webvtt',
                '-f', 'webvtt',
                '-' // Pipe to stdout
            ]);

            subProcess.stdout.pipe(res);

            subProcess.stderr.on('data', d => {
                // console.log(`SubExtract Error: ${d}`);
            });

            req.on('close', () => {
                subProcess.kill();
            });

        } else if (parsedUrl.pathname === '/extract-subtitles') {
            const videoUrl = parsedUrl.query.url;

            if (!videoUrl) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing URL' }));
                return;
            }

            console.log(`Extracting all subtitles from: ${videoUrl}`);

            // First, get subtitle metadata
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoUrl
            ]);

            let output = '';
            ffprobe.stdout.on('data', chunk => output += chunk);

            ffprobe.on('close', async (code) => {
                if (code === 0) {
                    try {
                        const data = JSON.parse(output);
                        const subs = data.streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({
                            index: i,
                            lang: s.tags?.language || 'und',
                            title: s.tags?.title || `Track ${i + 1}`,
                            codec: s.codec_name
                        }));

                        if (subs.length === 0) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ subtitles: [] }));
                            return;
                        }

                        // Extract each subtitle to a file (SEQUENTIALLY to avoid crashing server)
                        const subtitleFiles = [];

                        // Helper to run extraction as a promise
                        const extractTrack = (sub) => {
                            return new Promise((resolve) => {
                                const filename = `sub_${sub.index}_${sub.lang}.vtt`;
                                const filepath = path.join(hlsDir, filename);

                                // If file exists, skip extraction
                                if (fs.existsSync(filepath)) {
                                    subtitleFiles.push({
                                        index: sub.index,
                                        lang: sub.lang,
                                        title: sub.title,
                                        file: `/hls/${filename}`
                                    });
                                    resolve();
                                    return;
                                }

                                const ffmpegSub = spawn('ffmpeg', [
                                    '-y',
                                    '-i', videoUrl,
                                    '-map', `0:s:${sub.index}`,
                                    '-c:s', 'webvtt',
                                    filepath
                                ]);

                                ffmpegSub.on('close', (subCode) => {
                                    if (subCode === 0) {
                                        subtitleFiles.push({
                                            index: sub.index,
                                            lang: sub.lang,
                                            title: sub.title,
                                            file: `/hls/${filename}`
                                        });
                                    }
                                    resolve();
                                });
                            });
                        };

                        // Process all sequentially
                        for (const sub of subs) {
                            await extractTrack(sub);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ subtitles: subtitleFiles }));

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
            // SubIndex is now handled by client sidecar

            if (!videoUrl) {
                res.writeHead(400);
                res.end('Missing URL');
                return;
            }

            // Cleanup previous stream
            if (ffmpegProcess) {
                try {
                    ffmpegProcess.stdin.write('q'); // Try graceful exit
                    ffmpegProcess.kill('SIGKILL');
                } catch (e) { }
                ffmpegProcess = null;
            }

            // Clear HLS directory (sync for safety)
            try {
                const files = fs.readdirSync(hlsDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(hlsDir, file));
                }
            } catch (e) {
                // console.error("Error clearing HLS dir:", e);
            }

            console.log(`Starting HLS for: ${videoUrl} | Audio: ${audioIndex}`);

            // Detect Codec (Probe first to decide Strategy)
            console.log(`Probing video codec for: ${videoUrl}`);
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
                    } catch (e) {
                        console.log("Probe JSON Parse Error");
                    }
                }
                console.log(`Detected Codec: ${codecName}`);

                // Detect Client Type
                const userAgent = req.headers['user-agent'] || '';
                const isLGTV = /Web0S|NetCast|SmartTV/i.test(userAgent);
                console.log(`Client Detected: ${isLGTV ? 'LG Smart TV' : 'PC/Mobile Browser'} (${userAgent})`);

                // Transcoding Strategy
                let videoCodec = 'libx264';
                let videoOpts = ['-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18', '-pix_fmt', 'yuv420p'];

                if (isLGTV) {
                    if (codecName === 'h264') {
                        videoCodec = 'copy';
                        videoOpts = ['-bsf:v', 'h264_mp4toannexb'];
                    } else if (codecName === 'hevc') {
                        videoCodec = 'copy';
                        videoOpts = ['-bsf:v', 'hevc_mp4toannexb'];
                    } else {
                        // Fallback: Transcode required for other formats on HLS
                        console.log("LG TV detected but codec not H264/HEVC -> Falling back to Transcode");
                    }
                }

                console.log(`Selected Video Codec: ${videoCodec}`);

                // Base Args
                const ffmpegArgs = [
                    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    '-i', videoUrl,
                    '-map', '0:v:0',
                    '-map', '[outa]',
                ];

                // Subtitles are handled via /subtitles endpoint (Sidecar)
                ffmpegArgs.push('-sn');

                ffmpegArgs.push(
                    // --- Video Strategy ---
                    '-c:v', videoCodec,
                    ...videoOpts,

                    // --- Audio: Complex Filter (Selected Track) ---
                    '-filter_complex',
                    `[0:a:${audioIndex}]aformat=channel_layouts=5.1[a51];` +
                    `[a51]channelsplit=channel_layout=5.1[FL][FR][FC][LFE][SL][SR];` +
                    // EQ Processing
                    `[FC]equalizer=f=5000:t=q:w=1:g=4,equalizer=f=8000:t=q:w=1:g=3[eFC_orig];` +
                    `[FL]equalizer=f=6000:t=q:w=1:g=4[eFL];` +
                    `[FR]equalizer=f=6000:t=q:w=1:g=4[eFR];` +
                    // Power Split Center Channel (Need 3 copies: To Left, To Right, To Center)
                    `[eFC_orig]asplit=3[eFC1][eFC2][eFC3];` +
                    // Mixing
                    `[eFL][eFC1]amix=inputs=2:weights='0.70 0.30'[nFL];` +
                    `[eFR][eFC2]amix=inputs=2:weights='0.70 0.30'[nFR];` +
                    `[eFC3]volume=1.5[nFC];` +
                    // Merge back to 5.1
                    `[nFL][nFR][nFC][LFE][SL][SR]join=inputs=6:channel_layout=5.1[outa]`,

                    // --- Audio Encoding ---
                    '-c:a', 'aac',
                    '-b:a', '640k',
                    '-ac', '6',

                    // --- Resilience Settings ---
                    '-max_muxing_queue_size', '4096',

                    // --- HLS Settings ---
                    '-f', 'hls',
                    '-hls_time', '4',
                    '-hls_list_size', '45', // 3 minutes buffer (Users request: Save space, keep last ~2 mins)
                    '-hls_flags', 'delete_segments+program_date_time', // Sliding window: Delete old segments
                    '-start_number', '0',
                    path.join(hlsDir, 'stream.m3u8')
                );

                // Force overwrite output
                ffmpegArgs.unshift('-y');

                console.log("DEBUG: AudioIdx:", audioIndex);
                console.log("DEBUG: Full Command:", "ffmpeg " + ffmpegArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' '));

                ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

                ffmpegProcess.stderr.on('data', (data) => {
                    console.log(`ffmpeg: ${data}`);
                });

                ffmpegProcess.on('close', (code) => {
                    console.log(`FFmpeg exited with code ${code}`);
                    // If ffmpeg exits before playlist is ready, fail the request
                    if (code !== 0 && !res.headersSent) {
                        clearInterval(checkPlaylist);
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: `FFmpeg exited early with code ${code}` }));
                    }
                });

                // Poll for playlist availability
                let attempts = 0;
                const maxAttempts = 240; // 120 seconds timeout

                const checkPlaylist = setInterval(() => {
                    attempts++;
                    if (fs.existsSync(path.join(hlsDir, 'stream.m3u8'))) {
                        clearInterval(checkPlaylist);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'started' }));
                        // Reset Watchdog after success
                        resetWatchdog();
                    } else if (attempts >= maxAttempts) {
                        clearInterval(checkPlaylist);
                        if (ffmpegProcess) ffmpegProcess.kill('SIGKILL');
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: 'Timeout waiting for stream' }));
                    }
                }, 500);
            }); // End Probe Callback
        } // End /start block

        else if (parsedUrl.pathname === '/stop') {
            if (ffmpegProcess) {
                ffmpegProcess.kill('SIGKILL');
                ffmpegProcess = null;
            }
            res.writeHead(200);
            res.end('Stopped');

        } else if (parsedUrl.pathname === '/ping') {
            // Client keeps connection alive
            resetWatchdog();
            res.writeHead(200);
            res.end('Pong');

        }
    }); // End fs.stat
}); // End createServer

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
