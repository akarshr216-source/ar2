import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createNetFusionApp } from './server-runtime/app.ts';
import { createApiReverseProxy } from './server-runtime/proxy.ts';

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

function resolveDashboardListenTarget(): { host: string; port: number } {
  const cli = parseCliFlags();
  let port = 3000;
  if (cli.port) {
    port = cli.port;
  } else if (process.env.DEFAULT_APP_PORT) {
    const p = Number(process.env.DEFAULT_APP_PORT);
    if (Number.isFinite(p) && p > 0) port = p;
  } else if (process.env.PORT && process.env.PORT !== process.env.NGINX_PORT) {
    const p = Number(process.env.PORT);
    if (Number.isFinite(p) && p > 0) port = p;
  }
  const host = cli.host || '0.0.0.0';
  return { host, port };
}

async function detectGoBackendOnPort(targetUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`${targetUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return false;
    const body = (await res.json()) as { application?: string; backend_mode?: string };
    return body.application === 'NetFusion' && body.backend_mode === 'go';
  } catch {
    return false;
  }
}

async function resolveApiProxyTarget(): Promise<string | null> {
  const explicit = (process.env.NETFUSION_API_PROXY_TARGET || '').trim().replace(/\/+$/, '');
  if (explicit === 'none' || explicit === 'off') {
    return null;
  }
  if (explicit) {
    const parsed = new URL(explicit);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('NETFUSION_API_PROXY_TARGET must use http:// or https://');
    }
    return parsed.origin;
  }
  // When running outside the AI Studio preview proxy, automatically prefer the Go API server on :8080 if reachable
  if (!process.env.DEFAULT_APP_PORT) {
    const localGo = 'http://127.0.0.1:8080';
    if (await detectGoBackendOnPort(localGo)) {
      return localGo;
    }
  }
  return null;
}

async function startServer() {
  const { host, port } = resolveDashboardListenTarget();
  const workspaceRoot = path.resolve(process.cwd());
  const proxyTarget = await resolveApiProxyTarget();

  let app: express.Express;
  if (proxyTarget) {
    app = express();
    const proxyMiddleware = createApiReverseProxy(proxyTarget);
    app.use('/api', proxyMiddleware);
    console.log(`NetFusion dashboard proxying /api/* to Go server at ${proxyTarget}`);
  } else {
    const instance = createNetFusionApp();
    app = instance.app;
  }

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

  app.listen(port, host, () => {
    console.log(`NetFusion dashboard listening on http://${host}:${port}`);
  });
}

void startServer();
