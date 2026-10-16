// Wachtrij voor het inlezen van documenten (2026-10-16).
//
// Aanleiding: 157 hoofdstukken tegelijk geüpload in Microbiologie. Elke upload
// startte meteen zijn eigen verwerking, dus 157 tegelijk vroegen embeddings
// aan; de Azure-snelheidslimiet (429) bleef overschreden, en na vijf pogingen
// werd elk bestand op "mislukt" gezet (63 van de 157). De bestanden zelf waren
// in orde.
//
// Nu: hoogstens `concurrency` documenten tegelijk. Loopt een document toch
// tegen de snelheidslimiet aan (`isRetryable`), dan gaat het na een pauze
// opnieuw in de rij (status blijft "wordt ingelezen"); pas na `maxAttempts`
// keer volgt "mislukt". Andere fouten zijn meteen definitief.
//
// De rij staat in het geheugen van het ene proces (LEAP draait als één
// replica, zie CLAUDE.md). Wat bij een herstart nog in de rij stond, kan de
// docent opnieuw laten inlezen met "Opnieuw inlezen".

/**
 * @param {object} o
 * @param {(id: string) => Promise<unknown>} o.run           verwerk één document
 * @param {number} [o.concurrency]                            hoeveel tegelijk
 * @param {number} [o.maxAttempts]                            pogingen bij een tijdelijke fout
 * @param {(attempt: number) => number} [o.backoffMs]         pauze vóór poging `attempt` (2, 3, …)
 * @param {(err: unknown) => boolean} [o.isRetryable]         tijdelijke fout (snelheidslimiet)?
 * @param {(id: string, err: unknown, attempt: number) => unknown} [o.onRetry]
 * @param {(id: string, err: unknown) => unknown} [o.onGiveUp]
 * @param {typeof setTimeout} [o.setTimer]
 */
export function createProcessingQueue({
  run,
  concurrency = 2,
  maxAttempts = 6,
  backoffMs = (attempt) => Math.min(30000 * 2 ** (attempt - 2), 300000),
  isRetryable = () => false,
  onRetry = () => {},
  onGiveUp = () => {},
  setTimer = setTimeout,
}) {
  const waiting = [];            // [{ id, attempt }]
  const known = new Set();       // in de rij, bezig of wachtend op een nieuwe poging
  let active = 0;

  function pump() {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift();
      active += 1;
      Promise.resolve()
        .then(() => run(job.id))
        .then(
          () => { known.delete(job.id); },
          async (err) => {
            if (isRetryable(err) && job.attempt < maxAttempts) {
              const next = job.attempt + 1;
              try { await onRetry(job.id, err, next); } catch { /* best effort */ }
              setTimer(() => { waiting.push({ id: job.id, attempt: next }); pump(); }, backoffMs(next));
              return;
            }
            known.delete(job.id);
            try { await onGiveUp(job.id, err); } catch { /* best effort */ }
          },
        )
        .finally(() => { active -= 1; pump(); });
    }
  }

  return {
    /** Zet een document in de rij; dubbel aanbieden doet niets. Geeft false als het er al in stond. */
    enqueue(id) {
      if (!id || known.has(id)) return false;
      known.add(id);
      waiting.push({ id, attempt: 1 });
      pump();
      return true;
    },
    has: (id) => known.has(id),
    stats: () => ({ waiting: waiting.length, active, known: known.size }),
  };
}
