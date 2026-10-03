/**
 * Test stream harness — runs an ffmpeg-generated test pattern to YouTube,
 * bypassing the Pi. Used to isolate camera/hardware from YouTube/pipeline.
 *
 * Usage:
 *   npx tsx scripts/test-stream.ts start [duration_sec]
 *   npx tsx scripts/test-stream.ts stop
 *   npx tsx scripts/test-stream.ts status
 *
 * What it does:
 *   1. Calls createBroadcastAndStartStream() — same as the real flow
 *   2. Writes the rtmpUrl + streamKey to logs/test-stream.json
 *   3. Spawns ffmpeg as a child process, pushing the test pattern PNG
 *   4. Saves the ffmpeg PID to logs/test-stream.pid for clean shutdown
 *   5. Logs everything to logs/test-stream.log
 *
 * This does NOT modify any DB state — it's a pure side-channel test.
 * The created YouTube broadcast is real and will appear on the channel
 * (use stop or let it auto-end via enableAutoStop).
 */

import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createBroadcastAndStartStream, endBroadcast } from './youtube-stream.js';
import { queryOne } from './db.js';

const SCOREBOARD_ID = 6;
const LOG_DIR = join(process.cwd(), 'logs');
const STATE_FILE = join(LOG_DIR, 'test-stream.json');
const PID_FILE = join(LOG_DIR, 'test-stream.pid');
const LOG_FILE = join(LOG_DIR, 'test-stream.log');
const SCRIPT_DIR = join(process.cwd(), 'test-stream');
const PATTERN_PNG = join(SCRIPT_DIR, 'test-pattern.png');

// Ensure logs/ exists before any write
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  writeFileSync(LOG_FILE, line + '\n', { flag: 'a' });
}

async function ensurePattern(): Promise<void> {
  if (existsSync(PATTERN_PNG)) return;
  log(`Generating test pattern at ${PATTERN_PNG}`);
  // Hand off to ffmpeg synchronously. test-pattern.png is built from testsrc2
  // (SMPTE color bars + moving element) — clearly a test source.
  const { execSync } = await import('child_process');
  execSync(
    `ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=1" ` +
    `-frames:v 1 -update 1 "${PATTERN_PNG}"`,
    { stdio: 'pipe' }
  );
}

async function start(durationSec: number): Promise<void> {
  // Refuse if already running
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0); // probe
      log(`Already running (PID ${pid}). Use "stop" first.`);
      process.exit(1);
    } catch {
      log(`Stale PID file, removing.`);
      require('fs').unlinkSync(PID_FILE);
    }
  }

  await ensurePattern();
  log(`Creating YouTube broadcast for scoreboard ${SCOREBOARD_ID}...`);
  const { rtmpUrl, streamName, broadcastId } = await createBroadcastAndStartStream(
    SCOREBOARD_ID,
    { title: 'SCOREBOARD TEST — ffmpeg test pattern (no camera)' }
  );
  log(`Broadcast created: ${broadcastId}`);
  log(`RTMP URL: ${rtmpUrl}`);
  log(`Stream name: ${streamName}`);

  // Persist state so stop() can find it
  const state = { rtmpUrl, streamName, broadcastId, startedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // Build ffmpeg args. Mirror scripts/stream-test.sh but without the duration flag
  // if user wants forever (duration=0). Audio is silent anullsrc — YouTube often
  // rejects streams with no audio track.
  const args = [
    '-y',
    '-loop', '1', '-framerate', '30', '-i', PATTERN_PNG,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k',
    '-maxrate', '4500k', '-bufsize', '9000k',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-f', 'flv',
    `${rtmpUrl}/${streamName}`,
  ];
  if (durationSec > 0) args.splice(args.indexOf('-y') + 1, 0, '-t', String(durationSec));

  log(`Spawning ffmpeg${durationSec > 0 ? ` (duration ${durationSec}s)` : ' (forever)'}`);
  const ff = spawn('/opt/homebrew/bin/ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  writeFileSync(PID_FILE, String(ff.pid));
  log(`ffmpeg PID ${ff.pid}`);

  // Stream ffmpeg output into our log
  ff.stdout.on('data', d => log(`[ffmpeg stdout] ${d.toString().trim()}`));
  ff.stderr.on('data', d => log(`[ffmpeg stderr] ${d.toString().trim()}`));
  ff.on('exit', async (code, sig) => {
    log(`ffmpeg exited (code=${code}, sig=${sig})`);
    try { require('fs').unlinkSync(PID_FILE); } catch {}
    try { require('fs').unlinkSync(STATE_FILE); } catch {}
    // Best-effort: end the YouTube broadcast so the dashboard cleans up
    if (existsSync(STATE_FILE) === false) {
      try {
        log('Ending YouTube broadcast...');
        await endBroadcast(SCOREBOARD_ID);
      } catch (err) {
        log(`endBroadcast error (ignoring): ${err}`);
      }
    }
  });

  // Don't await — let it run. Just confirm spawn.
  log('Test stream started. Open the YouTube live dashboard to verify.');
  log(`Public URL (after YouTube goes live): https://www.youtube.com/watch?v=${broadcastId}`);
}

async function stop(): Promise<void> {
  let killed = false;
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    log(`Killing ffmpeg PID ${pid}`);
    try {
      process.kill(pid, 'SIGTERM');
      killed = true;
      // Give it 2s, then SIGKILL
      await new Promise(r => setTimeout(r, 2000));
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
    } catch (err) {
      log(`kill error (probably already gone): ${err}`);
    }
    try { require('fs').unlinkSync(PID_FILE); } catch {}
  } else {
    log('No PID file — nothing to stop.');
  }

  // Also try to end the broadcast
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    log(`Ending broadcast ${state.broadcastId}...`);
    try {
      await endBroadcast(SCOREBOARD_ID);
      log('Broadcast ended.');
    } catch (err) {
      log(`endBroadcast error: ${err}`);
    }
    try { require('fs').unlinkSync(STATE_FILE); } catch {}
  }

  if (!killed && !existsSync(STATE_FILE)) {
    log('Nothing was running.');
  }
}

async function status(): Promise<void> {
  const running = existsSync(PID_FILE);
  const state = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : null;
  console.log(JSON.stringify({
    running,
    pid: running ? parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10) : null,
    state,
  }, null, 2));
}

const [, , cmd, arg] = process.argv;
(async () => {
  try {
    switch (cmd) {
      case 'start': {
        const dur = arg ? parseInt(arg, 10) : 60;
        await start(dur);
        break;
      }
      case 'stop': await stop(); break;
      case 'status': await status(); break;
      default:
        console.error('Usage: tsx scripts/test-stream.ts <start [duration]|stop|status>');
        process.exit(2);
    }
  } catch (err) {
    log(`FATAL: ${err}`);
    if (err instanceof Error && err.stack) log(err.stack);
    process.exit(1);
  }
})();
