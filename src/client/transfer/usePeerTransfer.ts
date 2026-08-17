import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  ChunkAck,
  ClientRoomMessage,
  FileManifest,
  RoomRole,
  ServerRoomMessage,
  TransferProgress,
} from "../../shared/protocol";
import { negotiatingIceRoute, selectedIceRoute, type IceRoute } from "../transport/iceRoute";
import { loadTurnIceServers } from "../transport/turnCredentials";
import { createPeerConnection } from "../transport/webrtcPeer";
import { loadChunkAckHashes, loadCompletedChunkIndexes, saveChunkAckProgress } from "./ackProgress";
import {
  acceptTransferMessage,
  consumeCompletedChunkMessages,
  createChunkAck,
  createIncomingTransferState,
  createTransferKeyExchangeMessage,
  getTransferContentKey,
  getTransferVerificationPhrase,
  hasSentTransferKeyExchange,
  parseDataChannelTransferMessage,
  type DataChannelTransferMessage,
  type TransferKeyExchangeMessage,
} from "./dataChannelTransfer";
import { sendPeerTransferFiles } from "./peerSender";
import {
  deleteSpilloverChunk,
  downloadSpilloverChunk,
  type SpilloverCredentials,
} from "./spilloverClient";
import { sendSpilloverTransferFiles } from "./spilloverSender";
import { loadReceivedFile } from "./receivedChunkStore";
import { ReceivedFileStreamWriter, type FileSystemDirectoryHandleLike } from "./receivedFileStream";
import { loadReceivedManifests, saveReceivedManifest } from "./receivedManifestStore";

export type PeerTransferStatus = "idle" | "connecting" | "ready" | "transferring" | "complete" | "error";
export type TransferIntegrityStatus = "idle" | "pending" | "verified" | "mismatch";

export interface ReceivedFile {
  file?: File;
  name: string;
  savedToDisk?: boolean;
  size: number;
  url?: string;
}

export interface UsePeerTransferInput {
  files: File[];
  manifests: FileManifest[];
  onServerMessage: (listener: (message: ServerRoomMessage) => void) => () => void;
  pairingStatus: string;
  expiresAt?: number;
  recoveryToken?: string;
  role?: RoomRole;
  roomId?: string;
  sendRoomMessage: (message: ClientRoomMessage) => void;
}

