import { DEFAULT_BLE_CONFIG } from '../types';

export class TC4BluetoothService {
  private device: any | null = null;
  private server: any | null = null;
  private rxChar: any | null = null;
  private txChar: any | null = null;
  private onDataCallback: ((bt: number, et: number) => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();
  private buffer = "";
  private pollingInterval: number | null = null;

  constructor() {}

  async connect(onData: (bt: number, et: number) => void, onDisconnect: () => void): Promise<string> {
    this.onDataCallback = onData;
    this.onDisconnectCallback = onDisconnect;

    // Check for browser support
    const nav = navigator as any;
    if (!nav.bluetooth) {
      throw new Error("当前浏览器不支持 Web Bluetooth。请使用 Chrome, Edge 或 Bluefy (iOS)。");
    }

    try {
      console.log('Requesting Bluetooth Device...');
      this.device = await nav.bluetooth.requestDevice({
        filters: [{ services: [DEFAULT_BLE_CONFIG.serviceUuid] }],
        optionalServices: [DEFAULT_BLE_CONFIG.serviceUuid]
      });

      if (!this.device || !this.device.gatt) {
        throw new Error('未找到设备或 GATT 服务不可用');
      }

      this.device.addEventListener('gattserverdisconnected', this.onDisconnected);

      console.log('Connecting to GATT Server...');
      this.server = await this.device.gatt.connect();

      console.log('Getting Service...');
      const service = await this.server.getPrimaryService(DEFAULT_BLE_CONFIG.serviceUuid);

      console.log('Getting Characteristics...');
      this.rxChar = await service.getCharacteristic(DEFAULT_BLE_CONFIG.characteristicRxUuid);
      this.txChar = await service.getCharacteristic(DEFAULT_BLE_CONFIG.characteristicTxUuid);

      await this.rxChar.startNotifications();
      this.rxChar.addEventListener('characteristicvaluechanged', this.handleNotifications);
      
      console.log('Connected to TC4 Device');
      
      // Start polling loop in case device needs READ command
      this.startPolling();

      return this.device.name || "TC4 Device";

    } catch (error: any) {
      console.error('Connection failed:', error);
      throw error;
    }
  }

  private startPolling() {
     if (this.pollingInterval) clearInterval(this.pollingInterval);
     
     // Send READ command every second according to TC4 protocol
     // Using CRLF (\r\n) instead of just \n for better compatibility
     this.pollingInterval = setInterval(async () => {
        if (this.server?.connected && this.txChar) {
            try {
                await this.txChar.writeValue(this.textEncoder.encode("READ\r\n"));
            } catch (e) {
                console.warn("Failed to write READ command", e);
            }
        } else {
            if (this.pollingInterval) clearInterval(this.pollingInterval);
        }
     }, 1000) as any;
  }

  private handleNotifications = (event: Event) => {
    const target = event.target as any;
    const value = target.value;
    if (!value) return;

    const chunk = this.textDecoder.decode(value);
    // console.debug("Raw BLE Data:", chunk); // Uncomment for debugging
    this.buffer += chunk;

    // Handle both \n and \r for broader device support
    if (this.buffer.match(/[\r\n]/)) {
      const parts = this.buffer.split(/[\r\n]+/);
      
      // The last part is likely incomplete, keep it in buffer
      this.buffer = parts.pop() || "";
      
      for (const line of parts) {
          if (line.trim()) {
              this.parseTC4String(line);
          }
      }
    }
  };

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
        console.error("Error parsing TC4 string", line, e);
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