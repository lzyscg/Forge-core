import type { TemplateDetail } from '../../../shared/contracts';
import type { MockTemplateFixture } from '../mock-schema';

/**
 * 知乎单章生产模板 fixture。
 * 平台代码只能引用本文件导出的 id 常量与通用的 templateFixture 对象，
 * 所有业务内容（名称、描述、示例正文）只允许出现在这里。
 */

export const TEMPLATE_ID = 'zhihu-single-chapter';
export const WRITER_AGENT_ID = 'writer';
export const REVIEWER_AGENT_ID = 'reviewer';
export const INPUT_CHAPTER_BRIEF_ID = 'chapter-brief';
export const INPUT_SOURCE_MATERIAL_ID = 'source-material';
export const SKILL_CHAPTER_WRITING_ID = 'skill-chapter-writing';
export const SKILL_CHAPTER_REVIEW_ID = 'skill-chapter-review';

const template: TemplateDetail = {
  id: TEMPLATE_ID,
  name: '知乎单章生产',
  description:
    '面向知乎短篇故事的单章仿写模板：写作 Agent 产出章节稿，审核 Agent 清单式复审并退回或通过，终稿由审核 Agent 提交。',
  version: '1.0.0',
  agentCount: 2,
  status: 'valid',
  updatedAt: '2026-01-01T00:00:00.000Z',
  inputFields: [
    {
      id: INPUT_CHAPTER_BRIEF_ID,
      label: '章节要求',
      kind: 'text',
      required: true,
      description: '本章的叙事目标、人称视角、字数范围与必须保留的伏笔。',
    },
    {
      id: INPUT_SOURCE_MATERIAL_ID,
      label: '原始素材',
      kind: 'text',
      required: true,
      description: '可供改编的原始故事素材、梗概或真实经历片段。',
    },
  ],
  agents: [
    {
      id: WRITER_AGENT_ID,
      name: '章节写作',
      description: '根据章节要求与原始素材产出章节初稿，并在收到退回意见后进行返修。',
      model: 'forge-longform-v2',
      skills: [
        {
          id: SKILL_CHAPTER_WRITING_ID,
          name: '章节写作 Skill',
          description: '提供叙事节奏、人称一致性与伏笔管理的写作辅助规则，按需加载。',
        },
      ],
    },
    {
      id: REVIEWER_AGENT_ID,
      name: '章节审核',
      description: '对章节稿进行清单式复审：退回具体问题，或通过并提交终稿。',
      model: 'forge-precise-v1',
      skills: [
        {
          id: SKILL_CHAPTER_REVIEW_ID,
          name: '章节审核 Skill',
          description: '提供人称、节奏、伏笔收束与平台合规的检查清单，按需加载。',
        },
      ],
    },
  ],
  routes: [
    {
      from: WRITER_AGENT_ID,
      to: REVIEWER_AGENT_ID,
      kind: 'artifact',
      label: '提交章节稿',
    },
    {
      from: REVIEWER_AGENT_ID,
      to: WRITER_AGENT_ID,
      kind: 'message',
      label: '退回修改意见',
    },
  ],
  finalOutput: {
    name: '终稿章节',
    format: 'markdown',
    submitters: [REVIEWER_AGENT_ID],
  },
};

