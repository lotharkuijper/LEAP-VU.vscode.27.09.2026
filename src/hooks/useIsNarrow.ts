import { useEffect, useState } from 'react';

// True op een telefoon: smaller dan Tailwinds `md` (768px). Voor indelingen die
// je niet alleen met CSS-klassen kunt omzetten, zoals de chat die op een smal
// scherm één paneel tegelijk toont (lijst, gesprek of document).
const QUERY = '(max-width: 767.98px)';

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);

  return narrow;
}
