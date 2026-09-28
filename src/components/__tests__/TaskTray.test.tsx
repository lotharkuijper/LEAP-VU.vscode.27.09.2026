// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import { TaskTray, formatElapsed } from '../TaskTray';
import { startTask, findRunning, __resetTasksForTests, type TaskContext } from '../../lib/backgroundTasks';

const nl = translations.nl as Record<string, string>;
beforeEach(() => { try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ } __resetTasksForTests(); });
afterEach(() => { cleanup(); __resetTasksForTests(); });

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Twee "pagina's" met het takenvak erbuiten, zoals in App.tsx.
function App() {
  return (
    <LanguageProvider>
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<Link to="/chat">naar chat</Link>} />
          <Route path="/chat" element={<p>chatpagina</p>} />
        </Routes>
        <TaskTray />
      </MemoryRouter>
    </LanguageProvider>
  );
}

describe('achtergrondtaken + takenvak', () => {
  it('taak loopt door na navigeren, toont voortgang en geeft een seintje met link naar het resultaat', async () => {
    const d = deferred<{ message: string }>();
    let ctx!: TaskContext;
    render(<App />);
    act(() => {
      startTask({ kind: 'concepts', key: 'c1', title: 'Begrippen extraheren (E&B1)', resultLink: '/admin', where: 'server',
        run: (c) => { ctx = c; return d.promise; }, summarize: (r) => r.message });
    });
    act(() => ctx.report({ done: 12, total: 30, labelKey: 'admin.conceptJob.reading' }));
    expect(screen.getByTestId('task-running')).toHaveTextContent(nl['admin.conceptJob.reading'].replace('{done}', '12').replace('{total}', '30'));

    // Naar een ander deel van de app: de taak (en het vak) blijft.
    fireEvent.click(screen.getByText('naar chat'));
    expect(screen.getByText('chatpagina')).toBeInTheDocument();
    expect(screen.getByTestId('task-running')).toBeInTheDocument();

    await act(async () => { d.resolve({ message: '100 begrippen totaal' }); await d.promise; });
    const done = screen.getByTestId('task-done');
    expect(done).toHaveTextContent(nl['tasks.doneTitle'].replace('{title}', 'Begrippen extraheren (E&B1)'));
    expect(done).toHaveTextContent('100 begrippen totaal');
    fireEvent.click(screen.getByTestId('link-task-result'));
    expect(screen.queryByTestId('task-done')).toBeNull(); // weggeklikt na openen resultaat
  });

  it('een tweede start van dezelfde taak haakt aan bij de lopende (geen dubbele taken)', () => {
    const d = deferred<number>();
    const a = startTask({ kind: 'concepts', key: 'c1', title: 'x', run: () => d.promise });
    const b = startTask({ kind: 'concepts', key: 'c1', title: 'x', run: () => Promise.resolve(2) });
    expect(b.id).toBe(a.id);
    expect(findRunning('concepts', 'c1')?.id).toBe(a.id);
  });

  it('een fout wordt gemeld en is weg te klikken', async () => {
    render(<App />);
    let p!: Promise<unknown>;
    act(() => { p = startTask({ kind: 'upload', title: 'Bestanden uploaden', run: async () => { throw new Error('Netwerkfout'); } }).promise; });
    await act(async () => { await p.catch(() => {}); });
    expect(screen.getByTestId('task-error')).toHaveTextContent('Netwerkfout');
    fireEvent.click(screen.getByTestId('button-dismiss-task'));
    expect(screen.queryByTestId('task-tray')).toBeNull();
  });

  it('formatElapsed', () => {
    expect(formatElapsed(45_000)).toBe('45 s');
    expect(formatElapsed(180_000)).toBe('3 min');
  });
});
