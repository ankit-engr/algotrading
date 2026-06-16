import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { router } from './routes.js';
import { screenRouter } from './screenRoutes.js';
import { settings } from './config.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { broadcaster } from './services/alerts.js';

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/', router);
app.use('/api/screens', screenRouter);

// Health check root fallback
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Bank Nifty AI Signal Engine Node.js API (Pure Backend)',
    version: settings.appVersion
  });
});

const server = createServer(app);

// WebSocket setup
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  broadcaster.addConnection(ws);

  ws.on('close', () => {
    broadcaster.removeConnection(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket connection error:', err);
    broadcaster.removeConnection(ws);
  });
});

// Upgrade HTTP to WS
server.on('upgrade', (request, socket, head) => {
  const url = request.url || '';
  const pathname = url.split('?')[0];

  if (pathname === '/ws/live') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const PORT = settings.port;

server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`Starting ${settings.appName} v${settings.appVersion}`);
  console.log(`Listening on port ${PORT} (API server)`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/live`);
  console.log(`=========================================`);

  startScheduler();
});

// Graceful Shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  stopScheduler();
  server.close(() => {
    console.log('Server shut down successfully.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('Shutting down server...');
  stopScheduler();
  server.close(() => {
    console.log('Server shut down successfully.');
    process.exit(0);
  });
});
