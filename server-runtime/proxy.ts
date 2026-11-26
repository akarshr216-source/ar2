import http from 'node:http';
import https from 'node:https';
import type { Request, Response } from 'express';

export function createApiReverseProxy(targetOrigin: string) {
  const target = new URL(targetOrigin);
  const client = target.protocol === 'https:' ? https : http;

  return (req: Request, res: Response) => {
    const upstreamHeaders: http.OutgoingHttpHeaders = {
      ...req.headers,
      host: target.host,
    };
    const remoteIp = req.socket.remoteAddress || '';
    if (remoteIp) {
      upstreamHeaders['x-forwarded-for'] = remoteIp;
    }

    const proxyReq = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: req.originalUrl,
        method: req.method,
        headers: upstreamHeaders,
      },
      (proxyRes) => {
        res.status(proxyRes.statusCode || 502);
        for (const [key, val] of Object.entries(proxyRes.headers)) {
          if (val !== undefined) {
            res.setHeader(key, val);
          }
        }
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.status(502).json({
          error: `Go API server at ${targetOrigin} is offline or unreachable.`,
        });
      } else {
        res.end();
      }
    });

    req.on('aborted', () => {
      proxyReq.destroy();
    });

    req.pipe(proxyReq);
  };
}
