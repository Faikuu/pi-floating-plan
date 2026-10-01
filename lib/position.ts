/**
 * Where the panel sits in the terminal.
 *
 * pi's overlay API takes an anchor and a margin, and the margin is what keeps
 * the panel off the edges. It is applied to all four sides, but only the two
 * the anchor touches can move anything: top and left for `top-left`, bottom
 * and right for `bottom-right`. One `padding` therefore covers every anchor.
 *
 * pi resolves these options once, when the overlay is shown, rather than on
 * every frame — so a change to the anchor or the padding has to rebuild the
 * overlay to take effect (see `reopenOverlay` in the extension).
 */

import type { OverlayOptions } from "@earendil-works/pi-tui";
import type { FloatingPlanConfig } from "./config.ts";

/**
 * Below this the framed panel is more noise than signal, so it is not shown
 * at all.
 */
const MIN_VISIBLE_WIDTH = 24;

/** The panel's size, placement and input behaviour as one overlay option set. */
export function overlayOptions(config: FloatingPlanConfig): OverlayOptions {
	return {
		anchor: config.anchor,
		width: config.width,
		minWidth: 20,
		// A safety net for a short terminal: a long plan is cut from the bottom
		// rather than allowed to reach the editor.
		maxHeight: "60%",
		margin: { top: config.padding, right: config.padding, bottom: config.padding, left: config.padding },
		visible: (termWidth: number) => termWidth >= MIN_VISIBLE_WIDTH,
		// The editor keeps focus and every keystroke: the panel is a spectator,
		// not a dialog.
		nonCapturing: true,
	};
}