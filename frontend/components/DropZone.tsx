import { useState, type DragEvent } from 'react';
import { ACCEPT } from '../src/files';

interface Props {
  disabled: boolean;
  onSelect: (file: File) => void;
}

export function DropZone({ disabled, onSelect }: Props) {
  const [dragging, setDragging] = useState(false);

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) onSelect(file);
  };

  return (
    <label
      className={`dropzone${dragging ? ' dragging' : ''}${disabled ? ' disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept={ACCEPT}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onSelect(file);
          e.target.value = ''; // so choosing the same file again still fires a change
        }}
      />
      <span className="dropzone-icon" aria-hidden="true">
        ▲
      </span>
      <strong>Drop your film here</strong>
      <span className="muted">or click to choose a file · MP4, MOV, MKV or WebM</span>
    </label>
  );
}