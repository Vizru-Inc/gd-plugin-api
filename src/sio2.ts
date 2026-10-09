/**
 * Minimal Socket.IO v2 client (Engine.IO protocol 3, websocket transport only)
 * for the Workers runtime, where the official socket.io-client can't run.
 *
 * Wire format (text frames):
 *   0{"sid":…,"pingInterval":25000,"pingTimeout":60000}   open (server → client)
 *   2 / 3                                                  ping / pong (client pings in EIO3)
 *   40/ambient,                                            connect to namespace
 *   42/ambient,["event",{…}]                               event
 *   44/ambient,{…}                                         namespace error
 *   41/ambient,                                            namespace disconnect
 * Binary attachments aren't supported; audio is sent as base64 strings.
 */
export interface Sio2Handlers {
  onConnect: () => void;
  onEvent: (event: string, data: unknown) => void;
  onError: (message: string) => void;
  onClose: (reason: string) => void;
}

export class Sio2Client {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  connected = false;

  constructor(
    private readonly baseUrl: string, // https://host (origin only)
    private readonly nsp: string, // "/ambient"
    private readonly h: Sio2Handlers,
  ) {}

  async connect(): Promise<void> {
    this.closedByUs = false;
    const url = `${this.baseUrl.replace(/\/$/, '')}/socket.io/?EIO=3&transport=websocket`;
    const res = await fetch(url, { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket;
    if (!ws) throw new Error(`Ambient server refused the WebSocket upgrade (HTTP ${res.status})`);
    ws.accept();
    this.ws = ws;

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') this.onFrame(ev.data);
    });
    ws.addEventListener('close', (ev) => this.onSocketGone(`closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`));
    ws.addEventListener('error', () => this.onSocketGone('socket error'));
  }

  emit(event: string, data: unknown): void {
    this.send(`42${this.nsp},${JSON.stringify([event, data])}`);
  }

  close(): void {
    this.closedByUs = true;
    if (this.connected) this.send(`41${this.nsp},`);
    this.cleanup();
    try {
      this.ws?.close(1000, 'client closed');
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  private send(frame: string) {
    try {
      this.ws?.send(frame);
    } catch {
      /* socket already gone; close handler reports it */
    }
  }

  private onFrame(frame: string) {
    const type = frame[0];
    if (type === '0') {
      // Engine.IO open: start pinging (EIO3 clients ping the server), then join the namespace.
      let interval = 25000;
      try {
        interval = JSON.parse(frame.slice(1)).pingInterval ?? interval;
      } catch {
        /* keep default */
      }
      this.pingTimer = setInterval(() => this.send('2'), interval);
      this.send(`40${this.nsp},`);
      return;
    }
    if (type === '2') return this.send('3');
    if (type === '3') return; // pong
    if (type === '1') return this.onSocketGone('server closed the transport');
    if (type !== '4') return;

    // Socket.IO packet: 4<type><nsp>,<payload>
    const sioType = frame[1];
    let rest = frame.slice(2);
    if (rest.startsWith('/')) {
      const comma = rest.indexOf(',');
      const nsp = comma === -1 ? rest : rest.slice(0, comma);
      if (nsp !== this.nsp) return; // root namespace "40" etc.
      rest = comma === -1 ? '' : rest.slice(comma + 1);
    } else if (sioType === '0') {
      return; // "40": connected to the root namespace, not ours yet
    }

    if (sioType === '0') {
      this.connected = true;
      this.h.onConnect();
    } else if (sioType === '2') {
      const json = rest.replace(/^\d+/, ''); // optional ack id
      try {
        const [event, data] = JSON.parse(json) as [string, unknown];
        this.h.onEvent(event, data);
      } catch {
        /* malformed frame */
      }
    } else if (sioType === '4') {
      let msg = rest;
      try {
        const parsed = JSON.parse(rest);
        msg = typeof parsed === 'string' ? parsed : parsed?.message ?? rest;
      } catch {
        /* plain text */
      }
      this.h.onError(msg || 'Namespace error');
    } else if (sioType === '1') {
      this.onSocketGone('server disconnected the namespace');
    }
  }

  private onSocketGone(reason: string) {
    if (!this.ws) return;
    const wasOurs = this.closedByUs;
    this.cleanup();
    this.ws = null;
    if (!wasOurs) this.h.onClose(reason);
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.connected = false;
  }
}
