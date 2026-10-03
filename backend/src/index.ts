import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { scoreboardsRouter } from './routes/scoreboards.js';
import { displayRouter } from './routes/display.js';
import { gamechangerRouter } from './routes/gamechanger.js';
import { streamRouter } from './routes/stream.js';
import { directStreamRouter } from './routes/direct-stream.js';
import { youtubeAuthRouter, youtubeApiRouter } from './routes/youtube.js';
import { initSocketServer, setSocketIO } from './socket.js';
import { startGCPoller } from './gamechanger-poller.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4020;

app.use(cors({ origin: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Serve API documentation page
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/docs', express.static(path.join(__dirname, '..', 'public')));

// ── Serve the built frontend (production mode) ─────────────────────────
// The frontend is built with `npm run build` in /frontend and outputs to
// /frontend/dist. Express serves these static files directly — no separate
// Vite dev server needed. This is what makes the public URL reliable.
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

// ── Serve HLS segments for the direct stream mode ──────────────────────
// In 'direct' mode, an ffmpeg listener writes .m3u8 + .ts files to
// /public/hls/<scoreboardId>/. The watch page reads /stream-hls/<id>/...
// and plays it via hls.js.
const hlsRoot = path.join(__dirname, '..', 'public', 'hls');
app.use(
  '/stream-hls',
  express.static(hlsRoot, {
    // CORS so hls.js can fetch the playlist + segments from any origin
    setHeaders: (res) => {
      res.set('Access-Control-Allow-Origin', '*');
      // Cached m3u8 must be short; segments can be longer
      res.set('Cache-Control', 'public, max-age=2');
    },
  })
);

app.use('/api/scoreboards', scoreboardsRouter);
app.use('/api/scoreboards', gamechangerRouter);
app.use('/api/scoreboards', streamRouter);
app.use('/api/scoreboards', directStreamRouter);
app.use('/api/scoreboards', youtubeApiRouter);
// Auth-flow router — note path is /api/auth, not /api/scoreboards/:id, because
// it's an OAuth callback that doesn't carry the scoreboard ID in the URL.
app.use('/api/auth', youtubeAuthRouter);
app.use('/display', displayRouter);

// SPA catch-all: any non-API, non-display, non-HLS route returns index.html
// so client-side routing (e.g. /scoreboard/6) works on direct navigation.
// IMPORTANT: must come AFTER all static + API routes, otherwise it'll
// shadow /stream-hls/... and return index.html for HLS requests.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/stream-hls/')) return next();  // 404, not SPA
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/display/')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── HTTP + Socket.io servers ──────────────────────────────────────
// One HTTP server under both Express and Socket.io.
// Ping config tuned for Cloudflare Tunnel: the tunnel aggressively closes
// idle connections, so we ping every 10s (well under Cloudflare's 100s
// timeout) to keep the WebSocket alive. Without this, clients reconnect
// every ~30-60s and miss state pushes during the gap.
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: true },
  pingInterval: 10_000,   // send ping every 10s
  pingTimeout: 15_000,    // wait 15s for pong before disconnecting
  maxHttpBufferSize: 1e6,
});

// Wire up connection/disconnect logging + room-based subscriptions
initSocketServer(io);
setSocketIO(io);

httpServer.listen(PORT, () => {
  console.log(`Scoreboard backend listening on http://localhost:${PORT}`);
  // Start GameChanger background poller for live game sync
  startGCPoller();
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  httpServer.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});

export default app;
