/**
 * imitation-blueprint 结构门禁（模板自带，随任务 snapshot 冻结，沙箱内运行）。
 *
 * CommonJS：`module.exports = { validate }`，validate({ content, artifactType, context })
 * 返回 { pass, issues }，issues 项形如 { stage, evidence, scope }。
 *
 * 校验内容（纯字符串处理，无文件系统 / 网络 / require）：
 *   1. 13 个固定二级标题齐全且保持声明顺序；
 *   2. 每章（`## NN｜…`）完整包含 7 个固定三级标题，且「章末钩子」独立存在；
 *   3. 每章 P0 至少一个 `[FACT @Lx-Ly]` 或 `[OBS @Lx-Ly]` 来源标签；
 *   4. 冷开场（`## 00`）的 P0 不得写「无」；
 *   5. 保留字面门禁标记 `## 分章执行卡`（不得删除/改名/升降级）；
 *   6. 篇幅（8,000-12,000 汉字）为**软检查**：仅篇幅超界不判定失败。
 *
 * 这是模板文件，业务词允许出现；平台 gate-runner 只负责执行它。
 */
module.exports = {
  validate: function (input) {
    var content = (input && input.content) || '';
    var issues = [];
    var lines = content.split('\n');

    var REQUIRED_H2 = [
      '提取基准与章节边界',
      '一句话主线',
      '叙述契约',
      '主题与价值冲突',
      '叙事指纹',
      '原文事实冲突与处理决定',
      '源文功能覆盖总表',
      '全局信息揭示表',
      '全局生命周期调度',
      '分章执行卡',
      '主要人物与关系状态',
      '伏笔与回收',
      '复现门禁报告',
    ];

    var REQUIRED_H3 = [
      '章节目的与退出状态',
      '事实与知识边界',
      '因果与篇幅',
      '情绪执行与读者压力',
      '声音、判断与对白',
      '场景连续性与生命周期',
      '章末钩子',
    ];

    // 收集所有 `## ` 二级标题（排除 `### `），记录所在行号。
    var h2Lines = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^###\s/.test(lines[i])) {
        continue;
      }
      if (/^##\s/.test(lines[i])) {
        h2Lines.push({ index: i, title: lines[i].replace(/^##\s+/, '').trim() });
      }
    }

    // 结构标题 = 非章节卡（`## NN｜…`）的二级标题。
    var structural = [];
    for (var s = 0; s < h2Lines.length; s++) {
      if (!/^\d{2}｜/.test(h2Lines[s].title)) {
        structural.push(h2Lines[s].title);
      }
    }

    // 1. 13 个固定二级标题齐全且顺序正确。
    var requiredOnly = [];
    for (var r = 0; r < structural.length; r++) {
      if (REQUIRED_H2.indexOf(structural[r]) !== -1) {
        requiredOnly.push(structural[r]);
      }
    }
    for (var rr = 0; rr < REQUIRED_H2.length; rr++) {
      if (requiredOnly[rr] !== REQUIRED_H2[rr]) {
        issues.push({
          stage: 'structure',
          evidence: '固定二级标题缺失或顺序错误：期望「' + REQUIRED_H2[rr] + '」',
          scope: 'all',
        });
        break;
      }
    }

    // 5. 字面门禁标记 `## 分章执行卡` 保留。
    if (structural.indexOf('分章执行卡') === -1) {
      issues.push({
        stage: 'structure',
        evidence: '缺少字面门禁标记「## 分章执行卡」',
        scope: 'all',
      });
    }

    // 章节执行卡解析：`## NN｜…`（1-3 位数字 + 全角/半角竖线）。
    // 无法识别的「## X｜…」（非数字开头的卡片）报结构错误，避免静默跳过校验。
    var chapters = [];
    for (var c = 0; c < h2Lines.length; c++) {
      var cardMatch = /^(\d{1,3})[｜|](.*)$/.exec(h2Lines[c].title);
      if (cardMatch === null) {
        if (/[｜|]/.test(h2Lines[c].title) && REQUIRED_H2.indexOf(h2Lines[c].title) === -1) {
          issues.push({
            stage: 'structure',
            evidence: '章节卡未使用两位数字编号：「' + h2Lines[c].title + '」',
            scope: 'all',
          });
        }
        continue;
      }
      var endIndex = c + 1 < h2Lines.length ? h2Lines[c + 1].index : lines.length;
      var body = lines.slice(h2Lines[c].index, endIndex).join('\n');
      chapters.push({ num: cardMatch[1], label: cardMatch[2].trim(), body: body });
    }

    if (chapters.length === 0) {
      issues.push({
        stage: 'structure',
        evidence: '未找到任何章节执行卡（## NN｜…）',
        scope: 'all',
      });
    }

    for (var ch = 0; ch < chapters.length; ch++) {
      var chapter = chapters[ch];
      var scope = '章' + chapter.num;
      var chapterLines = chapter.body.split('\n');

      // 2. 每章 7 个固定三级标题齐全，「章末钩子」独立。
      var chapterH3 = [];
      for (var j = 0; j < chapterLines.length; j++) {
        var mm = /^###\s+(.*)$/.exec(chapterLines[j]);
        if (mm) {
          chapterH3.push(mm[1].trim());
        }
      }
      for (var h = 0; h < REQUIRED_H3.length; h++) {
        if (chapterH3.indexOf(REQUIRED_H3[h]) === -1) {
          issues.push({
            stage: 'structure',
            evidence: '章节缺少三级标题「' + REQUIRED_H3[h] + '」',
            scope: scope,
          });
        }
      }

      // 3. P0 来源标签；4. 冷开场 P0 不得写「无」。
      // P0 定位行：行首可选列表符后跟 `P0` 或 `Bxxx-P0-n`，再跟冒号。
      var p0Lines = [];
      for (var p = 0; p < chapterLines.length; p++) {
        if (/^[-*#\s]*P0[-0-9]*\s*[:：]/.test(chapterLines[p])) {
          p0Lines.push(chapterLines[p]);
        }
      }
      if (p0Lines.length === 0) {
        // 宽松兜底：整章存在任一 FACT/OBS 标签即视为 P0 有出处。
        if (!/\[(?:FACT|OBS) @/.test(chapter.body)) {
          issues.push({
            stage: 'facts',
            evidence: '章节缺少带来源标签的 P0',
            scope: scope,
          });
        }
      } else {
        var hasTag = p0Lines.some(function (pl) {
          return /\[(?:FACT|OBS) @/.test(pl);
        });
        if (!hasTag) {
          issues.push({
            stage: 'facts',
            evidence: 'P0 缺少 [FACT @Lx-Ly] 或 [OBS @Lx-Ly] 来源标签',
            scope: scope,
          });
        }
        if (chapter.num === '00') {
          var coldOpenHasNone = p0Lines.some(function (pl) {
            var val = pl.replace(/^[-*#\s]*P0[-0-9]*\s*[:：]\s*/, '').trim();
            return /^无[：:。]?/.test(val);
          });
          if (coldOpenHasNone) {
            issues.push({
              stage: 'facts',
              evidence: '冷开场 P0 不得写「无」',
              scope: scope,
            });
          }
        }
      }
    }

    // 6. 篇幅软检查（不单独判失败）。
    var hanzi = content.replace(/[^一-鿿]/g, '').length;
    if (hanzi < 8000 || hanzi > 12000) {
      issues.push({
        stage: 'length',
        evidence: '篇幅 ' + hanzi + ' 汉字，建议 8000-12000（软检查）',
        scope: 'all',
      });
    }

    // 硬性项 = 除 length 外的所有 issue；任何硬性项失败即 pass=false。
    var hard = [];
    for (var q = 0; q < issues.length; q++) {
      if (issues[q].stage !== 'length') {
        hard.push(issues[q]);
      }
    }
    return { pass: hard.length === 0, issues: issues };
  },
};