export const templateFixture: MockTemplateFixture = {
  template,
  sampleTaskName: '第一章 旧信疑云',
  sampleInput: {
    [INPUT_CHAPTER_BRIEF_ID]: '以第一人称推进家族聚会中的冲突，结尾留下旧信来源的悬念，约 800 字。',
    [INPUT_SOURCE_MATERIAL_ID]: '家族聚会中出现一封来源不明的旧信，信上提到一桩无人愿意提起的往事。',
  },  sampleArtifacts: {
    v1: {
      title: '第一章 旧信疑云 V1',
      content:
        '# 第一章 旧信疑云（V1）\n\n' +
        '年夜饭的圆桌刚摆好，二姑就从提包里抽出一只牛皮纸信封，按在桌中央。\n\n' +
        '“这是从老宅抽屉里翻出来的，”她说，“谁都别急着吃饭，先看看这个。”\n\n' +
        '信封已经泛黄，右上角的邮戳模糊得只剩一个圆。父亲瞥了一眼，筷子停在半空，又默默放下。\n\n' +
        '我拆开信纸。信上的字迹陌生而工整，开头只有一句：“当年那件事，并非如你们所想。”\n\n' +
        '满桌人都沉默了。我抬起头，发现祖母的座位不知什么时候空了。',
    },
    v2: {
      title: '第一章 旧信疑云 V2',
      content:
        '# 第一章 旧信疑云（V2）\n\n' +
        '年夜饭的圆桌刚摆好，二姑就从提包里抽出一只牛皮纸信封，按在桌中央。\n\n' +
        '“这是从老宅抽屉里翻出来的，”她说，声音压得很低，“谁都别急着吃饭，先看看这个。”\n\n' +
        '信封已经泛黄，右上角的邮戳模糊得只剩半个圆。父亲瞥了一眼，筷子停在半空，随后慢慢放下。我从没见过他这样失态。\n\n' +
        '信纸只有薄薄一页，字迹陌生而工整，开头只有一句：“当年那件事，并非如你们所想。”\n\n' +
        '满桌人都沉默了。我想说点什么打破这股寒气，却发现祖母的座位不知什么时候空了——她的碗里，还搁着半块没吃完的年糕。',
    },
  },
  sampleThinking:
    '先用旧信开场制造悬念：让二姑把信封按在桌中央，再压住对话密度，' +
    '用父亲停住的筷子和祖母空出的座位替我推进节奏，结尾只留一句信纸开头。',
  sampleHumanQuestion: '原始素材里那封旧信的落款日期，需要设定在哪一年？',
  sampleHumanAnswer: '设定在一九九八年冬天，和老宅拆迁是同一年。',
  sampleReturnNote: '第二节节奏过快，退回修改意见：补足人物反应并压低对话密度。',
  sampleApprovalNote: '清单复审通过：人称、节奏、伏笔收束与合规均符合要求，提交终稿。',
};

/**
 * 模拟 Skill 快照（阶段 E 展示读：MockGateway.getSkillContent 的唯一内容源）。
 * versionHash 是冻结常量，不在运行期计算，保证种子数据与画布节点可复现。
 */
export const MOCK_SKILLS: Record<string, { content: string; versionHash: string }> = {
  [SKILL_CHAPTER_WRITING_ID]: {
    content:
      '# 章节写作 Skill\n\n' +
      '## 叙事节奏\n' +
      '- 开篇三百字内必须落下一个具体的悬念物件，并让至少一个人物对它失态。\n' +
      '- 冲突场景优先写动作与停顿，少写心理独白；每段对话后留一个反应镜头。\n\n' +
      '## 人称一致性\n' +
      '- 全程第一人称时，叙述者只能写自己看得见、听得出的信息。\n' +
      '- 返修时先核对人称，再调整句子，不新增叙述者不在场的画面。\n\n' +
      '## 伏笔管理\n' +
      '- 每个伏笔登记「埋设章节/回收章节」，本章末尾至少推进一条。\n' +
      '- 旧信、空座位等关键物件每次出现都要带一个新的细节。',
    versionHash: '8f3a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819283a4b5c6d7e8',
  },
  [SKILL_CHAPTER_REVIEW_ID]: {
    content:
      '# 章节审核 Skill\n\n' +
      '## 检查清单\n' +
      '1. 人称是否全程一致，叙述者是否越界看见不在场画面。\n' +
      '2. 节奏是否过快：冲突处有没有人物反应与停顿。\n' +
      '3. 伏笔是否只埋不收或提前泄露底牌。\n' +
      '4. 结尾是否留下下一章的钩子。\n' +
      '5. 平台合规：无违禁词、无真实人物指向。\n\n' +
      '## 退回原则\n' +
      '- 退回意见必须落到具体行号或句子，给出可执行的修改方向。\n' +
      '- 同一问题连续两版未解决时，升级为阻断问题并说明证据。',
    versionHash: '2c9d0e1f3a4b5c6d7e8f90123456789abcdef0123456789abcdef0123456789a',
  },
};
