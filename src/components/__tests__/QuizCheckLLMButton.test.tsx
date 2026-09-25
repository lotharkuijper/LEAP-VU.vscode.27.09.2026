// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../i18n';
import { QuizCheckLLMButton } from '../QuizCheckLLMButton';
import { takeStudiecafeHandoff } from '../../lib/studiecafeHandoff';
import { buildQuizFeedbackExcerpt, type QuizExcerptLabels } from '../../lib/quizFeedbackExcerpt';
import type { MCQQuestion, OpenQuestion } from '../../services/llm.service';

const MCQ: MCQQuestion = {
  type: 'mcq',
  question: 'Hoe bereken je het relatief risico?',
  options: ['I1/I0', 'I1−I0', 'odds-ratio', 'prevalentie'],
  correctAnswer: 0,
  explanation: 'Je deelt de incidenties door elkaar.',
  source: 'rag',
};

const LABELS: QuizExcerptLabels = {
  heading: 'Quizvraag', source: 'bron', casus: 'Casus', yourAnswer: 'Mijn antwoord',
  correctAnswer: 'Juiste antwoord', feedback: 'Feedback', feedforward: 'Feedforward',
  score: 'Score', modelAnswer: 'Modelantwoord', noAnswer: '(geen antwoord)',
};

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
afterEach(cleanup);

describe('buildQuizFeedbackExcerpt', () => {
  it('neemt bij MCQ vraag, opties, eigen antwoord, juist antwoord en feedback op', () => {
    const a = buildQuizFeedbackExcerpt({
      question: MCQ, answer: { type: 'mcq', selectedIndex: 2 }, labels: LABELS,
      sourceLabel: 'Cursusmateriaal', sources: [{ title: 'H3', documentId: 'doc-3' }], courseId: 'course-1',
    });
    expect(a.type).toBe('chat_excerpt');
    expect(a.content).toContain(MCQ.question);
    expect(a.content).toContain('**Mijn antwoord:** C. odds-ratio');
    expect(a.content).toContain('**Juiste antwoord:** A. I1/I0');
    expect(a.content).toContain(MCQ.explanation);
    expect(a.content).toContain('bron: Cursusmateriaal');
    expect(a.sources).toEqual([{ index: 1, title: 'H3', documentId: 'doc-3' }]);
    expect(a.meta?.module).toBe('quiz');
    expect(a.meta?.courseId).toBe('course-1');
  });

  it('neemt bij open vragen het eigen antwoord, score, feedback, feedforward en modelantwoord op', () => {
    const q: OpenQuestion = { type: 'open', question: 'Leg RR uit.', modelAnswer: 'RR is ...', rubric: '- def' };
    const a = buildQuizFeedbackExcerpt({
      question: q,
      answer: { type: 'open', text: 'Mijn uitleg', evaluation: { score: 60, feedback: 'Goed begin', feedforward: 'Noem de formule' } },
      labels: LABELS,
    });
    for (const s of ['Mijn uitleg', '60/100', 'Goed begin', 'Noem de formule', 'RR is ...']) {
      expect(a.content).toContain(s);
    }
  });

  it('blijft onder de servergrens voor bijlage-inhoud', () => {
    const long = { ...MCQ, explanation: 'x'.repeat(20000) };
    const a = buildQuizFeedbackExcerpt({ question: long, answer: { type: 'mcq', selectedIndex: 0 }, labels: LABELS });
    expect(a.content.length).toBeLessThanOrEqual(12000);
  });
});

describe('QuizCheckLLMButton — "Klopt dit wel?"', () => {
  it('opent het Studiecafé in een nieuw tabblad en draagt vraag + feedback over als check-llm', () => {
    render(
      <LanguageProvider>
        <QuizCheckLLMButton
          question={MCQ}
          answer={{ type: 'mcq', selectedIndex: 1 }}
          sourceLabel="Cursusmateriaal"
          courseId="course-1"
        />
      </LanguageProvider>,
    );
    const link = screen.getByTestId('button-quiz-check-llm') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/studiecafe');
    expect(link.getAttribute('target')).toBe('_blank');

    fireEvent.click(link);

    const handoff = takeStudiecafeHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff!.category).toBe('check-llm');
    expect(handoff!.mode).toBe('thread');
    expect(handoff!.courseId).toBe('course-1');
    expect(handoff!.attachment.meta?.module).toBe('quiz');
    expect(handoff!.attachment.content).toContain(MCQ.question);
    expect(handoff!.attachment.content).toContain(MCQ.explanation);
  });
});
