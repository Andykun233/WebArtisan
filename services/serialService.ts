import { DataPoint } from '../types';

export class TC4SerialService {
  private port: any | null = null;
  private reader: any | null = null;
  private onDataCallback: ((bt: number, et: number) => void) | null = null;
  private onRawCallback: ((data: string) => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();
  private buffer = "";
  private pollingInterval: number | null = null;
  private isReading = false;
  private lastET = 20.0; // Cache to handle single-channel devices

  constructor() {}

  async connect(
      onData: (bt: number, et: number) => void, 
      onDisconnect: () => void, 
      baudRate: number = 115200,
      onRaw?: (data: string) => void
  ): Promise<string> {
    this.onDataCallback = onData;
    this.onDisconnectCallback = onDisconnect;
    this.onRawCallback = onRaw || null;

    const nav = navigator as any;
    if (!nav.serial) {
      throw new Error("当前浏览器不支持 Web Serial API。请使用 Chrome, Edge 或支持该 API 的浏览器。");
    }

    try {
      console.log('Requesting Serial Port...');
      this.port = await nav.serial.requestPort();

      // Open with user-specified baudRate
      await this.port.open({ baudRate: baudRate });

      console.log(`Serial Port Opened at ${baudRate} baud`);

      // Start reading loop
      this.isReading = true;
      this.readLoop();

      // Start polling loop (SEND READ COMMAND)
      this.startPolling();

      return "Serial/SPP Device";

    } catch (error: any) {
      console.error('Serial Connection failed:', error);
      this.cleanup();
      throw error;
    }
  }

  private startPolling() {
     if (this.pollingInterval) clearInterval(this.pollingInterval);
     
     this.pollingInterval = setInterval(async () => {
        if (this.port?.writable && !this.port.writable.locked) {
            try {
                const writer = this.port.writable.getWriter();
                // Send READ with CRLF for maximum compatibility
                await writer.write(this.textEncoder.encode("READ\r\n"));
                writer.releaseLock();
            } catch (e) {
                console.warn("Failed to write READ command", e);
            }
        }
     }, 1000) as any;
  }

  private async readLoop() {
      while (this.port?.readable && this.isReading) {
        this.reader = this.port.readable.getReader();
        try {
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) {
              // Reader has been canceled.
              break;
            }
            if (value) {
                const chunk = this.textDecoder.decode(value);
                // Send raw data to UI for debugging
                if (this.onRawCallback) {
                    this.onRawCallback(chunk);
                }
                this.handleData(chunk);
            }
          }
        } catch (error) {
          console.error("Read Error", error);
        } finally {
          this.reader.releaseLock();
        }
      }
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    
    // Improved regex split to handle \r\n, \n, or \r
    if (this.buffer.match(/[\r\n]/)) {
      const parts = this.buffer.split(/[\r\n]+/);
      
      // The last part is likely incomplete, keep it in buffer
      this.buffer = parts.pop() || "";
      
      for (const line of parts) {
          if (line.trim()) {
              this.parseGreedy(line);
          }
      }
    }
  }

  private parseGreedy(line: string) {
    try {
        const cleanLine = line.trim();
        if (!cleanLine || cleanLine.startsWith('#')) return;

        // Greedy Regex: Find any sequence that looks like a number (integer or float)
        // e.g. "Temp: 150.5, Env: 200" -> matches ["150.5", "200"]
        const matches = cleanLine.match(/[-+]?[0-9]*\.?[0-9]+/g);

        if (matches) {
            const numbers = matches.map(parseFloat);
            
            if (numbers.length >= 2) {
                // Assuming standard order: BT, ET
                const bt = numbers[0];
                const et = numbers[1];
                this.lastET = et;
                if (this.onDataCallback) this.onDataCallback(bt, et);
            } else if (numbers.length === 1) {
                // Single channel detected (assume BT)
                const bt = numbers[0];
                // Reuse last known ET to avoid graph crashing to 0
                if (this.onDataCallback) this.onDataCallback(bt, this.lastET);
            }
        }
    } catch (e) {
        console.warn("Parse error:", e);
    }
  }

  async disconnect() {
    this.isReading = false;
    if (this.pollingInterval) clearInterval(this.pollingInterval);

    if (this.reader) {
        try {
            await this.reader.cancel();
        } catch (e) { console.error(e) }
    }
    
    if (this.port) {
        try {
            await this.port.close();
        } catch (e) { console.error(e) }
    }

    this.cleanup();
    
    if (this.onDisconnectCallback) {
        this.onDisconnectCallback();
    }
  }

  private cleanup() {
      this.port = null;
      this.reader = null;
      this.buffer = "";
  }
}