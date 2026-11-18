// Fragmenten uit een YouTube-video: tijdstip in de bronnenlijst en een link naar
// dat moment. Andere bronnen (pdf, pptx, web) blijven precies zoals ze waren.
import { describe, it, expect } from 'vitest';
import { videoSpanFromMetadata, chunkToDisplaySource, dedupeSourcesByDocument } from '../rag.service';
import { locationLabel } from '../../components/SourceList';

const ID = 'dQw4w9WgXcQ';
const videoMeta = { source: 'youtube', videoId: ID, timeStart: 130, timeEnd: 190 };

describe('videoSpanFromMetadata', () => {
  it('geeft tijdvak en een link naar het moment in de video', () => {
    expect(videoSpanFromMetadata(videoMeta)).toEqual({
      timeStart: 130, timeEnd: 190, videoHref: `https://www.youtube.com/watch?v=${ID}&t=130s`,
    });
  });

  it('negeert andere bronnen en ongeldige video-id’s', () => {
    expect(videoSpanFromMetadata(null)).toBeNull();
    expect(videoSpanFromMetadata({ source: 'web', sourceUrl: 'https://x.example' })).toBeNull();
    expect(videoSpanFromMetadata({ source: 'pptx', slideStart: 2 })).toBeNull();
    expect(videoSpanFromMetadata({ ...videoMeta, videoId: 'x"><script>' })).toBeNull();
    expect(videoSpanFromMetadata({ ...videoMeta, timeStart: 'abc' })).toBeNull();
  });
});

describe('bronnenlijst', () => {
  it('toont het tijdstip bij een video, en laat pdf en pptx ongemoeid', () => {
    const video = chunkToDisplaySource({ documentTitle: 'Neurulatie', similarity: 0.8, documentId: 'd1', metadata: videoMeta });
    expect(locationLabel(video)).toBe('▶ 2:10');
    const pdf = chunkToDisplaySource({ documentTitle: 'reader.pdf', similarity: 0.8, documentId: 'd2', metadata: { pageStart: 3 } });
    expect(pdf).toEqual({ title: 'reader.pdf', similarity: 0.8, documentId: 'd2', pageStart: 3, pageEnd: 3 });
    expect(locationLabel(pdf)).toBe('p. 3');
    const web = chunkToDisplaySource({ documentTitle: 'site', similarity: 0.8, documentId: 'd3', metadata: { source: 'web', sourceUrl: 'https://x.example' } });
    expect(web).toEqual({ title: 'site', similarity: 0.8, documentId: 'd3' });
  });

  it('twee momenten uit dezelfde video blijven twee bronnen', () => {
    const a = chunkToDisplaySource({ documentTitle: 'V', similarity: 0.9, documentId: 'd1', metadata: videoMeta });
    const b = chunkToDisplaySource({ documentTitle: 'V', similarity: 0.7, documentId: 'd1', metadata: { ...videoMeta, timeStart: 300 } });
    expect(dedupeSourcesByDocument([a, b], 5)).toHaveLength(2);
  });
});
