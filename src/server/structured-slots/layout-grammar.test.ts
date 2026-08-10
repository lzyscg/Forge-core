// @vitest-environment node
/**
 * Deterministic LayoutGrammar v1 compiler + single-pass matcher tests
 * (design §8.6/§8.6.1/§8.6.2, spec §4.3, design §25.5 F03/F04).
 *
 * The compiler validates the six-kind production AST (slot/sequence/choice/
 * optional/repeat/empty), resolves every reference into the declared type set,
 * proves termination (generatable fixed point) and static determinism
 * (nullable / min|max consumption / FIRST / FOLLOW with an EOF production-end
 * marker), enforces `limits.structure.maxChildrenPerSlot`, and returns an
 * immutable compiled structure with the exact normalized AST. `matchProduction`
 * performs a single-pass, left-to-right, non-backtracking match that decides at
 * choice/optional/repeat boundaries only from the next child typeId (or EOF),
 * emitting exactly one bounded STRUCTURE_PRODUCTION_MISMATCH at the first
 * failure position.
 */
import { describe, expect, it } from 'vitest';
import type { IssueLocation, StructuredSlotLimitsV1 } from '../../shared/structured-slots';
import {
  compileLayoutGrammarV1,
  matchProduction,
  type CompiledLayoutGrammarV1,
  type GrammarNode,
  type LayoutGrammarV1,
} from './layout-grammar';

const limits: StructuredSlotLimitsV1 = {
  schema: { maxSchemaDepth: 10, maxSchemaNodes: 100, maxEnumItems: 20, maxPatternLength: 50 },
  structure: { maxSlots: 100, maxTreeDepth: 10, maxChildrenPerSlot: 100 },
  payload: { maxSpecBytesPerSlot: 10000, maxContentBytesPerSlot: 10000, maxScaffoldPayloadBytes: 10000 },
  draft: { maxChangedSlots: 100, maxDraftBytes: 10000 },
  attempt: {
    maxSlotToolCallsPerAttempt: 10,
    maxValidationRunsPerAttempt: 10,
    maxValidatorInvocationsPerAttempt: 10,
    maxAggregateValidatorCpuMsPerAttempt: 1000,
    maxAggregateValidatorWallClockMsPerAttempt: 1000,
    maxValidatorOutputBytesPerAttempt: 10000,
    maxAttemptWallClockMs: 10000,
  },
  validation: {
    maxValidators: 5,
    maxValidatorInvocationsPerGate: 5,
    maxAggregateValidatorCpuMsPerGate: 1000,
    maxAggregateValidatorWallClockMsPerGate: 1000,
    maxValidatorOutputBytesPerGate: 10000,
    maxIssuesPerRun: 100,
  },
  output: { maxArtifactFiles: 10, maxArtifactBytesPerFile: 10000, maxTotalArtifactBytes: 10000 },
};

const DOC_TYPE_IDS = new Set(['document', 'title', 'subtitle', 'paragraph', 'quote']);

const documentGrammar: LayoutGrammarV1 = {
  rootType: 'document',
  productions: {
    document: {
      children: {
        kind: 'sequence',
        items: [
          { kind: 'slot', type: 'title' },
          { kind: 'optional', item: { kind: 'slot', type: 'subtitle' } },
          {
            kind: 'repeat',
            min: 1,
            max: 20,
            item: {
              kind: 'choice',
              items: [
                { kind: 'slot', type: 'paragraph' },
                { kind: 'slot', type: 'quote' },
              ],
            },
          },
        ],
      },
    },
    title: { children: { kind: 'empty' } },
    subtitle: { children: { kind: 'empty' } },
    paragraph: { children: { kind: 'empty' } },
    quote: { children: { kind: 'empty' } },
  },
};

/** Exact normalized AST expected for the `document` production (design §8.6). */
const expectedDocumentChildren: GrammarNode = {
  kind: 'sequence',
  items: [
    { kind: 'slot', type: 'title' },
    { kind: 'optional', item: { kind: 'slot', type: 'subtitle' } },
    {
      kind: 'repeat',
      min: 1,
      max: 20,
      item: {
        kind: 'choice',
        items: [
          { kind: 'slot', type: 'paragraph' },
          { kind: 'slot', type: 'quote' },
        ],
      },
    },
  ],
};

/** A location for one child instance slot (parallel to childTypeIds). */
const slotLoc = (slotId: string): IssueLocation => ({
  kind: 'slot',
  slotId,
  field: 'children',
  valuePointer: '',
});

const childLocs = (n: number, prefix = 'c'): IssueLocation[] =>
  Array.from({ length: n }, (_, i) => slotLoc(`${prefix}${i + 1}`));

