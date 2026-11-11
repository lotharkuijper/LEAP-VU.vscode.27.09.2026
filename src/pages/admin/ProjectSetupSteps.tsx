// Een project inrichten in stappen (besluit 2026-11-11), zoals Cursusmateriaal:
// een balk met per stap een korte status, één stap tegelijk in beeld. Een nieuw
// project is een concept: alleen de docent ziet het en probeert het uit in een
// eigen testgroep, tot hij het in de laatste stap opent voor studenten.
// Volgorde (2026-11-11): eerst wat telt (feedback en beoordeling), dan pas de
// personages die daarheen helpen; personages zijn optioneel.
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../i18n';

export const PROJECT_STEPS = ['task', 'material', 'feedback', 'personas', 'groups', 'open'] as const;
export type ProjectStep = typeof PROJECT_STEPS[number] | 'running';

/** Wat de docent wil met feedback en beoordeling (projects.feedback_mode). */
export type FeedbackMode = 'marking' | 'both' | 'feedback';
const FEEDBACK_MODES: readonly string[] = ['marking', 'both', 'feedback'];

/** De gekozen modus; nog niet gekozen (oudere projecten): afgeleid uit de beoordelaars die er zijn. */
export function effectiveFeedbackMode(stored: string | null | undefined, hasMarker: boolean, feedbackGivers: number): FeedbackMode | null {
  if (stored && FEEDBACK_MODES.includes(stored)) return stored as FeedbackMode;
  if (hasMarker && feedbackGivers > 0) return 'both';
  if (hasMarker) return 'marking';
  if (feedbackGivers > 0) return 'feedback';
  return null;
}

export interface SetupFacts {
  project: { title?: string | null; research_question?: string | null; briefing_markdown?: string | null; status?: string | null; submissions_enabled?: boolean | null; group_mode?: string | null; feedback_mode?: string | null };
  docs: Array<{ material_kind?: string | null; is_visible_to_students: boolean }>;
  personas: Array<{ id: string; name: string; persona_type?: string; project_knowledge_doc_ids?: string[] | null; course_knowledge?: string | null }>;
  preassessorId: string | null;
  /** Is de cursus al eens vanuit Canvas geopend? null = nog onbekend. */
  canvasLinked: boolean | null;
}

/** Een aandachtspunt; `optional` = mag, maar hoeft niet (telt niet als probleem). */
export interface SetupIssue { step: typeof PROJECT_STEPS[number]; key: string; optional?: boolean; vars?: Record<string, string> }

/** Alle aandachtspunten van de inrichting, per stap. */
export function setupIssues(f: SetupFacts): SetupIssue[] {
  const out: SetupIssue[] = [];
  if (!f.project.title?.trim() || !f.project.research_question?.trim()) out.push({ step: 'task', key: 'taskMissing' });
  if (!f.project.briefing_markdown?.trim()) out.push({ step: 'task', key: 'noBriefing' });
  const material = f.docs.filter((d) => d.material_kind !== 'rubric');
  if (material.length === 0) out.push({ step: 'material', key: 'noMaterial', optional: true });
  else if (!material.some((d) => d.is_visible_to_students)) out.push({ step: 'material', key: 'materialHidden' });
  const rubrics = f.docs.filter((d) => d.material_kind === 'rubric');
  if (rubrics.some((d) => !d.is_visible_to_students)) out.push({ step: 'feedback', key: 'rubricHidden' });
  const evaluators = f.personas.filter((p) => p.persona_type === 'evaluator');
  if (rubrics.length > 0) {
    for (const p of evaluators) {
      if (!(p.project_knowledge_doc_ids || []).length) out.push({ step: 'feedback', key: 'evaluatorNoRubric', vars: { name: p.name } });
    }
  }
  // Klopt wat er staat met wat de docent koos?
  const hasMarker = !!f.preassessorId && evaluators.some((p) => p.id === f.preassessorId);
  const feedbackGivers = evaluators.filter((p) => p.id !== f.preassessorId).length;
  const mode = effectiveFeedbackMode(f.project.feedback_mode, hasMarker, feedbackGivers);
  if (mode === null) out.push({ step: 'feedback', key: 'chooseFeedbackMode', optional: true });
  if (mode === 'marking' || mode === 'both') {
    if (!f.project.submissions_enabled) out.push({ step: 'feedback', key: 'markingNeedsSubmissions' });
    if (!hasMarker) out.push({ step: 'feedback', key: 'noMarker' });
  }
  if ((mode === 'feedback' || mode === 'both') && feedbackGivers === 0) out.push({ step: 'feedback', key: 'noFeedbackGiver' });
  if (mode === 'marking' && feedbackGivers > 0) out.push({ step: 'feedback', key: 'leftoverFeedback' });
  if (mode === 'feedback' && hasMarker) out.push({ step: 'feedback', key: 'leftoverMarker', optional: true });
  // Personages zijn optioneel: zonder werken studenten zonder gesprekspartner.
  const talkers = f.personas.filter((p) => p.persona_type !== 'evaluator');
  if (talkers.length === 0) out.push({ step: 'personas', key: 'noPersonas', optional: true });
  for (const p of talkers) {
    const knows = (p.project_knowledge_doc_ids || []).length > 0 || (p.course_knowledge && p.course_knowledge !== 'none');
    if (!knows) out.push({ step: 'personas', key: 'personaKnowsNothing', optional: true, vars: { name: p.name } });
  }
  if (f.project.group_mode === 'canvas' && f.canvasLinked === false) out.push({ step: 'groups', key: 'canvasNotLinked', optional: true });
  return out;
}

