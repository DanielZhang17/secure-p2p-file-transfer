import { describe, expect, it } from "vitest";
import { encodeRoomMessage, parseServerMessage, RoomSocket } from "./roomSocket";

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
});

describe("RoomSocket", () => {
  it("delegates send and close to the underlying socket", () => {
    const fakeSocket = {
      closed: false,
      sent: [] as string[],
      addEventListener: () => {},
      close() {
        this.closed = true;
      },
      send(payload: string) {
        this.sent.push(payload);
      },
    };
    const roomSocket = new RoomSocket(fakeSocket as unknown as WebSocket);

    roomSocket.send({ type: "join", role: "sender" });
    roomSocket.close();

    expect(fakeSocket.sent).toEqual(['{"type":"join","role":"sender"}']);
    expect(fakeSocket.closed).toBe(true);
  });
});
