
export interface DataPoint {
  time: number; // Seconds since start
  bt: number;   // Bean Temperature
  et: number;   // Environment Temperature
  ror: number;  // Rate of Rise (BT)
  et_ror?: number; // Rate of Rise (ET)
}

export enum RoastStatus {
  IDLE = 'IDLE',
  CONNECTED = 'CONNECTED',
  ROASTING = 'ROASTING',
  COOLING = 'COOLING',
  FINISHED = 'FINISHED',
}

export type RoastEvent = {
  time: number;
  label: string;
  temp: number;
};
