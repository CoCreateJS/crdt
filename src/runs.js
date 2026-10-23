// Run identity reuses the first operation ID. Browser/frame identity comes from
// Socket Client; no separate actor ID or generated run ID is introduced.
export function assignRun(object, change) {
    const key = JSON.stringify([change.clientId, change.frameId]);
    object.runs ||= new Map();
    const previous = object.runs.get(key);
    const insertion = !change.history && change.value.length > 0;
    if (!insertion) { object.runs.delete(key); return change; }
    const continuing = change.length === 0 && change.runBreak !== true && previous && change.start === previous.nextPosition && change.left === previous.last;
    const runId = continuing ? previous.id : change.id;
    const runIndex = continuing ? previous.index + 1 : 0;
    const runLeft = continuing ? previous.left : change.left;
    const runRight = continuing ? previous.right : change.right;
    if (change.runEnd === true) object.runs.delete(key);
    else object.runs.set(key, {
        id: runId, index: runIndex, left: runLeft, right: runRight,
        last: `${change.id}:${change.value.length - 1}`,
        nextPosition: change.start + change.value.length
    });
    return { ...change, runVersion: 1, runId, runIndex, runLeft, runRight };
}

export function clearRun(object, clientId, frameId) {
    object?.runs?.delete(JSON.stringify([clientId, frameId]));
}

// A foreign edit may invalidate sequential positioning even when the last local
// character still exists. Detect this in CRDT rather than requiring DOM hooks.
export function reconcileRuns(object, change, previous, current) {
    if (!object.runs?.size) return;
    const boundaryRuns = new Set();
    if (change.value.length) {
        for (const id of [change.left, change.right]) {
            const run = previous.nodes.get(id)?.runId;
            if (run) boundaryRuns.add(run);
        }
    }
    for (const id of [ ...(change.targets || []), ...(change.restores || []).map(item => item.target) ]) {
        const run = previous.nodes.get(id)?.runId;
        if (run) boundaryRuns.add(run);
    }
    const positions = new Map(current.visible.map((node, index) => [node.id, index + 1]));
    for (const [key, run] of object.runs) {
        if (positions.get(run.last) !== run.nextPosition || boundaryRuns.has(run.id)) object.runs.delete(key);
    }
}
