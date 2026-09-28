// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { Pencil, Trash2 } from 'lucide-react';
import { LanguageProvider } from '../../../i18n';
import { RowActions, fitCount } from '../RowActions';
import { ListRow } from '../ListRow';

beforeEach(() => { try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ } });
afterEach(cleanup);

describe('fitCount — hoeveel knoppen passen naast elkaar?', () => {
  it('alles past en geen menu nodig → alles', () => {
    expect(fitCount([80, 90, 100], 300, 60, false)).toBe(3);
  });
  it('past niet → zoveel als er naast "⋯ Meer" passen', () => {
    // 60 (Meer) + 4 + 80 + 4 + 90 = 238 ≤ 250; + 4 + 100 past niet meer
    expect(fitCount([80, 90, 100], 250, 60, false)).toBe(2);
  });
  it('een menu is sowieso nodig (gevaarlijke actie) → ruimte voor "⋯ Meer" reserveren', () => {
    expect(fitCount([80, 90], 180, 60, true)).toBe(1);
  });
  it('heel smal → alles in het menu', () => {
    expect(fitCount([80, 90], 50, 60, false)).toBe(0);
  });
  it('zonder meting (0 px, bv. bij het eerste tekenen) → alles tonen', () => {
    expect(fitCount([80, 90], 0, 60, true)).toBe(2);
  });
});

describe('RowActions', () => {
  const setup = () => {
    const onEdit = vi.fn(); const onDelete = vi.fn();
    render(
      <LanguageProvider>
        <RowActions
          menuTestId="more"
          actions={[
            { key: 'edit', label: 'Bewerken', icon: Pencil, onClick: onEdit, testId: 'edit' },
            { key: 'delete', label: 'Verwijderen', icon: Trash2, tone: 'danger', title: 'Definitief weg', onClick: onDelete, testId: 'delete' },
          ]}
        />
      </LanguageProvider>,
    );
    return { onEdit, onDelete };
  };

  it('gevaarlijke acties staan nooit los in de rij, maar achter "⋯ Meer"', () => {
    const { onEdit } = setup();
    fireEvent.click(screen.getByTestId('edit'));
    expect(onEdit).toHaveBeenCalled();
    expect(screen.queryByTestId('delete')).toBeNull();
    expect(screen.getByTestId('more')).toHaveAttribute('aria-expanded', 'false');
  });

  it('menu openen, gevaarlijke actie kiezen (met uitleg) en het menu sluit weer', () => {
    const { onDelete } = setup();
    fireEvent.click(screen.getByTestId('more'));
    const menu = screen.getByRole('menu');
    const item = within(menu).getByTestId('delete');
    expect(item).toHaveAttribute('role', 'menuitem');
    expect(item).toHaveTextContent('Definitief weg');
    fireEvent.click(item);
    expect(onDelete).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape sluit het menu', () => {
    setup();
    fireEvent.click(screen.getByTestId('more'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ListRow', () => {
  it('toont titel, labels, uitleg en knoppen — elke knop maar één keer', () => {
    render(
      <LanguageProvider>
        <ListRow
          title="DEB-learn"
          badges={<span>Actief</span>}
          meta={<span>Cue-bereik: ±2</span>}
          actions={[{ key: 'edit', label: 'Bewerken', onClick: () => {}, testId: 'edit' }]}
        />
      </LanguageProvider>,
    );
    expect(screen.getByText('DEB-learn')).toBeInTheDocument();
    expect(screen.getByText('Actief')).toBeInTheDocument();
    expect(screen.getByText('Cue-bereik: ±2')).toBeInTheDocument();
    expect(screen.getAllByTestId('edit')).toHaveLength(1);
  });
});
