// Gedeelde stukjes voor het tabblad Analyse.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export function useApi<T>(url: string | null) {
  const { session } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!url || !session?.access_token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData(d as T);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url, session?.access_token]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, load };
}

export function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className="chic-card p-3 min-w-0" data-testid={testId}>
      <div className="text-xs text-gray-500 truncate">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

export function fmt(n: number, lang: string) {
  return new Intl.NumberFormat(lang).format(n);
}
