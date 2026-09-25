// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRefocusAfterLoading } from '../useRefocusAfterLoading';

// Spiegelt het chat-invoerveld: disabled tijdens `loading`, zoals in ChatPage.
function Harness({ loading }: { loading: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useRefocusAfterLoading(ref, loading);
  return (
    <>
      <textarea ref={ref} disabled={loading} data-testid="input" />
      <button data-testid="other">elders</button>
    </>
  );
}

afterEach(cleanup);

describe('useRefocusAfterLoading', () => {
  it('zet de focus terug op het invoerveld zodra het antwoord binnen is', async () => {
    const { rerender } = render(<Harness loading={false} />);
    const input = screen.getByTestId('input') as HTMLTextAreaElement;
    await userEvent.click(input);
    expect(document.activeElement).toBe(input);

    // Versturen: veld wordt disabled en verliest de focus. Browsers doen die
    // focus-drop vanzelf; jsdom niet, dus we simuleren hem vóór het disablen.
    input.blur();
    rerender(<Harness loading={true} />);
    expect(input.disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);

    // Antwoord binnen: focus moet vanzelf terug zijn.
    rerender(<Harness loading={false} />);
    expect(document.activeElement).toBe(input);

    // En de gebruiker kan meteen typen.
    await userEvent.keyboard('volgende vraag');
    expect(input.value).toBe('volgende vraag');
  });

  it('pakt geen focus bij de eerste render zonder voorafgaande loading', () => {
    render(<Harness loading={false} />);
    expect(document.activeElement).toBe(document.body);
  });

  it('steelt de focus niet als de gebruiker tijdens het wachten elders heeft geklikt', () => {
    const { rerender } = render(<Harness loading={true} />);
    const other = screen.getByTestId('other');
    other.focus();

    rerender(<Harness loading={false} />);
    expect(document.activeElement).toBe(other);
  });
});
