
export class WebSocketService {
  private ws: WebSocket | null = null;
  private onDataCallback: ((bt: number, et: number) => void) | null = null;
  private onRawCallback: ((data: string) => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private onErrorCallback: ((msg: string) => void) | null = null;
  
  // Heartbeat to keep connection alive
  private pingInterval: number | null = null;

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
            // Ensure protocol is present
            const fullUrl = url.includes('://') ? url : `ws://${url}`;
            console.log(`Connecting to WebSocket: ${fullUrl}`);
            
            this.ws = new WebSocket(fullUrl);

            this.ws.onopen = () => {
                console.log('WebSocket Connected');
                this.startHeartbeat();
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
          const data = JSON.parse(jsonStr);
          
          let bt = 0;
          let et = 0;

          // Artisan standard JSON structure:
          // { "temp1": 150.0, "temp2": 200.0, ... }
          // temp1 is typically ET (Env), temp2 is BT (Bean) in default Artisan setups.
          
          if (typeof data.temp2 === 'number') bt = data.temp2;
          else if (typeof data.Bean === 'number') bt = data.Bean;
          else if (typeof data.bt === 'number') bt = data.bt;

          if (typeof data.temp1 === 'number') et = data.temp1;
          else if (typeof data.Environment === 'number') et = data.Environment;
          else if (typeof data.et === 'number') et = data.et;

          // Filter out 0/0 packets if valid data exists elsewhere or valid packets are expected
          // But allow 0 if it's the start.
          
          if (this.onDataCallback) {
              this.onDataCallback(bt, et);
          }

      } catch (e) {
          // Not JSON, ignore or log
          // console.warn("WS Parse Error", e);
      }
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

  disconnect() {
      this.cleanup();
      if (this.ws) {
          this.ws.close();
          this.ws = null;
      }
  }

  private cleanup() {
      if (this.pingInterval) clearInterval(this.pingInterval);
  }
}
