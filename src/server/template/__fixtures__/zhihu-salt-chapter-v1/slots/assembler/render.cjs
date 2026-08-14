'use strict';

function requiredContent(node, label) {
  if (!node || typeof node !== 'object') {
    throw new Error('cannot assemble empty ' + label + ' slot');
  }
  if (node.contentPresence !== 'set') return '';
  if (typeof node.content !== 'string') throw new Error('cannot assemble invalid ' + label + ' slot');
  return node.content;
}

function assemble(input) {
  if (!input || !Array.isArray(input.tree)) {
    throw new Error('assembler input did not contain a scaffold tree');
  }
  var roots = input.tree.filter(function (node) { return node && node.parentSlotId === null && node.typeId === 'chapter'; });
  if (roots.length !== 1) {
    throw new Error('assembler requires exactly one chapter root');
  }

  var root = roots[0];
  var children = input.tree
    .filter(function (node) { return node && node.parentSlotId === root.slotId; })
    .sort(function (a, b) { return a.order - b.order; });
  if (children.length < 5 || children.length > 20) {
    throw new Error('assembler received an invalid chapter child count');
  }

  var title = requiredContent(children[0], 'title');
  var opening = requiredContent(children[1], 'opening');
  var scenes = [];
  for (var i = 2; i < children.length - 2; i += 1) {
    if (children[i].typeId !== 'scene_block') {
      throw new Error('assembler received a non-scene middle slot');
    }
    scenes.push(requiredContent(children[i], 'scene_block'));
  }
  if (scenes.length < 1 || scenes.length > 16) {
    throw new Error('assembler received an invalid scene count');
  }
  var closure = requiredContent(children[children.length - 2], 'emotional_closure');
  var ending = requiredContent(children[children.length - 1], 'chapter_end');
  var content = '# ' + title + '\n\n' + [opening].concat(scenes, [closure, ending]).join('\n\n') + '\n';

  return [{
    routeId: 'chapter-md',
    content: content,
  }];
}

module.exports = { assemble: assemble };
