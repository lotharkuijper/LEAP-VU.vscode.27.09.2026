// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 't' } } }) } },
}));

import { LanguageProvider } from '../../../i18n';
import { PurposeReview } from '../PurposeReview';
import { PurposePicker } from '../PurposePicker';
import { WarningList } from '../ReadinessStep';
import { suggestForBatch } from '../FilesStep';
import type { CourseFile } from '../../../services/course-files.service';

const file = (over: Partial<CourseFile>): CourseFile => ({
  id: 'd1', title: 'Studiehandleiding.pdf', filename: 'Studiehandleiding.pdf', file_type: 'pdf', file_size: 1000,
  created_at: '', processing_status: 'completed', total_chunks: 5, isWeb: false, folderName: 'RAG',
  purpose: 'course_material', purposeConfirmed: false,
  suggestion: { purpose: 'course_info', confidence: 'high', reason: 'courseInfoName' },
  ...over,
});

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>);

describe('suggestForBatch', () => {
  it('kiest het meest voorkomende voorstel voor een upload', () => {
    expect(suggestForBatch([{ name: '1.college.pdf' }, { name: '2.college.pptx' }, { name: 'data.csv' }]).purpose).toBe('course_material');
    expect(suggestForBatch([{ name: 'a.csv' }, { name: 'b.omv' }])).toMatchObject({ purpose: 'project', materialKind: 'data' });
  });
});

describe('PurposeReview — eenmalige controle', () => {
  it('toont per bestand het voorstel met reden en neemt het voorstel over als keuze', () => {
    wrap(<PurposeReview courseId="c1" files={[file({})]} projects={[]} onDone={() => {}} />);
    const row = screen.getByTestId('row-review-d1');
    expect(row.textContent).toMatch(/Cursusinformatie|Course information/);
    expect((screen.getByTestId('select-review-d1') as HTMLSelectElement).value).toBe('course_info');
    // Eén bestand krijgt een ander doel dan nu → dat wordt gemeld.
    expect(screen.getByTestId('text-review-changes').textContent).toMatch(/1/);
  });

  it('stuurt alle keuzes in één keer naar de server, ook aangepaste', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, results: [{ docId: 'd1', ok: true }, { docId: 'd2', ok: true }] }) });
    const onDone = vi.fn();
    wrap(<PurposeReview courseId="c1" files={[file({}), file({ id: 'd2', title: 'Antwoorden.pdf', suggestion: { purpose: 'teacher_only', confidence: 'high', reason: 'answersOrExam' } })]} projects={[]} onDone={onDone} />);
    fireEvent.change(screen.getByTestId('select-review-d1'), { target: { value: 'course_material' } });
    fireEvent.click(screen.getByTestId('button-review-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/course-files/c1/review');
    expect(JSON.parse(init.body).decisions).toEqual([
      { docId: 'd1', purpose: 'course_material' },
      { docId: 'd2', purpose: 'teacher_only' },
    ]);
  });

  it('laat niet bevestigen zolang bij Projectmateriaal geen project is gekozen', () => {
    wrap(<PurposeReview courseId="c1" files={[file({ suggestion: { purpose: 'project', materialKind: 'data', confidence: 'high', reason: 'dataFile' } })]} projects={[{ id: 'p1', title: 'P', documents: [] }]} onDone={() => {}} />);
    expect((screen.getByTestId('button-review-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('select-review-d1-project'), { target: { value: 'p1' } });
    expect((screen.getByTestId('button-review-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('toont niets als alles al bevestigd is', () => {
    const { container } = wrap(<PurposeReview courseId="c1" files={[file({ purposeConfirmed: true })]} projects={[]} onDone={() => {}} />);
    expect(container.querySelector('[data-testid="panel-purpose-review"]')).toBeNull();
  });
});

describe('PurposePicker', () => {
  it('legt bij elke keuze uit wat LEAP ermee doet en markeert het voorstel', () => {
    const onChange = vi.fn();
    wrap(<PurposePicker value={{ purpose: 'course_info' }} onChange={onChange} projects={[]} suggested="course_info" />);
    expect(screen.getByTestId('purpose-desc').textContent).toMatch(/geen begrippen of quizvragen|no concepts or quiz/i);
    fireEvent.click(screen.getByTestId('purpose-option-teacher_only'));
    expect(onChange).toHaveBeenCalledWith({ purpose: 'teacher_only' });
  });
});

describe('WarningList', () => {
  it('toont waarschuwingen in gewone taal met een knop naar de juiste stap', () => {
    const onGoTo = vi.fn();
    wrap(<WarningList onGoTo={onGoTo} warnings={[{ code: 'conceptsWithoutEvidence', severity: 'warning', step: 'concepts', count: 2, items: ['Ecologisch onderzoek', 'Bias'] }]} />);
    const w = screen.getByTestId('warning-conceptsWithoutEvidence');
    expect(w.textContent).toMatch(/2/);
    expect(w.textContent).toMatch(/Ecologisch onderzoek/);
    expect(w.textContent).not.toMatch(/material\.warning/);
    fireEvent.click(w.querySelector('button')!);
    expect(onGoTo).toHaveBeenCalledWith('concepts');
  });
});
