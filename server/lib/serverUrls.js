// Where the server listens and the public URL of the app (links in e-mails).
export const PORT = process.env.PORT || process.env.API_PORT || 3001;

export function resolveAppBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  return '';
}
