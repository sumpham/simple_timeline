import { describe, expect, it } from 'vitest';
import { barNote, noteTag } from '../client/components/Board.tsx';
import { defaultTimelineText, timelineTextToStore } from '../shared/bookings.ts';

describe('noteTag', () => {
  it('is null for a missing or blank note', () => {
    expect(noteTag(null)).toBeNull();
    expect(noteTag(undefined)).toBeNull();
    expect(noteTag('   \n ')).toBeNull();
  });

  it('shows a short note whole', () => {
    expect(noteTag('NFT')).toBe('NFT');
    expect(noteTag('0123456789')).toBe('0123456789');
  });

  it('keeps the first ten characters of a long note', () => {
    expect(noteTag('Performance run 2')).toBe('Performanc…');
    expect(noteTag('SIT rerun for defects')).toBe('SIT rerun…');
  });

  it('flattens line breaks so the bar stays on one line', () => {
    expect(noteTag('  NFT\nround 2')).toBe('NFT round…');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(noteTag('Kiểm thử hiệu năng')).toBe('Kiểm thử h…');
  });
});

describe('barNote', () => {
  // Six pixels a character stands in for the real font.
  const measure = (label: string, note: string) => (label.length + note.length) * 6;

  it('shows the whole note when label and note fit', () => {
    // "AI" + " · Build core services" = 2 + 22 = 24 chars = 144px
    expect(barNote('AI', 'Build core services', 150, measure)).toBe('Build core services');
  });

  it('falls back to the short tag when the whole note would not fit', () => {
    expect(barNote('AI', 'Build core services', 100, measure)).toBe('Build core…');
  });

  it('flattens line breaks in a whole note', () => {
    expect(barNote('AI', 'Round\n2', 500, measure)).toBe('Round 2');
  });

  it('is null with no note', () => {
    expect(barNote('AI', '  ', 500, measure)).toBeNull();
  });
});

describe('timeline text', () => {
  it('defaults to the project name, then the note', () => {
    expect(defaultTimelineText('Huawei Migration', 'NFT')).toBe('Huawei Migration · NFT');
    expect(defaultTimelineText('Huawei Migration', '  ')).toBe('Huawei Migration');
    expect(defaultTimelineText('Huawei Migration', 'NFT\nround 2')).toBe('Huawei Migration · NFT round 2');
  });

  it('stores nothing while the text is blank or still the default', () => {
    const d = defaultTimelineText('Huawei Migration', 'NFT');
    expect(timelineTextToStore(null, d)).toBeNull();
    expect(timelineTextToStore('   ', d)).toBeNull();
    expect(timelineTextToStore(' Huawei Migration · NFT ', d)).toBeNull();
  });

  it('stores what the user wrote, on one line', () => {
    const d = defaultTimelineText('Huawei Migration', 'NFT');
    expect(timelineTextToStore('HW NFT  run\n2', d)).toBe('HW NFT run 2');
  });
});
