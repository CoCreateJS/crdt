# CoCreate-crdt

CoCreate crdt Take it for a spin in our [playground!](https://cocreate.app/docs/crdt)

![minified](https://img.badgesize.io/https://cdn.cocreate.app/crdt/latest/CoCreate-crdt.min.js?style=flat-square&label=minified&color=orange)
![gzip](https://img.badgesize.io/https://cdn.cocreate.app/crdt/latest/CoCreate-crdt.min.js?compression=gzip&style=flat-square&label=gzip&color=yellow)
![brotli](https://img.badgesize.io/https://cdn.cocreate.app/crdt/latest/CoCreate-crdt.min.js?compression=brotli&style=flat-square&label=brotli)
![GitHub latest release](https://img.shields.io/github/v/release/CoCreate-app/CoCreate-crdt?style=flat-square)
![GitHub contributors](https://img.shields.io/github/contributors/CoCreate-app/CoCreate-crdt?style=flat-square)
![License](https://img.shields.io/static/v1?style=flat-square&label=license&message=AGPL-3.0&color=green)
![Hiring](https://img.shields.io/static/v1?style=flat-square&label=&message=Hiring&color=blueviolet)

![CoCreate-crdt](https://cdn.cocreate.app/docs/CoCreate-crdt.gif)

## [Docs & Demo](https://cocreate.app/docs/crdt)

For a complete guide and working demo refer to the [doumentation](https://cocreate.app/docs/crdt)

## CDN

```html
<script src="https://cdn.cocreate.app/crdt/latest/CoCreate-crdt.min.js"></script>
```

```html
<script src="https://cdn.cocreate.app/crdt/latest/CoCreate-crdt.min.css"></script>
```

## NPM

```shell
$ npm i @cocreate/crdt
```

## yarn

```shell
$ yarn install @cocreate/crdt
```

# Table of Contents

-   [Table of Contents](#table-of-contents)
-   [Announcements](#announcements)
-   [Roadmap](#roadmap)
-   [How to Contribute](#how-to-contribute)
-   [About](#about)
-   [License](#license)

<a name="announcements"></a>

# Announcements

All updates to this library are documented in our [CHANGELOG](https://github.com/CoCreate-app/CoCreate-crdt/blob/master/CHANGELOG.md) and [releases](https://github.com/CoCreate-app/CoCreate-crdt/releases). You may also subscribe to email for releases and breaking changes.

<a name="roadmap"></a>

# Roadmap

If you are interested in the future direction of this project, please take a look at our open [issues](https://github.com/CoCreate-app/CoCreate-crdt/issues) and [pull requests](https://github.com/CoCreate-app/CoCreate-crdt/pulls). We would love to hear your feedback.

<a name="about"></a>

# About

CoCreate-crdt is guided and supported by the CoCreate Developer Experience Team.

Please Email the Developer Experience Team [here](mailto:develop@cocreate.app) in case of any queries.

CoCreate-crdt is maintained and funded by CoCreate. The names and logos for CoCreate are trademarks of CoCreate, LLC.

<a name="contribute"></a>

# How to Contribute

We encourage contribution to our libraries (you might even score some nifty swag), please see our [CONTRIBUTING](https://github.com/CoCreate-app/CoCreate-crdt/blob/master/CONTRIBUTING.md) guide for details.

We want this library to be community-driven, and CoCreate led. We need your help to realize this goal. To help make sure we are building the right things in the right order, we ask that you create [issues](https://github.com/CoCreate-app/CoCreate-crdt/issues) and [pull requests](https://github.com/CoCreate-app/CoCreate-crdt/pulls) or merely upvote or comment on existing issues or pull requests.

We appreciate your continued support, thank you!

<a name="license"></a>

# License

This software is dual-licensed under the GNU Affero General Public License version 3 (AGPLv3) and a commercial license.

-   **Open Source Use**: For open-source projects and non-commercial use, this software is available under the AGPLv3. The AGPLv3 allows you to freely use, modify, and distribute this software, provided that all modifications and derivative works are also licensed under the AGPLv3. For the full license text, see the [LICENSE file](https://github.com/CoCreate-app/CoCreate-crdt/blob/master/LICENSE).

-   **Commercial Use**: For-profit companies and individuals intending to use this software for commercial purposes must obtain a commercial license. The commercial license is available when you sign up for an API key on our [website](https://cocreate.app). This license permits proprietary use and modification of the software without the copyleft requirements of the AGPLv3. It is ideal for integrating this software into proprietary commercial products and applications.

If you have not purchased a commercial license and intend to use this software for commercial purposes, you are required to sign up for an API key on our website.


## Identity-based operation tracking

Run `npm test` for isolated operation-engine tests with mocked transport and
storage. New edits use operation format 2. The public `start`, `length`, and
`value` interface still accepts JavaScript UTF-16 offsets, but each outgoing edit
also captures:

- Stable identities for the exact characters being deleted (`targets`).
- The deleted text (`removedValue`).
- Left/right neighbor identities and neighboring character values.
- Stable identities for inserted characters, derived from operation ID and offset.

Replay uses an anchored sequence with retained deletion markers. Two clients
that both delete the same character therefore delete that identity twice, rather
than deleting the next surviving character. Character values and neighboring
text provide context, but are not used to guess which repeated character an
operation meant. Concurrent insertion runs have deterministic ordering and remain
contiguous. Operations whose anchor has not arrived remain pending in the sequence
until that anchor arrives.

Undo deletes only the characters created by its edit and removes only that edit's
deletion markers. Another user's deletions and insertions remain intact. Redo
inverts the undo operation. Text update events include the canonical `string`, a
splice against the current visible text, and the original identity `operation`.
Existing input/textarea consumers can therefore continue applying visible splices.

Snapshots retain character identities, deleted anchors, deletion markers and
processed operation IDs. Late identity edits can still target retained anchors.
Snapshot persistence appends a checkpoint rather than replacing the stored log,
so concurrent appends are not overwritten. Physical history/tombstone garbage
collection is not implemented; the server history remains append-only.

Simultaneous readers of the same uninitialized database field derive identical
baseline IDs from the field scope and text, using SHA-256 through Web Crypto.
Different initial field values still require application/server reconciliation.

### Compatibility and limits

All actively collaborating clients must be updated together to use format 2.
Historical positional logs remain readable and are assigned deterministic
identities during replay. The original author intent of already recorded,
concurrent positional operations cannot be recovered after the fact. Old clients
will not correctly interpret identity-based deletes, restores, or snapshots.

Existing storage keys concatenate array/object/key; changing that format still
needs a migration to remove potential key collisions. Identity metadata is
retained for correctness and will grow with editing history. Large-document
performance and safe physical garbage collection need further work.

The tests cover concurrent deletes, repeated characters, concurrent insert/delete
and replacement, selective undo, out-of-order and duplicate delivery, bootstrap,
snapshot/reload, Unicode offsets and multi-writer convergence. They do not prove
every possible schedule or test production transport, browser rendering, cursor
mapping, authorization or persistence failure recovery. These changes do not
modify CoCreate-text's DOM rendering or wire Markdown to CRDT automatically.

## Typing runs

See [the typing run contract](docs/operations.md). Concurrent runs at the same
anchor are ordered by persisted `clientId`, then by their first operation's ID
(`runId`) for runs from the same browser. No user ID, server election or new random
run identifier participates. Insertion anchors preserve deliberate placement in
already-observed content.

Consecutive insertion-only operations continue a run when the next position and
last character anchor both match. CRDT automatically ends it on a position break
or an incoming edit that shifts or interrupts the run. `endRun({ array, object,
key })` is optional for semantic boundaries without text operations, such as blur
or submit. The optional boolean flags `runBreak` and
`runEnd` establish boundaries on a particular edit. Run metadata persists with
operations and snapshots. Local editing requires Socket Client to have initialized
its `clientId` and `frameId`.
