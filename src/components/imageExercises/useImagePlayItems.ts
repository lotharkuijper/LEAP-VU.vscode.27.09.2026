import { useEffect, useState } from 'react';
import { fetchPlayList, type PlayListItem } from '../../services/image-play.service';

/** De foto's waarmee een student in deze cursus kan oefenen (leeg als er geen zijn of het niet mag). */
export function useImagePlayItems(courseId: string | null | undefined, enabled = true): PlayListItem[] {
  const [items, setItems] = useState<PlayListItem[]>([]);
  useEffect(() => {
    setItems([]);
    if (!courseId || !enabled) return;
    let alive = true;
    fetchPlayList(courseId).then((list) => { if (alive) setItems(list); }).catch(() => {});
    return () => { alive = false; };
  }, [courseId, enabled]);
  return items;
}
