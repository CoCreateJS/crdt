/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://CoCreateJS.com/licenses/> or contact us at sales@CoCreateJS.com.

import crud from '@cocreate/crud-client';
import { ulid, ulidDecode } from '@cocreate/utils';
import localStorage from '@cocreate/local-storage';
import { prepareChange, replaySequence, inverseChange, textDiff } from './sequence.js';
import { anchorSelection, resolveSelection } from './selection.js';
import { assignRun, clearRun, reconcileRuns } from './runs.js';

/**
 * @typedef {Object} CRDTData
 * @property {string} array - The collection/array name.
 * @property {string} object - The document/object ID.
 * @property {string} key - The specific key/field being edited.
 * @property {string} [value] - The string value being inserted or updated.
 * @property {number} [start] - The starting index of the change.
 * @property {number} [length] - The length of the text being updated.
 * @property {string} [frameId] - The browser frame origin ID.
 * @property {string} [id] - The unique ULID for the change.
 */

const objects = Object.create(null);
// Read browser identity when creating an operation, after Socket Client initializes.
const getClientId = () => crud.socket.clientId;
const frameId = crud.socket.frameId;
let lastLocalId = '';
let selectionClock = 0;
function nextId(minimum = '') {
    const candidate = ulid();
    const floor = minimum > lastLocalId ? minimum : lastLocalId;
    if (candidate > floor) return (lastLocalId = candidate);
    // Advance logical time while keeping this client's random suffix. Incrementing
    // another client's complete ID could give two writers the same operation ID.
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const time = floor.slice(0, 10).split('');
    for (let i = time.length - 1; i >= 0; i--) {
        const next = alphabet.indexOf(time[i]) + 1;
        if (next < 32) {
            time[i] = alphabet[next];
            return (lastLocalId = time.join('') + candidate.slice(10));
        }
        time[i] = '0';
    }
    throw new Error('CRDT operation ID exhausted.');
}

const isRealtime = data => data.realtime === true || data.realtime === 'true';


/**
 * Pure helper function to replace String.prototype.customSplice.
 * Prevents global prototype pollution while allowing string mutation logic.
 *
 * @param {string} str - The original string.
 * @param {number} index - The zero-based index at which to start changing the string.
 * @param {number} count - The number of characters to remove.
 * @param {string} [add=""] - The string to insert.
 * @returns {string} The modified string.
 *
 * @example
 * spliceString("Hello World", 6, 5, "CRDT"); // Returns "Hello CRDT"
 * @private
 * @environment client
 */
function spliceString(str, index, count, add) {
    if (index < 0) {
        index = str.length + index;
        if (index < 0) index = 0;
    }
    return str.slice(0, index) + (add || "") + str.slice(index + Math.abs(count));
}

/**
 * Retrieves the internal CRDT tracking object for a specific field.
 * If it doesn't exist locally, it queries the database for the changelog.
 *
 * @param {CRDTData} data - The document tracking configuration.
 * @returns {Promise<Object|undefined>} The tracked object containing text and changelogs.
 * @private
 * @environment client
 */
async function getObject(data) {
    if (['_id', 'organization_id'].includes(data.key)) return;
    const name = getName(data);
    const object = objects[name] ||= {};
    if (object.loading) return object.loading;
    if (object.changeLog) return object;
    object.pendingChanges = [];
    object.loading = (async () => {
        let changeLog = [];
        if (!data.scope && data.read !== 'false' && !data.newObject) {
            const response = await crud.send({
                method: 'object.read', array: 'crdt',
                object: { filter: { query: { name }, limit: 1 } }
            });
            changeLog = response?.object?.[0]?.changeLog || [];
        }
        object.undoLog = new Map();
        object.redoLog = new Map();
        object.undoStack = [];
        object.redoStack = [];
        object.changeLog = [...new Map(changeLog.filter(Boolean).map(change => [change.id, { ...change }])).values()];
        if (data.scope && data.initialValue && !object.changeLog.length) {
            object.changeLog.push({
                id: nextId(), start: 0, length: 0, value: String(data.initialValue),
                type: 'insert', history: true, clientId: getClientId() || 'local',
                frameId: frameId || 'local'
            });
        }
        object.changeIds = new Set(object.changeLog.flatMap(change => [change.id, ...(change.seenIds || [])]));
        await generateText(data, true);
        for (const change of object.pendingChanges.splice(0)) receiveChange(change);
        return object;
    })();
    try { return await object.loading; }
    catch (error) { delete object.changeLog; throw error; }
    finally { delete object.loading; }
}

