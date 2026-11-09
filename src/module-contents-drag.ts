/** The corners of a box, as `DOMRect` reports them — the one shape `pointOutsideRect` needs. */
export interface RectLike {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** True when the point is strictly outside `rect`. A point on the edge counts as inside, so a pointer
 * resting on the modal's border doesn't flicker it between dimmed and normal. */
export function pointOutsideRect(x: number, y: number, rect: RectLike): boolean {
	return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}
