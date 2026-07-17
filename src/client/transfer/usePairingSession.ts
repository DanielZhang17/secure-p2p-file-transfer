import { useEffect, useRef, useState } from "react";
import type { ClientRoomMessage, RoomRole, ServerRoomMessage } from "../../shared/protocol";
import { normalizeRoomCode, ROOM_CODE_PATTERN, roomIdFromCode } from "../../shared/roomCode";
import { roomWebSocketUrl, RoomSocket } from "../transport/roomSocket";
import {
  clearPairingRecoverySession,
  loadPairingRecoverySession,
  savePairingRecoverySession,
} from "./pairingRecoveryStore";

export type PairingStatus = "idle" | "creating" | "connecting" | "waiting" | "connected" | "expired" | "error";

export interface PairingState {
  code: string;
  expiresAt?: number;
  message: string;
  recoveryToken?: string;
  role?: RoomRole;
  roomId: string;
  status: PairingStatus;
}

interface RoomCreationResponse {
  code: string;
  expiresAt: number;
  roomId: string;
}

const idlePairingState: PairingState = {
  code: "",
  message: "",
  roomId: "",
  status: "idle",
};
const RECONNECT_DELAY_MS = 1_000;

export function usePairingSession() {
  const [initialState] = useState<PairingState>(() => initialPairingState());
  const [state, setState] = useState<PairingState>(initialState);
  const ignoredCloseSocketRef = useRef<WebSocket | null>(null);
  const messageListenersRef = useRef(new Set<(message: ServerRoomMessage) => void>());
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const roomSocketRef = useRef<RoomSocket | null>(null);
  const stateRef = useRef<PairingState>(initialState);
  const webSocketRef = useRef<WebSocket | null>(null);

  function clearReconnectTimer(): void {
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
  }

  function closeCurrentSocket(): void {
    clearReconnectTimer();
    ignoredCloseSocketRef.current = webSocketRef.current;
    roomSocketRef.current?.close();
    roomSocketRef.current = null;
    webSocketRef.current = null;
  }

  function connectToRoom(
    room: Pick<PairingState, "code" | "expiresAt" | "recoveryToken" | "roomId">,
    role: RoomRole,
  ): void {
    closeCurrentSocket();
    const socket = new WebSocket(roomWebSocketUrl(room.roomId, room.code));
    const roomSocket = new RoomSocket(socket);
    roomSocketRef.current = roomSocket;
    webSocketRef.current = socket;

    const connectingState: PairingState = {
      ...room,
      message: "Opening pairing room.",
      role,
      status: "connecting",
    };
    stateRef.current = connectingState;
    setState(connectingState);

    socket.addEventListener("open", () => {
      roomSocket.send(room.recoveryToken ? { type: "join", role, recoveryToken: room.recoveryToken } : { type: "join", role });
    });
    socket.addEventListener("error", () => {
      setState((current) =>
        canReconnect(current)
          ? { ...current, message: "Pairing connection disrupted. Reconnecting.", status: "connecting" }
          : { ...current, message: "Pairing connection failed.", status: "error" },
      );
    });
    socket.addEventListener("close", () => {
      if (ignoredCloseSocketRef.current === socket) {
        ignoredCloseSocketRef.current = null;
        return;
      }

      scheduleReconnectOrFail();
    });
    roomSocket.onMessage((message) => {
      const next = nextPairingState(stateRef.current, message, role);
      stateRef.current = next;
      setState(next);
      syncPairingRecoverySession(next, message);
      for (const listener of messageListenersRef.current) {
        listener(message);
      }
    });
  }

  function scheduleReconnectOrFail(): void {
    const current = stateRef.current;

    if (!canReconnect(current)) {
      setState((latest) => {
        if (latest.status === "expired" || latest.status === "error") {
          return latest;
        }

        const next = { ...latest, message: "Pairing connection closed.", status: "error" as const };
        stateRef.current = next;
        return next;
      });
      return;
    }

    const reconnectingState: PairingState = {
      ...current,
      message: "Pairing connection dropped. Reconnecting.",
      status: "connecting",
    };
    stateRef.current = reconnectingState;
    setState(reconnectingState);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = undefined;
      const latest = stateRef.current;
      if (canReconnect(latest)) {
        connectToRoom(latest, latest.role);
      }
    }, RECONNECT_DELAY_MS);
  }

  async function startSenderRoom(): Promise<void> {
    clearPairingRecoverySession();
    closeCurrentSocket();
    setState({
      ...idlePairingState,
      message: "Creating pairing room.",
      role: "sender",
      status: "creating",
    });

    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      const body: unknown = await response.json();
      if (!response.ok || !isRoomCreationResponse(body)) {
        throw new Error("room creation failed");
      }

      connectToRoom(body, "sender");
    } catch {
      setState({
        ...idlePairingState,
        message: "Could not create a pairing room.",
        role: "sender",
        status: "error",
      });
    }
  }

  function joinRecipientRoom(inputCode: string): void {
    const code = normalizeRoomCode(inputCode);

    if (!ROOM_CODE_PATTERN.test(code)) {
      setState({
        ...idlePairingState,
        code,
        message: "Enter the 6-character pairing code.",
        role: "recipient",
        status: "error",
      });
      return;
    }

    clearPairingRecoverySession();
    connectToRoom({ code, roomId: roomIdFromCode(code) }, "recipient");
  }

  function resetPairing(): void {
    clearPairingRecoverySession();
    closeCurrentSocket();
    stateRef.current = idlePairingState;
    setState(idlePairingState);
  }

  function onServerMessage(listener: (message: ServerRoomMessage) => void): () => void {
    messageListenersRef.current.add(listener);
    return () => {
      messageListenersRef.current.delete(listener);
    };
  }

  function sendRoomMessage(message: ClientRoomMessage): void {
    roomSocketRef.current?.send(message);
  }

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const current = stateRef.current;
    if (canReconnect(current)) {
      connectToRoom(current, current.role);
    }

    return closeCurrentSocket;
  }, []);

  return {
    joinRecipientRoom,
    onServerMessage,
    resetPairing,
    sendRoomMessage,
    startSenderRoom,
    state,
  };
}