export function usePeerTransfer(input: UsePeerTransferInput) {
  const channelRef = useRef<RTCDataChannel | null>(null);
  const completedChunkKeysRef = useRef(new Set<string>());
  const confirmedVerificationPhraseRef = useRef<string | undefined>(undefined);
  const directoryWriterRef = useRef<ReceivedFileStreamWriter | null>(null);
  const expectedAckHashesRef = useRef(new Map<string, string>());
  const integrityFailedRef = useRef(false);
  const iceRouteRefreshRef = useRef(0);
  const keyWaitersRef = useRef(new Map<string, Array<(key: CryptoKey) => void>>());
  const manifestsRef = useRef(input.manifests);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const observedIceTransportsRef = useRef(new WeakSet<RTCIceTransport>());
  const peerCreationRef = useRef<Promise<RTCPeerConnection> | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const peerConfirmedTransferIdsRef = useRef(new Set<string>());
  const receivedAckHashesRef = useRef(new Map<string, string>());
  const receivedBytesRef = useRef(0);
  const receiveQueueRef = useRef(Promise.resolve());
  const sentBytesRef = useRef(0);
  const speedSampleRef = useRef({ at: 0, bytes: 0 });
  const startedSenderPeerRef = useRef(false);
  const statusRef = useRef<PeerTransferStatus>("idle");
  const verifiedAckKeysRef = useRef(new Set<string>());
  const [activeLanes, setActiveLanes] = useState(0);
  const [completedChunks, setCompletedChunks] = useState(0);
  const [confirmedVerificationPhrase, setConfirmedVerificationPhrase] = useState<string | undefined>(undefined);
  const [incomingManifests, setIncomingManifests] = useState<FileManifest[]>([]);
  const [integrityStatus, setIntegrityStatus] = useState<TransferIntegrityStatus>("idle");
  const [iceRoute, setIceRoute] = useState<IceRoute>(negotiatingIceRoute);
  const [peerConfirmedTransferIds, setPeerConfirmedTransferIds] = useState<Set<string>>(new Set());
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [receiveDirectoryReady, setReceiveDirectoryReady] = useState(false);
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [sentBytes, setSentBytes] = useState(0);
  const [speedBytesPerSecond, setSpeedBytesPerSecond] = useState(0);
  const [spilloverBytes, setSpilloverBytes] = useState(0);
  const [status, setStatusState] = useState<PeerTransferStatus>("idle");
  const [usingRecoveryRelay, setUsingRecoveryRelay] = useState(false);
  const [verificationPhrase, setVerificationPhrase] = useState<string | undefined>(undefined);
  const setStatus = useCallback<Dispatch<SetStateAction<PeerTransferStatus>>>((nextStatus) => {
    const resolvedStatus = typeof nextStatus === "function" ? nextStatus(statusRef.current) : nextStatus;
    statusRef.current = resolvedStatus;
    setStatusState(resolvedStatus);
  }, []);
  const incomingRef = useRef(createIncomingState());
  manifestsRef.current = input.manifests;

  const progressManifests = input.manifests.length > 0 ? input.manifests : incomingManifests;
  const totalBytes = useMemo(
    () => progressManifests.reduce((sum, manifest) => sum + manifest.size, 0),
    [progressManifests],
  );
  const totalChunks = useMemo(
    () => progressManifests.reduce((sum, manifest) => sum + manifest.chunkCount, 0),
    [progressManifests],
  );

  const progress = useMemo<TransferProgress>(
    () => ({
      transferId: progressManifests[0]?.transferId ?? "pending",
      mode: usingRecoveryRelay ? "recovery-relay" : iceRoute.mode,
      addressFamily: iceRoute.addressFamily,
      totalBytes,
      sentBytes,
      receivedBytes,
      completedChunks: status === "complete" ? Math.max(completedChunks, totalChunks) : completedChunks,
      totalChunks,
      retryCount,
      activeLanes: status === "transferring" ? activeLanes : 0,
      spilloverBytes,
      speedBytesPerSecond,
    }),
    [
      activeLanes,
      completedChunks,
      iceRoute,
      progressManifests,
      receivedBytes,
      retryCount,
      sentBytes,
      speedBytesPerSecond,
      spilloverBytes,
      status,
      totalBytes,
      totalChunks,
      usingRecoveryRelay,
    ],
  );

  const sendRoomMessage = input.sendRoomMessage;

  const resetIceRoute = useCallback(() => {
    iceRouteRefreshRef.current += 1;
    setIceRoute(negotiatingIceRoute);
  }, []);

  const refreshIceRoute = useCallback(async (peer: RTCPeerConnection) => {
    if (peerRef.current !== peer) {
      return;
    }

    const refresh = iceRouteRefreshRef.current + 1;
    iceRouteRefreshRef.current = refresh;
    try {
      const route = selectedIceRoute(await peer.getStats());
      if (peerRef.current === peer && iceRouteRefreshRef.current === refresh) {
        setIceRoute(route);
      }
    } catch {
      // Route reporting is diagnostic and must not interrupt a working transfer.
    }
  }, []);

  const observeIceRoute = useCallback((peer: RTCPeerConnection) => {
    const iceTransport = peer.sctp?.transport.iceTransport;
    if (!iceTransport || observedIceTransportsRef.current.has(iceTransport)) {
      return;
    }

    observedIceTransportsRef.current.add(iceTransport);
    iceTransport.addEventListener("selectedcandidatepairchange", () => void refreshIceRoute(peer));
  }, [refreshIceRoute]);

  const sendTransferKeyExchanges = useCallback(
    async (send: (message: TransferKeyExchangeMessage) => void) => {
      for (const transferId of uniqueTransferIds(manifestsRef.current)) {
        send(await createTransferKeyExchangeMessage(incomingRef.current, transferId));
      }
    },
    [],
  );

  useEffect(() => {
    if (input.role !== "sender" || input.pairingStatus !== "connected" || input.manifests.length === 0) {
      return;
    }

    void sendTransferKeyExchanges((message) => sendRoomMessage({ type: "transfer", message }));
  }, [input.manifests, input.pairingStatus, input.role, sendRoomMessage, sendTransferKeyExchanges]);

  const handleIncomingTransferMessage = useCallback(
    async (
      message: DataChannelTransferMessage,
      sendReply: (reply: TransferKeyExchangeMessage) => void,
      source: "data-channel" | "room",
    ) => {
      if (message.type === "key-exchange" && !hasSentTransferKeyExchange(incomingRef.current, message.transferId)) {
        sendReply(await createTransferKeyExchangeMessage(incomingRef.current, message.transferId));
      }

      if (message.type === "verification-confirmed") {
        if (getTransferContentKey(incomingRef.current, message.transferId)) {
          peerConfirmedTransferIdsRef.current.add(message.transferId);
          setPeerConfirmedTransferIds(new Set(peerConfirmedTransferIdsRef.current));
        }
        return;
      }

      if (message.type !== "key-exchange") {
        const phrase = getTransferVerificationPhrase(incomingRef.current, transferMessageId(message));
        if (!phrase || confirmedVerificationPhraseRef.current !== phrase) {
          throw new Error("verification confirmation required");
        }
      }

      if (message.type === "manifest") {
        setUsingRecoveryRelay(source === "room");
        setStatus("transferring");
        setIntegrityStatus("pending");
        startSpeedSample();
        upsertIncomingManifest(message.manifest);
        if (input.recoveryToken && input.expiresAt) {
          void saveReceivedManifest({
            expiresAt: input.expiresAt,
            manifest: message.manifest,
            recoveryToken: input.recoveryToken,
          });
        }
      }

      const file = await acceptTransferMessage(incomingRef.current, message);
      if (message.type === "key-exchange") {
        const phrase = getTransferVerificationPhrase(incomingRef.current, message.transferId);
        if (phrase) {
          setVerificationPhrase(phrase);
        }
        resolveTransferKeyWaiters(message.transferId);
      }
      for (const completedChunk of consumeCompletedChunkMessages(incomingRef.current)) {
        const manifest = incomingRef.current.manifests.get(completedChunk.fileId);
        const ack = await createChunkAck(completedChunk);
        addReceivedBytes(plaintextChunkBytes(manifest, completedChunk.chunkIndex));
        setCompletedChunks((current) => current + 1);
        sendRoomMessage({ type: "ack", ack });
        if (manifest && input.recoveryToken && input.expiresAt) {
          void saveChunkAckProgress({
            ack,
            expiresAt: input.expiresAt,
            manifest,
            recoveryToken: input.recoveryToken,
          });
        }
      }

      if (file) {
        setReceivedFiles((current) => [
          ...current,
          { file, name: file.name, size: file.size, url: URL.createObjectURL(file) },
        ]);
        setIntegrityStatus("verified");
        setStatus("complete");
      }
    },
    [input.expiresAt, input.recoveryToken, sendRoomMessage],
  );

  const setupChannel = useCallback(
    (channel: RTCDataChannel) => {
      channelRef.current = channel;
      if (channel.readyState === "open") {
        setStatus("ready");
        const peer = peerRef.current;
        if (peer) {
          observeIceRoute(peer);
          void refreshIceRoute(peer);
        }
        void sendTransferKeyExchanges((message) => channel.send(JSON.stringify(message)));
      }
      channel.addEventListener("open", () => {
        setStatus("ready");
        const peer = peerRef.current;
        if (peer) {
          observeIceRoute(peer);
          void refreshIceRoute(peer);
        }
        void sendTransferKeyExchanges((message) => channel.send(JSON.stringify(message)));
      });
      channel.addEventListener("close", () => {
        if (statusRef.current === "complete") {
          return;
        }

        startedSenderPeerRef.current = false;
        channelRef.current = null;
        peerRef.current?.close();
        pendingIceCandidatesRef.current = [];
        peerCreationRef.current = null;
        peerRef.current = null;
        resetIceRoute();
        setStatus("idle");
      });
      channel.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }

        const message = parseDataChannelTransferMessage(event.data);
        if (!message) {
          return;
        }

        receiveQueueRef.current = receiveQueueRef.current
          .then(() => handleIncomingTransferMessage(
            message,
            (reply) => channel.send(JSON.stringify(reply)),
            "data-channel",
          ))
          .catch(() => {
            setStatus("error");
          });
      });
    },
    [handleIncomingTransferMessage, observeIceRoute, refreshIceRoute, resetIceRoute, sendTransferKeyExchanges],
  );

  const ensurePeer = useCallback(async () => {
    if (peerRef.current) {
      return peerRef.current;
    }

    if (!peerCreationRef.current) {
      peerCreationRef.current = (async () => {
        const iceServers = await loadTurnIceServers(input.roomId, input.recoveryToken);
        const peer = createPeerConnection(iceServers);
        resetIceRoute();
        peer.onicecandidate = (event) => {
          if (event.candidate) {
            sendRoomMessage({ type: "signal", payload: { type: "ice", candidate: event.candidate.toJSON() } });
          }
        };
        peer.ondatachannel = (event) => {
          setupChannel(event.channel);
        };
        peer.addEventListener("iceconnectionstatechange", () => {
          if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
            observeIceRoute(peer);
            void refreshIceRoute(peer);
          } else if (
            peerRef.current === peer
            && (peer.iceConnectionState === "new" || peer.iceConnectionState === "checking")
          ) {
            resetIceRoute();
          }
        });
        peerRef.current = peer;
        setStatus("connecting");

        return peer;
      })();
    }

    try {
      return await peerCreationRef.current;
    } finally {
      peerCreationRef.current = null;
    }
  }, [input.recoveryToken, input.roomId, observeIceRoute, refreshIceRoute, resetIceRoute, sendRoomMessage, setupChannel]);

  const startSenderPeer = useCallback(async () => {
    if (startedSenderPeerRef.current) {
      return;
    }

    startedSenderPeerRef.current = true;
    const peer = await ensurePeer();
    setupChannel(peer.createDataChannel("files"));
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    sendRoomMessage({ type: "signal", payload: { type: "offer", sdp: offer.sdp ?? "" } });
  }, [ensurePeer, sendRoomMessage, setupChannel]);

  const handleSignal = useCallback(
    async (message: ServerRoomMessage) => {
      if (message.type === "peer-joined" && input.role === "sender") {
        await sendTransferKeyExchanges((keyExchange) => sendRoomMessage({ type: "transfer", message: keyExchange }));
        await startSenderPeer();
        return;
      }

      if (message.type === "ack") {
        if (!acceptChunkAck(message.ack)) {
          return;
        }

        completedChunkKeysRef.current.add(chunkKey(message.ack.transferId, message.ack.fileId, message.ack.chunkIndex));
        const manifest = input.manifests.find(
          (candidate) => candidate.transferId === message.ack.transferId && candidate.fileId === message.ack.fileId,
        );
        if (manifest && input.recoveryToken && input.expiresAt) {
          void saveChunkAckProgress({
            ack: message.ack,
            expiresAt: input.expiresAt,
            manifest,
            recoveryToken: input.recoveryToken,
          });
        }
        return;
      }

      if (message.type === "transfer") {
        receiveQueueRef.current = receiveQueueRef.current
          .then(() =>
            handleIncomingTransferMessage(message.message, (reply) => {
              sendRoomMessage({ type: "transfer", message: reply });
            }, "room"),
          )
          .catch(() => {
            setStatus("error");
          });
        return;
      }

      if (message.type === "spillover-chunk") {
        receiveQueueRef.current = receiveQueueRef.current
          .then(async () => {
            const credentials = spilloverCredentials();
            if (!credentials) {
              throw new Error("spillover credentials are missing");
            }

            setStatus("transferring");
            setUsingRecoveryRelay(true);
            const chunk = await downloadSpilloverChunk(credentials, message.chunk);
            const file = await acceptTransferMessage(incomingRef.current, chunk);
            const manifest = incomingRef.current.manifests.get(chunk.fileId);
            for (const completedChunk of consumeCompletedChunkMessages(incomingRef.current)) {
              const ack = await createChunkAck(completedChunk);
              addReceivedBytes(plaintextChunkBytes(manifest, completedChunk.chunkIndex));
              setCompletedChunks((current) => current + 1);
              sendRoomMessage({ type: "ack", ack });
              if (manifest && input.recoveryToken && input.expiresAt) {
                void saveChunkAckProgress({
                  ack,
                  expiresAt: input.expiresAt,
                  manifest,
                  recoveryToken: input.recoveryToken,
                });
              }
            }
            setSpilloverBytes((current) => current + message.chunk.ciphertextBytes);
            try {
              await deleteSpilloverChunk(credentials, message.chunk);
            } catch {
              // Expiry cleanup also runs from the room alarm; failed deletes should not fail a completed download.
            }

            if (file) {
              setReceivedFiles((current) => [
                ...current,
                { file, name: file.name, size: file.size, url: URL.createObjectURL(file) },
              ]);
              setIntegrityStatus("verified");
              setStatus("complete");
            }
          })
          .catch(() => {
            setStatus("error");
          });
        return;
      }

      if (message.type !== "signal") {
        return;
      }

      const peer = await ensurePeer();
      if (message.payload.type === "offer") {
        await peer.setRemoteDescription({ type: "offer", sdp: message.payload.sdp });
        await addPendingIceCandidates(peer, pendingIceCandidatesRef.current);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        sendRoomMessage({ type: "signal", payload: { type: "answer", sdp: answer.sdp ?? "" } });
        return;
      }

      if (message.payload.type === "answer") {
        await peer.setRemoteDescription({ type: "answer", sdp: message.payload.sdp });
        await addPendingIceCandidates(peer, pendingIceCandidatesRef.current);
        return;
      }

      if (!peer.remoteDescription) {
        pendingIceCandidatesRef.current.push(message.payload.candidate);
        return;
      }

      await peer.addIceCandidate(message.payload.candidate);
    },
    [
      ensurePeer,
      handleIncomingTransferMessage,
      input.expiresAt,
      input.manifests,
      input.recoveryToken,
      input.role,
      input.roomId,
      sendRoomMessage,
      sendTransferKeyExchanges,
      startSenderPeer,
    ],
  );

  useEffect(() => input.onServerMessage((message) => void handleSignal(message)), [handleSignal, input]);

  useEffect(() => {
    if (input.role !== "recipient" || !input.recoveryToken) {
      return;
    }

    let cancelled = false;
    void hydrateRecipientRecovery(input.recoveryToken).catch(() => {
      if (!cancelled) {
        setStatus("error");
      }
    });

    return () => {
      cancelled = true;
    };

    async function hydrateRecipientRecovery(recoveryToken: string): Promise<void> {
      const manifests = await loadReceivedManifests(recoveryToken);
      if (cancelled || manifests.length === 0) {
        return;
      }

      let restoredCompletedChunks = 0;
      let restoredBytes = 0;
      const restoredFiles: ReceivedFile[] = [];

      for (const manifest of manifests) {
        incomingRef.current.manifests.set(manifest.fileId, manifest);
        upsertIncomingManifest(manifest);

        const completedIndexes = await loadCompletedChunkIndexes(manifest, recoveryToken);
        restoredCompletedChunks += completedIndexes.size;
        for (const chunkIndex of completedIndexes) {
          restoredBytes += plaintextChunkBytes(manifest, chunkIndex);
        }

        const file = await loadReceivedFile(manifest);
        if (file) {
          restoredFiles.push({ file, name: file.name, size: file.size, url: URL.createObjectURL(file) });
        }
      }

      if (cancelled) {
        for (const restoredFile of restoredFiles) {
          if (restoredFile.url) {
            URL.revokeObjectURL(restoredFile.url);
          }
        }
        return;
      }

      receivedBytesRef.current = restoredBytes;
      setCompletedChunks(restoredCompletedChunks);
      setReceivedBytes(restoredBytes);
      if (restoredFiles.length > 0) {
        setReceivedFiles(restoredFiles);
      }

      const restoredTotalChunks = manifests.reduce((sum, manifest) => sum + manifest.chunkCount, 0);
      if (restoredCompletedChunks >= restoredTotalChunks && restoredFiles.length === manifests.length) {
        setIntegrityStatus("verified");
        setStatus("complete");
      } else if (restoredCompletedChunks > 0) {
        setIntegrityStatus("pending");
        setStatus("transferring");
      }
    }
  }, [input.recoveryToken, input.role]);

  useEffect(() => {
    if (input.pairingStatus === "idle") {
      startedSenderPeerRef.current = false;
      channelRef.current?.close();
      peerRef.current?.close();
      channelRef.current = null;
      pendingIceCandidatesRef.current = [];
      peerCreationRef.current = null;
      peerRef.current = null;
      directoryWriterRef.current = null;
      incomingRef.current = createIncomingState();
      keyWaitersRef.current.clear();
      confirmedVerificationPhraseRef.current = undefined;
      peerConfirmedTransferIdsRef.current.clear();
      receiveQueueRef.current = Promise.resolve();
      completedChunkKeysRef.current.clear();
      expectedAckHashesRef.current.clear();
      integrityFailedRef.current = false;
      receivedBytesRef.current = 0;
      receivedAckHashesRef.current.clear();
      sentBytesRef.current = 0;
      speedSampleRef.current = { at: 0, bytes: 0 };
      verifiedAckKeysRef.current.clear();
      setActiveLanes(0);
      setCompletedChunks(0);
      setConfirmedVerificationPhrase(undefined);
      setIncomingManifests([]);
      resetIceRoute();
      setIntegrityStatus("idle");
      setPeerConfirmedTransferIds(new Set());
      setReceivedBytes(0);
      setReceivedFiles([]);
      setReceiveDirectoryReady(false);
      setRetryCount(0);
      setSentBytes(0);
      setSpeedBytesPerSecond(0);
      setSpilloverBytes(0);
      setStatus("idle");
      setUsingRecoveryRelay(false);
      setVerificationPhrase(undefined);
    }
  }, [input.pairingStatus, resetIceRoute]);

  const chooseReceiveDirectory = useCallback(async () => {
    const picker = directoryPicker();
    if (!picker) {
      setStatus("error");
      return;
    }

    directoryWriterRef.current = new ReceivedFileStreamWriter(await picker());
    setReceiveDirectoryReady(true);
  }, []);

  const sendSelectedFiles = useCallback(async () => {
    const transferIds = uniqueTransferIds(input.manifests);
    if (
      !verificationPhrase ||
      confirmedVerificationPhrase !== verificationPhrase ||
      transferIds.some((transferId) => !peerConfirmedTransferIdsRef.current.has(transferId))
    ) {
      setStatus("error");
      return;
    }

    const channel = channelRef.current?.readyState === "open" ? channelRef.current : undefined;
    const credentials = spilloverCredentials();
    if (!channel && !credentials) {
      setStatus("error");
      return;
    }

    setStatus("transferring");
    expectedAckHashesRef.current.clear();
    integrityFailedRef.current = false;
    receivedAckHashesRef.current.clear();
    verifiedAckKeysRef.current.clear();
    setIntegrityStatus(input.manifests.length > 0 ? "pending" : "idle");
    setActiveLanes(0);
    setCompletedChunks(0);
    setRetryCount(0);
    setSentBytes(0);
    sentBytesRef.current = 0;
    receivedBytesRef.current = 0;
    setSpeedBytesPerSecond(0);
    setSpilloverBytes(0);
    setUsingRecoveryRelay(false);
    startSpeedSample();

    try {
      if (input.recoveryToken) {
        const restoredAckHashes = await hydratePersistedAckProgress(
          input.manifests,
          input.recoveryToken,
          completedChunkKeysRef.current,
        );
        for (const [key, hash] of restoredAckHashes) {
          expectedAckHashesRef.current.set(key, hash);
          receivedAckHashesRef.current.set(key, hash);
          verifiedAckKeysRef.current.add(key);
        }
        refreshSenderIntegrityStatus();
      }

      for (const transferId of uniqueTransferIds(input.manifests)) {
        if (hasSentTransferKeyExchange(incomingRef.current, transferId)) {
          continue;
        }
        const keyExchangeMessage = await createTransferKeyExchangeMessage(incomingRef.current, transferId);
        if (channel) {
          channel.send(JSON.stringify(keyExchangeMessage));
        } else {
          sendRoomMessage({ type: "transfer", message: keyExchangeMessage });
        }
      }

      if (channel) {
        await sendPeerTransferFiles({
          channel,
          contentKeyForTransfer: waitForTransferContentKey,
          files: input.files,
          isChunkComplete: (manifest, chunkIndex) =>
            completedChunkKeysRef.current.has(chunkKey(manifest.transferId, manifest.fileId, chunkIndex)),
          manifests: input.manifests,
          onExpectedAck: recordExpectedAck,
          onProgress: (progress) => {
            setActiveLanes(progress.activeLanes);
            setCompletedChunks(progress.completedChunks);
            setRetryCount(progress.retryCount);
            applySentBytes(progress.sentBytes);
          },
        });
      } else if (credentials) {
        setUsingRecoveryRelay(true);
        await sendSpilloverTransferFiles({
          credentials,
          contentKeyForTransfer: waitForTransferContentKey,
          files: input.files,
          isChunkComplete: (manifest, chunkIndex) =>
            completedChunkKeysRef.current.has(chunkKey(manifest.transferId, manifest.fileId, chunkIndex)),
          manifests: input.manifests,
          onExpectedAck: recordExpectedAck,
          onProgress: (progress) => {
            setActiveLanes(progress.activeLanes);
            setCompletedChunks(progress.completedChunks);
            setRetryCount(progress.retryCount);
            applySentBytes(progress.sentBytes);
            setSpilloverBytes(progress.spilloverBytes);
          },
          sendRoomMessage,
        });
      }
      if (!refreshSenderIntegrityStatus()) {
        setStatus("transferring");
      }
    } catch {
      setActiveLanes(0);
      setStatus("error");
    }
  }, [confirmedVerificationPhrase, input.expiresAt, input.files, input.manifests, input.recoveryToken, input.roomId, sendRoomMessage, verificationPhrase]);

  const confirmVerificationPhrase = useCallback(() => {
    if (verificationPhrase) {
      confirmedVerificationPhraseRef.current = verificationPhrase;
      setConfirmedVerificationPhrase(verificationPhrase);
      for (const transferId of incomingRef.current.transferKeys.keys()) {
        const confirmation = { type: "verification-confirmed" as const, transferId };
        if (channelRef.current?.readyState === "open") {
          channelRef.current.send(JSON.stringify(confirmation));
        }
        sendRoomMessage({ type: "transfer", message: confirmation });
      }
    }
  }, [sendRoomMessage, verificationPhrase]);

  return {
    canSend:
      input.role === "sender" &&
      input.files.length > 0 &&
      Boolean(verificationPhrase) &&
      confirmedVerificationPhrase === verificationPhrase &&
      uniqueTransferIds(input.manifests).every((transferId) => peerConfirmedTransferIds.has(transferId)) &&
      (status === "ready" || (input.pairingStatus === "connected" && Boolean(spilloverCredentials()))),
    canChooseReceiveDirectory: input.role !== "sender" && Boolean(directoryPicker()),
    chooseReceiveDirectory,
    confirmVerificationPhrase,
    progress,
    receiveDirectoryReady,
    receivedFiles,
    integrityStatus,
    sendSelectedFiles,
    status,
    verificationPhrase,
    verificationConfirmed: Boolean(verificationPhrase) && confirmedVerificationPhrase === verificationPhrase,
  };

  function createIncomingState() {
    return createPersistentIncomingTransferState({
      directoryWriterRef,
      setIntegrityStatus,
      setReceivedFiles,
      setStatus,
    });
  }

  function recordExpectedAck(ack: ChunkAck): void {
    const key = chunkKey(ack.transferId, ack.fileId, ack.chunkIndex);
    expectedAckHashesRef.current.set(key, ack.hash);

    const receivedHash = receivedAckHashesRef.current.get(key);
    if (receivedHash && receivedHash !== ack.hash) {
      markIntegrityMismatch(key);
      return;
    }

    if (receivedHash === ack.hash) {
      verifiedAckKeysRef.current.add(key);
    }

    refreshSenderIntegrityStatus();
  }

  function acceptChunkAck(ack: ChunkAck): boolean {
    const key = chunkKey(ack.transferId, ack.fileId, ack.chunkIndex);
    const expectedHash = expectedAckHashesRef.current.get(key);
    if (expectedHash && expectedHash !== ack.hash) {
      markIntegrityMismatch(key);
      return false;
    }

    receivedAckHashesRef.current.set(key, ack.hash);
    if (expectedHash === ack.hash) {
      verifiedAckKeysRef.current.add(key);
    }

    refreshSenderIntegrityStatus();
    return true;
  }

  function markIntegrityMismatch(key: string): void {
    integrityFailedRef.current = true;
    completedChunkKeysRef.current.delete(key);
    verifiedAckKeysRef.current.delete(key);
    setActiveLanes(0);
    setIntegrityStatus("mismatch");
    setStatus("error");
  }

  function refreshSenderIntegrityStatus(): boolean {
    if (integrityFailedRef.current) {
      return false;
    }

    const requiredChunks = input.manifests.reduce((sum, manifest) => sum + manifest.chunkCount, 0);
    if (requiredChunks === 0) {
      setIntegrityStatus("idle");
      return false;
    }

    if (expectedAckHashesRef.current.size >= requiredChunks && verifiedAckKeysRef.current.size >= requiredChunks) {
      setIntegrityStatus("verified");
      setStatus("complete");
      return true;
    }

    setIntegrityStatus("pending");
    return false;
  }

  function resolveTransferKeyWaiters(transferId: string): void {
    const contentKey = getTransferContentKey(incomingRef.current, transferId);
    if (!contentKey) {
      return;
    }

    const waiters = keyWaitersRef.current.get(transferId) ?? [];
    keyWaitersRef.current.delete(transferId);
    for (const resolve of waiters) {
      resolve(contentKey);
    }
  }

  function waitForTransferContentKey(transferId: string): Promise<CryptoKey> {
    const contentKey = getTransferContentKey(incomingRef.current, transferId);
    if (contentKey) {
      return Promise.resolve(contentKey);
    }

    return new Promise((resolve) => {
      const waiters = keyWaitersRef.current.get(transferId) ?? [];
      waiters.push(resolve);
      keyWaitersRef.current.set(transferId, waiters);
    });
  }

  function spilloverCredentials(): SpilloverCredentials | undefined {
    if (!input.roomId || !input.recoveryToken) {
      return undefined;
    }

    return { roomId: input.roomId, recoveryToken: input.recoveryToken };
  }

  function upsertIncomingManifest(manifest: FileManifest): void {
    setIncomingManifests((current) => {
      const existingIndex = current.findIndex(
        (candidate) => candidate.transferId === manifest.transferId && candidate.fileId === manifest.fileId,
      );
      if (existingIndex === -1) {
        return [...current, manifest];
      }

      const next = current.slice();
      next[existingIndex] = manifest;
      return next;
    });
  }

  function addReceivedBytes(bytes: number): void {
    setReceivedBytes((current) => {
      const next = current + bytes;
      receivedBytesRef.current = next;
      recordSpeedSample(sentBytesRef.current + next);
      return next;
    });
  }

  function applySentBytes(bytes: number): void {
    sentBytesRef.current = bytes;
    setSentBytes(bytes);
    recordSpeedSample(bytes + receivedBytesRef.current);
  }

  function startSpeedSample(): void {
    speedSampleRef.current = { at: Date.now(), bytes: sentBytesRef.current + receivedBytesRef.current };
  }

  function recordSpeedSample(totalTransferredBytes: number): void {
    const now = Date.now();
    const previous = speedSampleRef.current;
    if (previous.at === 0 || totalTransferredBytes <= previous.bytes) {
      speedSampleRef.current = { at: now, bytes: totalTransferredBytes };
      return;
    }

    const elapsedSeconds = (now - previous.at) / 1000;
    if (elapsedSeconds > 0) {
      setSpeedBytesPerSecond(Math.round((totalTransferredBytes - previous.bytes) / elapsedSeconds));
    }
    speedSampleRef.current = { at: now, bytes: totalTransferredBytes };
  }
}