/**
 * Rebuilds the current text state from the changeLog.
 * Replays stable character identities and tombstones; old logs use positional replay.
 *
 * @param {CRDTData} data - The document tracking configuration.
 * @param {boolean} flag - Whether to fetch from DB if empty.
 * @returns {Promise<string>} The rebuilt text string.
 * @private
 * @environment client
 */
async function generateText(data, flag) {
    const object = objects[getName(data)];
    object.changeLog.sort((a, b) => a.id.localeCompare(b.id));
    object.sequence = replaySequence(object.changeLog);
    object.text = object.sequence.text;
    if (!data.scope && !object.changeLog.length && data.read !== 'false') {
        await checkDb(data, flag);
    }
    return object.text;
}

/**
 * Checks the database for the raw document value if no changelog is available.
 *
 * @param {CRDTData} data - The document tracking configuration.
 * @param {boolean|string} flag - Whether to insert the fetched text as a base change.
 * @returns {Promise<string>} The base text string.
 * @private
 * @environment client
 */
async function checkDb(data, flag) {
    let { array, object, key } = data;


    let string = '';
    if (data.newObject) {
        string = data.newObject;
    } else {
        let response = await crud.send({ method: 'object.read', array, object: { _id: object, key } });
        string = crud.getValueFromObject(response.object[0], key);
    }

    if (string && typeof string !== 'string') string = "";

    // Seed the CRDT with the existing string from the database
    if (string && typeof string === 'string' && flag !== false) {
        // Concurrent readers of the same uninitialized field must identify its
        // baseline characters identically. Scope and content determine this ID.
        const bytes = new TextEncoder().encode(JSON.stringify([array, object, key, string]));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        let suffix = '';
        for (let i = 0; i < 16; i++) suffix += alphabet[digest[i] & 31];
        insertChange({ ...data, id: '0000000000' + suffix, value: string,
            start: 0, length: 0, frameId, history: true });
    }

    return string || '';
}

/**
 * The core Collaborative Editing Engine.
 * Handles incoming characters, out-of-order resolution, and conflict management.
 *
 * @param {CRDTData} data - The payload containing the keystroke/change.
 *
 * @example
 * insertChange({ array: "users", object: "123", key: "bio", value: "A", start: 0 });
 * @private
 * @environment client
 */
