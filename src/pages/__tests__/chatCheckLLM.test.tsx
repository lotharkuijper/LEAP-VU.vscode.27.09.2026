// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────────────────
// Net als studiecafeHandoffComposer.test.tsx: stabiele referenties voor auth +
// cursus en een nep-supabase (alleen auth.getSession is nodig voor de token).
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ session: { access_token: 'test-token' } }),
}));

vi.mock('../../contexts/ActiveCourseContext', () => ({
  useActiveCourse: () => ({ activeCourseId: 'course-1', activeCourse: { name: 'Statistiek' } }),
  // Onderdelen per cursus: geen context = alles aan.
  useOptionalActiveCourse: () => undefined,
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
    },
  },
}));

// rag.service wordt door ChatPage geïmporteerd; in deze test renderen we alleen
// AssistantMessageBody zonder retrievedContext, dus de helpers worden niet
// aangeroepen — we stubben ze toch zodat de module-import licht blijft.
vi.mock('../../services/rag.service', () => ({
  searchRelevantChunksWithStats: vi.fn(),
  buildContextWithCap: vi.fn(),
  dedupeSourcesByDocument: vi.fn(() => []),
  chunkToDisplaySource: vi.fn(),
  ragDocumentDownloadUrl: vi.fn(() => '#'),
  openRagDocument: vi.fn(),
  chunkToSourceItem: vi.fn(),
}));

// DocumentViewer trekt pdfjs-dist mee (DOMMatrix bestaat niet in jsdom); we
// renderen AssistantMessageBody zonder viewer, dus een lege stub volstaat.
vi.mock('../../components/DocumentViewer', () => ({
  DocumentViewer: () => null,
}));

// react-router-dom: alleen useNavigate is nodig in AssistantMessageBody.
const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

import { AssistantMessageBody } from '../ChatPage';
import { LanguageProvider } from '../../i18n';

function jsonRes(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
}

function renderBody() {
  return render(
    <LanguageProvider>
      <AssistantMessageBody
        messageId="msg-1"
        content="Het gemiddelde is de som gedeeld door het aantal waarnemingen."
        onRequestSource={vi.fn()}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.clear();
    localStorage.setItem('lair-vu-lang', 'nl');
    sessionStorage.clear();
  } catch { /* noop */ }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


describe('AssistantMessageBody — "Klopt dit wel?"', () => {
  it('stalt een thread-overdracht en navigeert bij "Klopt dit wel?" (handleCheckLLM)', async () => {
    const user = userEvent.setup();
    // handleCheckLLM doet geen fetch; een lege stub volstaat zodat een eventuele
    // import-afhankelijkheid niet de echte fetch raakt.
    vi.stubGlobal('fetch', vi.fn(() => jsonRes({}, true)));

    renderBody();

    await user.click(screen.getByTestId('button-check-llm-msg-1'));

    // De overdracht is in sessionStorage gestald in thread-modus met een
    // chat-excerpt-bijlage en de juiste categorie.
    await waitFor(() => expect(sessionStorage.getItem('leapvu:studiecafe-handoff')).not.toBeNull());
    const stash = JSON.parse(sessionStorage.getItem('leapvu:studiecafe-handoff') as string);
    expect(stash).toMatchObject({ v: 1, courseId: 'course-1', category: 'check-llm', mode: 'thread' });
    expect(stash.targetThreadId).toBeUndefined();
    expect(stash.attachment).toMatchObject({ type: 'chat_excerpt' });
    // En de navigatie naar het Studiecafé.
    expect(navigateMock).toHaveBeenCalledWith('/studiecafe');
  });

  it('toont alleen de knop "Klopt dit wel?", niet meer "In bestaand topic"', () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes({}, true)));
    renderBody();
    expect(screen.getByTestId('button-check-llm-msg-1')).toHaveTextContent('Klopt dit wel?');
    expect(screen.queryByTestId('button-check-llm-reply-msg-1')).not.toBeInTheDocument();
  });
});
