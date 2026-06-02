import { describe, expect, it } from "vitest";
import { buildRtcConfiguration } from "./webrtcPeer";

describe("buildRtcConfiguration", () => {
  it("returns the ICE servers supplied by the caller", () => {
    const iceServers: RTCIceServer[] = [
      { urls: ["worker-issued-ice-url"], username: "u", credential: "p" },
    ];

    const config = buildRtcConfiguration(iceServers);

    expect(config.iceServers).toBe(iceServers);
  });

  it("defaults to an empty ICE server list", () => {
    expect(buildRtcConfiguration().iceServers).toEqual([]);
  });
});
