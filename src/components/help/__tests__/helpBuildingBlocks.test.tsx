// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { LanguageProvider } from '../../../i18n';
import { Tooltip } from '../Tooltip';
import { AdminHint } from '../AdminHint';
import { HelpToggle } from '../HelpToggle';
import { HelpTip } from '../HelpTip';
import { setHelpVisible, HELP_VISIBLE_STORAGE_KEY } from '../helpVisibility';

afterEach(() => { cleanup(); act(() => setHelpVisible(true)); });
const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>);

describe('Tooltip', () => {
  it('geeft een pictogramknop een naam voor schermlezers en vervangt title', () => {
    wrap(<Tooltip label="Website verwijderen"><button type="button" title="oud" data-testid="b">🗑</button></Tooltip>);
    const b = screen.getByTestId('b');
    expect(b.getAttribute('aria-label')).toBe('Website verwijderen');
    expect(b.hasAttribute('title')).toBe(false);
    expect(screen.getByTestId('tooltip').textContent).toBe('Website verwijderen');
    // Het zichtbare label is voor ogen; de naam komt uit aria-label (niet dubbel voorgelezen).
    expect(screen.getByTestId('tooltip').getAttribute('aria-hidden')).toBe('true');
  });

  it('laat een bestaand aria-label staan', () => {
    wrap(<Tooltip label="Verwijderen"><button type="button" aria-label="Verwijder bestand X" data-testid="b">x</button></Tooltip>);
    expect(screen.getByTestId('b').getAttribute('aria-label')).toBe('Verwijder bestand X');
  });
});

describe('Uitleg tonen (schakelaar)', () => {
  it('verbergt vraagtekens en tips, maar laat intro en waarschuwingen staan; de keuze wordt onthouden', () => {
    wrap(
      <>
        <HelpToggle />
        <HelpTip id="material.addWebsite" />
        <AdminHint variant="intro" testId="intro">Waar dit voor is.</AdminHint>
        <AdminHint variant="tip" testId="tip">Extra uitleg.</AdminHint>
        <AdminHint variant="warning" testId="warn">Let op.</AdminHint>
      </>,
    );
    const toggle = screen.getByTestId('toggle-help-visible');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('help-material.addWebsite')).toBeTruthy();
    expect(screen.getByTestId('tip')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('help-material.addWebsite')).toBeNull();
    expect(screen.queryByTestId('tip')).toBeNull();
    expect(screen.getByTestId('intro')).toBeTruthy();
    expect(screen.getByTestId('warn')).toBeTruthy();
    expect(localStorage.getItem(HELP_VISIBLE_STORAGE_KEY)).toBe('0');

    fireEvent.click(toggle);
    expect(screen.getByTestId('help-material.addWebsite')).toBeTruthy();
    expect(localStorage.getItem(HELP_VISIBLE_STORAGE_KEY)).toBe('1');
  });
});
