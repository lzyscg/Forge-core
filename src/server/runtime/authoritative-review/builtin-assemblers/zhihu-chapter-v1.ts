/**
 * The production v2 Zhihu chapter assembler.  It is intentionally a small,
 * total function: no imports, process state, clock, random source or I/O.
 * The registry calls it twice over isolated canonical clones and compares the
 * exact returned bytes before those bytes may become authoritative.
 */

export interface ZhihuChapterAssemblerNodeV1 {
  slotId: string;
  parentSlotId: string | null;
  typeId: string;
  order: number;
  contentPresence: 'unset' | 'set';
  content: string | null;
}

export interface ZhihuChapterAssemblerInputV1 {
  authority: {
    mapRef: { kind: string; digest: string; byteLength: number; mediaType: string; schemaVersion: number };
    contentRevisionManifestRef: { kind: string; digest: string; byteLength: number; mediaType: string; schemaVersion: number };
    templateSnapshotHash: string;
  };
  tree: readonly ZhihuChapterAssemblerNodeV1[];
}

export interface ZhihuChapterAssemblerOutputV1 {
  routeId: 'chapter-markdown';
  artifactFile: 'chapter.md';
  mediaType: 'text/markdown';
  content: string;
}

/**
 * Checked-in normalized implementation source identity.  This is deliberately
 * not Function#toString (which changes between tsx/vitest/transpilers).  Any
 * semantic edit to the implementation must update this LF-only UTF-8 body,
 * making the profile rotation explicit and reviewable.
 */
export const ZHIHU_CHAPTER_ASSEMBLER_CANONICAL_SOURCE = `(input) => {
  if (!input || !Array.isArray(input.tree)) throw new Error('assembler input did not contain a scaffold tree');
  const requiredContent = (node, label) => {
    if (!node || node.contentPresence !== 'set' || typeof node.content !== 'string') {
      throw new Error('cannot assemble unset or invalid ' + label + ' slot');
    }
    return node.content;
  };
  const roots = input.tree.filter((node) => node.parentSlotId === null && node.typeId === 'chapter');
  if (roots.length !== 1) throw new Error('assembler requires exactly one chapter root');
  const root = roots[0];
  const children = input.tree.filter((node) => node.parentSlotId === root.slotId).sort((a, b) => a.order - b.order || (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0));
  if (children.length < 5 || children.length > 20) throw new Error('assembler received an invalid chapter child count');
  if (children[0]?.typeId !== 'title' || children[1]?.typeId !== 'opening') throw new Error('assembler received an invalid chapter prefix');
  if (children.at(-2)?.typeId !== 'emotional_closure' || children.at(-1)?.typeId !== 'chapter_end') throw new Error('assembler received an invalid chapter suffix');
  const scenes = children.slice(2, -2);
  if (scenes.length < 1 || scenes.length > 16 || scenes.some((node) => node.typeId !== 'scene_block')) throw new Error('assembler received an invalid scene sequence');
  const content = '# ' + requiredContent(children[0], 'title') + '\\n\\n' + [requiredContent(children[1], 'opening'), ...scenes.map((node) => requiredContent(node, 'scene_block')), requiredContent(children.at(-2), 'emotional_closure'), requiredContent(children.at(-1), 'chapter_end')].join('\\n\\n') + '\\n';
  return [{ routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content }];
}`;

function requiredContent(node: ZhihuChapterAssemblerNodeV1 | undefined, label: string): string {
  if (node === undefined || node.contentPresence !== 'set' || typeof node.content !== 'string') {
    throw new Error(`cannot assemble unset or invalid ${label} slot`);
  }
  return node.content;
}

export function assembleZhihuChapterV1(
  input: ZhihuChapterAssemblerInputV1,
): readonly ZhihuChapterAssemblerOutputV1[] {
  if (!Array.isArray(input.tree)) throw new Error('assembler input did not contain a scaffold tree');
  const roots = input.tree.filter((node) => node.parentSlotId === null && node.typeId === 'chapter');
  if (roots.length !== 1) throw new Error('assembler requires exactly one chapter root');

  const root = roots[0]!;
  const children = input.tree
    .filter((node) => node.parentSlotId === root.slotId)
    .sort((a, b) => a.order - b.order || (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0));
  if (children.length < 5 || children.length > 20) {
    throw new Error('assembler received an invalid chapter child count');
  }
  if (children[0]?.typeId !== 'title' || children[1]?.typeId !== 'opening') {
    throw new Error('assembler received an invalid chapter prefix');
  }
  if (children.at(-2)?.typeId !== 'emotional_closure' || children.at(-1)?.typeId !== 'chapter_end') {
    throw new Error('assembler received an invalid chapter suffix');
  }
  const scenes = children.slice(2, -2);
  if (scenes.length < 1 || scenes.length > 16 || scenes.some((node) => node.typeId !== 'scene_block')) {
    throw new Error('assembler received an invalid scene sequence');
  }
  const content = `# ${requiredContent(children[0], 'title')}\n\n${[
    requiredContent(children[1], 'opening'),
    ...scenes.map((node) => requiredContent(node, 'scene_block')),
    requiredContent(children.at(-2), 'emotional_closure'),
    requiredContent(children.at(-1), 'chapter_end'),
  ].join('\n\n')}\n`;
  return [{ routeId: 'chapter-markdown', artifactFile: 'chapter.md', mediaType: 'text/markdown', content }];
}
