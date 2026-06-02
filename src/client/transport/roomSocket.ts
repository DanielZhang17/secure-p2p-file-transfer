import type { ClientRoomMessage, ServerRoomMessage } from "../../shared/protocol";

export function encodeRoomMessage(message: ClientRoomMessage): string {
  return JSON.stringify(message);
}

export function parseServerMessage(payload: string): ServerRoomMessage {
  return JSON.parse(payload) as ServerRoomMessage;
}

export class RoomSocket {
  constructor(private readonly socket: WebSocket) {}

  send(message: ClientRoomMessage): void {
    this.socket.send(encodeRoomMessage(message));
  }

  onMessage(handler: (message: ServerRoomMessage) => void): void {
    this.socket.addEventListener("message", (event) => {
      handler(parseServerMessage(String(event.data)));
    });
  }

  close(): void {
    this.socket.close();
  }
}
