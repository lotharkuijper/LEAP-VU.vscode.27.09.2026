import { useEffect, useRef, type RefObject } from 'react';

// Zet de focus terug op een invoerveld zodra `loading` van true naar false gaat.
// Achtergrond: het chat-invoerveld is `disabled` terwijl het taalmodel antwoordt,
// en een uitgeschakeld element verliest in de browser zijn focus. Zonder deze
// hook moest de student na elk antwoord opnieuw in het veld klikken.
// We pakken de focus alleen terug als die nergens anders staat (body/null of het
// veld zelf), zodat we niet de focus stelen als de gebruiker tijdens het wachten
// bewust ergens anders is gaan klikken of typen.
export function useRefocusAfterLoading(
  ref: RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  loading: boolean,
) {
  const wasLoadingRef = useRef(loading);

  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = loading;
    if (!wasLoading || loading) return;

    const el = ref.current;
    if (!el || el.disabled) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== el) return;
    el.focus();
  }, [loading, ref]);
}
