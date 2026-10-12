import type { ScrollMapping } from './scrollMapping';

/** Unscaled mapping, for axes that never approach the browser size cap (columns). */
export function identityMapping(total: number): ScrollMapping {
    return {
        virtualTotal: total,
        physicalTotal: total,
        scaled: false,
        toVirtual: (scroll) => scroll,
        toPhysical: (offset) => offset,
    };
}
