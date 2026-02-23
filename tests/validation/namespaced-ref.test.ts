import { describe, it, expect } from 'vitest';
import { isNamespacedRef } from '../../src/utils/validation';

describe('isNamespacedRef', () => {
  describe('valid job: references', () => {
    it.each([
      'job:raw',
      'job:my-artifact',
      'job:my_artifact',
      'job:pointcloud123',
      'job:A',
    ])('accepts %s', (ref) => {
      expect(isNamespacedRef(ref)).toBe(true);
    });
  });

  describe('valid step: references', () => {
    it.each([
      'step:step1.output',
      'step:my-step.my-slot',
      'step:step_1.out',
      'step:A.B',
      'step:lidar-normalize.result',
    ])('accepts %s', (ref) => {
      expect(isNamespacedRef(ref)).toBe(true);
    });
  });

  describe('invalid references', () => {
    it.each([
      ['bare name', 'raw'],
      ['bare name with dash', 'my-artifact'],
      ['wrong namespace', 'artifact:foo'],
      ['step without dot', 'step:step1'],
      ['step with spaces', 'step:step 1.out'],
      ['job with dot', 'job:with.dot'],
      ['job with slash', 'job:path/to'],
      ['empty string', ''],
      ['just colon', ':'],
      ['step missing slot', 'step:step1.'],
      ['step missing id', 'step:.slot'],
    ])('%s: rejects %s', (_label, ref) => {
      expect(isNamespacedRef(ref)).toBe(false);
    });
  });
});
