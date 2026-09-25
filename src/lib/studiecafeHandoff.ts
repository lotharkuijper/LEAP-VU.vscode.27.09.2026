import { type ChatExcerptAttachment } from '../components/ChatExcerptCard';

// Overdracht chat → Studiecafé (Task #351). De chat stalt een momentopname van
// het AI-antwoord in sessionStorage; StudiecafePage leest die bij binnenkomst
// uit, opent de composer met de juiste categorie en de bijlage. sessionStorage
// (niet de URL) omdat de inhoud markdown/KaTeX bevat en te groot/gevoelig is
// voor een query-string.
const KEY = 'leapvu:studiecafe-handoff';
// Overdracht naar een NIEUW tabblad (quiz → Studiecafé): sessionStorage wordt
// niet betrouwbaar naar een nieuw tabblad gekopieerd, dus die variant loopt via
// localStorage met een korte houdbaarheid. Zo blijft de lopende quiz in het
// oorspronkelijke tabblad intact.
const CROSS_TAB_KEY = 'leapvu:studiecafe-handoff-crosstab';
export const CROSS_TAB_TTL_MS = 2 * 60 * 1000;

export interface StudiecafeHandoff {
  v: 1;
  courseId: string | null;
  category: string;
  attachment: ChatExcerptAttachment;
  // 'thread' (standaard): open de nieuwe-thread-composer met de bijlage.
  // 'reply': de student wil het antwoord als reactie in een bestaand topic
  // plaatsen — StudiecafePage toont een kies-een-topic-banner en laadt de
  // bijlage in de reply-composer van de gekozen thread.
  mode?: 'thread' | 'reply';
  // Optioneel (Task #354): de student koos het doel-topic al in de chat. Bij
  // reply-modus klapt StudiecafePage deze thread automatisch uit met de bijlage
  // voorgeladen, zodat de student niet ook nog op de Studiecafé-pagina hoeft te
  // zoeken. Leeg ⇒ de student kiest alsnog een topic op de pagina (oude flow).
  targetThreadId?: string;
}

export function stashStudiecafeHandoff(h: StudiecafeHandoff, opts: { crossTab?: boolean } = {}): void {
  try {
    if (opts.crossTab) {
      localStorage.setItem(CROSS_TAB_KEY, JSON.stringify({ at: Date.now(), handoff: h }));
    } else {
      sessionStorage.setItem(KEY, JSON.stringify(h));
    }
  } catch { /* storage niet beschikbaar */ }
}

function isValidHandoff(parsed: any): parsed is StudiecafeHandoff {
  return !!parsed && parsed.v === 1 && !!parsed.attachment && parsed.attachment.type === 'chat_excerpt';
}

function takeCrossTab(): StudiecafeHandoff | null {
  try {
    const raw = localStorage.getItem(CROSS_TAB_KEY);
    if (!raw) return null;
    localStorage.removeItem(CROSS_TAB_KEY);
    const wrapped = JSON.parse(raw);
    if (!wrapped || typeof wrapped.at !== 'number' || Date.now() - wrapped.at > CROSS_TAB_TTL_MS) return null;
    return isValidHandoff(wrapped.handoff) ? wrapped.handoff : null;
  } catch {
    return null;
  }
}

// Leest én verwijdert de overdracht (eenmalig). Eerst de tab-eigen variant,
// daarna de variant uit een ander tabblad. Geeft null als er niets (geldigs) staat.
export function takeStudiecafeHandoff(): StudiecafeHandoff | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    if (raw) sessionStorage.removeItem(KEY);
  } catch { raw = null; }
  if (!raw) return takeCrossTab();
  try {
    const parsed = JSON.parse(raw);
    return isValidHandoff(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
