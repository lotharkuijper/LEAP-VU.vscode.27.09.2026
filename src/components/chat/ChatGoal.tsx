import { useEffect, useState } from 'react';
import { Target, Pencil, X } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { Tooltip } from '../help/Tooltip';

// Optioneel doel voor dit chatgesprek (server/chat/chatGoal.js). De student kiest
// het zelf; niets is verplicht. De tutor houdt er rekening mee en de reflectie
// in het leerdagboek benoemt hoe ver de student kwam.

export const CHAT_GOAL_MAX = 200;

/** Pure: het laatst gezette doel uit opgeslagen berichten (key aanwezig = ooit gezet; null = weggehaald). */
export function goalFromMessages(rows: Array<{ role: string; retrievedContext?: unknown }>): { goal: string | null; touched: boolean } {
  let goal: string | null = null;
  let touched = false;
  for (const m of rows) {
    const rc = m.retrievedContext as Record<string, unknown> | null | undefined;
    if (m.role === 'user' && rc && Object.prototype.hasOwnProperty.call(rc, 'chatGoal')) {
      touched = true;
      goal = typeof rc.chatGoal === 'string' && rc.chatGoal.trim() ? rc.chatGoal.trim() : null;
    }
  }
  return { goal, touched };
}

export function ChatGoalButton({ goal, onClick, disabled }: { goal: string | null; onClick: () => void; disabled?: boolean }) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={t('chat.goal.hint')}
      aria-pressed={!!goal}
      className={`px-3 py-1.5 text-xs rounded-md border flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 ${goal ? 'border-brand-400 bg-brand-50 text-brand-700' : 'border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600'}`}
      data-testid="button-chat-goal"
    >
      <Target className="w-3.5 h-3.5" />
      {t('chat.goal.button')}
    </button>
  );
}

/** Editor (als open) of label met het huidige doel. */
export function ChatGoalBar({ goal, editing, onSave, onRemove, onEdit, onCancel }: {
  goal: string | null;
  editing: boolean;
  onSave: (goal: string) => void;
  onRemove: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(goal || '');
  useEffect(() => { if (editing) setDraft(goal || ''); }, [editing, goal]);

  if (editing) {
    const save = () => { const g = draft.replace(/\s+/g, ' ').trim(); if (g) onSave(g.slice(0, CHAT_GOAL_MAX)); else onRemove(); };
    return (
      <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50/60 p-3" data-testid="panel-chat-goal">
        <label htmlFor="chat-goal-input" className="mb-1 block text-xs font-medium text-gray-700">{t('chat.goal.question')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="chat-goal-input"
            value={draft}
            maxLength={CHAT_GOAL_MAX}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') onCancel(); }}
            placeholder={t('chat.goal.placeholder')}
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand-400"
            data-testid="input-chat-goal"
          />
          <button type="button" onClick={save} className="whitespace-nowrap rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700" data-testid="button-chat-goal-save">
            {t('common.save')}
          </button>
          {goal && (
            <button type="button" onClick={onRemove} className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-red-700 hover:bg-red-50" data-testid="button-chat-goal-remove">
              {t('chat.goal.remove')}
            </button>
          )}
          <button type="button" onClick={onCancel} className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100">
            {t('common.cancelAction')}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">{t('chat.goal.note')}</p>
      </div>
    );
  }
  if (!goal) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-1.5 text-sm text-brand-800" data-testid="label-chat-goal">
      <Target className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{t('chat.goal.label')}:</span> {goal}</span>
      <Tooltip label={t('chat.goal.edit')}>
        <button type="button" onClick={onEdit} className="rounded p-1 hover:bg-brand-100" data-testid="button-chat-goal-edit"><Pencil className="h-3.5 w-3.5" /></button>
      </Tooltip>
      <Tooltip label={t('chat.goal.remove')}>
        <button type="button" onClick={onRemove} className="rounded p-1 hover:bg-brand-100" data-testid="button-chat-goal-clear"><X className="h-3.5 w-3.5" /></button>
      </Tooltip>
    </div>
  );
}
