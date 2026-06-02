export interface VerifyPhraseProps {
  phrase: string;
  confirmed: boolean;
  onConfirm: () => void;
}

export function VerifyPhrase({ phrase, confirmed, onConfirm }: VerifyPhraseProps) {
  return (
    <section className="verify-box" aria-label="Verification phrase">
      <span>Verification phrase</span>
      <strong>{phrase}</strong>
      <button type="button" disabled={confirmed} onClick={onConfirm}>
        {confirmed ? "Verified" : "Looks right"}
      </button>
    </section>
  );
}
