# Typing run contract (version 1)

This contract extends identity operation format 2. It requires no server-assigned
rank, extra browser identity, new database collection, or randomly generated run
identifier. All collaborating clients must use the same ordering implementation.

## Identity and scope

The operation's `clientId` is the persisted browser identity supplied by the
initialized Socket Client. `frameId` identifies its existing page/frame context.
`user_id` remains useful author metadata but does not participate in ordering.
The local API rejects ordinary edits before client/frame identity is available;
it does not invent a fallback browser ID. Scope remains `array/object/key`.

## Operation fields

| Field | Meaning |
| --- | --- |
| `id` | Unique operation ID; unchanged existing operation contract |
| `clientId` | Persisted Socket Client browser ID |
| `frameId` | Existing Socket Client frame ID |
| `runVersion` | `1` for this grouping contract |
| `runId` | ID of the first operation in this run |
| `runIndex` | Zero-based operation number within the run, not a character offset |
| `runLeft`, `runRight` | Character identities surrounding the initial run insertion |
| `left`, `right` | Character identities surrounding this individual operation |

Each inserted character still has its existing operation-ID/UTF-16-offset identity.
Runs are grouping metadata; they never replace character identities or deletion
markers. The server broadcasts and persists the fields with the operation. No
arrival-order lookup is needed to infer membership during replay.

## Run boundaries

CRDT manages run boundaries from the edits it receives. Local tracking is scoped
to the field, client and frame. An insertion-only operation continues the previous
run when both its numeric `start` equals the previous insertion's end and its
left anchor equals the last character inserted by that run. Otherwise it starts
a new run using its own operation ID. Replacements start a new run; deletes, undo
and redo close the active run. A whole-value `replaceText` is a standalone run.

On a foreign edit, CRDT checks whether the expected next insertion position has
shifted, whether the last run character was removed, or whether the edit directly
inserts into or modifies the run. Any of these closes the active run, so the next
local insertion starts anew. Concurrent insertion elsewhere that leaves the run
and expected position intact does not end it.

No editor call is required to detect a changed insertion position or an incoming
edit that breaks sequential positioning. `endRun({ array, object, key })` remains
an optional semantic boundary for events with no text operation, such as blur,
submit or an explicit move away and back to the identical position. CRDT cannot
observe a cursor move with no accompanying edit. Boolean `runBreak: true` and
`runEnd: true` can also establish boundaries on an edit when the integration knows
its intent (for example a standalone paste). There is no idle timeout or heuristic
that assumes every multi-character input is a paste.

```js
await crdt.updateText({ array, object, key, realtime: true, start: 0, value: 'H' });
await crdt.updateText({ array, object, key, realtime: true, start: 1, value: 'i' });
// These operations share the first operation's ID as runId, with indexes 0 and 1.
crdt.endRun({ array, object, key });
await crdt.updateText({ array, object, key, realtime: true, start: 2, value: '!' });
// This operation starts a new run with its own ID.
```

Only `realtime: true` publishes an operation to other elements, the socket, or
storage. A private editor can provide a stable, editor-specific `scope` and
`initialValue` to keep its history in memory. It can also provide the originating
`element`; CRDT returns the update event with that element as its sole target.
The element reference is excluded from the history log and socket packet. Undo
and redo use the same scope. A Save action can publish the completed string with
a separate realtime `replaceText` call against the shared array/object/key.

## Ordering

Character anchors determine document placement. For concurrent insertion branches
at the same anchor, compare `clientId` as case-sensitive code-unit strings,
ascending. For separate runs from the same browser, compare `runId` ascending.
Existing operation IDs resolve remaining ties. The rank is a comparison rule,
not an integer stored or recalculated from the connected participant list.

A continuation stays inside its run's branch. Explicit placement before content
an author already observed takes precedence over concurrent priority: a deliberate
insertion inside an existing run is allowed to split that run. Right-anchor
constraints establish that placement before concurrent branch ordering is applied.

Historical operations without run metadata retain their operation-ID ordering.
Snapshots retain the node client/run metadata and insertion boundaries, so replay
uses the same rule after compaction. Clients reconnecting do not rewrite previous
run membership; a new frame starts new local run tracking.

## Validation coverage

Tests cover four concurrent character-by-character runs, reversed delivery,
multiple frames sharing one client, explicit/inferred boundaries, deliberate
insertions inside existing content and the existing identity/snapshot regressions.
Changed write positions and foreign interruptions are detected inside CRDT.
Optional non-writing editor actions can explicitly end a run; network and browser
integration testing remain separate work.

## Selections and shared presence

Text and selection use the same `crdt` socket method and field scope. An optional
`selection` on `updateText` describes the **resulting** source selection after
that edit, with directional UTF-16 offsets:

```js
await crdt.updateText({
    array, object, key, realtime: true, start: 0, value: 'hello',
    selection: { anchor: 5, head: 2 }
});
await crdt.updateSelection({ array, object, key, realtime: true, selection: { anchor: 2, head: 2 } });
await crdt.updateSelection({ array, object, key, realtime: true, selection: null }); // blur/hide
```

Each endpoint becomes `{ left, right, affinity }`, where left and right are
stable neighboring character IDs (or null at a boundary). Default affinity is
`left`: a cursor stays immediately after its left neighbor when another writer
inserts into the same gap. Callers may also supply these endpoint references
with `affinity: 'right'` to stay before the right neighbor. Deleted neighbors
remain resolvable through tombstones. Unknown references wait until their text
arrives. Anchor/head preserve backward selections; they are not normalized away.

Editor adapters can supply a synchronous local `captureSelection()` callback
instead of numeric `selection`. CRDT calls it after dispatching the text update
so it reads the actual resulting editor selection. The callback never travels
on the socket or enters history. A callback failure does not stop broadcasting
or saving an already-applied text edit.

A text operation and its selection share one packet and history entry.
`updateSelection` sends `type: 'selection'` without a text operation ID, document
save, or undo entry. A changed position ends the local typing run; duplicate
positions are suppressed and metadata-only updates preserve the run. A per-frame
`selectionClock` prevents older packets from replacing a newer selection.
Selection-only updates are transient and are not restored from document history.
Optional `presence` carries display metadata such as userName and cursor colors.

`cocreate-crdt-selection` exposes `selection` references and a `resolved`
`{ anchor, head, start, end }` for the current source text (null for blur).
Known selections are resolved again after subsequent edits. Editor owns browser
selection capture and source-to-DOM mapping; its `cursors.js` renders remote
presence. CRDT owns transport for both text and presence. Editor surfaces do not
need the legacy Cursors package or Selection's former HTML-string position APIs.

For loaded fields, `updateSelection` anchors and caches the selection synchronously
before returning its Promise. `crdt.getSelection({array, object, key})` synchronously
returns the current local `{anchor, head, start, end}`, `undefined` before capture
or while references are unresolved, and `null` after clearing. Optional `clientId`
and `frameId` select another participant. Editor can restore the cached local
selection after a remote edit without rereading its source position from the DOM.

`crdt.getSelections({array, object, key})` returns current resolved presence entries
in the same shape as the selection event, including cleared entries. This lets a
newly bound editor display presence already known to CRDT. Returned anchor and
metadata objects are copied. One offset index per replayed sequence serves all
participants, including tombstone anchors.

Incoming presence requires a valid participant/frame and a positive safe-integer
clock. Invalid presence is ignored without dropping an accompanying text operation.
