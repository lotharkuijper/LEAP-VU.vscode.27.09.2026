// Aan/uit-stand van de vraagteken-uitleg in het beheer ("Uitleg tonen").
// Standaard aan; de keuze wordt in de browser onthouden. Een klein gedeeld
// geheugen met abonnees, zodat alle HelpTips tegelijk verdwijnen/verschijnen
// zonder dat er een provider om het beheer heen hoeft.
import { useSyncExternalStore } from 'react';

export const HELP_VISIBLE_STORAGE_KEY = 'leap-help-visible';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(HELP_VISIBLE_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

let current = typeof window === 'undefined' ? true : read();

export function setHelpVisible(visible: boolean): void {
  current = visible;
  try { localStorage.setItem(HELP_VISIBLE_STORAGE_KEY, visible ? '1' : '0'); } catch { /* privé-venster: alleen deze sessie */ }
  listeners.forEach((l) => l());
}

export function isHelpVisible(): boolean {
  return current;
}

export function useHelpVisible(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
    () => true,
  );
}
