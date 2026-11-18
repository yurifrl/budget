import { describe, expect, test } from 'bun:test';

import { avatarColor, generateAvatar, luminance, type AvatarSpec } from './generate';
import { avatarScene, detailForSize } from './scene';
import { avatarSvg } from './svg';

const seeds = Array.from({ length: 500 }, (_, i) => `seed-${i}`);

describe('generateAvatar', () => {
  test('is deterministic', () => {
    expect(generateAvatar('yuri')).toEqual(generateAvatar('yuri'));
    expect(avatarColor('yuri')).toBe(generateAvatar('yuri').accent);
  });

  test('different seeds give different specs (500 seeds, near-zero collisions)', () => {
    const unique = new Set(seeds.map((s) => JSON.stringify(generateAvatar(s))));
    expect(unique.size).toBe(500);
  });

  test('a 4-person household never looks alike', () => {
    const ids = ['3f2a9c1e-77aa-4b10-9d0e-aa11bb22cc33', 'b1c0d9e8-1111-4222-8333-444455556666', 'a', 'b'];
    const looks = new Set(ids.map((s) => JSON.stringify(generateAvatar(s))));
    expect(looks.size).toBe(4);
  });

  test('feature choices are well distributed', () => {
    const specs = seeds.map(generateAvatar);
    const count = <T>(f: (s: AvatarSpec) => T) => new Set(specs.map(f)).size;
    expect(count((s) => s.bg)).toBeGreaterThanOrEqual(14);
    expect(count((s) => s.eyes.kind)).toBe(5);
    expect(count((s) => s.mouth.kind)).toBe(5);
    expect(count((s) => s.brow)).toBe(3);
    expect(count((s) => s.decor)).toBe(4);
    const blush = specs.filter((s) => s.blush).length;
    expect(blush).toBeGreaterThan(180);
    expect(blush).toBeLessThan(320);
  });

  test('spec values stay within bounds', () => {
    for (const spec of seeds.map(generateAvatar)) {
      const { faceShape: f, eyes: e, mouth: m } = spec;
      expect(f.size).toBeGreaterThanOrEqual(66);
      expect(f.size).toBeLessThanOrEqual(76);
      expect(f.radius).toBeGreaterThanOrEqual(f.size * 0.3 - 0.1);
      expect(f.radius).toBeLessThanOrEqual(f.size * 0.5 + 0.1);
      expect(Math.abs(f.dx)).toBeLessThanOrEqual(7);
      expect(Math.abs(f.dy)).toBeLessThanOrEqual(6);
      expect(Math.abs(f.rotate)).toBeLessThanOrEqual(16);
      expect(e.spacing).toBeGreaterThanOrEqual(11);
      expect(e.spacing).toBeLessThanOrEqual(16);
      expect(e.y).toBeLessThan(0);
      expect(m.y).toBeGreaterThan(e.y);
      expect(m.width).toBeLessThanOrEqual(13);
      expect(spec.decorX).toBeGreaterThanOrEqual(14);
      expect(spec.decorX).toBeLessThanOrEqual(86);
      for (const c of [spec.bg, spec.face, spec.accent, spec.ink]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test('features stay readable: ink contrasts with the face', () => {
    for (const spec of seeds.map(generateAvatar)) {
      const [hi, lo] = [luminance(spec.face), luminance(spec.ink)].sort((a, b) => b - a);
      expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThan(4.5);
    }
  });

  test('snapshot of fixed seeds (changing the generator re-rolls every avatar)', () => {
    expect(generateAvatar('syscd')).toMatchSnapshot();
    expect(generateAvatar('yuri')).toMatchSnapshot();
    expect(generateAvatar('3f2a9c1e-77aa-4b10-9d0e-aa11bb22cc33')).toMatchSnapshot();
  });
});

describe('scene', () => {
  test('simple detail drops blush and brows; full keeps them', () => {
    const seed = seeds.find((s) => {
      const a = generateAvatar(s);
      return a.blush && a.brow !== 'none';
    })!;
    const spec = generateAvatar(seed);
    const size = (d: 'full' | 'simple') =>
      JSON.stringify(avatarScene(spec, d)).split('"t":').length;
    expect(size('full')).toBeGreaterThan(size('simple'));
  });

  test('detail threshold and svg serialization', () => {
    expect(detailForSize(18)).toBe('simple');
    expect(detailForSize(96)).toBe('full');
    const svg = avatarSvg(generateAvatar('yuri'), 48);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 100 100"');
  });
});