interface PersistentIncomingTransferStateInput {
  directoryWriterRef: MutableRefObject<ReceivedFileStreamWriter | null>;
  setIntegrityStatus: Dispatch<SetStateAction<TransferIntegrityStatus>>;
  setReceivedFiles: Dispatch<SetStateAction<ReceivedFile[]>>;
  setStatus: Dispatch<SetStateAction<PeerTransferStatus>>;
}

function createPersistentIncomingTransferState(input?: PersistentIncomingTransferStateInput) {
  return createIncomingTransferState({
    completeReceivedFile: async (manifest) => {
      const writer = input?.directoryWriterRef.current;
      if (!input || !writer) {
        return;
      }

      await writer.complete(manifest);
      input.setReceivedFiles((current) => [
        ...current,
        { name: manifest.name, savedToDisk: true, size: manifest.size },
      ]);
      input.setIntegrityStatus("verified");
      input.setStatus("complete");
    },
    persistReceivedChunks: true,
    writeReceivedChunk: async (chunk) => input?.directoryWriterRef.current?.writeChunk(chunk) ?? false,
  });
}

interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike>;
}

function directoryPicker(): (() => Promise<FileSystemDirectoryHandleLike>) | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as WindowWithDirectoryPicker).showDirectoryPicker;
}

