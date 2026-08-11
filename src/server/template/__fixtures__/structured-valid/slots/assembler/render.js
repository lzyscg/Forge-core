'use strict';

/**
 * forge-assembler/v1 fixture implementation.
 *
 * Deterministic, pure renderer: receives the frozen sealed scaffold snapshot
 * plus explicit configuration and returns `{ routeId, content }[]` of UTF-8
 * text files, one entry per declared route. The sandbox ABI conformance shape
 * is pinned by the runtime sandbox task: the sandbox exposes
 * `module.exports.<exportName>` ('assemble'), so the implementation must be
 * an object whose `assemble` method is the ABI entry point.
 *
 * @param {unknown} input Read-only canonical JSON input envelope.
 * @returns {Array<{ routeId: string, content: string }>} UTF-8 text files.
 */
module.exports = {
  assemble(input) {
    return [{ routeId: 'document-md', content: '# Fixture document\n' }];
  },
};
