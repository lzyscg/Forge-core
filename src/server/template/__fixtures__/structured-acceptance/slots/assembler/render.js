'use strict';

/**
 * forge-assembler/v1 acceptance fixture implementation.
 *
 * Deterministic, pure renderer: receives the frozen sealed scaffold snapshot
 * (canonical JSON envelope) and returns `{ routeId, content }[]` of UTF-8
 * text files, one entry per declared route. This acceptance renderer DERIVES
 * its output from the sealed scaffold content — the title slot becomes the
 * H1, and the first filled body slot becomes the body paragraph — so an
 * acceptance run can assert that the final artifact content derives from the
 * sealed scaffold (spec §12: the Assembler is the only producer of create
 * files, and the SealRecord content identity hashes this canonical input).
 *
 * The envelope shape is pinned by the runtime sandbox ABI conformance task:
 * `input.tree` is the depth-first pre-order slot projection array, each entry
 * `{ slotId, parentSlotId, order, typeId, spec, contentPresence, content, path }`.
 *
 * @param {unknown} input Read-only canonical JSON input envelope.
 * @returns {Array<{ routeId: string, content: string }>} UTF-8 text files.
 */
module.exports = {
  assemble(input) {
    var tree = Array.isArray(input && input.tree) ? input.tree : [];
    var title = '';
    var body = '';
    for (var i = 0; i < tree.length; i += 1) {
      var slot = tree[i];
      if (slot && slot.contentPresence === 'set' && typeof slot.content === 'string') {
        if (slot.typeId === 'title' && title === '') {
          title = slot.content;
        } else if (slot.typeId === 'body' && body === '') {
          body = slot.content;
        }
      }
    }
    var lines = [];
    if (title !== '') {
      lines.push('# ' + title);
    }
    if (body !== '') {
      lines.push('');
      lines.push(body);
    }
    if (lines.length === 0) {
      lines.push('# Fixture document');
    }
    return [{ routeId: 'document-md', content: lines.join('\n') + '\n' }];
  },
};

