export type TransferMode = "direct-p2p" | "turn-relay" | "recovery-relay";

export type RoomRole = "sender" | "recipient";

export interface FileManifest {
  transferId: string;
  fileId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  chunkSize: number;
  chunkCount: number;
  fileHash?: string;
}

export interface ChunkAck {
  transferId: string;
  fileId: string;
  chunkIndex: number;
  hash: string;
}

export interface TransferProgress {
  transferId: string;
  mode: TransferMode;
  totalBytes: number;
  sentBytes: number;
  receivedBytes: number;
  completedChunks: number;
  totalChunks: number;
  retryCount: number;
  activeLanes: number;
  spilloverBytes: number;
}

export type SignalPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

export type ClientRoomMessage =
  | { type: "join"; role: RoomRole; recoveryToken?: string }
  | { type: "signal"; payload: SignalPayload }
  | { type: "manifest"; manifest: FileManifest }
  | { type: "ack"; ack: ChunkAck }
  | { type: "heartbeat"; at: number };

export type ServerRoomMessage =
  | { type: "joined"; roomId: string; role: RoomRole; recoveryToken: string; expiresAt: number }
  | { type: "peer-joined"; role: RoomRole }
  | { type: "signal"; payload: SignalPayload }
  | { type: "manifest"; manifest: FileManifest }
  | { type: "ack"; ack: ChunkAck }
  | { type: "expired"; roomId: string }
  | { type: "error"; code: string; message: string };
