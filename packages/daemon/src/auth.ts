/**
 * API-key based auth for the daemon's external surface (HTTP /api/* + WS).
 *
 * Activated by the SISYPHUS_API_KEY env var:
 *   - Unset (or empty): no auth applied. Suitable for local dev. A one-time
 *     warning is logged on first request so it's noticed.
 *   - Set: every /api/* request must carry `Authorization: Bearer <key>`;
 *     /health stays open for liveness probes. WS upgrade requires either the
 *     same Authorization header, or `?token=<key>` query string (browser
 *     WebSocket can't customise headers).
 *
 * Future: per-plugin scopes, OAuth/JWT, mTLS — out of scope here. M11 is the
 * floor: shared-secret good enough to deploy behind a reverse proxy.
 */
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';

function readKey(): string | null {
  const v = process.env.SISYPHUS_API_KEY?.trim();
  return v && v.length > 0 ? v : null;
}

let warnedNoAuth = false;
function maybeWarn(): void {
  if (warnedNoAuth) return;
  if (!readKey()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[sisyphus-daemon] SISYPHUS_API_KEY not set — /api/* and /ws are open (dev mode)',
    );
    warnedNoAuth = true;
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  maybeWarn();
  const expected = readKey();
  if (!expected) return next();
  const presented = extractBearer(c.req.header('Authorization'));
  if (presented !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};

export function isWSAuthorized(req: IncomingMessage): boolean {
  maybeWarn();
  const expected = readKey();
  if (!expected) return true;

  // 1. Authorization header (Node-side WS clients, curl --header)
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const headerKey = extractBearer(authHeader);
  if (headerKey === expected) return true;

  // 2. ?token=KEY query string — fallback for browser WebSocket which
  // can't set custom headers.
  if (req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.searchParams.get('token') === expected) return true;
    } catch {
      // ignore malformed url
    }
  }
  return false;
}