function insertChange(data) {
    const { captureSelection, element, ...payloadData } = data;
    data = payloadData;
    const object = objects[getName(data)];
    if (!object?.changeLog) return false;
    const remote = !!data.frameId && data.frameId !== frameId;
    let change = {
        ...data,
        history: data.history,
        id: data.id || nextId(object.changeLog.at(-1)?.id), value: data.value || '', start: data.start,
        length: data.length || 0,
        clientId: remote ? data.clientId : getClientId() || (data.scope && 'local'),
        frameId: data.frameId || frameId || (data.scope && 'local'),
        user_id: data.user_id || localStorage.getItem('user_id'),
        type: data.value ? 'insert' : 'delete'
    };
    if (!Number.isInteger(change.start) || change.start < 0 ||
        !Number.isInteger(change.length) || change.length < 0 ||
        typeof change.value !== 'string') throw new RangeError('Invalid CRDT text operation.');
    if (!remote && !data.scope && !change.history && (!change.clientId || !change.frameId))
        throw new Error('Socket Client must initialize clientId and frameId before editing.');
    const log = object.changeLog;
    if (object.changeIds.has(change.id)) return false;
    if (change.format !== 2 && log[0]?.type === 'snapshot' && change.id <= log[0].id) {
        if (!remote) {
            const detail = { ...data, start: 0, length: object.text.length, value: object.text, string: object.text };
            if (element && !isRealtime(data))
                localChange({ ...detail, elements: [element] }, object.text);
            else if (isRealtime(data)) localChange(detail, object.text);
        }
        return false;
    }
    const before = object.text || '';
    if (!remote) {
        if (change.format !== 2) change = prepareChange(object.sequence, change);
        change = assignRun(object, change);
    }
    const nextLog = [...log, change].sort((a, b) => a.id.localeCompare(b.id));
    const sequence = replaySequence(nextLog);
    // Validate explicit post-edit selections before committing a text operation.
    if (data.selection !== undefined) {
        try {
            if (remote && !validSelectionSender(data)) throw new RangeError('Invalid selection sender.');
            anchorSelection(sequence, data.selection);
        } catch (error) {
            if (!remote) throw error;
            // Malformed ephemeral presence must not discard a valid text edit.
            data = { ...data };
            delete data.selection;
            delete data.selectionClock;
            delete change.selection;
            delete change.selectionClock;
        }
    }
    if (remote) reconcileRuns(object, sequence.operations.get(change.id) || change, object.sequence, sequence);
    object.changeIds.add(change.id);
    object.changeLog = nextLog;
    object.sequence = sequence;
    object.text = object.sequence.text;
    if (!remote) {
        if (data.undoOf || data.redoOf) {
            const from = data.undoOf ? object.undoStack : object.redoStack;
            const to = data.undoOf ? object.redoStack : object.undoStack;
            const index = from.indexOf(data.undoOf || data.redoOf);
            if (index >= 0) from.splice(index, 1);
            to.push(change.id);
        } else if (!data.history) {
            object.undoStack.push(change.id);
            object.redoStack.length = 0;
        }
    }
    // Apply text first so editor adapters can report the actual resulting selection.
    const payload = { ...data, ...change };
    const detail = { ...payload, ...textDiff(before, object.text), operation: change,
        string: object.text };
    if (element && !remote && !isRealtime(data))
        localChange({ ...detail, elements: [element] }, object.text);
    else if (remote || isRealtime(data)) localChange(detail, object.text);
    let selection = data.selection;
    if (!remote && captureSelection) {
        // An adapter failure must never prevent an already-applied edit reaching peers.
        try { selection = anchorSelection(object.sequence, captureSelection()); }
        catch (error) { console.error('Unable to capture CRDT selection:', error); }
    }
    if (selection !== undefined) {
        payload.selection = anchorSelection(object.sequence, selection);
        payload.selectionClock = remote ? data.selectionClock : ++selectionClock;
        change.selection = payload.selection;
        change.selectionClock = payload.selectionClock;
        rememberSelection(object, payload);
    }
    if (!remote && isRealtime(data)) broadcastChange(payload);
    if (remote || isRealtime(data)) publishSelections(object);
    if (!remote && isRealtime(data) && data.save !== 'false') persistChange(data, change);
    return true;
}

/**
 * Broadcasts a local change to other connected browser clients via WebSocket.
 *
 * @param {CRDTData} data - The change payload.
 * @private
 * @environment client
 */
function broadcastChange(data) {
    crud.socket.send({
        method: "crdt",
        broadcastSender: false,
        broadcastClient: true,
        data
    });
}

/**
 * Dispatches a DOM event to update the local UI (e.g., input fields, textareas).
 *
 * @param {CRDTData} data - The change payload.
 * @param {string} string - The newly calculated full text string.
 * @private
 * @environment client
 */
function localChange(data, string) {
    const localChange = new CustomEvent('cocreate-crdt-update', {
        detail: { ...data, string },
    });
    window.dispatchEvent(localChange);
}

/**
 * Saves the changeLog operation to the backend database for permanent storage.
 *
 * @param {CRDTData} data - The change payload.
 * @param {Object} change - The generated ULID change object.
 * @private
 * @environment client
 */
function persistChange(data, change) {
    let name = getName(data);
    let Data = {
        method: 'object.update',
        array: 'crdt',
        object: {
            name,
            '$push.changeLog': change,
            crud: {
                array: data.array,
                object: data.object,
                key: data.key
            }
        },
        filter: {
            query: { name },
            limit: 1
        },
        upsert: true,
        namespace: data.namespace,
        room: data.room,
        broadcast: data.broadcast,
        broadcastSender: data.broadcastSender,
        broadcastClient: false,
        metadata: 'crdt-change'
    };

    crud.send(Data);
}