function chunkKey(transferId: string, fileId: string, chunkIndex: number): string {
  return `${transferId}:${fileId}:${chunkIndex}`;
}

function uniqueTransferIds(manifests: FileManifest[]): string[] {
  return Array.from(new Set(manifests.map((manifest) => manifest.transferId)));
}

async function addPendingIceCandidates(
  peer: RTCPeerConnection,
  pendingCandidates: RTCIceCandidateInit[],
): Promise<void> {
  for (const candidate of pendingCandidates.splice(0)) {
    await peer.addIceCandidate(candidate);
  }
}

function transferMessageId(message: Exclude<DataChannelTransferMessage, { type: "key-exchange" | "verification-confirmed" }>): string {
  return message.type === "manifest" ? message.manifest.transferId : message.transferId;
}

async function hydratePersistedAckProgress(
  manifests: FileManifest[],
  recoveryToken: string,
  completedChunkKeys: Set<string>,
): Promise<Map<string, string>> {
  const ackHashes = new Map<string, string>();

  await Promise.all(
    manifests.map(async (manifest) => {
      const completedIndexes = await loadCompletedChunkIndexes(manifest, recoveryToken);
      for (const chunkIndex of completedIndexes) {
        completedChunkKeys.add(chunkKey(manifest.transferId, manifest.fileId, chunkIndex));
      }

      const manifestAckHashes = await loadChunkAckHashes(manifest, recoveryToken);
      for (const [chunkIndex, hash] of manifestAckHashes) {
        if (completedIndexes.has(chunkIndex)) {
          ackHashes.set(chunkKey(manifest.transferId, manifest.fileId, chunkIndex), hash);
        }
      }
    }),
  );

  return ackHashes;
}

function plaintextChunkBytes(manifest: FileManifest | undefined, chunkIndex: number): number {
  if (!manifest) {
    return 0;
  }

  const offset = chunkIndex * manifest.chunkSize;
  return Math.max(0, Math.min(manifest.chunkSize, manifest.size - offset));
}
