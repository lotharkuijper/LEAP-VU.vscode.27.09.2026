import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus, X } from 'lucide-react';
import { useLanguage } from '../../i18n';
import { constrain, fitSize, initialView, maxScale, panBy, zoomAt, type Size, type ZoomView } from '../../lib/imageZoom';

/**
 * De foto over het hele scherm, om in te zoomen op een structuur. Muis: scrollwiel
 * zoomt rond de muis, slepen verschuift, dubbelklik zoomt in (of terug). Telefoon of
 * tablet: knijpen en slepen. Toetsen: + en − zoomen, 0 = passend, pijltjes
 * verschuiven, Esc sluit. Sluiten kan alleen met de knop of Esc, zodat slepen de
 * weergave niet per ongeluk sluit.
 */
export function ZoomableImage({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { t } = useLanguage();
  const boxRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size>({ w: 0, h: 0 });
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<ZoomView>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);

  const fit = fitSize(natural, box);
  const max = maxScale(natural, fit);
  // Laatste maten voor de handlers die buiten React om lopen (wiel, toetsen).
  const geo = useRef({ fit, box, max });
  geo.current = { fit, box, max };

  // Venstergrootte meten, ook als het scherm draait of van grootte verandert.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Nieuwe maten: terug naar passend als je niet ingezoomd was, anders in beeld houden.
  useEffect(() => {
    setView((v) => (v.scale <= 1 ? initialView(fit, box) : constrain(v, fit, box)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit.w, fit.h, box.w, box.h]);

  const zoomCenter = useCallback((factor: number) => {
    const g = geo.current;
    setView((v) => zoomAt(v, factor, g.box.w / 2, g.box.h / 2, g.fit, g.box, g.max));
  }, []);
  const reset = useCallback(() => setView(initialView(geo.current.fit, geo.current.box)), []);

  // Scrollwiel: niet passief, anders kan de pagina eronder mee scrollen.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const g = geo.current;
      setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, g.fit, g.box, g.max));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const g = geo.current;
      const step = 80;
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomCenter(1.5);
      else if (e.key === '-' || e.key === '_') zoomCenter(1 / 1.5);
      else if (e.key === '0') reset();
      else if (e.key === 'ArrowLeft') setView((v) => panBy(v, step, 0, g.fit, g.box));
      else if (e.key === 'ArrowRight') setView((v) => panBy(v, -step, 0, g.fit, g.box));
      else if (e.key === 'ArrowUp') setView((v) => panBy(v, 0, step, g.fit, g.box));
      else if (e.key === 'ArrowDown') setView((v) => panBy(v, 0, -step, g.fit, g.box));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomCenter, reset]);

  // De pagina eronder staat stil zolang de foto open is.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    pinch.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = local(e);
    pointers.current.set(e.pointerId, now);
    const pts = [...pointers.current.values()];
    if (pts.length === 1) {
      setView((v) => panBy(v, now.x - prev.x, now.y - prev.y, fit, box));
    } else if (pts.length === 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current && pinch.current.dist > 0) {
        const factor = dist / pinch.current.dist;
        setView((v) => zoomAt(v, factor, (a.x + b.x) / 2, (a.y + b.y) / 2, fit, box, max));
      }
      pinch.current = { dist };
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    pinch.current = null;
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    setView((v) => (v.scale > 1.01 ? initialView(fit, box) : zoomAt(v, 3, p.x, p.y, fit, box, max)));
  };

  const btn = 'rounded-full bg-white/90 p-2 text-gray-800 shadow hover:bg-white disabled:opacity-40';
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label={alt} data-testid="dialog-play-zoom">
      <div className="flex items-center justify-between gap-2 p-3">
        <p className="hidden text-xs text-white/80 sm:block">{t('imagePlay.zoomHint')}</p>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => zoomCenter(1 / 1.5)} disabled={view.scale <= 1} className={btn} aria-label={t('imagePlay.zoomOut')} title={t('imagePlay.zoomOut')} data-testid="button-zoom-out"><Minus className="h-5 w-5" /></button>
          <span className="min-w-[3.5rem] text-center text-sm tabular-nums text-white" aria-live="polite">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoomCenter(1.5)} disabled={view.scale >= max} className={btn} aria-label={t('imagePlay.zoomIn')} title={t('imagePlay.zoomIn')} data-testid="button-zoom-in"><Plus className="h-5 w-5" /></button>
          <button type="button" onClick={reset} disabled={view.scale <= 1} className={btn} aria-label={t('imagePlay.zoomReset')} title={t('imagePlay.zoomReset')} data-testid="button-zoom-reset"><Maximize className="h-5 w-5" /></button>
          <button type="button" onClick={onClose} className={`${btn} ml-2`} aria-label={t('imagePlay.close')} title={t('imagePlay.close')} data-testid="button-zoom-close"><X className="h-5 w-5" /></button>
        </div>
      </div>
      <div
        ref={boxRef}
        className={`relative flex-1 select-none overflow-hidden ${view.scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        data-testid="zoom-area"
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="absolute left-0 top-0 max-w-none"
          style={{
            width: fit.w || undefined,
            height: fit.h || undefined,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            visibility: fit.w ? 'visible' : 'hidden',
          }}
        />
      </div>
    </div>
  );
}
