import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LAYER,
  allPrinted,
  isEditable,
  isPrinted,
  isVisible,
  layersOf,
  standardLayers,
  toggleOn,
  withNewLayer,
  withStandardLayers,
  withoutLayer,
  type Layer,
} from './layers';

const layer = (id: string, over: Partial<Layer> = {}): Layer => ({
  id, name: id, visible: true, locked: false, ...over,
});

describe('isVisible', () => {
  const layers = [layer('physical'), layer('logical', { visible: false })];

  it('shows an object on a visible layer', () => {
    expect(isVisible(['physical'], layers)).toBe(true);
  });

  it('hides an object only on a hidden layer', () => {
    expect(isVisible(['logical'], layers)).toBe(false);
  });

  it('shows an object that is on both', () => {
    // On more than one view, and one of them is being looked at.
    expect(isVisible(['physical', 'logical'], layers)).toBe(true);
  });

  it('shows an object that has never been assigned', () => {
    // The rule that keeps a diagram drawn before layers existed from
    // disappearing the moment somebody adds one.
    expect(isVisible(undefined, layers)).toBe(true);
    expect(isVisible([], layers)).toBe(true);
  });

  it('shows an object whose layers have all been deleted', () => {
    // Deleting a view of the network must not delete the network.
    expect(isVisible(['gone'], layers)).toBe(true);
  });
});

describe('isEditable', () => {
  const layers = [layer('base'), layer('background', { locked: true })];

  it('lets an unlocked object be edited', () => {
    expect(isEditable(['base'], layers)).toBe(true);
    expect(isEditable(undefined, layers)).toBe(true);
  });

  it('refuses an object on a locked layer', () => {
    expect(isEditable(['background'], layers)).toBe(false);
  });

  it('refuses an object that is on a locked layer as well as a free one', () => {
    // Half-locked is locked: otherwise adding an object to a second layer
    // would be a way of unlocking it.
    expect(isEditable(['base', 'background'], layers)).toBe(false);
  });
});

describe('the set of layers', () => {
  it('always has one', () => {
    expect(layersOf(undefined)).toEqual([DEFAULT_LAYER]);
    expect(layersOf([])).toEqual([DEFAULT_LAYER]);
  });

  it('keeps what a document already had', () => {
    const mine = [layer('physical')];
    expect(layersOf(mine)).toBe(mine);
  });

  it('does not add a second layer with the same name', () => {
    const grown = withNewLayer([layer('a', { name: 'Physical' })], 'Physical', 'b');
    expect(grown[1]!.name).toBe('Physical 2');
  });

  it('names an unnamed layer rather than leaving it blank', () => {
    expect(withNewLayer([], '   ', 'x')[0]!.name).toBe('Layer');
  });

  it('never leaves a document with no layers at all', () => {
    expect(withoutLayer([layer('only')], 'only')).toEqual([DEFAULT_LAYER]);
  });

  it('removes the one asked for and keeps the rest', () => {
    const left = withoutLayer([layer('a'), layer('b')], 'a');
    expect(left.map((l) => l.id)).toEqual(['b']);
  });
});

describe('toggleOn', () => {
  it('adds and removes', () => {
    expect(toggleOn(undefined, 'a')).toEqual(['a']);
    expect(toggleOn(['a'], 'a')).toEqual([]);
    expect(toggleOn(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('views that do not print (LT-184)', () => {
  const layers = [layer('physical'), layer('notes', { print: false }), layer('hidden', { visible: false })];

  it('leaves out an object only on a view set not to print', () => {
    expect(isPrinted(['notes'], layers)).toBe(false);
    expect(isPrinted(['physical'], layers)).toBe(true);
  });

  it('prints an object also on a view that prints', () => {
    expect(isPrinted(['notes', 'physical'], layers)).toBe(true);
  });

  it('never prints what is not being shown', () => {
    expect(isPrinted(['hidden'], layers)).toBe(false);
  });

  it('prints an object on no view, or only on views since removed', () => {
    expect(isPrinted(undefined, layers)).toBe(true);
    expect(isPrinted(['gone'], layers)).toBe(true);
  });

  it('treats a view saved before the toggle existed as printed', () => {
    expect(allPrinted([layer('old')])).toBe(true);
    expect(allPrinted(layers)).toBe(false);
  });
});

describe('the standard views (LT-184)', () => {
  const ids = () => {
    let n = 0;
    return () => `id${++n}`;
  };

  it('replaces an untouched base view with Physical, Logical, Overlay and Annotations', () => {
    expect(withStandardLayers(undefined, ids()).map((l) => l.name)).toEqual(['Physical', 'Logical', 'Overlay', 'Annotations']);
    expect(standardLayers(ids()).every((l) => l.visible && !l.locked)).toBe(true);
  });

  it('keeps views already made and adds only the missing ones', () => {
    const got = withStandardLayers([layer('mine', { name: 'Change 12' }), layer('l', { name: 'logical' })], ids());
    expect(got.map((l) => l.name)).toEqual(['Change 12', 'logical', 'Physical', 'Overlay', 'Annotations']);
  });

  it('keeps a base view that has been used', () => {
    const got = withStandardLayers([{ ...DEFAULT_LAYER, locked: true }], ids());
    expect(got[0]).toEqual({ ...DEFAULT_LAYER, locked: true });
    expect(got).toHaveLength(5);
    expect(withStandardLayers(undefined, ids(), new Set(['base']))[0]).toEqual(DEFAULT_LAYER);
  });
});
