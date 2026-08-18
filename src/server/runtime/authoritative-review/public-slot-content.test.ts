// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type { ContentValueV2, SlotContentVersionV2 } from '../../authoritative-review/authority-types';
import { publicSlotContentDetail } from './public-slot-content';

const versionRef: BlobRefV2 = {
  kind: 'content_version',
  digest: 'a'.repeat(64),
  byteLength: 1,
  mediaType: 'application/json',
  schemaVersion: 1,
};

const valueRef: BlobRefV2 = {
  kind: 'content_value',
  digest: 'b'.repeat(64),
  byteLength: 1,
  mediaType: 'application/json',
  schemaVersion: 1,
};

describe('publicSlotContentDetail', () => {
  it('returns a bounded preview and preserves the authoritative version identity', () => {
    const version = {
      state: 'set',
      slotId: 'slot-1',
      slotRevision: 2,
      contentDigest: 'c'.repeat(64),
      taskContentRevision: 3,
      mapRef: { ...versionRef, kind: 'map_snapshot' },
      mapSemanticDigest: 'd'.repeat(64),
      contentSchemaDigest: 'schema',
      blobRef: valueRef,
      provenance: { kind: 'agent', agentId: 'writer', workItemId: 'wi-1', attemptId: 'att-1' },
    } as unknown as SlotContentVersionV2;
    const contentValue = {
      slotId: 'slot-1',
      contentSchemaDigest: 'schema',
      taskContentRevision: 3,
      mediaType: 'text/markdown',
      text: '0123456789',
      selfDigest: 'e'.repeat(64),
    } as ContentValueV2;

    expect(publicSlotContentDetail({
      manifestPhase: 'finalized',
      versionRef,
      version,
      contentValue,
      maxTextLength: 4,
    })).toEqual({
      state: 'set',
      slotRevision: 2,
      taskContentRevision: 3,
      manifestPhase: 'finalized',
      versionRef,
      contentValueRef: valueRef,
      contentDigest: 'c'.repeat(64),
      mediaType: 'text/markdown',
      text: '0123',
      textLength: 10,
      truncated: true,
    });
  });

  it('makes an unset version explicit without inventing content', () => {
    const version = {
      state: 'unset',
      slotId: 'slot-1',
      slotRevision: 0,
      taskContentRevision: 1,
      mapRef: { ...versionRef, kind: 'map_snapshot' },
      mapSemanticDigest: 'd'.repeat(64),
      contentSchemaDigest: 'schema',
      unsetReason: 'initial',
      unsetProvenance: { kind: 'created_empty' },
    } as unknown as SlotContentVersionV2;

    expect(publicSlotContentDetail({
      manifestPhase: 'baseline_unset',
      versionRef,
      version,
      contentValue: null,
    })).toMatchObject({
      state: 'unset',
      contentValueRef: null,
      contentDigest: null,
      text: null,
      textLength: 0,
      truncated: false,
    });
  });
});