// WebSocket listener for incoming remote CRDT changes
crud.socket.listen('crdt', function (response) {
    let data = { ...response.data, socketId: response.socketId || response.data.socketId };
    let name = getName(data);
    let object = objects[name];

    if (object) {
        // Only insert if it originated from a different frame/browser
        if (data.frameId !== frameId) {
            if (object.loading) object.pendingChanges.push({ ...data });
            else receiveChange({ ...data });
        }
    }
});

function receiveChange(data) {
    if (data.type === 'selection') {
        const object = objects[getName(data)];
        if (object?.sequence) {
            if (rememberSelection(object, data)) publishSelections(object);
        }
    } else insertChange(data);
}

function validSelectionSender(data) {
    return typeof data.clientId === 'string' && !!data.clientId &&
        typeof data.frameId === 'string' && !!data.frameId &&
        Number.isSafeInteger(data.selectionClock) && data.selectionClock > 0;
}

function rememberSelection(object, data) {
    if (!validSelectionSender(data)) return false;
    object.selections ||= new Map();
    const sender = JSON.stringify([data.clientId, data.frameId]);
    const previous = object.selections.get(sender);
    if (previous && previous.selectionClock >= data.selectionClock) return false;
    try {
        object.selections.set(sender, { ...data,
            selection: anchorSelection(object.sequence, data.selection),
            presence: data.presence ? { ...data.presence } : undefined });
        return true;
    } catch {
        return false;
    }
}

/** Current presence, resolved against the latest committed source. No DOM access.  * @public
 * @environment client
 */
function getSelections(data) {
    const object = objects[getName(data)];
    if (!object?.sequence) return [];
    return selectionDetails(object);
}

function selectionDetails(object) {
    const result = [];
    for (const data of object.selections?.values() || []) {
        const resolved = resolveSelection(object.sequence, data.selection);
        if (resolved === undefined) continue;
        result.push({ array: data.array, object: data.object, key: data.key,
            clientId: data.clientId, frameId: data.frameId, socketId: data.socketId,
            selection: anchorSelection(object.sequence, data.selection), resolved,
            presence: data.presence ? { ...data.presence } : undefined });
    }
    return result;
}

/** Cached local selection; undefined until reported, null after clearing.  * @public
 * @environment client
 */
function getSelection(data) {
    const object = objects[getName(data)];
    const sender = JSON.stringify([data.clientId ?? getClientId(), data.frameId ?? frameId]);
    const entry = object?.selections?.get(sender);
    return entry ? resolveSelection(object.sequence, entry.selection) : undefined;
}

function publishSelections(object) {
    for (const detail of selectionDetails(object)) {
        window.dispatchEvent(new CustomEvent('cocreate-crdt-selection', {
            detail
        }));
    }
}

/** Share selection without modifying text, history, or persisted document data.  * @public
 * @environment client
 */
async function updateSelection(data) {
    // Loaded fields anchor immediately, before a remote edit can change offsets.
    let object = objects[getName(data)];
    if (!object?.sequence || object.loading) object = await getObject(data);
    if (!object) return;
    if (isRealtime(data) && (!getClientId() || !frameId))
        throw new Error('Socket Client must initialize before sharing selection.');
    const payload = { array: data.array, object: data.object, key: data.key,
        clientId: getClientId() || 'local', frameId: frameId || 'local',
        realtime: data.realtime, type: 'selection', presence: data.presence,
        selection: anchorSelection(object.sequence, data.selection) };
    const previous = object.selections?.get(JSON.stringify([payload.clientId, payload.frameId]));
    const samePosition = previous && JSON.stringify(previous.selection) === JSON.stringify(payload.selection);
    if (samePosition && JSON.stringify(previous.presence) === JSON.stringify(payload.presence)) return;
    payload.selectionClock = ++selectionClock;
    if (!samePosition) clearRun(object, payload.clientId, payload.frameId);
    rememberSelection(object, payload);
    if (isRealtime(data)) {
        broadcastChange(payload);
        publishSelections(object);
    }
}

/**
 * Syncs entire CRDT states from a remote source, often used for initial connection.
 *
 * @param {Object} data - The sync payload from the server.
 * @private
 * @environment client
 */
