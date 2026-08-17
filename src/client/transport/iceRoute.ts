import type { TransferAddressFamily, TransferMode } from "../../shared/protocol";

export interface IceRoute {
  mode: Extract<TransferMode, "negotiating" | "direct-p2p" | "turn-relay">;
  addressFamily: TransferAddressFamily;
}

interface IceCandidatePairStatsLike extends RTCStats {
  localCandidateId?: string;
  nominated?: boolean;
  remoteCandidateId?: string;
  selected?: boolean;
  state?: string;
}

interface IceCandidateStatsLike extends RTCStats {
  address?: string | null;
  candidateType?: string;
  ip?: string;
}

interface TransportStatsLike extends RTCStats {
  selectedCandidatePairId?: string;
}

export const negotiatingIceRoute: IceRoute = {
  mode: "negotiating",
  addressFamily: "unknown",
};

export function selectedIceRoute(report: RTCStatsReport): IceRoute {
  const pair = findSelectedCandidatePair(report);
  if (!pair?.localCandidateId || !pair.remoteCandidateId) {
    return negotiatingIceRoute;
  }

  const localCandidate = report.get(pair.localCandidateId) as IceCandidateStatsLike | undefined;
  const remoteCandidate = report.get(pair.remoteCandidateId) as IceCandidateStatsLike | undefined;
  if (!localCandidate?.candidateType || !remoteCandidate?.candidateType) {
    return negotiatingIceRoute;
  }

  return {
    mode:
      localCandidate.candidateType === "relay" || remoteCandidate.candidateType === "relay"
        ? "turn-relay"
        : "direct-p2p",
    addressFamily: sharedAddressFamily(localCandidate, remoteCandidate),
  };
}

function findSelectedCandidatePair(report: RTCStatsReport): IceCandidatePairStatsLike | undefined {
  let selectedPairId: string | undefined;
  let selectedPair: IceCandidatePairStatsLike | undefined;
  let nominatedPair: IceCandidatePairStatsLike | undefined;

  report.forEach((stat) => {
    if (stat.type === "transport") {
      selectedPairId ??= (stat as TransportStatsLike).selectedCandidatePairId;
      return;
    }

    if (stat.type !== "candidate-pair") {
      return;
    }

    const pair = stat as IceCandidatePairStatsLike;
    if (pair.selected) {
      selectedPair ??= pair;
    }
    if (pair.nominated && pair.state === "succeeded") {
      nominatedPair ??= pair;
    }
  });

  return (selectedPairId ? (report.get(selectedPairId) as IceCandidatePairStatsLike | undefined) : undefined)
    ?? selectedPair
    ?? nominatedPair;
}

function sharedAddressFamily(
  localCandidate: IceCandidateStatsLike,
  remoteCandidate: IceCandidateStatsLike,
): TransferAddressFamily {
  const localFamily = addressFamily(localCandidate.address ?? localCandidate.ip);
  const remoteFamily = addressFamily(remoteCandidate.address ?? remoteCandidate.ip);

  if (localFamily === "unknown") {
    return remoteFamily;
  }
  if (remoteFamily === "unknown") {
    return localFamily;
  }

  return localFamily === remoteFamily ? localFamily : "unknown";
}

function addressFamily(address: string | null | undefined): TransferAddressFamily {
  if (!address) {
    return "unknown";
  }

  if (address.includes(":")) {
    return "ipv6";
  }

  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) ? "ipv4" : "unknown";
}
