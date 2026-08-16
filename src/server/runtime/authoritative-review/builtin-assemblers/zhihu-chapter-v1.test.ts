import { describe, expect, it } from 'vitest';

import { assembleZhihuChapterV1, type ZhihuChapterAssemblerInputV1 } from './zhihu-chapter-v1';

export function zhihuAssemblerFixture(): ZhihuChapterAssemblerInputV1 {
  return {
    authority: {
      mapRef: { kind: 'map_snapshot', digest: 'a'.repeat(64), byteLength: 1, mediaType: 'application/json', schemaVersion: 1 },
      contentRevisionManifestRef: { kind: 'content_revision_manifest', digest: 'b'.repeat(64), byteLength: 1, mediaType: 'application/json', schemaVersion: 1 },
      templateSnapshotHash: 'template',
    },
    tree: [
      { slotId: 'root', parentSlotId: null, typeId: 'chapter', order: 0, contentPresence: 'unset', content: null },
      { slotId: 'title', parentSlotId: 'root', typeId: 'title', order: 0, contentPresence: 'set', content: '雨夜' },
      { slotId: 'opening', parentSlotId: 'root', typeId: 'opening', order: 1, contentPresence: 'set', content: '我在门口等。' },
      { slotId: 'scene', parentSlotId: 'root', typeId: 'scene_block', order: 2, contentPresence: 'set', content: '灯忽然灭了。' },
      { slotId: 'closure', parentSlotId: 'root', typeId: 'emotional_closure', order: 3, contentPresence: 'set', content: '原来告别很轻。' },
      { slotId: 'end', parentSlotId: 'root', typeId: 'chapter_end', order: 4, contentPresence: 'set', content: '天亮之前，我走了。' },
    ],
  };
}

describe('builtin Zhihu chapter v1 assembler', () => {
  it('produces the exact production route and markdown bytes', () => {
    expect(assembleZhihuChapterV1(zhihuAssemblerFixture())).toEqual([{
      routeId: 'chapter-markdown',
      artifactFile: 'chapter.md',
      mediaType: 'text/markdown',
      content: '# 雨夜\n\n我在门口等。\n\n灯忽然灭了。\n\n原来告别很轻。\n\n天亮之前，我走了。\n',
    }]);
  });

  it('fails closed for unset content and invalid chapter topology', () => {
    const unset = structuredClone(zhihuAssemblerFixture());
    unset.tree[1]!.contentPresence = 'unset';
    unset.tree[1]!.content = null;
    expect(() => assembleZhihuChapterV1(unset)).toThrow(/unset or invalid title/);
    expect(() => assembleZhihuChapterV1({ ...zhihuAssemblerFixture(), tree: [] })).toThrow(/exactly one chapter root/);
  });
});
