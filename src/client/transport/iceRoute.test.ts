import { describe, expect, it } from "vitest";
import { selectedIceRoute } from "./iceRoute";

describe("selectedIceRoute", () => {
  it("reports a selected direct IPv6 candidate pair", () => {
    expect(selectedIceRoute(statsReport([
      { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
      { id: "pair", type: "candidate-pair", localCandidateId: "local", remoteCandidateId: "remote" },
      { id: "local", type: "local-candidate", candidateType: "host", address: "2001:db8::1" },
      { id: "remote", type: "remote-candidate", candidateType: "host", address: "2001:db8::2" },
    ]))).toEqual({ mode: "direct-p2p", addressFamily: "ipv6" });
  });

  it("reports TURN when either selected candidate is relayed", () => {
    expect(selectedIceRoute(statsReport([
      { id: "pair", type: "candidate-pair", selected: true, localCandidateId: "local", remoteCandidateId: "remote" },
      { id: "local", type: "local-candidate", candidateType: "relay", address: "192.0.2.1" },
      { id: "remote", type: "remote-candidate", candidateType: "prflx", address: null },
    ]))).toEqual({ mode: "turn-relay", addressFamily: "ipv4" });
  });

  it("supports the nominated candidate-pair fallback", () => {
    expect(selectedIceRoute(statsReport([
      {
        id: "pair",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
      { id: "local", type: "local-candidate", candidateType: "srflx", address: "192.0.2.1" },
      { id: "remote", type: "remote-candidate", candidateType: "prflx", address: "198.51.100.2" },
    ]))).toEqual({ mode: "direct-p2p", addressFamily: "ipv4" });
  });

  it("keeps the route negotiating until a complete selected pair is available", () => {
    expect(selectedIceRoute(statsReport([
      { id: "pair", type: "candidate-pair", nominated: true, state: "in-progress" },
    ]))).toEqual({ mode: "negotiating", addressFamily: "unknown" });
  });
});

function statsReport(stats: Array<Record<string, unknown>>): RTCStatsReport {
  const report = new Map(stats.map((stat) => [stat.id, stat]));
  return report as unknown as RTCStatsReport;
}
