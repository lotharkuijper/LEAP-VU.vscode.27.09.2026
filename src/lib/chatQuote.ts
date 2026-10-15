// Tekst uit een document als citaat in een chatinvoer zetten (DocumentViewer →
// "Vraag in de chat"). Het citaat komt tussen aanhalingstekens bovenaan de
// invoer (achter wat er al stond), met een lege regel eronder voor de vraag.
export function appendQuote(current: string, text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return current;
  const quoted = `“${clean}”`;
  const before = current.trimEnd();
  return `${before ? `${before}\n\n` : ''}${quoted}\n\n`;
}

/** Zet de cursor achteraan in een tekstvak (na het invoegen van een citaat). */
export function focusAtEnd(el: HTMLTextAreaElement | null) {
  if (!el) return;
  requestAnimationFrame(() => {
    el.focus();
    const n = el.value.length;
    el.setSelectionRange(n, n);
  });
}