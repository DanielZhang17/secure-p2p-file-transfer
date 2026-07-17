export interface VerifyPhraseProps {
  confirmed?: boolean;
  onConfirm?: () => void;
  phrase: string;
  labels?: VerifyPhraseLabels;
}

export interface VerifyPhraseLabels {
  confirm: string;
  confirmed: string;
  help: string;
  label: string;
  title: string;
}

const defaultLabels: VerifyPhraseLabels = {
  confirm: "The phrases match",
  confirmed: "Phrase confirmed",
  help: "Compare this phrase with the other device before sending files.",
  label: "Transfer check phrase",
  title: "Transfer check phrase",
};

export function VerifyPhrase({ confirmed = false, onConfirm, phrase, labels = defaultLabels }: VerifyPhraseProps) {
  return (
    <div className="verify-phrase" aria-label={labels.label}>
      <span>{labels.title}</span>
      <strong>{phrase}</strong>
      <small>{labels.help}</small>
      {confirmed ? <span role="status">{labels.confirmed}</span> : onConfirm ? (
        <button type="button" className="secondary" onClick={onConfirm}>
          {labels.confirm}
        </button>
      ) : null}
    </div>
  );
}
