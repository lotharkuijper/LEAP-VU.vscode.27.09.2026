import { useEffect, useState } from 'react';

// True als het scherm smaller is dan `minWide` pixels (standaard Tailwinds `md`,
// 768px). Voor indelingen die je niet alleen met CSS-klassen kunt omzetten, zoals
// de chat die op een smal scherm één paneel tegelijk toont (lijst, gesprek of document).
export function useIsNarrow(minWide = 768): boolean {
  const query = `(max-width: ${minWide - 0.02}px)`;
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, [query]);

  return narrow;
}
