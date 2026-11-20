// Gedeelde stukjes voor beeldoefeningen (docent- en studentkant).

export const BUCKET = 'image_exercises';
export const THUMB_URL_SECONDS = 600;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Een fout met een status (en code) die de route zo doorgeeft. */
export const fail = ({ status, error, code }) => Object.assign(new Error(error), { status, code });

/** Tijdelijke links naar foto's in de private map: Map(pad → link). */
export async function signedUrlMap(db, paths) {
  if (!paths.length) return new Map();
  const { data } = await db.storage.from(BUCKET).createSignedUrls(paths, THUMB_URL_SECONDS);
  return new Map((data || []).filter((s) => s?.path && s?.signedUrl).map((s) => [s.path, s.signedUrl]));
}