export function ProjectStepNav({ step, onStep, issues, isOpen }: {
  step: ProjectStep;
  onStep: (s: ProjectStep) => void;
  issues: SetupIssue[];
  /** Open voor studenten: dan is er ook "Tijdens het project". */
  isOpen: boolean;
}) {
  const { t } = useLanguage();
  const tk = (k: string) => t(k as 'admin.projects.steps.task');
  return (
    <nav className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(min(9.5rem,100%),1fr))]" aria-label={t('admin.projects.steps.label')} data-testid="nav-project-steps">
      {PROJECT_STEPS.map((s, i) => {
        const active = s === step;
        const open = issues.filter((x) => x.step === s && !x.optional).length;
        // Zonder personages is de stap niet "in orde" maar ook geen probleem: optioneel.
        const skipped = s === 'personas' && issues.some((x) => x.key === 'noPersonas');
        return (
          <button
            key={s}
            type="button"
            onClick={() => onStep(s)}
            className={`text-left rounded-xl border px-3 py-2.5 transition-all ${active ? 'border-sky-400 bg-sky-50 ring-2 ring-sky-200' : 'border-gray-200 bg-white hover:border-gray-300'}`}
            aria-current={active ? 'step' : undefined}
            data-testid={`step-${s}`}
          >
            <div className="flex items-center gap-2">
              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${active ? 'bg-sky-600 text-white' : 'bg-gray-100 text-gray-700'}`}>{i + 1}</span>
              <span className="text-sm font-semibold text-gray-900">{tk(`admin.projects.steps.${s}`)}</span>
            </div>
            <p className={`mt-1 text-xs font-medium ${open ? 'text-amber-700' : 'text-emerald-700'}`} data-testid={`step-status-${s}`}>
              {s === 'open'
                ? <span className={isOpen ? 'text-emerald-700' : 'text-amber-700'}>{t(isOpen ? 'admin.projects.status.open' : 'admin.projects.status.draft')}</span>
                : skipped
                  ? <span className="text-gray-600">{t('admin.projects.steps.noneOptional')}</span>
                  : open
                  ? t('admin.projects.steps.attention', { n: String(open) })
                  : <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />{t('admin.projects.steps.ok')}</span>}
            </p>
          </button>
        );
      })}
      {isOpen && (
        <button
          type="button"
          onClick={() => onStep('running')}
          className={`text-left rounded-xl border px-3 py-2.5 transition-all ${step === 'running' ? 'border-emerald-400 bg-emerald-50 ring-2 ring-emerald-200' : 'border-gray-200 bg-white hover:border-gray-300'}`}
          aria-current={step === 'running' ? 'step' : undefined}
          data-testid="step-running"
        >
          <span className="text-sm font-semibold text-gray-900">{t('admin.projects.steps.running')}</span>
          <p className="mt-1 text-xs text-gray-600">{t('admin.projects.steps.runningHint')}</p>
        </button>
      )}
    </nav>
  );
}

/** "Volgende stap" onderaan een stap. */
export function NextStepButton({ step, onStep }: { step: ProjectStep; onStep: (s: ProjectStep) => void }) {
  const { t } = useLanguage();
  const i = PROJECT_STEPS.indexOf(step as typeof PROJECT_STEPS[number]);
  if (i < 0 || i === PROJECT_STEPS.length - 1) return null;
  const next = PROJECT_STEPS[i + 1];
  return (
    <div className="flex justify-end">
      <button type="button" onClick={() => onStep(next)} className="inline-flex items-center gap-1 text-sm font-medium text-sky-700 hover:text-sky-900" data-testid="button-next-project-step">
        {t('admin.projects.steps.next', { step: t(`admin.projects.steps.${next}` as 'admin.projects.steps.task') })}
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