function sync(data) {
    if (data.clientId === getClientId()) return;

    if (data.array.includes('crdt')) {
        if (data.object && data.object[0]) {
            let Data = data.object[0];
            let name = Data.name;
            let object = objects[name];

            if (object && Data.crud) {
                Data.crud.value = Data.text;
                Data.crud.start = 0;
                Data.crud.length = object['text'].length;

                object['changeLog'] = Data.changeLog;
                object['text'] = Data.text;

                localChange(Data.crud, Data.text);
                console.log('crdtSync');
            }
        }
    }
}

/**
 * Helper to fetch the current full text of a tracked field.
 *
 * @param {CRDTData} data - The document tracking configuration.
 * @returns {Promise<string>} The current text value.
 * @public
 * @environment client
 */
async function getText(data) {
    const object = await getObject(data);
    return object?.text;
}

/**
 * Replaces the entire contents of the text state with a new string.
 * Used for copy/paste or programmatic overwrites.
 *
 * @param {CRDTData} data - Payload containing the new replacement string.
 * @public
 * @environment client
 */
async function replaceText(data) {
    const object = await getObject(data);
    if (!object) return;
    return updateText({ ...data, start: 0, length: object.text.length, runBreak: true, runEnd: true });
}

/**
 * Wraps insertChange and additionally broadcasts a standard object update
 * for systems not listening to raw CRDT streams.
 *
 * @param {CRDTData} data - The change payload.
 * @public
 * @environment client
 */
async function updateText(data) {
    let object = await getObject(data);
    if (object) {
        if (!insertChange({ ...data })) return;

        if (isRealtime(data) && data.crud !== 'false' && data.save !== 'false') {
            if (data.upsert === undefined) data.upsert = true;

            let wholestring = await getText(data);
            return crud.send({
                method: 'object.update',
                array: data.array,
                object: {
                    _id: data.object,
                    [data.key]: wholestring
                },
                upsert: data.upsert,
                namespace: data.namespace,
                room: data.room,
                broadcast: data.broadcast,
                broadcastSender: false,
                broadcastClient: true,
                metadata: 'crdt-updateobject'
            });
        }
    }
}

/**
 * Inverts an operation to facilitate undo functionality.
 * A deletion becomes an insertion, and an insertion becomes a deletion.
 *
 * @param {CRDTData} data - The data context.
 * @param {Object} change - The change object to invert.
 * @returns {Object} An object containing the inverted data and change payloads.
 * @private
 * @environment client
 */
function createChange(data, object, change) {
    return inverseChange(object.sequence, object.sequence.operations.get(change.id) || change,
        nextId(object.changeLog.at(-1)?.id), data);
}

/** Undo only characters and deletion markers owned by a local edit.  * @public
 * @environment client
 */
async function undoText(data) {
    const object = await getObject(data);
    const id = object?.undoStack.at(-1);
    if (!id) return;
    const change = object.changeLog.find(entry => entry.id === id);
    if (!change) return;
    const inverse = createChange(data, object, change);
    return updateText({ ...inverse, undoOf: id });
}

/** Redo by inverting the previous undo operation.  * @public
 * @environment client
 */
async function redoText(data) {
    const object = await getObject(data);
    const id = object?.redoStack.at(-1);
    if (!id) return;
    const change = object.changeLog.find(entry => entry.id === id);
    if (!change) return;
    const inverse = createChange(data, object, change);
    return updateText({ ...inverse, redoOf: id });
}

/**
 * Reconstructs the document state up to a specific historical version index.
 * Useful for time-travel debugging and version history viewing.
 *
 * @param {CRDTData} data - Contains version number target.
 * @returns {Promise<Object>} The rebuilt document state at that point in time.
 * @private
 * @environment client
 */
async function viewVersion(data) {
    try {
        let name = getName(data);
        let object = objects[name];
        let changeLog = object.changeLog;
        const sortedLog = [...changeLog].sort((a, b) => a.id.localeCompare(b.id));
        const log = data.version !== undefined ? sortedLog.slice(0, data.version) : sortedLog;
        const string = replaySequence(log).text;

        data.value = string;
        return data;
    } catch (e) {
        console.error(e);
    }
}