const compile = (
  grammar: LayoutGrammarV1,
  typeIds: ReadonlySet<string> = DOC_TYPE_IDS,
  l = limits,
): CompiledLayoutGrammarV1 => compileLayoutGrammarV1(grammar, typeIds, l);

describe('compileLayoutGrammarV1 — six AST kinds, normalized AST, consumption', () => {
  it('compiles a document grammar covering all six kinds and exposes the exact normalized AST', () => {
    const compiled = compile(documentGrammar);
    expect(compiled.rootType).toBe('document');
    expect(compiled.productions.document.children).toEqual(expectedDocumentChildren);
    expect(compiled.productions.document.nullable).toBe(false);
    expect(compiled.productions.document.minConsumption).toBe(2);
    expect(compiled.productions.document.maxConsumption).toBe(22);
    expect([...compiled.productions.document.first]).toEqual(['title']);
    expect(compiled.productions.document.generatable).toBe(true);
    for (const leaf of ['title', 'subtitle', 'paragraph', 'quote']) {
      expect(compiled.productions[leaf].children).toEqual({ kind: 'empty' });
      expect(compiled.productions[leaf].nullable).toBe(true);
      expect(compiled.productions[leaf].minConsumption).toBe(0);
      expect(compiled.productions[leaf].maxConsumption).toBe(0);
      expect(compiled.productions[leaf].first.size).toBe(0);
      expect(compiled.productions[leaf].generatable).toBe(true);
    }
  });

  it('returns an immutable deep-frozen compiled structure', () => {
    const compiled = compile(documentGrammar);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.productions)).toBe(true);
    expect(Object.isFrozen(compiled.productions.document)).toBe(true);
    expect(Object.isFrozen(compiled.productions.document.children)).toBe(true);
    expect(() => {
      (compiled.productions.document.children as { kind: string }).kind = 'choice';
    }).toThrow();
    // Sets are exposed as ReadonlySet; the set object itself is frozen (V8
    // does not make frozen Set.add throw, so immutability is type-level here,
    // matching the slot-schema `_enumHashes` convention).
    expect(Object.isFrozen(compiled.productions.document.first)).toBe(true);
  });
});

describe('compileLayoutGrammarV1 — reference resolution (LAYOUT_GRAMMAR_REFERENCE_UNKNOWN)', () => {
  it('rejects an unknown rootType', () => {
    expect(() => compile({ ...documentGrammar, rootType: 'missing' })).toThrow(
      'LAYOUT_GRAMMAR_REFERENCE_UNKNOWN',
    );
  });

  it('rejects an unknown production key', () => {
    expect(() =>
      compile({
        rootType: 'document',
        productions: {
          ...documentGrammar.productions,
          stray: { children: { kind: 'empty' } },
        },
      }),
    ).toThrow('LAYOUT_GRAMMAR_REFERENCE_UNKNOWN');
  });

  it('rejects an unknown slot.type reference', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: { children: { kind: 'slot', type: 'missing' } },
            title: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'title']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_REFERENCE_UNKNOWN');
  });

  it('rejects a declared type that has no production (missing production)', () => {
    expect(() =>
      compile({
        rootType: 'document',
        productions: { document: { children: { kind: 'slot', type: 'title' } } },
      }),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });
});

