export interface DataPoint {
  time: number; // Seconds since start
  bt: number;   // Bean Temperature
  et: number;   // Environment Temperature
  ror: number;  // Rate of Rise (BT)
}

export enum RoastStatus {
  IDLE = 'IDLE',
  CONNECTED = 'CONNECTED',
  ROASTING = 'ROASTING',
  COOLING = 'COOLING',
  FINISHED = 'FINISHED',
}

export interface BluetoothConfig {
  serviceUuid: string;
  characteristicTxUuid: string;
  characteristicRxUuid: string;
}

// Nordic UART Service (Common for TC4/Arduino Bluetooth)
export const DEFAULT_BLE_CONFIG: BluetoothConfig = {
  serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', 
  characteristicTxUuid: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Write
  characteristicRxUuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // Notify
};

export type RoastEvent = {
  time: number;
  label: string;
  temp: number;
};
