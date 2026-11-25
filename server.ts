import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createNetFusionApp } from './server-runtime/app.ts';

function parseHostBind(): { host: string; port?: number } {
  const raw = (process.env.NETFUSION_HOST_BIND || '').trim();
  if (!raw) return { host: '0.0.0.0' };
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && idx < raw.length - 1) {
    const host = raw.slice(0, idx) || '0.0.0.0';
    const port = Number(raw.slice(idx + 1));
    return { host, port: Number.isFinite(port) && port > 0 ? port : undefined };
  }
  return { host: raw };
}

function resolveListenPort(bindPort?: number): number {
  if (bindPort) return bindPort;
  if (process.env.DEFAULT_APP_PORT) {
    const p = Number(process.env.DEFAULT_APP_PORT);
    if (Number.isFinite(p) && p > 0) return p;
  }
  if (process.env.PORT && process.env.PORT !== process.env.NGINX_PORT) {
    const p = Number(process.env.PORT);
    if (Number.isFinite(p) && p > 0) return p;
  }
  return 3000;
}

async function startServer() {
  const bind = parseHostBind();
  const port = resolveListenPort(bind.port);
  const workspaceRoot = path.resolve(process.cwd());

  const { app } = createNetFusionApp();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(workspaceRoot, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(port, bind.host, () => {
    console.log(`NetFusion control plane listening on http://${bind.host}:${port}`);
  });
}

void startServer();
