import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createNetFusionApp } from './server-runtime/app.ts';

function parseCliFlags(): { host?: string; port?: number } {
  const args = process.argv.slice(2);
  let host: string | undefined;
  let port: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      const p = Number(args[++i]);
      if (Number.isFinite(p) && p > 0) port = p;
    } else if (arg.startsWith('--port=')) {
      const p = Number(arg.slice('--port='.length));
      if (Number.isFinite(p) && p > 0) port = p;
    } else if (arg === '--host' && args[i + 1]) {
      host = args[++i].trim() || undefined;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length).trim() || undefined;
    }
  }
  return { host, port };
}

function parseEnvHostBind(): { host?: string; port?: number } {
  const raw = (process.env.NETFUSION_HOST_BIND || '').trim();
  if (!raw) return {};
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && idx < raw.length - 1) {
    const host = raw.slice(0, idx) || undefined;
    const port = Number(raw.slice(idx + 1));
    return { host, port: Number.isFinite(port) && port > 0 ? port : undefined };
  }
  return { host: raw };
}

function resolveListenTarget(): { host: string; port: number } {
  const cli = parseCliFlags();
  const envBind = parseEnvHostBind();

  let port = 3000;
  if (cli.port) {
    port = cli.port;
  } else if (process.env.DEFAULT_APP_PORT) {
    const p = Number(process.env.DEFAULT_APP_PORT);
    if (Number.isFinite(p) && p > 0) port = p;
  } else if (envBind.port) {
    port = envBind.port;
  } else if (process.env.PORT && process.env.PORT !== process.env.NGINX_PORT) {
    const p = Number(process.env.PORT);
    if (Number.isFinite(p) && p > 0) port = p;
  }

  const host = cli.host || (process.env.DEFAULT_APP_PORT ? '0.0.0.0' : envBind.host || '0.0.0.0');
  return { host, port };
}

async function startServer() {
  const { host, port } = resolveListenTarget();
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

  const srv = app.listen(port, host, () => {
    console.log(`NetFusion control plane listening on http://${host}:${port}`);
  });
  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRNOTAVAIL' && host !== '0.0.0.0') {
      console.warn(`Bind address ${host} is unavailable here; falling back to 0.0.0.0:${port}`);
      app.listen(port, '0.0.0.0', () => {
        console.log(`NetFusion control plane listening on http://0.0.0.0:${port}`);
      });
      return;
    }
    throw err;
  });
}

void startServer();
