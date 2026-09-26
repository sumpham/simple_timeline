import { describe, expect, it } from 'vitest';
import { noteTag } from '../client/components/Board.tsx';

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
