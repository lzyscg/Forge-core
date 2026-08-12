'use strict';

function failure(evidence) {
  return {
    pass: false,
    issues: [{ stage: 'chapter-structure', evidence: evidence }],
  };
}

function filled(node) {
  return node && node.contentPresence === 'set' && typeof node.content === 'string' && node.content.trim() !== '';
}

function validate(input) {
  if (!input || !Array.isArray(input.tree)) {
    return failure('validator input did not contain a scaffold tree');
  }

  var tree = input.tree;
  var ids = Object.create(null);
  for (var i = 0; i < tree.length; i += 1) {
    var node = tree[i];
    if (!node || typeof node.slotId !== 'string' || ids[node.slotId]) {
      return failure('slot ids must be present and unique');
    }
    ids[node.slotId] = true;
  }

  var roots = tree.filter(function (node) { return node && node.parentSlotId === null; });
  if (roots.length !== 1 || roots[0].typeId !== 'chapter') {
    return failure('the scaffold must have exactly one chapter root');
  }

  var root = roots[0];
  var children = tree
    .filter(function (node) { return node && node.parentSlotId === root.slotId; })
    .sort(function (a, b) { return a.order - b.order; });

  if (children.length < 5 || children.length > 20) {
    return failure('chapter must contain title, opening, 1-16 scenes, closure and ending');
  }
  if (children[0].typeId !== 'title' || children[1].typeId !== 'opening') {
    return failure('title and opening must be the first two child slots');
  }
  if (children[children.length - 2].typeId !== 'emotional_closure' || children[children.length - 1].typeId !== 'chapter_end') {
    return failure('closure and chapter_end must be the last two child slots');
  }
  for (var j = 2; j < children.length - 2; j += 1) {
    if (children[j].typeId !== 'scene_block') {
      return failure('all middle child slots must be scene_block slots');
    }
  }

  var requiredTypes = ['title', 'opening', 'emotional_closure', 'chapter_end'];
  for (var k = 0; k < children.length; k += 1) {
    if (requiredTypes.indexOf(children[k].typeId) !== -1 || children[k].typeId === 'scene_block') {
      if (!filled(children[k])) {
        return failure('required chapter slot content is missing: ' + children[k].typeId);
      }
    }
  }

  return { pass: true, issues: [] };
}

module.exports = { validate: validate };
