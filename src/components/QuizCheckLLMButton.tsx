import { Coffee } from 'lucide-react';
import { useLanguage } from '../i18n';
import { stashStudiecafeHandoff } from '../lib/studiecafeHandoff';
import { buildQuizFeedbackExcerpt, type QuizExcerptAnswer } from '../lib/quizFeedbackExcerpt';
import type { QuizQuestion } from '../services/llm.service';

// "Klopt dit wel?" bij de feedback op een quizvraag: plaatst vraag, eigen
// antwoord en feedback in het Studiecafé (categorie check-llm), net als de
// "Check de LLM"-knop in de chat. Opent in een NIEUW tabblad zodat de lopende
// quiz niet verloren gaat; een <a> i.p.v. window.open omdat een gewone link
// niet door pop-upblokkers wordt tegengehouden.
export function QuizCheckLLMButton(props: {
  question: QuizQuestion;
  answer: QuizExcerptAnswer | undefined;
  sourceLabel?: string;
  sources?: Array<{ title: string; documentId?: string }>;
  courseId: string | null;
  testId?: string;
}) {
  const { t } = useLanguage();

  const handleClick = () => {
    stashStudiecafeHandoff(
      {
        v: 1,
        courseId: props.courseId,
        category: 'check-llm',
        attachment: buildQuizFeedbackExcerpt({
          question: props.question,
          answer: props.answer,
          sourceLabel: props.sourceLabel,
          sources: props.sources,
          courseId: props.courseId,
          labels: {
            heading: t('quiz.checkLLM.heading'),
            source: t('quiz.checkLLM.source'),
            casus: t('quiz.casusLabel'),
            yourAnswer: t('quiz.checkLLM.yourAnswer'),
            correctAnswer: t('quiz.checkLLM.correctAnswer'),
            feedback: t('quiz.checkLLM.feedback'),
            feedforward: t('quiz.feedforward'),
            score: t('quiz.score'),
            modelAnswer: t('quiz.modelAnswerExample'),
            noAnswer: t('quiz.checkLLM.noAnswer'),
          },
        }),
        mode: 'thread',
      },
      { crossTab: true },
    );
  };

  return (
    <a
      href="/studiecafe"
      target="_blank"
      rel="noopener"
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100 transition-colors"
      title={t('quiz.checkLLM.hint')}
      data-testid={props.testId ?? 'button-quiz-check-llm'}
    >
      <Coffee className="w-3.5 h-3.5" />
      {t('quiz.checkLLM.label')}
    </a>
  );
}