describe('compileLayoutGrammarV1 — node validation (LAYOUT_GRAMMAR_NODE_INVALID)', () => {
  it('rejects an unknown node kind', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: { document: { children: { kind: 'wildcard' } as never } },
        },
        new Set(['document']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });

  it('rejects unknown fields on a node', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: { children: { kind: 'slot', type: 'title', extra: true } as never },
            title: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'title']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });

  it('rejects a sequence with fewer than one item', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: { document: { children: { kind: 'sequence', items: [] } } },
        },
        new Set(['document']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });

  it('rejects a choice with fewer than two items', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: { children: { kind: 'choice', items: [{ kind: 'slot', type: 'document' }] } },
          },
        },
        new Set(['document']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });

  it('rejects an optional without an item', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: { children: { kind: 'optional', item: undefined } as never },
          },
        },
        new Set(['document']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });

  it('rejects illegal repeat cardinalities', () => {
    const base = (children: GrammarNode): LayoutGrammarV1 => ({
      rootType: 'document',
      productions: { document: { children } },
    });
    const repeat = (min: number, max: number): GrammarNode => ({
      kind: 'repeat',
      min,
      max,
      item: { kind: 'slot', type: 'document' },
    });
    expect(() => compile(base(repeat(1.5, 3)), new Set(['document']))).toThrow(
      'LAYOUT_GRAMMAR_NODE_INVALID',
    );
    expect(() => compile(base(repeat(-1, 3)), new Set(['document']))).toThrow(
      'LAYOUT_GRAMMAR_NODE_INVALID',
    );
    expect(() => compile(base(repeat(3, 1)), new Set(['document']))).toThrow(
      'LAYOUT_GRAMMAR_NODE_INVALID',
    );
    expect(() => compile(base(repeat(0, 0)), new Set(['document']))).toThrow(
      'LAYOUT_GRAMMAR_NODE_INVALID',
    );
    expect(() => compile(base(repeat(0, Infinity)), new Set(['document']))).toThrow(
      'LAYOUT_GRAMMAR_NODE_INVALID',
    );
    expect(() => compile(base(repeat(0, NaN)), new Set(['document']))).toThrow(
      'LAYOUT_GRAMMAR_NODE_INVALID',
    );
  });

  it('rejects empty nested inside any composite node', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: { kind: 'sequence', items: [{ kind: 'empty' }] },
            },
            title: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'title']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: { children: { kind: 'optional', item: { kind: 'empty' } } },
          },
        },
        new Set(['document']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });

  it('rejects a production whose max consumption exceeds maxChildrenPerSlot', () => {
    const tight: StructuredSlotLimitsV1 = {
      ...limits,
      structure: { ...limits.structure, maxChildrenPerSlot: 20 },
    };
    // section consumes heading (1) + repeat max 20 => 21 > 20.
    expect(() =>
      compile(
        {
          rootType: 'section',
          productions: {
            section: {
              children: {
                kind: 'sequence',
                items: [
                  { kind: 'slot', type: 'heading' },
                  {
                    kind: 'repeat',
                    min: 0,
                    max: 20,
                    item: { kind: 'slot', type: 'paragraph' },
                  },
                ],
              },
            },
            heading: { children: { kind: 'empty' } },
            paragraph: { children: { kind: 'empty' } },
          },
        },
        new Set(['section', 'heading', 'paragraph']),
        tight,
      ),
    ).toThrow('LAYOUT_GRAMMAR_NODE_INVALID');
  });
});

describe('compileLayoutGrammarV1 — nullable repeat (LAYOUT_GRAMMAR_NULLABLE_REPEAT)', () => {
  it('rejects a repeat whose item is nullable', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'repeat',
                min: 0,
                max: 5,
                item: { kind: 'optional', item: { kind: 'slot', type: 'paragraph' } },
              },
            },
            paragraph: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NULLABLE_REPEAT');
  });

  it('rejects a repeat whose item is a nullable sequence', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'repeat',
                min: 0,
                max: 5,
                item: {
                  kind: 'sequence',
                  items: [{ kind: 'optional', item: { kind: 'slot', type: 'paragraph' } }],
                },
              },
            },
            paragraph: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NULLABLE_REPEAT');
  });
});

