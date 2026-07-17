import { describe, expect, it } from "vitest";
import { encodeRoomMessage, parseServerMessage, roomWebSocketUrl, RoomSocket } from "./roomSocket";

class FakeWebSocket {
  closed = false;
  sent: string[] = [];
  private messageListener?: (event: MessageEvent<string>) => void;

  addEventListener(type: "message", listener: (event: MessageEvent<string>) => void): void {
    this.messageListener = type === "message" ? listener : this.messageListener;
  }

  close(): void {
    this.closed = true;
  }

  dispatchMessage(data: string): void {
    this.messageListener?.(new MessageEvent("message", { data }));
  }

  send(payload: string): void {
    this.sent.push(payload);
  }
}

describe("roomSocket protocol helpers", () => {
  it("encodes join message exactly as JSON", () => {
    expect(encodeRoomMessage({ type: "join", role: "sender" })).toBe('{"type":"join","role":"sender"}');
  });

  it("parses peer-joined server message", () => {
    expect(parseServerMessage('{"type":"peer-joined","role":"recipient"}')).toEqual({
      type: "peer-joined",
      role: "recipient",
    });
  });

  it("uses secure websocket URLs for HTTPS pages", () => {
    expect(roomWebSocketUrl("room-ABCD23", "ABCD23", { host: "send.718788.xyz", protocol: "https:" })).toBe(
      "wss://send.718788.xyz/api/rooms/room-ABCD23?code=ABCD23",
    );
  });
});

describe("RoomSocket", () => {
  it("delegates send and close to the underlying socket", () => {
    const fakeSocket = new FakeWebSocket();
    const roomSocket = new RoomSocket(fakeSocket as unknown as WebSocket);

    roomSocket.send({ type: "join", role: "sender" });
    roomSocket.close();

    expect(fakeSocket.sent).toEqual(['{"type":"join","role":"sender"}']);
    expect(fakeSocket.closed).toBe(true);
  });

  it("parses server messages before calling the message handler", () => {
    const fakeSocket = new FakeWebSocket();
    const roomSocket = new RoomSocket(fakeSocket as unknown as WebSocket);
    const received: unknown[] = [];

    roomSocket.onMessage((message) => {
      received.push(message);
    });
    fakeSocket.dispatchMessage('{"type":"peer-joined","role":"recipient"}');

    expect(received).toEqual([{ type: "peer-joined", role: "recipient" }]);
  });
});
