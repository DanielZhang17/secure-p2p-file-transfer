export interface JoinRoomProps {
  code: string;
  onCodeChange: (code: string) => void;
}

export function JoinRoom({ code, onCodeChange }: JoinRoomProps) {
  return (
    <label className="field">
      <span>Pairing code</span>
      <input
        aria-label="Pairing code"
        value={code}
        maxLength={6}
        inputMode="text"
        autoComplete="one-time-code"
        onChange={(event) => onCodeChange(event.currentTarget.value.toUpperCase())}
      />
    </label>
  );
}
