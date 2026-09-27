// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../i18n';
import { HelpTip } from '../HelpTip';

afterEach(cleanup);

const renderTip = () => render(
  <LanguageProvider>
    <div>
      <HelpTip id="material.addWebsite" />
      <button type="button" data-testid="elsewhere">ergens anders</button>
    </div>
  </LanguageProvider>,
);

describe('HelpTip', () => {
  it('opent de uitleg bij een klik en sluit bij een tweede klik', () => {
    renderTip();
    const btn = screen.getByTestId('help-material.addWebsite');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByTestId('help-panel-material.addWebsite');
    expect(panel.textContent).toMatch(/Website toevoegen|Add website/);
    expect(panel.textContent).not.toMatch(/help\.material/); // geen ruwe sleutel
    fireEvent.click(btn);
    expect(screen.queryByTestId('help-panel-material.addWebsite')).toBeNull();
  });

  it('sluit met Esc en bij een klik ernaast', () => {
    renderTip();
    const btn = screen.getByTestId('help-material.addWebsite');
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('help-panel-material.addWebsite')).toBeNull();
    fireEvent.click(btn);
    fireEvent.mouseDown(screen.getByTestId('elsewhere'));
    expect(screen.queryByTestId('help-panel-material.addWebsite')).toBeNull();
  });

  it('heeft een toegankelijk label met het onderwerp', () => {
    renderTip();
    expect(screen.getByTestId('help-material.addWebsite').getAttribute('aria-label')).toMatch(/Website toevoegen|Add website/);
  });
});
