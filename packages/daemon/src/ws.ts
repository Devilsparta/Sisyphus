/**
 * WebSocket hub — broadcasts daemon events to all connected UI clients
 * and accepts incoming request/response frames (M1: receive only, dispatch
 * lands in M2 once skills are real).
 *
 * Frame format follows the custom IPC protocol pinned in the kernel:
 *   { type: 'event',    event, data }            — one-way notification
 *   { type: 'request',  id, method, params }     — RPC call
 *   { type: 'response', id, result?, error? }    — RPC reply
 */
import type { Server as HTTPServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  IPCEvent,
  IPCMessage,
  IPCResponse,
} from '@sisyphus/kernel';

const WS_PATH = '/ws';

export type Sender = <T>(event: string, data: T) => void;

export interface WSHubOptions {
  /**
   * Called once per new connection (after the WS handshake completes) with a
   * per-client `send` function. Use this to push initial state — readiness,
   * registry snapshot, etc. — so late-joining clients see the same picture
   * boot-time clients did.
   */
  onConnection?: (send: Sender) => void;
  /**
   * Per-request gate for the WS upgrade. Returning false rejects the upgrade
   * with 401 before the handshake completes. M11 uses this for API key auth.
   */
  isAuthorized?: (req: IncomingMessage) => boolean;
}

export interface WSHub {
  attach(server: HTTPServer): void;
  broadcast<T>(event: string, data: T): void;
  close(): Promise<void>;
}

export function createWSHub(opts: WSHubOptions = {}): WSHub {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);

    const send: Sender = (event, data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const envelope: IPCEvent = { type: 'event', event, data };
        ws.send(JSON.stringify(envelope));
      }
    };

    ws.on('message', (raw) => {
      let msg: IPCMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'request') {
        // M1: no methods registered yet. Reply with method-not-found so
        // clients can verify the request/response plumbing works.
        const reply: IPCResponse = {
          type: 'response',
          id: msg.id,
          error: { code: -32601, message: `Unknown method: ${msg.method}` },
        };
        ws.send(JSON.stringify(reply));
      }
      // type === 'response' or 'event': M1 has no client→server pubsub or
      // pending RPC table; ignore silently.
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });

    opts.onConnection?.(send);
  });

  return {
    attach(server: HTTPServer) {
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head) => {
        // Allow WS_PATH plus query string (?token=...) variants.
        let pathname: string;
        try {
          pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        } catch {
          socket.destroy();
          return;
        }
        if (pathname !== WS_PATH) {
          socket.destroy();
          return;
        }
        if (opts.isAuthorized && !opts.isAuthorized(req)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });
    },

    broadcast<T>(event: string, data: T) {
      const envelope: IPCEvent<T> = { type: 'event', event, data };
      const payload = JSON.stringify(envelope);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    },

    async close() {
      for (const ws of clients) {
        ws.close();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
