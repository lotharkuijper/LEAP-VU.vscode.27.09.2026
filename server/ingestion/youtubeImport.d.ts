// Typen voor server/ingestion/youtubeImport.js (de pure helpers die de frontend gebruikt).
export function parseYouTubeId(raw: string | null | undefined): string | null;
export function isYouTubeUrl(url: string | null | undefined): boolean;
export function canonicalYouTubeUrl(videoId: string): string;
export function youTubeTimeUrl(videoId: string, seconds: number): string;
export function formatVideoTime(seconds: number): string;
