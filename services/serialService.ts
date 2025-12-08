import { DataPoint } from '../types';

export class TC4SerialService {
  private port: any | null = null;
  private reader: any | null = null;
  private writer: any | null = null;
  private onDataCallback: ((bt: number, et: number) => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();
  private buffer = "";
  private pollingInterval: number | null = null;
  private isReading = false;

  constructor() {}

  async connect(onData: (bt: number, et: number) => void, onDisconnect: () => void): Promise<string> {
    this.onDataCallback = onData;
    this.onDisconnectCallback = onDisconnect;

    const nav = navigator as any;
    if (!nav.serial) {
      throw new Error("当前浏览器不支持 Web Serial API。请使用 Chrome, Edge 或支持该 API 的浏览器。");
    }

    try {
      console.log('Requesting Serial Port...');
      this.port = await nav.serial.requestPort();

      // Default to 115200 which is common for TC4 sketches (aArtisan). 
      // Some HC-05 modules might default to 9600.
      // Ideally this should be configurable, but 115200 is a good standard default.
      await this.port.open({ baudRate: 115200 });

      console.log('Serial Port Opened');

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
                await writer.write(this.textEncoder.encode("READ\n"));
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
    // Process lines
    if (this.buffer.includes('\n')) {
      const lines = this.buffer.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        this.parseTC4String(lines[i]);
      }
      this.buffer = lines[lines.length - 1];
    }
  }

  private parseTC4String(line: string) {
    // Expected format: "CHAN1,CHAN2,CHAN3,CHAN4" 
    // Usually Chan1=BT, Chan2=ET
    try {
        const parts = line.split(',');
        if (parts.length >= 2) {
            const bt = parseFloat(parts[0]);
            const et = parseFloat(parts[1]);
            
            if (!isNaN(bt) && !isNaN(et) && this.onDataCallback) {
                this.onDataCallback(bt, et);
            }
        }
    } catch (e) {
        // Ignore parse errors for partial lines
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