import type { AuthoritativeSlotContentDetailV2, BlobRefV2 } from '../../../shared/authoritative-review-v2';
import type {
  ContentRevisionManifestPhaseV2,
  ContentValueV2,
  SlotContentVersionV2,
} from '../../authoritative-review/authority-types';

export const PUBLIC_SLOT_CONTENT_PREVIEW_MAX = 20_000;

export function publicSlotContentDetail(input: {
  manifestPhase: ContentRevisionManifestPhaseV2;
  versionRef: BlobRefV2;
  version: SlotContentVersionV2;
  contentValue: ContentValueV2 | null;
  maxTextLength?: number;
}): AuthoritativeSlotContentDetailV2 {
  const { version } = input;
  if (version.state === 'set' && input.contentValue === null) {
    throw new Error(`missing content value for set slot ${version.slotId}`);
  }
  const contentValue = version.state === 'set' ? input.contentValue : null;
  const text = contentValue?.text ?? null;
  const textLength = text?.length ?? 0;
  const maxTextLength = input.maxTextLength ?? PUBLIC_SLOT_CONTENT_PREVIEW_MAX;
  const truncated = text !== null && textLength > maxTextLength;
  return {
    state: version.state,
    slotRevision: version.slotRevision,
    taskContentRevision: version.taskContentRevision,
    manifestPhase: input.manifestPhase,
    versionRef: input.versionRef,
    contentValueRef: version.state === 'set' ? version.blobRef : null,
    contentDigest: version.state === 'set' ? version.contentDigest : null,
    mediaType: contentValue?.mediaType ?? null,
    text: text === null ? null : text.slice(0, maxTextLength),
    textLength,
    truncated,
  };
}
