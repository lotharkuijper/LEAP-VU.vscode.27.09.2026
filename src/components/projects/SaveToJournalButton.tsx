import { useState } from 'react';
import { BookText, Check, Loader2 } from 'lucide-react';
import { useLanguage } from '../../i18n';

// "Bewaar in mijn leerdagboek" in de projectruimte (2026-10-27,
// server/projects/projectJournalSave.js). Groepsteksten (tussenstand, eindreflectie,
// beoordeling, feedback op ingeleverd werk) staan bij de groep; elk groepslid
// bewaart zelf wat het in het eigen dagboek wil. Twee keer bewaren geeft geen
// dubbele regel. Met withNote kan de student er een eigen reflectie bij zetten.
export function SaveToJournalButton({ groupId, token, source, id, saved, withNote = false, onSaved, testId }: {
  groupId: string;
  token: string | null | undefined;
  source: 'checkpoint' | 'assessment' | 'review';
  id: string;
  saved: boolean;
  withNote?: boolean;
  onSaved: () => void;
  testId?: string;
}) {
  const { t, lang } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  if (saved) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-700" data-testid={testId ? `${testId}-saved` : undefined}>
        <Check className="w-3 h-3" aria-hidden="true" />{t('room.journalSave.saved')}
      </span>
    );
  }

  const save = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/groups/${groupId}/journal-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, id, lang, ...(withNote && note.trim() ? { note: note.trim() } : {}) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('room.journalSave.failed'));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 space-y-1">
      {withNote && (
        <label className="block">
          <span className="text-[11px] text-gray-600">{t('room.journalSave.noteLabel')}</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder={t('room.journalSave.notePlaceholder')}
            className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-xs"
            data-testid={testId ? `${testId}-note` : undefined}
          />
        </label>
      )}
      <button
        type="button"
        onClick={save}
        disabled={busy || !token}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-gray-300 px-2 py-1 text-[11px] text-gray-700 hover:border-blue-400 hover:text-blue-700 disabled:opacity-50"
        data-testid={testId}
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookText className="w-3 h-3" />}
        {t('room.journalSave.button')}
      </button>
      {error && <p className="text-[11px] text-red-700" role="alert">{error}</p>}
    </div>
  );
}
