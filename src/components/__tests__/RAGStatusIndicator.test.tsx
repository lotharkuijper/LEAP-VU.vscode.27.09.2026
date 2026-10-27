// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// "RAG beschikbaar · n documenten (n chunks)" is voor docenten en beheerders;
// studenten zien het niet (2026-10-27). De bron bij een antwoord blijft voor iedereen.
const auth = { isAdmin: false, isDocent: false };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../hooks/useRAGStatus', () => ({
  useRAGStatus: () => ({ isAvailable: true, documentCount: 16, chunkCount: 173, loading: false, noCourse: false, noRagFolders: false }),
}));

import { RAGStatusIndicator } from '../RAGStatusIndicator';
import { LanguageProvider } from '../../i18n';

const show = () => render(<LanguageProvider><RAGStatusIndicator /></LanguageProvider>);

afterEach(() => { cleanup(); auth.isAdmin = false; auth.isDocent = false; });

describe('RAGStatusIndicator', () => {
  it('toont niets aan een student', () => {
    const { container } = show();
    expect(container.textContent).toBe('');
  });
  it('toont de status aan een docent', () => {
    auth.isDocent = true;
    show();
    expect(screen.getByText(/173/)).toBeTruthy();
  });
  it('toont de status aan een beheerder', () => {
    auth.isAdmin = true;
    show();
    expect(screen.getByText(/173/)).toBeTruthy();
  });
});
