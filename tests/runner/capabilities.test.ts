import { describe, it, expect } from 'vitest';
import { matchesCapabilities } from '../../src/utils/capabilities';

describe('matchesCapabilities', () => {
  it('matches when requires is empty or missing', () => {
    expect(matchesCapabilities({}, { cpu: 4 })).toBe(true);
    expect(matchesCapabilities(null, {})).toBe(true);
    expect(matchesCapabilities(undefined, undefined)).toBe(true);
  });

  it('numbers require greater or equal', () => {
    expect(matchesCapabilities({ mem_gb: 16 }, { mem_gb: 32 })).toBe(true);
    expect(matchesCapabilities({ mem_gb: 16 }, { mem_gb: 16 })).toBe(true);
    expect(matchesCapabilities({ mem_gb: 16 }, { mem_gb: 8 })).toBe(false);
    expect(matchesCapabilities({ mem_gb: 16 }, { mem_gb: '32' })).toBe(false);
  });

  it('booleans and strings require equality', () => {
    expect(matchesCapabilities({ gpu: true }, { gpu: true })).toBe(true);
    expect(matchesCapabilities({ gpu: true }, { gpu: false })).toBe(false);
    expect(matchesCapabilities({ ara_version: '0.3.1' }, { ara_version: '0.3.1' })).toBe(true);
    expect(matchesCapabilities({ ara_version: '0.3.1' }, { ara_version: '0.3.2' })).toBe(false);
  });

  it('lists require every element to be present', () => {
    expect(matchesCapabilities({ tags: ['gdal'] }, { tags: ['gdal', 'region=br'] })).toBe(true);
    expect(matchesCapabilities({ tags: ['gdal', 'gpu'] }, { tags: ['gdal'] })).toBe(false);
    expect(matchesCapabilities({ tags: ['gdal'] }, { tags: 'gdal' })).toBe(false);
  });

  it('a missing capability fails the match', () => {
    expect(matchesCapabilities({ mem_gb: 16 }, {})).toBe(false);
    expect(matchesCapabilities({ mem_gb: 16 }, undefined)).toBe(false);
  });

  it('an unsupported requirement shape never matches', () => {
    expect(matchesCapabilities({ nested: { a: 1 } }, { nested: { a: 1 } })).toBe(false);
  });
});
