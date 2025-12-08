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
  // private lastET = 20.0; // Removed in favor of strict 0 default

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
     
     const sendCommand = async () => {
        if (this.port?.writable && !this.port.writable.locked) {
            try {
                const writer = this.port.writable.getWriter();
                // Send READ with just \n to avoid "phantom space" caused by \r on some Arduinos
                await writer.write(this.textEncoder.encode("READ\n"));
                writer.releaseLock();
            } catch (e) {
                console.warn("Failed to write READ command", e);
            }
        }
     };

     // Execute immediately to get data right away
     sendCommand();

     this.pollingInterval = setInterval(sendCommand, 1000) as any;
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
            const numbers = matches.map(n => {
                const val = parseFloat(n);
                return isNaN(val) ? 0 : val;
            });

            let bt = 0;
            let et = 0;

            // SPECIAL LOGIC FOR MULTI-CHANNEL DEVICES (e.g. 0.00, 0.00, 29.65...)
            // If 3 or more numbers: 3rd number (Index 2) is BT.
            if (numbers.length >= 3) {
                bt = numbers[2];

                // For ET: Check other channels (excluding index 2)
                const potentialETs = numbers.filter((_, idx) => idx !== 2);
                const foundET = potentialETs.find(n => Math.abs(n) > 0.001);
                
                et = foundET !== undefined ? foundET : 0;
            }
            // STANDARD LOGIC (2 channels)
            else if (numbers.length === 2) {
                bt = numbers[0];
                et = numbers[1];
            } 
            // SINGLE CHANNEL LOGIC
            else if (numbers.length === 1) {
                bt = numbers[0];
                et = 0; // Default to 0 if not detected
            }

            if (this.onDataCallback) this.onDataCallback(bt, et);
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