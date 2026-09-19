import type { LinkData } from '../types/domain';
import { DEFAULTS } from '../theme';

/**
 * What a link looks like unless it has been given a look of its own (LT-079).
 *
 * Only the appearance travels: colour, path type, flow direction, width, line
 * style and — when chosen — the arrowheads at each end (LT-180). A link's ports, its label, its health rule and whether it is in
 * maintenance are facts about the network, not style, and resetting the style
 * must never touch them — losing a port label because someone tidied the
 * colours would be a bad trade.
 *
 * Stored on the document, so the choice travels with the diagram and everyone
 * who opens it draws the same links.
 */
export type LinkStyleDefaults = Pick<
  LinkData,
  'color' | 'pathType' | 'direction' | 'width' | 'lineStyle' | 'startCap' | 'endCap'
>;

/** What the app draws with when nobody has said otherwise.
 *
 *  Bezier since LT-130, asked for repeatedly: "default the links path to
 *  bezier no matter how we build the topolgy". Every creator that does not
 *  have an opinion of its own leaves `pathType` unset and gets this. */
export const BUILT_IN_LINK_STYLE: LinkStyleDefaults = {
  color: DEFAULTS.linkColor,
  pathType: 'bezier',
  direction: 'none',
  width: 2,
  lineStyle: 'solid',
};

/** The style a new link is born with, or that "reset" returns one to. */
export function linkStyleDefaults(
  stored: Partial<LinkStyleDefaults> | undefined,
): LinkStyleDefaults {
  return { ...BUILT_IN_LINK_STYLE, ...(stored ?? {}) };
}

/** The style fields of a link, as they would be saved as the default. The
 *  arrowheads only when the link has its own; otherwise its direction decides
 *  them, as it does for every link. */
export function styleOf(data: LinkData): LinkStyleDefaults {
  return {
    color: data.color,
    pathType: data.pathType,
    direction: data.direction,
    width: data.width,
    lineStyle: data.lineStyle ?? 'solid',
    ...(data.startCap ? { startCap: data.startCap } : {}),
    ...(data.endCap ? { endCap: data.endCap } : {}),
  };
}

/**
 * The patch that puts a link back to the default look.
 *
 * A hand-drawn route is part of the look, so it goes: that is what "default
 * path type" means when the link has been bent by hand. Everything else about
 * the link is left exactly as it was.
 */
export function resetToDefault(
  stored: Partial<LinkStyleDefaults> | undefined,
): Partial<LinkData> {
  const defaults = linkStyleDefaults(stored);
  return {
    ...defaults,
    waypoints: [],
    curvature: undefined,
    // The default's own arrowheads, or none — leaving the direction to decide.
    startCap: defaults.startCap,
    endCap: defaults.endCap,
  };
}
