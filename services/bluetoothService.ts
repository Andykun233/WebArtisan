import { DEFAULT_BLE_CONFIG } from '../types';

// Add missing Web Bluetooth types to global scope
declare global {
  interface Navigator {
    bluetooth: {
      requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
    };
  }

  interface RequestDeviceOptions {
    filters?: Array<{
      services?: (string | number)[];
      name?: string;
      namePrefix?: string;
    }>;
    optionalServices?: (string | number)[];
    acceptAllDevices?: boolean;
  }

  interface BluetoothDevice extends EventTarget {
    id: string;
    name?: string;
    gatt?: BluetoothRemoteGATTServer;
  }

  interface BluetoothRemoteGATTServer {
    connected: boolean;
    device: BluetoothDevice;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
  }

  interface BluetoothRemoteGATTService {
    uuid: string;
    isPrimary: boolean;
    getCharacteristic(characteristic: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    uuid: string;
    value?: DataView;
    readValue(): Promise<DataView>;
    writeValue(value: BufferSource): Promise<void>;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  }
}

export class TC4BluetoothService {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  private txChar: BluetoothRemoteGATTCharacteristic | null = null;
  private onDataCallback: ((bt: number, et: number) => void) | null = null;
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();
  private buffer = "";

  constructor() {}

  async connect(onData: (bt: number, et: number) => void): Promise<void> {
    this.onDataCallback = onData;

    try {
      console.log('Requesting Bluetooth Device...');
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [DEFAULT_BLE_CONFIG.serviceUuid] }],
        optionalServices: [DEFAULT_BLE_CONFIG.serviceUuid]
      });

      if (!this.device || !this.device.gatt) {
        throw new Error('Device not found or GATT not available');
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

    } catch (error) {
      console.error('Argh! ' + error);
      throw error;
    }
  }

  private startPolling() {
     // Send READ command every second according to TC4 protocol
     const pollInterval = setInterval(async () => {
        if (this.server?.connected && this.txChar) {
            try {
                // TC4 protocol: "READ" followed by newline
                await this.txChar.writeValue(this.textEncoder.encode("READ\n"));
            } catch (e) {
                console.warn("Failed to write READ command", e);
            }
        } else {
            clearInterval(pollInterval);
        }
     }, 1000);
  }

  private handleNotifications = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;

    const chunk = this.textDecoder.decode(value);
    this.buffer += chunk;

    // TC4 lines end with \n
    if (this.buffer.includes('\n')) {
      const lines = this.buffer.split('\n');
      // Process all complete lines
      for (let i = 0; i < lines.length - 1; i++) {
        this.parseTC4String(lines[i]);
      }
      // Keep the remainder
      this.buffer = lines[lines.length - 1];
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
    // In a real app, trigger a state update in the UI
  };

  disconnect() {
    if (this.device && this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
  }
}