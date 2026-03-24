
export class WebSocketService {
  private ws: WebSocket | null = null;
  private onDataCallback: ((bt: number, et: number) => void) | null = null;
  private onRawCallback: ((data: string) => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private onErrorCallback: ((msg: string) => void) | null = null;
  
  // Heartbeat to keep connection alive
  private pingInterval: number | null = null;
  // Artisan-style polling request interval
  private requestInterval: number | null = null;
  private messageId = Math.floor(Date.now() % 100000);

  private lastBt = 0;
  private lastEt = 0;

  // Align with Artisan WebSocket tab defaults shown in docs/examples.
  private readonly commandNode = 'command';
  private readonly messageIdNode = 'id';
  private readonly machineIdNode = 'machine';
  private readonly machineIdValue = 0;
  private readonly dataRequestTag = 'getData';
  private readonly requestIntervalMs = 1000;

  constructor() {}

  connect(
      url: string,
      onData: (bt: number, et: number) => void, 
      onDisconnect: () => void,
      onRaw?: (data: string) => void,
      onError?: (msg: string) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
        this.onDataCallback = onData;
        this.onDisconnectCallback = onDisconnect;
        this.onRawCallback = onRaw || null;
        this.onErrorCallback = onError || null;

        try {
            const input = url.trim();
            if (!input) {
                reject(new Error("WebSocket 地址不能为空"));
                return;
            }

            const isHttpsPage = typeof window !== 'undefined' && window.location.protocol === 'https:';

            // If protocol is omitted, follow page security context:
            // https page -> wss, http page -> ws.
            const fullUrl = input.includes('://')
                ? input
                : `${isHttpsPage ? 'wss' : 'ws'}://${input}`;

            // Mixed-content guard: HTTPS pages cannot open ws:// sockets.
            if (isHttpsPage && fullUrl.startsWith('ws://')) {
                reject(new Error("当前页面是 HTTPS（如 Netlify），不能连接 ws://。请改用 wss:// 地址，或在本地 http:// 页面访问。"));
                return;
            }

            console.log(`Connecting to WebSocket: ${fullUrl}`);
            
            this.ws = new WebSocket(fullUrl);

            this.ws.onopen = () => {
                console.log('WebSocket Connected');
                this.lastBt = 0;
                this.lastEt = 0;
                this.startHeartbeat();
                this.startDataRequests();
                resolve(`WS: ${fullUrl}`);
            };

            this.ws.onmessage = (event) => {
                const msg = event.data;
                if (typeof msg === 'string') {
                     if (this.onRawCallback) this.onRawCallback(msg);
                     this.parseMessage(msg);
                }
            };

            this.ws.onclose = (event) => {
                console.log('WebSocket Closed', event.code, event.reason);
                this.cleanup();
                if (this.onDisconnectCallback) this.onDisconnectCallback();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket Error', error);
                // Only reject if it happens during initial connection
                if (this.ws?.readyState === WebSocket.CONNECTING) {
                     reject(new Error("WebSocket 连接失败。请检查地址或网络。"));
                } else {
                     if (this.onErrorCallback) this.onErrorCallback("WebSocket 发生错误");
                }
            };

        } catch (e: any) {
            reject(new Error(e.message || "无效的 WebSocket 地址"));
        }
    });
  }

  private parseMessage(jsonStr: string) {
      try {
          const parsed = JSON.parse(jsonStr);
          const payload = this.extractDataPayload(parsed);

          // Prefer BT/ET in nested data node (Artisan WebSocket examples),
          // then fall back to commonly used direct keys.
          const bt = this.pickNumeric(payload, ['BT', 'Bean', 'temp2', 'bt', 'bean']);
          const et = this.pickNumeric(payload, ['ET', 'Environment', 'temp1', 'et', 'env']);

          if (bt !== null) this.lastBt = bt;
          if (et !== null) this.lastEt = et;

          if ((bt !== null || et !== null) && this.onDataCallback) {
              this.onDataCallback(this.lastBt, this.lastEt);
          }

      } catch (e) {
          // Not JSON, ignore or log
          // console.warn("WS Parse Error", e);
      }
  }

  private extractDataPayload(parsed: unknown): Record<string, unknown> {
      if (!parsed || typeof parsed !== 'object') return {};
      const obj = parsed as Record<string, unknown>;
      const dataNode = obj.data;
      if (dataNode && typeof dataNode === 'object' && !Array.isArray(dataNode)) {
          return dataNode as Record<string, unknown>;
      }
      return obj;
  }

  private pickNumeric(source: Record<string, unknown>, keys: string[]): number | null {
      for (const key of keys) {
          const value = source[key];
          if (typeof value === 'number' && Number.isFinite(value)) return value;
          if (typeof value === 'string') {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) return parsed;
          }
      }
      return null;
  }

  private sendDataRequest() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.dataRequestTag) return;
      this.messageId = (this.messageId + 1) % 100000;
      const request = {
          [this.commandNode]: this.dataRequestTag,
          [this.messageIdNode]: this.messageId,
          [this.machineIdNode]: this.machineIdValue
      };
      this.ws.send(JSON.stringify(request));
  }

  private startHeartbeat() {
      if (this.pingInterval) clearInterval(this.pingInterval);
      // Send a ping every 30s to keep connection alive if needed
      // Artisan usually just pushes data, but good practice for some proxies
      this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              // Standard text ping or empty json
              // this.ws.send('{"command": "ping"}'); 
          }
      }, 30000) as any;
  }

  private startDataRequests() {
      if (this.requestInterval) clearInterval(this.requestInterval);
      // Match Artisan behavior: send one request every sampling interval (1s default in this app).
      this.sendDataRequest();
      this.requestInterval = setInterval(() => {
          this.sendDataRequest();
      }, this.requestIntervalMs) as any;
  }

  disconnect() {
      this.cleanup();
      if (this.ws) {
          this.ws.close();
          this.ws = null;
      }
  }

  private cleanup() {
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.requestInterval) clearInterval(this.requestInterval);
      this.pingInterval = null;
      this.requestInterval = null;
  }
}
