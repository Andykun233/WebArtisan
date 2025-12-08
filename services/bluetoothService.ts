import { DEFAULT_BLE_CONFIG } from '../types';

// Add Fallback UUIDs for HM-10 / CC2541 modules often used in DIY roasters
const HM10_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const HM10_CHAR_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

export class TC4BluetoothService {
  private device: any | null = null;
  private server: any | null = null;
  private rxChar: any | null = null;
  private txChar: any | null = null;
  private onDataCallback: ((bt: number, et: number) => void) | null = null;
  private onRawCallback: ((data: string) => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();
  private buffer = "";
  private pollingInterval: number | null = null;
  private lastET = 20.0;

  constructor() {}

  async connect(
      onData: (bt: number, et: number) => void, 
      onDisconnect: () => void,
      onRaw?: (data: string) => void
  ): Promise<string> {
    this.onDataCallback = onData;
    this.onDisconnectCallback = onDisconnect;
    this.onRawCallback = onRaw || null;

    // Check for browser support
    const nav = navigator as any;
    if (!nav.bluetooth) {
      throw new Error("当前浏览器不支持 Web Bluetooth。请使用 Chrome, Edge 或 Bluefy (iOS)。");
    }

    try {
      console.log('Requesting Bluetooth Device...');
      // Request filters for both standard Nordic UART and HM-10
      this.device = await nav.bluetooth.requestDevice({
        filters: [
            { services: [DEFAULT_BLE_CONFIG.serviceUuid] },
            { services: [HM10_SERVICE_UUID] }
        ],
        optionalServices: [DEFAULT_BLE_CONFIG.serviceUuid, HM10_SERVICE_UUID]
      });

      if (!this.device || !this.device.gatt) {
        throw new Error('未找到设备或 GATT 服务不可用');
      }

      this.device.addEventListener('gattserverdisconnected', this.onDisconnected);

      console.log('Connecting to GATT Server...');
      this.server = await this.device.gatt.connect();

      console.log('Getting Service...');
      // Try Nordic Service First
      let service = null;
      let isHM10 = false;
      
      try {
          service = await this.server.getPrimaryService(DEFAULT_BLE_CONFIG.serviceUuid);
      } catch (e) {
          console.log("Nordic service not found, trying HM-10...");
          service = await this.server.getPrimaryService(HM10_SERVICE_UUID);
          isHM10 = true;
      }

      console.log('Getting Characteristics...');
      if (isHM10) {
          // HM-10 uses one characteristic for both TX and RX
          const char = await service.getCharacteristic(HM10_CHAR_UUID);
          this.rxChar = char;
          this.txChar = char;
      } else {
          // Nordic uses separate
          this.rxChar = await service.getCharacteristic(DEFAULT_BLE_CONFIG.characteristicRxUuid);
          this.txChar = await service.getCharacteristic(DEFAULT_BLE_CONFIG.characteristicTxUuid);
      }

      await this.rxChar.startNotifications();
      this.rxChar.addEventListener('characteristicvaluechanged', this.handleNotifications);
      
      console.log('Connected to TC4/BLE Device');
      
      // Start polling loop in case device needs READ command
      this.startPolling();

      return this.device.name || "TC4/BLE Device";

    } catch (error: any) {
      console.error('Connection failed:', error);
      throw error;
    }
  }

  private startPolling() {
     if (this.pollingInterval) clearInterval(this.pollingInterval);
     
     const sendCommand = async () => {
        if (this.server?.connected && this.txChar) {
            try {
                // Send READ command with just \n
                await this.txChar.writeValue(this.textEncoder.encode("READ\n"));
            } catch (e) {
                console.warn("Failed to write READ command", e);
            }
        } else {
            if (this.pollingInterval) clearInterval(this.pollingInterval);
        }
     };

     // Execute immediately to get data right away
     sendCommand();
     
     // Schedule interval
     this.pollingInterval = setInterval(sendCommand, 1000) as any;
  }

  private handleNotifications = (event: Event) => {
    const target = event.target as any;
    const value = target.value;
    if (!value) return;

    const chunk = this.textDecoder.decode(value);
    
    // Send raw data to UI
    if (this.onRawCallback) {
        this.onRawCallback(chunk);
    }

    this.buffer += chunk;

    // Handle both \n and \r for broader device support
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
  };

  private parseGreedy(line: string) {
    try {
        const cleanLine = line.trim();
        if (!cleanLine || cleanLine.startsWith('#')) return;

        // Greedy Regex: Find any sequence that looks like a number (integer or float)
        const matches = cleanLine.match(/[-+]?[0-9]*\.?[0-9]+/g);

        if (matches) {
            const numbers = matches.map(parseFloat);
            
            if (numbers.length >= 2) {
                const bt = numbers[0];
                const et = numbers[1];
                this.lastET = et;
                if (this.onDataCallback) this.onDataCallback(bt, et);
            } else if (numbers.length === 1) {
                const bt = numbers[0];
                if (this.onDataCallback) this.onDataCallback(bt, this.lastET);
            }
        }
    } catch (e) {
        console.error("Error parsing BLE string", line, e);
    }
  }

  private onDisconnected = () => {
    console.log('Device disconnected');
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    if (this.onDisconnectCallback) this.onDisconnectCallback();
  };

  disconnect() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    
    if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
    
    if (this.rxChar) {
        this.rxChar.removeEventListener('characteristicvaluechanged', this.handleNotifications);
    }
  }
}