describe('compileLayoutGrammarV1 — termination (LAYOUT_GRAMMAR_NON_TERMINATING)', () => {
  it('rejects a mandatory recursion without a finite exit', () => {
    expect(() =>
      compile(
        {
          rootType: 'a',
          productions: {
            a: {
              children: { kind: 'repeat', min: 1, max: 5, item: { kind: 'slot', type: 'a' } },
            },
          },
        },
        new Set(['a']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NON_TERMINATING');
  });

  it('rejects mutual recursion without a finite exit', () => {
    expect(() =>
      compile(
        {
          rootType: 'a',
          productions: {
            a: { children: { kind: 'slot', type: 'b' } },
            b: { children: { kind: 'slot', type: 'a' } },
          },
        },
        new Set(['a', 'b']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_NON_TERMINATING');
  });

  it('accepts a recursive grammar with a finite exit', () => {
    const compiled = compile(
      {
        rootType: 'section',
        productions: {
          section: {
            children: {
              kind: 'sequence',
              items: [
                { kind: 'slot', type: 'heading' },
                {
                  kind: 'repeat',
                  min: 0,
                  max: 20,
                  item: {
                    kind: 'choice',
                    items: [
                      { kind: 'slot', type: 'paragraph' },
                      { kind: 'slot', type: 'section' },
                    ],
                  },
                },
              ],
            },
          },
          heading: { children: { kind: 'empty' } },
          paragraph: { children: { kind: 'empty' } },
        },
      },
      new Set(['section', 'heading', 'paragraph']),
    );
    expect(compiled.productions.section.maxConsumption).toBe(21);
    expect(compiled.productions.section.generatable).toBe(true);
  });

  it('rejects an unreachable non-generatable production as PRODUCTION_UNREACHABLE, not NON_TERMINATING', () => {
    expect(() =>
      compile(
        {
          rootType: 'a',
          productions: {
            a: { children: { kind: 'empty' } },
            selfLoop: { children: { kind: 'slot', type: 'selfLoop' } },
          },
        },
        new Set(['a', 'selfLoop']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_PRODUCTION_UNREACHABLE');
  });
});

describe('compileLayoutGrammarV1 — unreachable productions (LAYOUT_GRAMMAR_PRODUCTION_UNREACHABLE)', () => {
  it('rejects a production unreachable from rootType', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            ...documentGrammar.productions,
            orphan: { children: { kind: 'empty' } },
          },
        },
        new Set([...DOC_TYPE_IDS, 'orphan']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_PRODUCTION_UNREACHABLE');
  });
});

describe('compileLayoutGrammarV1 — static determinism (grammar_ambig)', () => {
  it('rejects a choice with overlapping FIRST (LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS)', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'choice',
                items: [
                  { kind: 'slot', type: 'paragraph' },
                  { kind: 'slot', type: 'paragraph' },
                ],
              },
            },
            paragraph: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS');
  });

  it('rejects a choice whose branch FIRST sets overlap via a nested sequence', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'choice',
                items: [
                  {
                    kind: 'sequence',
                    items: [
                      { kind: 'slot', type: 'paragraph' },
                      { kind: 'slot', type: 'quote' },
                    ],
                  },
                  { kind: 'slot', type: 'paragraph' },
                ],
              },
            },
            paragraph: { children: { kind: 'empty' } },
            quote: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph', 'quote']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS');
  });

  it('rejects a nullable choice branch (LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS)', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'choice',
                items: [
                  { kind: 'optional', item: { kind: 'slot', type: 'paragraph' } },
                  { kind: 'slot', type: 'quote' },
                ],
              },
            },
            paragraph: { children: { kind: 'empty' } },
            quote: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph', 'quote']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_CHOICE_AMBIGUOUS');
  });

  it('rejects optional followed by the same type it contains (LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT)', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'sequence',
                items: [
                  { kind: 'optional', item: { kind: 'slot', type: 'paragraph' } },
                  { kind: 'slot', type: 'paragraph' },
                ],
              },
            },
            paragraph: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT');
  });

  it('rejects a nullable optional.item (LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT)', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'optional',
                item: { kind: 'optional', item: { kind: 'slot', type: 'paragraph' } },
              },
            },
            paragraph: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_OPTIONAL_FOLLOW_CONFLICT');
  });

  it('rejects a variable repeat whose FIRST intersects FOLLOW (LAYOUT_GRAMMAR_REPEAT_FOLLOW_CONFLICT)', () => {
    expect(() =>
      compile(
        {
          rootType: 'document',
          productions: {
            document: {
              children: {
                kind: 'sequence',
                items: [
                  { kind: 'repeat', min: 0, max: 3, item: { kind: 'slot', type: 'paragraph' } },
                  { kind: 'slot', type: 'paragraph' },
                ],
              },
            },
            paragraph: { children: { kind: 'empty' } },
          },
        },
        new Set(['document', 'paragraph']),
      ),
    ).toThrow('LAYOUT_GRAMMAR_REPEAT_FOLLOW_CONFLICT');
  });

  it('accepts a fixed-count repeat following a same-FIRST type (min === max exemption)', () => {
    const compiled = compile(
      {
        rootType: 'fixed',
        productions: {
          fixed: {
            children: {
              kind: 'sequence',
              items: [
                { kind: 'repeat', min: 2, max: 2, item: { kind: 'slot', type: 'paragraph' } },
                { kind: 'slot', type: 'paragraph' },
              ],
            },
          },
          paragraph: { children: { kind: 'empty' } },
        },
      },
      new Set(['fixed', 'paragraph']),
    );
    expect(compiled.productions.fixed.minConsumption).toBe(3);
    expect(compiled.productions.fixed.maxConsumption).toBe(3);
  });
});

