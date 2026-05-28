/**
 * UI-side WebSocket client.
 *
 * Subscribes to daemon events (chat tokens, registry deltas, plugin
 * lifecycle, etc.) and provides a simple `on(event, handler)` API.
 *
 * M1: receive-only. M2 will add a request() helper with id-based correlation
 * once skills become callable.
 *
 * Frame format follows the custom IPC protocol pinned in the kernel.
 */
import type { IPCEvent, IPCMessage } from '@sisylabs/kernel';

type EventHandler<T = unknown> = (data: T) => void;

class WSClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs = 2000;

  connect(url: string) {
    this.url = url;
    this.openSocket();
  }

  private openSocket() {
    if (!this.url) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onmessage = (e) => {
      let msg: IPCMessage;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (msg.type === 'event') {
        this.dispatchEvent(msg);
      }
      // 'response' / 'request': not handled in M1.
    };

    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // 'close' will follow.
    };
  }

  private dispatchEvent(msg: IPCEvent) {
    const handlers = this.handlers.get(msg.event);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(msg.data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[ws] handler for "${msg.event}" threw:`, err);
      }
    }
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler);
    return () => {
      set!.delete(handler as EventHandler);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, this.reconnectDelayMs);
  }
}

export const ws = new WSClient();
