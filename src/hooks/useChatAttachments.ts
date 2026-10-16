import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_LIMITS, buildPayload, downscaleImage, extensionOf, fileToBase64, imagesFromClipboard, isImageFile,
  isSupportedFile, metaOf, pastedImageName, renderPdfPages, searchExtra,
  type AttachmentMeta, type AttachmentPayload, type AttachmentsConfig, type PendingAttachment,
} from '../lib/chatAttachments';

// Bijlagen in de chat (src/lib/chatAttachments.ts). Alles blijft in het
// geheugen van deze pagina en verdwijnt zodra het gesprek wordt afgesloten
// (ander of nieuw gesprek, pagina verlaten of herladen).

export interface AttachmentError {
  key: string;
  params?: Record<string, string>;
}

const OFF: AttachmentsConfig = {
  available: false, reason: 'course_off', platformEnabled: false, courseOn: false, isStaff: false,
  limits: DEFAULT_LIMITS, usedToday: 0,
};

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export interface SendAttachments {
  payload: AttachmentPayload[];
  meta: AttachmentMeta[];
  /** Extra zoekwoorden voor het cursusmateriaal. */
  extra: string;
}

export function useChatAttachments(courseId: string | null, conversationId: string | null) {
  const [config, setConfig] = useState<AttachmentsConfig>(OFF);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<AttachmentError | null>(null);
  const [previews, setPreviews] = useState<Record<string, string[]>>({});
  const [noticeSeen, setNoticeSeen] = useState(false);
  // Bestanden die eerder in dit gesprek zijn meegegeven: hun tekst gaat bij elke
  // beurt mee, zolang het gesprek open is.
  const carriedRef = useRef<PendingAttachment[]>([]);
  const sentCountRef = useRef(0);
  const convRef = useRef(conversationId);

  useEffect(() => {
    let cancelled = false;
    if (!courseId) { setConfig(OFF); return; }
    (async () => {
      try {
        const r = await fetch(`/api/chat/attachments/config?courseId=${encodeURIComponent(courseId)}`, { headers: await authHeaders() });
        const d = r.ok ? await r.json() : null;
        if (!cancelled) setConfig(d ? { ...OFF, ...d, limits: { ...DEFAULT_LIMITS, ...(d.limits || {}) } } : OFF);
      } catch {
        if (!cancelled) setConfig(OFF);
      }
    })();
    return () => { cancelled = true; };
  }, [courseId]);

  // Ander gesprek = de chat is afgesloten: alles vergeten.
  useEffect(() => {
    if (convRef.current === conversationId) return;
    convRef.current = conversationId;
    carriedRef.current = [];
    sentCountRef.current = 0;
    setPending([]);
    setPreviews({});
    setError(null);
    setNoticeSeen(false);
  }, [conversationId]);

  const limits = config.limits;

  const add = useCallback(async (files: File[], { pasted = false } = {}) => {
    setError(null);
    if (!config.available || !courseId) {
      setError({ key: config.courseOn && !config.platformEnabled ? 'chat.attachments.platformOff' : 'chat.attachments.unavailable' });
      return;
    }
    const supported = files.filter(isSupportedFile);
    if (supported.length < files.length) setError({ key: 'chat.attachments.unsupported' });
    let images = pending.filter(p => p.kind === 'image').length;
    let total = sentCountRef.current + pending.length;
    for (const [i, file] of supported.entries()) {
      if (total >= limits.perConversation) {
        setError({ key: 'chat.attachments.tooManyConversation', params: { n: String(limits.perConversation) } });
        break;
      }
      if (file.size > limits.fileMb * 1024 * 1024) {
        setError({ key: 'chat.attachments.tooLarge', params: { mb: String(limits.fileMb) } });
        continue;
      }
      const id = crypto.randomUUID();
      const image = isImageFile(file);
      if (image && images >= limits.imagesPerMessage) {
        setError({ key: 'chat.attachments.tooManyImages', params: { n: String(limits.imagesPerMessage) } });
        continue;
      }
      if (image) images += 1;
      total += 1;
      const name = pasted ? pastedImageName(i) : file.name;
      setBusy(b => b + 1);
      try {
        let item: PendingAttachment;
        if (image) {
          const { dataUrl } = await downscaleImage(file, limits.imageMaxSide);
          item = { id, kind: 'image', name, mime: file.type, size: file.size, dataUrl };
        } else if (['txt', 'md'].includes(extensionOf(name))) {
          const raw = await file.text();
          item = { id, kind: 'file', name, size: file.size, text: raw.slice(0, limits.fileChars), truncated: raw.length > limits.fileChars };
        } else {
          const r = await fetch('/api/chat/attachments/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
            body: JSON.stringify({ courseId, name, data: await fileToBase64(file) }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(typeof d.error === 'string' ? d.error : `HTTP ${r.status}`);
          if (d.scanned) {
            if (limits.scanPages <= 0) throw new Error('scan');
            const scanImages = await renderPdfPages(file, limits.scanPages, limits.imageMaxSide);
            if (scanImages.length === 0) throw new Error('scan');
            item = { id, kind: 'file', name, size: file.size, pages: d.pages ?? null, scanned: true, scanImages };
          } else {
            item = { id, kind: 'file', name, size: file.size, pages: d.pages ?? null, text: String(d.text || ''), truncated: !!d.truncated };
          }
        }
        setPending(prev => [...prev, item]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        setError(msg && msg !== 'scan' && msg !== 'canvas' && !msg.startsWith('HTTP')
          ? { key: 'chat.attachments.readFailedDetail', params: { name, detail: msg } }
          : { key: 'chat.attachments.readFailed', params: { name } });
      } finally {
        setBusy(b => b - 1);
      }
    }
  }, [config, courseId, limits, pending]);

  const remove = useCallback((id: string) => {
    setPending(prev => prev.filter(p => p.id !== id));
    setError(null);
  }, []);

  /** Plakken in het invoerveld: afbeeldingen worden bijlagen, tekst plakt gewoon. */
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const imgs = imagesFromClipboard(e.clipboardData);
    if (imgs.length === 0) return;
    if (!config.available) {
      if (config.courseOn && !config.platformEnabled) setError({ key: 'chat.attachments.platformOff' });
      return;
    }
    e.preventDefault();
    void add(imgs, { pasted: true });
  }, [add, config]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!config.available) return;
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, [config.available]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!config.available) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    void add(files);
  }, [add, config.available]);

  /**
   * Haalt de bijlagen op voor de beurt die nu verstuurd wordt en onthoudt de
   * miniaturen bij dat bericht (alleen in het geheugen).
   */
  const takeForSend = useCallback((messageId: string, previousDescription?: string): SendAttachments => {
    const now = pending;
    const payload = buildPayload(now, carriedRef.current);
    const meta = now.map(metaOf);
    const extra = searchExtra(now, previousDescription);
    if (now.length > 0) {
      const thumbs = now.flatMap(a => (a.kind === 'image' && a.dataUrl ? [a.dataUrl] : a.scanImages?.slice(0, 1) || []));
      if (thumbs.length) setPreviews(prev => ({ ...prev, [messageId]: thumbs }));
      carriedRef.current = [...carriedRef.current, ...now.filter(a => a.kind === 'file' && typeof a.text === 'string')];
      sentCountRef.current += now.length;
      setPending([]);
      setNoticeSeen(true);
    }
    return { payload, meta, extra };
  }, [pending]);

  /** Bijlagen terugzetten als het versturen mislukte vóór er iets weg was. */
  const hasCarried = () => carriedRef.current.length > 0;

  return {
    config,
    available: config.available,
    /** Paperclip tonen: beschikbaar, of de cursus heeft het aan maar de beheerder (tijdelijk) niet. */
    showClip: config.available || (config.courseOn && !config.platformEnabled),
    limits,
    pending,
    busy: busy > 0,
    error,
    clearError: () => setError(null),
    showNotice: pending.length > 0 && !noticeSeen,
    previews,
    add,
    remove,
    onPaste,
    onDragOver,
    onDrop,
    takeForSend,
    hasCarried,
  };
}
