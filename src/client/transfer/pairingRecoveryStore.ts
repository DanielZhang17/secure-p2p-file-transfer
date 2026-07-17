import type { RoomRole } from "../../shared/protocol";

export interface PairingRecoverySession {
  code: string;
  expiresAt: number;
  recoveryToken: string;
  role: RoomRole;
  roomId: string;
}

const PAIRING_RECOVERY_STORAGE_KEY = "secure-p2p-transfer:pairing-session";

export function savePairingRecoverySession(session: PairingRecoverySession): void {
  if (session.expiresAt <= Date.now()) {
    clearPairingRecoverySession();
    return;
  }

  try {
    browserStorage()?.setItem(PAIRING_RECOVERY_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Recovery storage is opportunistic. Live transfers still work without it.
  }
}

export function loadPairingRecoverySession(): PairingRecoverySession | undefined {
  try {
    const raw = browserStorage()?.getItem(PAIRING_RECOVERY_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isPairingRecoverySession(parsed) || parsed.expiresAt <= Date.now()) {
      clearPairingRecoverySession();
      return undefined;
    }

    return parsed;
  } catch {
    clearPairingRecoverySession();
    return undefined;
  }
}

export function clearPairingRecoverySession(): void {
  try {
    browserStorage()?.removeItem(PAIRING_RECOVERY_STORAGE_KEY);
  } catch {
    // Ignore storage failures; clearing is best-effort.
  }
}

function isPairingRecoverySession(value: unknown): value is PairingRecoverySession {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "expiresAt" in value &&
    "recoveryToken" in value &&
    "role" in value &&
    "roomId" in value &&
    typeof value.code === "string" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    typeof value.recoveryToken === "string" &&
    isRoomRole(value.role) &&
    typeof value.roomId === "string"
  );
}

function isRoomRole(value: unknown): value is RoomRole {
  return value === "sender" || value === "recipient";
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return window.localStorage;
}
