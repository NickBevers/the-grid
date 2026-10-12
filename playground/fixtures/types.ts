/** A row in the fixtures: data, a group header, or a placeholder for a block still loading. */
export type PrototypeRow =
    | { kind: 'data'; id: string }
    | { kind: 'group'; id: string; label: string; expanded: boolean; childCount: number }
    | { kind: 'loading'; id: string };
