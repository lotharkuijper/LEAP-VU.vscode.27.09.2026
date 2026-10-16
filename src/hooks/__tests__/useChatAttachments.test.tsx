// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 't' } } }) } },
}));
// jsdom kent createImageBitmap/canvas niet: verkleinen nabootsen.
vi.mock('../../lib/chatAttachments', async (orig) => {
  const real = await orig<typeof import('../../lib/chatAttachments')>();
  return { ...real, downscaleImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 10 })) };
});

import { useChatAttachments } from '../useChatAttachments';

let api: ReturnType<typeof useChatAttachments>;
function Harness({ conv }: { conv: string }) {
  api = useChatAttachments('course-1', conv);
  return <textarea data-testid="ta" onPaste={api.onPaste} />;
}

function config(over: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/chat/attachments/config')) {
      return { ok: true, json: async () => ({ available: true, reason: null, platformEnabled: true, courseOn: true, isStaff: false, limits: { imagesPerMessage: 2 }, usedToday: 0, ...over }) };
    }
    return { ok: false, json: async () => ({}) };
  }));
}

function pasteImage(target: HTMLElement) {
  const file = new File(['x'], 'image.png', { type: 'image/png' });
  const clipboardData = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] };
  const ev = fireEvent.paste(target, { clipboardData });
  return ev; // false = preventDefault aangeroepen
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('useChatAttachments', () => {
  it('plakken van een schermafbeelding maakt een bijlage; versturen geeft inhoud alleen aan het verzoek', async () => {
    config({});
    render(<Harness conv="c1" />);
    await waitFor(() => expect(api.available).toBe(true));
    const notDefault = pasteImage(screen.getByTestId('ta'));
    expect(notDefault).toBe(false);
    await waitFor(() => expect(api.pending).toHaveLength(1));
    expect(api.pending[0]).toMatchObject({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' });
    expect(api.pending[0].name).toMatch(/^schermafbeelding-\d{4}\.png$/);

    let sent: ReturnType<typeof api.takeForSend> | undefined;
    act(() => { sent = api.takeForSend('m1'); });
    expect(sent!.payload).toEqual([{ kind: 'image', name: api.previews.m1 ? expect.any(String) : expect.any(String), dataUrl: 'data:image/png;base64,AAAA' }]);
    expect(JSON.stringify(sent!.meta)).not.toContain('base64');
    await waitFor(() => expect(api.pending).toHaveLength(0));
    expect(api.previews.m1).toEqual(['data:image/png;base64,AAAA']);
  });

  it('staat het uit, dan gaat plakken gewoon door en ontstaat er geen bijlage', async () => {
    config({ available: false, reason: 'course_off', courseOn: false });
    render(<Harness conv="c1" />);
    await waitFor(() => expect(api.config.reason).toBe('course_off'));
    expect(pasteImage(screen.getByTestId('ta'))).toBe(true);
    expect(api.pending).toHaveLength(0);
    expect(api.showClip).toBe(false);
  });

  it('beheerder heeft het uit maar de cursus aan: paperclip zichtbaar met melding', async () => {
    config({ available: false, reason: 'platform_off', platformEnabled: false, courseOn: true });
    render(<Harness conv="c1" />);
    await waitFor(() => expect(api.config.courseOn).toBe(true));
    expect(api.showClip).toBe(true);
    pasteImage(screen.getByTestId('ta'));
    await waitFor(() => expect(api.error?.key).toBe('chat.attachments.platformOff'));
  });

  it('houdt zich aan het maximum aantal afbeeldingen per bericht', async () => {
    config({});
    render(<Harness conv="c1" />);
    await waitFor(() => expect(api.available).toBe(true));
    const files = [1, 2, 3].map(i => new File(['x'], `f${i}.png`, { type: 'image/png' }));
    await act(async () => { await api.add(files); });
    expect(api.pending).toHaveLength(2);
    expect(api.error?.key).toBe('chat.attachments.tooManyImages');
  });

  it('ander gesprek = de chat is afgesloten: alles is weg', async () => {
    config({});
    const { rerender } = render(<Harness conv="c1" />);
    await waitFor(() => expect(api.available).toBe(true));
    await act(async () => { await api.add([new File(['x'], 'a.png', { type: 'image/png' })]); });
    act(() => { api.takeForSend('m1'); });
    await act(async () => { await api.add([new File(['x'], 'b.png', { type: 'image/png' })]); });
    expect(api.pending).toHaveLength(1);
    rerender(<Harness conv="c2" />);
    await waitFor(() => expect(api.pending).toHaveLength(0));
    expect(api.previews).toEqual({});
    expect(api.hasCarried()).toBe(false);
  });
});
