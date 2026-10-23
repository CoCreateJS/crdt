// Stable identities belong to source characters, not transient numeric positions.
// Indexes use UTF-16 code units to match String.slice and existing editor APIs.
const tokenId = (operation, index) => `${operation}:${index}`;

function compareBranches(a, b, parent) {
    const continuing = node => !!node.runId && node.runId === parent?.runId && node.clientId === parent?.clientId;
    if (continuing(a) !== continuing(b)) return continuing(a) ? -1 : 1;
    if (a.runId && b.runId) {
        // Code-unit comparison is locale-independent across clients.
        if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1;
        if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
    }
    return a.operation > b.operation ? -1 : a.operation < b.operation ? 1 : b.index - a.index;
}

function orderBranches(list, parentId, nodes) {
    // Observed placement takes precedence over concurrent client priority. If a
    // user inserts before existing content, retain that explicit right boundary.
    const edges = new Map(list.map(node => [node.id, new Set()]));
    const incoming = new Map(list.map(node => [node.id, 0]));
    for (const node of list) {
        let right = nodes.get(node.right);
        const visited = new Set();
        while (right && right.after !== parentId && !visited.has(right.id)) {
            visited.add(right.id);
            right = nodes.get(right.after);
        }
        if (right && right.id !== node.id && incoming.has(right.id) && !edges.get(node.id).has(right.id)) {
            edges.get(node.id).add(right.id);
            incoming.set(right.id, incoming.get(right.id) + 1);
        }
    }
    const compare = (a, b) => compareBranches(a, b, nodes.get(parentId));
    const ready = list.filter(node => incoming.get(node.id) === 0).sort(compare);
    const byId = new Map(list.map(node => [node.id, node]));
    const result = [];
    while (ready.length) {
        const node = ready.shift();
        result.push(node);
        for (const id of edges.get(node.id)) {
            incoming.set(id, incoming.get(id) - 1);
            if (incoming.get(id) === 0) { ready.push(byId.get(id)); ready.sort(compare); }
        }
    }
    if (result.length !== list.length) throw new Error('Conflicting CRDT insertion boundaries.');
    return result;
}

function visibleState(nodes) {
    const children = new Map();
    for (const node of nodes.values()) {
        let list = children.get(node.after);
        if (!list) children.set(node.after, list = []);
        list.push(node);
    }
    for (const [parent, list] of children) children.set(parent, orderBranches(list, parent, nodes));
    const stack = [...(children.get(null) || [])].reverse();
    const visible = [], order = [], visited = new Set();
    while (stack.length) {
        const node = stack.pop();
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        order.push(node);
        if (!node.deletedBy.size) visible.push(node);
        const descendants = children.get(node.id) || [];
        for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]);
    }
    return { nodes, visible, order, text: visible.map(node => node.value).join('') };
}

export function prepareChange(state, change) {
    const start = change.start, length = change.length || 0;
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 ||
        start + length > state.visible.length) throw new RangeError('Invalid CRDT text range.');
    const targets = state.visible.slice(start, start + length);
    return {
        ...change, format: 2,
        left: state.visible[start - 1]?.id || null,
        right: state.visible[start + length]?.id || null,
        targets: targets.map(node => node.id),
        restores: [],
        removedValue: targets.map(node => node.value).join(''),
        previousCharacter: state.visible[start - 1]?.value || '',
        nextCharacter: state.visible[start + length]?.value || ''
    };
}

export function replaySequence(log) {
    const snapshot = log.filter(change => change.type === 'snapshot').sort((a, b) => b.id.localeCompare(a.id))[0];
    const nodes = new Map();
    const seen = new Set(snapshot?.seenIds || []);
    const applied = new Set();
    const operations = new Map();
    if (snapshot?.sequence) {
        for (const node of snapshot.sequence) nodes.set(node.id, { ...node, deletedBy: new Set(node.deletedBy) });
    } else if (snapshot) {
        let after = null;
        for (let index = 0; index < snapshot.value.length; index++) {
            const id = tokenId(snapshot.id, index);
            nodes.set(id, { id, operation: snapshot.id, index, after, value: snapshot.value[index], deletedBy: new Set() });
            after = id;
        }
    }
    const deletions = [], restorations = [];
    const sorted = log.filter(change => change.type !== 'snapshot').slice().sort((a, b) => a.id.localeCompare(b.id));
    for (const raw of sorted) {
        if (seen.has(raw.id) || applied.has(raw.id)) continue;
        applied.add(raw.id);
        // Historical positional operations can only be interpreted in their old
        // deterministic replay order. New operations always carry author identities.
        let change = raw;
        if (raw.format !== 2) {
            const current = visibleState(nodes);
            change = prepareChange(current, { ...raw,
                start: Math.min(raw.start, current.visible.length),
                length: Math.min(raw.length || 0, Math.max(0, current.visible.length - raw.start)) });
        }
        operations.set(change.id, change);
        let after = change.left;
        for (let index = 0; index < change.value.length; index++) {
            const id = tokenId(change.id, index);
            nodes.set(id, { id, operation: change.id, index, after, value: change.value[index],
                clientId: change.clientId, runId: change.runId, right: change.right, deletedBy: new Set() });
            after = id;
        }
        for (const id of change.targets || []) {
            deletions.push([id, change.id]);
            // Apply immediately too, for positional legacy entries later in this replay.
            nodes.get(id)?.deletedBy.add(change.id);
        }
        for (const restore of change.restores || []) {
            restorations.push(restore);
            nodes.get(restore.target)?.deletedBy.delete(restore.deletion);
        }
    }
    // Preserve deletes/restores delivered before the insertion they reference.
    for (const [id, deletion] of deletions) nodes.get(id)?.deletedBy.add(deletion);
    for (const { target, deletion } of restorations) nodes.get(target)?.deletedBy.delete(deletion);
    return { ...visibleState(nodes), seenIds: new Set([...seen, ...applied]), operations };
}

export function inverseChange(state, change, id, data) {
    const inserted = Array.from({ length: change.value.length }, (_, index) => tokenId(change.id, index));
    const targets = [...inserted, ...(change.restores || []).map(restore => restore.target)];
    const indexes = targets.map(target => state.visible.findIndex(node => node.id === target)).filter(index => index >= 0);
    return {
        ...data, id, frameId: undefined, history: true, format: 2,
        start: indexes.length ? Math.min(...indexes) : change.start,
        length: indexes.length, value: '', left: change.left, right: change.right,
        targets, restores: (change.targets || []).map(target => ({ target, deletion: change.id })),
        removedValue: indexes.map(index => state.visible[index].value).join('')
    };
}

export function textDiff(before, after) {
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    return { start, length: oldEnd - start, value: after.slice(start, newEnd) };
}
