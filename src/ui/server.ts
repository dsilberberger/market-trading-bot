import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { loadConfig } from '../core/utils';
import { registerRoutes } from './routes';

const config = loadConfig(path.resolve(process.cwd(), 'src/config/default.json'));
const app = express();
const csrfToken = crypto.randomUUID();
const desiredPort = Number(process.env.UI_PORT || config.uiPort || 8787);
const desiredBind = process.env.UI_BIND || config.uiBind || '127.0.0.1';

app.use('/public', express.static(path.resolve(__dirname, 'public')));
app.use('/reports', express.static(path.resolve(process.cwd(), 'reports')));
app.use('/runs', express.static(path.resolve(process.cwd(), 'runs')));

registerRoutes(app, csrfToken);

const startServer = (port: number, bind: string, allowFallback = true) => {
  const server = app.listen(port, bind, () => {
    console.log(`UI running at http://${bind}:${(server.address() as any).port}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (allowFallback && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EADDRINUSE')) {
      const nextBind = bind === '127.0.0.1' ? '0.0.0.0' : bind;
      console.warn(`UI port ${port} blocked (${err.code}); retrying on bind ${nextBind} and an ephemeral port.`);
      startServer(0, nextBind, false);
      return;
    }
    console.error('UI failed to start', err);
    process.exit(1);
  });
};

startServer(desiredPort, desiredBind);