function initialPairingState(): PairingState {
  const saved = loadPairingRecoverySession();
  if (!saved) {
    return idlePairingState;
  }

  return {
    ...saved,
    message: "Restoring pairing room.",
    status: "connecting",
  };
}

function canReconnect(state: PairingState): state is PairingState & {
  code: string;
  expiresAt: number;
  recoveryToken: string;
  role: RoomRole;
  roomId: string;
} {
  return Boolean(
    state.code &&
      state.roomId &&
      state.role &&
      state.recoveryToken &&
      state.expiresAt &&
      state.expiresAt > Date.now() &&
      state.status !== "expired",
  );
}

function nextPairingState(current: PairingState, message: ServerRoomMessage, fallbackRole: RoomRole): PairingState {
  if (message.type === "joined") {
    const role = message.role;

    return {
      ...current,
      expiresAt: message.expiresAt,
      message: role === "sender" ? "Waiting for receiver." : "Waiting for sender.",
      recoveryToken: message.recoveryToken,
      role,
      roomId: message.roomId,
      status: "waiting",
    };
  }

  if (message.type === "peer-joined") {
    return {
      ...current,
      message: `${peerLabel(message.role)} connected.`,
      status: "connected",
    };
  }

  if (message.type === "expired") {
    return {
      ...current,
      message: "Pairing room expired. Create a new code.",
      roomId: message.roomId,
      status: "expired",
    };
  }

  if (message.type === "error") {
    return {
      ...current,
      message: roomErrorMessage(message.code),
      role: current.role ?? fallbackRole,
      status: "error",
    };
  }

  return current;
}

function syncPairingRecoverySession(state: PairingState, message: ServerRoomMessage): void {
  if (message.type === "joined" && canReconnect(state)) {
    savePairingRecoverySession({
      code: state.code,
      expiresAt: state.expiresAt,
      recoveryToken: state.recoveryToken,
      role: state.role,
      roomId: state.roomId,
    });
    return;
  }

  if (
    message.type === "expired" ||
    (message.type === "error" && ["invalid_room_code", "room_expired", "room_not_found"].includes(message.code))
  ) {
    clearPairingRecoverySession();
  }
}

function peerLabel(role: RoomRole): string {
  return role === "sender" ? "Sender" : "Receiver";
}

function roomErrorMessage(code: string): string {
  if (code === "invalid_room_code") {
    return "Pairing code is invalid.";
  }

  if (code === "room_not_found" || code === "room_expired") {
    return "Pairing room expired. Create a new code.";
  }

  return "Pairing room error.";
}

function isRoomCreationResponse(value: unknown): value is RoomCreationResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "expiresAt" in value &&
    "roomId" in value &&
    typeof value.code === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.roomId === "string"
  );
}
