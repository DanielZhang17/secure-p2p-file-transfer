import { normalizeRoomCode } from "../../shared/roomCode";

export interface JoinRoomProps {
  code: string;
  label?: string;
  onCodeChange: (code: string) => void;
}

export function JoinRoom({ code, label = "Pairing code", onCodeChange }: JoinRoomProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={code}
        maxLength={6}
        inputMode="text"
        autoComplete="one-time-code"
        onChange={(event) => onCodeChange(normalizeRoomCode(event.currentTarget.value))}
      />
    </label>
  );
}