/**
 * Intelligent Garbage Collection & Log Compaction (Watermark Strategy).
 * Compresses history safely by respecting active users' last known states,
 * falling back to a time limit for inactive users.
 *
 * @param {CRDTData} data - The document tracking configuration.
 * @param {number} [countThreshold=5000] - Minimum log size before triggering snapshot.
 * @param {number} [timeGracePeriodMs=604800000] - 7 days in ms. Older offline users lose their anchor.
 * @returns {Promise<Array|undefined>} The newly compressed changelog.
 * @private
 * @environment client
 */
async function createSnapshot(data, countThreshold = 5000, timeGracePeriodMs = 7 * 24 * 60 * 60 * 1000) {
    let name = getName(data);
    let object = objects[name];

    // Only compress if the log is large enough to warrant it
    if (!object || !object.changeLog || object.changeLog.length < countThreshold) return;

    object.changeLog.sort((a, b) => a.id.localeCompare(b.id));

    const now = Date.now();
    const latestUserChanges = new Map();

    // 1. Find the high-water mark (latest change) for each unique user
    for (let i = 0; i < object.changeLog.length; i++) {
        let change = object.changeLog[i];
        if (change && change.type !== 'snapshot') {
            let identifier = change.user_id || change.clientId || 'system';
            // Overwrites previous entries, leaving only the very last known index per user
            latestUserChanges.set(identifier, { index: i, timestamp: ulidDecode(change.id) });
        }
    }

    // 2. Determine the safe boundary for compression.
    let safeCompressionIndex = object.changeLog.length - 1;

    for (const [userId, record] of latestUserChanges.entries()) {
        let isStale = (now - record.timestamp) > timeGracePeriodMs;
        if (!isStale) {
            // User is active! We must protect their last known anchor point.
            if (record.index < safeCompressionIndex) {
                safeCompressionIndex = record.index;
            }
        }
    }

    const snapshotIndex = object.changeLog.findLastIndex(change => change.type === 'snapshot');
    if (safeCompressionIndex <= 0 || safeCompressionIndex <= snapshotIndex) return;

    // 3. Split the log at the safe boundary
    let logToCompress = object.changeLog.slice(0, safeCompressionIndex);
    let retainedLog = object.changeLog.slice(safeCompressionIndex);

    const prefix = replaySequence(logToCompress);
    const lastCompressedChange = logToCompress[logToCompress.length - 1];
    const snapshotChange = {
        id: lastCompressedChange.id, type: 'snapshot', format: 2,
        value: prefix.text, start: 0, length: 0, clientId: getClientId(), frameId,
        sequence: [...prefix.nodes.values()].map(node => ({ ...node, deletedBy: [...node.deletedBy] })),
        seenIds: [...prefix.seenIds], version: true
    };
    object.changeLog = [snapshotChange, ...retainedLog];
    object.changeIds = new Set([...prefix.seenIds, snapshotChange.id, ...retainedLog.map(change => change.id)]);
    object.sequence = replaySequence(object.changeLog);
    object.text = object.sequence.text;
    object.undoStack.length = 0;
    object.redoStack.length = 0;

    // 5. Persist the newly compressed array to the database
    if (isRealtime(data) && data.save !== "false") {
        crud.send({
            method: 'object.update',
            array: 'crdt',
            object: {
                name,
                '$push.changeLog': snapshotChange,
                crud: { array: data.array, object: data.object, key: data.key }
            },
            filter: { query: { name }, limit: 1 },
            upsert: true,
            metadata: 'crdt-snapshot'
        });
    }

    return object.changeLog;
}

/**
 * Helper to generate a unique string key representing a specific tracked document field.
 *
 * @param {CRDTData} data - The routing payload.
 * @returns {string} Concatenated namespace/document/key string.
 * @private
 * @environment client
 */
function getName(data) {
    const name = `${data.array}${data.object}${data.key}`;
    return data.scope ? `${name}\0${data.scope}` : name;
}

/** End the current local typing run after an explicit caret move, blur or action.  * @public
 * @environment client
 */
function endRun(data) {
    clearRun(objects[getName(data)], getClientId() || (data.scope && 'local'),
        frameId || (data.scope && 'local'));
}

export default { getText, updateText, replaceText, undoText, redoText, updateSelection, getSelection, getSelections, endRun };

/**
 * CoCreate crdt
 *
 * @module crdt
 * @environment client
 */