describe('matchProduction — single-pass deterministic matching', () => {
  const compiled = compile(documentGrammar);

  it('accepts children that fit the production', () => {
    expect(matchProduction(compiled, 'document', ['title', 'subtitle', 'paragraph'], childLocs(3))).toEqual([]);
    expect(
      matchProduction(compiled, 'document', ['title', 'paragraph', 'quote', 'paragraph'], childLocs(4)),
    ).toEqual([]);
    // optional skipped, both choice branches consumed across repeat iterations
    expect(
      matchProduction(compiled, 'document', ['title', 'quote', 'paragraph', 'quote'], childLocs(4)),
    ).toEqual([]);
  });

  it('fails on empty children against a production whose min consumption is above zero', () => {
    const issues = matchProduction(compiled, 'document', [], [slotLoc('parent')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('STRUCTURE_PRODUCTION_MISMATCH');
    expect(issues[0].primaryLocation).toEqual(slotLoc('parent'));
    expect(issues[0].details['position']).toBe(0);
    expect(issues[0].details['actual']).toBe('eof');
  });

  it('passes a production that can consume zero children', () => {
    const zero = compile(
      {
        rootType: 'zero',
        productions: {
          zero: {
            children: {
              kind: 'sequence',
              items: [{ kind: 'optional', item: { kind: 'slot', type: 'paragraph' } }],
            },
          },
          paragraph: { children: { kind: 'empty' } },
        },
      },
      new Set(['zero', 'paragraph']),
    );
    expect(matchProduction(zero, 'zero', [], [])).toEqual([]);
    expect(matchProduction(zero, 'zero', ['paragraph'], childLocs(1))).toEqual([]);

    const voidType = compile(
      {
        rootType: 'void',
        productions: {
          void: { children: { kind: 'empty' } },
        },
      },
      new Set(['void']),
    );
    expect(matchProduction(voidType, 'void', [], [])).toEqual([]);
  });

  it('emits exactly one bounded issue at the first failure location', () => {
    // title ok; optional(subtitle) skipped for 'title'; the repeat must consume
    // at least one paragraph/quote but 'title' is not in FIRST(choice).
    const issues = matchProduction(compiled, 'document', ['title', 'title'], childLocs(2));
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.code).toBe('STRUCTURE_PRODUCTION_MISMATCH');
    expect(issue.phase).toBe('structure');
    expect(issue.severity).toBe('error');
    expect(issue.source).toBe('layout_grammar');
    expect(issue.primaryLocation).toEqual(slotLoc('c2'));
    expect(issue.details['parentTypeId']).toBe('document');
    expect(issue.details['position']).toBe(1);
    expect(issue.details['actual']).toBe('title');
    expect(issue.details['expected']).toEqual({ kind: 'choice', itemCount: 2 });
  });

  it('fails when a child is left over after the production is fully consumed', () => {
    const leaf = compile(
      {
        rootType: 'leaf',
        productions: {
          leaf: { children: { kind: 'empty' } },
        },
      },
      new Set(['leaf']),
    );
    const issues = matchProduction(leaf, 'leaf', ['paragraph'], childLocs(1));
    expect(issues).toHaveLength(1);
    expect(issues[0].details['position']).toBe(0);
    expect(issues[0].details['actual']).toBe('paragraph');
    expect(issues[0].details['expected']).toEqual({ kind: 'empty' });
  });

  it('is deterministic: same input yields the same accept or the same first-failure position regardless of choice declaration order', () => {
    const build = (choiceItems: GrammarNode[]): CompiledLayoutGrammarV1 =>
      compile(
        {
          rootType: 'doc',
          productions: {
            doc: {
              children: {
                kind: 'sequence',
                items: [
                  { kind: 'slot', type: 'title' },
                  { kind: 'repeat', min: 1, max: 10, item: { kind: 'choice', items: choiceItems } },
                ],
              },
            },
            title: { children: { kind: 'empty' } },
            paragraph: { children: { kind: 'empty' } },
            quote: { children: { kind: 'empty' } },
          },
        },
        new Set(['doc', 'title', 'paragraph', 'quote']),
      );
    const orderA = build([
      { kind: 'slot', type: 'paragraph' },
      { kind: 'slot', type: 'quote' },
    ]);
    const orderB = build([
      { kind: 'slot', type: 'quote' },
      { kind: 'slot', type: 'paragraph' },
    ]);

    const inputs: string[][] = [
      ['title', 'paragraph', 'quote'],
      ['title', 'quote', 'paragraph'],
      ['title', 'paragraph'],
      ['title'],
      ['title', 'title'],
    ];
    for (const input of inputs) {
      const locs = childLocs(input.length);
      const resultA = matchProduction(orderA, 'doc', input, locs);
      const resultB = matchProduction(orderB, 'doc', input, locs);
      expect(resultA.length).toBe(resultB.length);
      const posA = resultA.length === 0 ? null : resultA[0].details['position'];
      const posB = resultB.length === 0 ? null : resultB[0].details['position'];
      expect(posA).toBe(posB);
    }
  });
});
