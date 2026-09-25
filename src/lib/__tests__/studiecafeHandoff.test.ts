// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  stashStudiecafeHandoff,
  takeStudiecafeHandoff,
  CROSS_TAB_TTL_MS,
  type StudiecafeHandoff,
} from '../studiecafeHandoff';
import { type ChatExcerptAttachment } from '../../components/ChatExcerptCard';

const KEY = 'leapvu:studiecafe-handoff';

function makeAttachment(): ChatExcerptAttachment {
  return {
    type: 'chat_excerpt',
    content: 'Dit is het AI-antwoord met $x^2$.',
    sources: [{ index: 1, title: 'Hoofdstuk 1', documentId: 'doc-1' }],
    meta: { module: 'chat', courseId: 'course-1' },
  };
}

function makeHandoff(): StudiecafeHandoff {
  return {
    v: 1,
    courseId: 'course-1',
    category: 'check-llm',
    attachment: makeAttachment(),
  };
}

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* noop */ }
});

describe('studiecafeHandoff — stash/take round-trip', () => {
  it('geeft een gestalde overdracht ongewijzigd terug', () => {
    const h = makeHandoff();
    stashStudiecafeHandoff(h);
    const got = takeStudiecafeHandoff();
    expect(got).toEqual(h);
  });

  it('leest de overdracht slechts één keer (eenmalig wissen)', () => {
    stashStudiecafeHandoff(makeHandoff());
    expect(takeStudiecafeHandoff()).not.toBeNull();
    // De tweede keer is er niets meer — de sleutel is verwijderd.
    expect(takeStudiecafeHandoff()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('geeft null wanneer er niets is gestald', () => {
    expect(takeStudiecafeHandoff()).toBeNull();
  });
});

describe('studiecafeHandoff — ongeldige payloads worden geweigerd', () => {
  it('weigert kapotte JSON', () => {
    sessionStorage.setItem(KEY, '{ niet: geldige json');
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('weigert een verkeerde versie', () => {
    const h = { ...makeHandoff(), v: 2 };
    sessionStorage.setItem(KEY, JSON.stringify(h));
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('weigert een ontbrekende bijlage', () => {
    const h: any = makeHandoff();
    delete h.attachment;
    sessionStorage.setItem(KEY, JSON.stringify(h));
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('weigert een bijlage met een verkeerd type', () => {
    const h: any = makeHandoff();
    h.attachment.type = 'iets_anders';
    sessionStorage.setItem(KEY, JSON.stringify(h));
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('wist ook een ongeldige payload (eenmalig)', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ v: 99 }));
    expect(takeStudiecafeHandoff()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe('studiecafeHandoff — overdracht naar een nieuw tabblad (quiz)', () => {
  const CROSS_KEY = 'leapvu:studiecafe-handoff-crosstab';
  beforeEach(() => { try { localStorage.clear(); } catch { /* noop */ } });

  it('levert een crossTab-overdracht af in een tabblad zonder sessionStorage-kopie, eenmalig', () => {
    const h = makeHandoff();
    stashStudiecafeHandoff(h, { crossTab: true });
    // Nieuw tabblad: sessionStorage is leeg.
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(takeStudiecafeHandoff()).toEqual(h);
    expect(localStorage.getItem(CROSS_KEY)).toBeNull();
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('negeert een verlopen crossTab-overdracht', () => {
    localStorage.setItem(CROSS_KEY, JSON.stringify({ at: Date.now() - CROSS_TAB_TTL_MS - 1, handoff: makeHandoff() }));
    expect(takeStudiecafeHandoff()).toBeNull();
    expect(localStorage.getItem(CROSS_KEY)).toBeNull();
  });

  it('geeft de tab-eigen overdracht voorrang boven een crossTab-overdracht', () => {
    const own = makeHandoff();
    const other = { ...makeHandoff(), category: 'vraag' };
    stashStudiecafeHandoff(other, { crossTab: true });
    stashStudiecafeHandoff(own);
    expect(takeStudiecafeHandoff()).toEqual(own);
  });
});
