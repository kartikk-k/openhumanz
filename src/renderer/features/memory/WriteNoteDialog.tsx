/**
 * Create or edit a note.
 *
 * `memory:write` writes a real Markdown file to a real directory on the user's
 * disk — the same file they can open in their editor, the same file the watcher
 * will re-index a moment later. The dialog is built to say so: the absolute
 * destination is shown before you commit, appending is a visible choice rather
 * than a hidden default, and overwriting an existing note is called
 * overwriting.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { HardDriveDownload, TriangleAlert } from 'lucide-react';
import { IPC } from '../../../shared/ipc';
import type { MemoryDoc } from '../../../shared/memory';
import { cn } from '../../lib/utils';
import { useMutation } from '../../lib/ipc';
import { toast } from '../../store';
import {
  Button,
  Dialog,
  Input,
  Switch,
  Textarea,
} from '../../components/ui';
import { mono, textMuted } from '../../components/ui/styles';
import { absolutePath, checkVaultPath } from './tree';

export interface WriteNoteDialogProps {
  open: boolean;
  onClose: () => void;
  /** `create` lets the path be typed; `edit` pins it to an existing note. */
  mode: 'create' | 'edit';
  /** Vault-relative path. Seeds the field in `create`, fixed in `edit`. */
  initialPath?: string;
  initialContent?: string;
  /** Absolute vault root from `memory:status`, for the destination line. */
  vaultPath: string;
  /** Paths already in the index — drives the overwrite warning. */
  existingPaths: readonly string[];
  onWritten: (doc: MemoryDoc) => void;
}

const NEW_NOTE_TEMPLATE = `---
tags: []
---

# `;

export function WriteNoteDialog({
  open,
  onClose,
  mode,
  initialPath = '',
  initialContent = '',
  vaultPath,
  existingPaths,
  onWritten,
}: WriteNoteDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [content, setContent] = useState(initialContent);
  const [append, setAppend] = useState(false);
  const [touched, setTouched] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed whenever the dialog is opened for a different note.
  useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    setContent(mode === 'edit' ? initialContent : NEW_NOTE_TEMPLATE);
    setAppend(false);
    setTouched(false);
  }, [open, mode, initialPath, initialContent]);

  const write = useMutation(IPC.memory.write, {
    onSuccess: (doc) => {
      toast.success(append ? 'Appended to note' : 'Note saved', {
        description: doc.path,
      });
      onWritten(doc);
      onClose();
    },
    onError: (error) => {
      toast.error('Could not write the note', {
        description: `${error.message} (${error.code})`,
        key: 'memory-write',
      });
    },
  });

  const check = useMemo(() => checkVaultPath(path), [path]);
  const exists = check.ok && existingPaths.includes(check.value);
  const destination = check.ok
    ? absolutePath(vaultPath, check.value)
    : absolutePath(vaultPath, path.trim() || '…');

  const submit = () => {
    setTouched(true);
    if (!check.ok || write.pending) return;
    void write.mutate({ path: check.value, content, append });
  };

  return (
    <Dialog
      open={open}
      onClose={write.pending ? () => {} : onClose}
      size="xl"
      disableOverlayClose={write.pending}
      disableEscapeClose={write.pending}
      title={mode === 'edit' ? 'Edit note' : 'New note'}
      description="Memory is Markdown files on disk. Saving writes the file; the watcher re-indexes it."
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center gap-1.5">
            <HardDriveDownload
              size={12}
              aria-hidden="true"
              className={cn('shrink-0', textMuted)}
            />
            <span
              className={cn('truncate text-[11px]', mono, textMuted)}
              title={destination}
            >
              {destination}
            </span>
          </div>
          <Button variant="ghost" onClick={onClose} disabled={write.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={write.pending}
            disabled={!check.ok}
          >
            {append ? 'Append' : 'Write file'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Path in the vault"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onBlur={() => setTouched(true)}
          disabled={mode === 'edit'}
          placeholder="people/ana.md"
          inputClassName={mono}
          error={touched && !check.ok ? check.error : undefined}
          hint={
            mode === 'edit'
              ? 'Editing writes back to the same file.'
              : 'Folders are created as needed. Relative to the vault root.'
          }
        />

        <Textarea
          ref={contentRef}
          label={append ? 'Text to append' : 'Content'}
          mono
          rows={16}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="# Title&#10;&#10;Front matter is optional. `tags:` in it becomes searchable."
          textareaClassName="leading-relaxed"
        />

        <Switch
          size="sm"
          checked={append}
          onChange={setAppend}
          label="Append instead of replacing"
          description="Adds to the end of the file rather than overwriting what is there."
        />

        {exists && !append ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-500/10">
            <TriangleAlert
              size={13}
              aria-hidden="true"
              className="mt-px shrink-0 text-amber-600 dark:text-amber-400"
            />
            <p className="text-[12px] leading-relaxed text-amber-800 dark:text-amber-200">
              <span className={mono}>{check.value}</span> already exists. Saving
              replaces its entire contents — there is no undo, and this is a
              file the user may have edited by hand.
            </p>
          </div>
        ) : null}

        {write.error ? (
          <p className="text-xs text-rose-600 dark:text-rose-400">
            {write.error.message}{' '}
            <span className={mono}>({write.error.code})</span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export default WriteNoteDialog;
