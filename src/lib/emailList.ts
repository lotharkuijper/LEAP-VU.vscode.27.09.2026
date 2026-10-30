// Leest e-mailadressen uit geplakte tekst voor het uitnodigingsveld.
// Scheidingstekens: komma, puntkomma, spatie of nieuwe regel. Een lijst uit
// Outlook ("Breet, J.J. (Jordy) j.j.breet@vu.nl;" of "Naam <adres>") mag ook:
// stukjes zonder @ zijn namen en worden overgeslagen, niet als ongeldig geteld.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface ParsedEmailList { valid: string[]; invalid: string[]; duplicates: number; }

export function parseEmailList(text: string): ParsedEmailList {
  const tokens = text
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^[<("'[]+|[>)"'\]]+$/g, ''))
    .filter((s) => s.includes('@'));
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalidSeen = new Set<string>();
  const invalid: string[] = [];
  let duplicates = 0;
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (EMAIL_RE.test(tok) && tok.length <= 254) {
      if (seen.has(low)) { duplicates++; continue; }
      seen.add(low); valid.push(low);
    } else if (!invalidSeen.has(low)) {
      invalidSeen.add(low); invalid.push(tok);
    }
  }
  return { valid, invalid, duplicates };
}
