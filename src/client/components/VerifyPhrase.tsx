export interface VerifyPhraseProps {
  phrase: string;
  confirmed: boolean;
  onConfirm: () => void;
}

export function VerifyPhrase({ phrase, confirmed, onConfirm }: VerifyPhraseProps) {
  return (
    <section className="verify-box" aria-label="Local check phrase">
      <span>Local check phrase</span>
      <strong>{phrase}</strong>
      <button type="button" disabled={confirmed} onClick={onConfirm}>
        {confirmed ? "Checked" : "Mark checked"}
      </button>
    </section>
  );
}
