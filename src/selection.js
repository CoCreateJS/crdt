// Selection offsets are UTF-16 source offsets, just like text operations.
// Both neighbors survive deletion as tombstones. Affinity chooses a side when
// concurrent text is inserted into the same gap.
export function anchorSelection(state, selection) {
    if (selection === null) return null;
    const endpoint = value => {
        if (typeof value === 'object' && value !== null) {
            if (!['left', 'right'].includes(value.affinity) ||
                !('left' in value) || !('right' in value) ||
                [value.left, value.right].some(id => id !== null && typeof id !== 'string'))
                throw new RangeError('Invalid CRDT selection reference.');
            return { left: value.left, right: value.right, affinity: value.affinity };
        }
        if (!Number.isInteger(value) || value < 0 || value > state.visible.length)
            throw new RangeError('Invalid CRDT selection offset.');
        return { left: state.visible[value - 1]?.id || null,
            right: state.visible[value]?.id || null, affinity: 'left' };
    };
    return { anchor: endpoint(selection.anchor), head: endpoint(selection.head) };
}

export function resolveSelection(state, selection) {
    if (selection === null) return null;
    const endpoint = point => {
        // An insertion may arrive after the selection that references it.
        if ((point.left && !state.nodes.has(point.left)) ||
            (point.right && !state.nodes.has(point.right))) return undefined;
        const id = point.affinity === 'right' ? point.right : point.left;
        if (id === null) return point.affinity === 'right' ? state.visible.length : 0;
        let offset = 0;
        for (const node of state.order) {
            if (node.id === id) return offset + (point.affinity === 'left' && !node.deletedBy.size ? 1 : 0);
            if (!node.deletedBy.size) offset++;
        }
        return undefined;
    };
    const anchor = endpoint(selection.anchor), head = endpoint(selection.head);
    if (anchor === undefined || head === undefined) return undefined;
    return { anchor, head, start: Math.min(anchor, head), end: Math.max(anchor, head) };
}
