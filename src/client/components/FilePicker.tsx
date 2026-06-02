export interface FilePickerProps {
  onFilesSelected: (files: File[]) => void;
}

export function FilePicker({ onFilesSelected }: FilePickerProps) {
  return (
    <label className="file-picker">
      <span>Drop files or choose from disk</span>
      <input
        aria-label="Choose files"
        type="file"
        multiple
        onChange={(event) => {
          const input = event.currentTarget;
          onFilesSelected(Array.from(input.files ?? []));
        }}
      />
    </label>
  );
}
