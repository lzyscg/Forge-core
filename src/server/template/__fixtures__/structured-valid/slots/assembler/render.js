'use strict';

/**
 * forge-assembler/v1 fixture implementation.
 *
 * Deterministic, pure renderer: receives the frozen sealed scaffold snapshot
 * plus explicit configuration and returns `{ routeId, content }[]` of UTF-8
 * text files, one entry per declared route. The sandbox ABI conformance shape
 * is pinned by the runtime sandbox task.
 *
 * @param {unknown} input Read-only canonical JSON input envelope.
 * @returns {Array<{ routeId: string, content: string }>} UTF-8 text files.
 */
module.exports = function render(input) {
  return [{ routeId: 'document-md', content: '# Fixture document\n' }];
};
