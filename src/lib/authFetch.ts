// Gedeelde hulpjes voor beheer-services die met de eigen server praten:
// headers met het inlogtoken, en een bestand als base64 voor een JSON-upload.
import { supabase } from './supabase';

export async function authHeaders(json = true): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  return h;
}

/** Een bestand als base64 (zonder "data:…;base64,"-voorvoegsel). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
