/**
 * Maps between physical scroll offsets and virtual content offsets.
 *
 * Browsers cap element height (Firefox near 17.9 million px, Chrome and Safari near 33.5 million), and
 * Firefox stops honouring `position: sticky` beyond about 8.95 million px of scroll (2^31 / 240 in its
 * internal units), which would unstick the header and pinned columns. A million rows at 32px is 32 million
 * px, so above `maxPhysicalHeight` (8 million, under every limit) the scrollable height is capped and scroll
 * positions are compressed in the middle of the range (see `DEFAULT_SCALED_EDGE`). Below the cap the mapping
 * is the identity.
 */
export const DEFAULT_MAX_PHYSICAL_HEIGHT = 8_000_000;

/**
 * Pixels at each end of a scaled range that map 1:1. Near the top and bottom there is not enough physical
 * room to pin rows to a compressed position (a row would have to start above the content), so the ends
 * scroll at true speed and only the middle is compressed.
 */
export const DEFAULT_SCALED_EDGE = 4000;

export type ScrollMapping = {
    readonly virtualTotal: number;
    readonly physicalTotal: number;
    readonly scaled: boolean;
    /** Virtual offset of the top of the viewport for a physical scrollTop. */
    toVirtual(scrollTop: number): number;
    /** Physical scrollTop that shows `virtualTop` at the top of the viewport. */
    toPhysical(virtualTop: number): number;
};

export function createScrollMapping(
    virtualTotal: number,
    viewportSize: number,
    maxPhysicalHeight: number = DEFAULT_MAX_PHYSICAL_HEIGHT,
    edge: number = DEFAULT_SCALED_EDGE
): ScrollMapping {
    if (virtualTotal <= maxPhysicalHeight || viewportSize >= maxPhysicalHeight) {
        return {
            virtualTotal,
            physicalTotal: virtualTotal,
            scaled: false,
            toVirtual: (scrollTop) => scrollTop,
            toPhysical: (virtualTop) => virtualTop,
        };
    }

    // Edge-linear: 1:1 for `ends` pixels at the top and bottom, compressed in between, continuous and
    // monotonic. At scroll 0 the first row is at the top, at the maximum scroll the last row at the bottom.
    const virtualRange = Math.max(virtualTotal - viewportSize, 0);
    const physicalRange = Math.max(maxPhysicalHeight - viewportSize, 1);
    const ends = Math.min(edge, physicalRange / 4);
    const ratio = (virtualRange - 2 * ends) / (physicalRange - 2 * ends);

    return {
        virtualTotal,
        physicalTotal: maxPhysicalHeight,
        scaled: true,
        toVirtual: (scrollTop) => {
            const top = Math.min(Math.max(scrollTop, 0), physicalRange);
            if (top <= ends) {
                return top;
            }
            if (top >= physicalRange - ends) {
                return virtualRange - (physicalRange - top);
            }

            return ends + (top - ends) * ratio;
        },
        toPhysical: (virtualTop) => {
            const top = Math.min(Math.max(virtualTop, 0), virtualRange);
            if (top <= ends) {
                return top;
            }
            if (top >= virtualRange - ends) {
                return physicalRange - (virtualRange - top);
            }

            return ends + (top - ends) / ratio;
        },
    };
}
