'use strict';

/**
 * forge-validator/v1 fixture implementation.
 *
 * Pure, deterministic validator: receives the frozen canonical JSON input
 * envelope scoped to its declared targets and returns the narrow
 * `{ pass, issues }` verdict. This fixture performs no business checks and
 * always passes; it exists to exercise contract compilation, resource
 * hashing and the resource manifest. The sandbox ABI conformance shape is
 * pinned by the runtime sandbox task.
 *
 * @param {unknown} envelope Read-only canonical JSON input envelope.
 * @returns {{ pass: boolean, issues: unknown[] }} Narrow verdict.
 */
module.exports = {
  validate(envelope) {
    return { pass: true, issues: [] };
  },
};
