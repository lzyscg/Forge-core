# 结构化控制器协议

自动化生产链不得把进程退出码、文件存在或自然语言中的“通过”当成成功。每个控制操作产生人读 Markdown 与机器读 JSON sidecar；只有 `scripts/controller_artifact.py` 验证成功后，正式产物才能进入下一阶段。`audit` 与 `ledger` 的判断字段仍由审核端给出并交叉验证；`packet` 的章节身份、签名、哈希和结构检查属于确定性运输字段，应由控制器生成，不再要求语言模型拼写 JSON。

## 一、章节边界先于大纲

有参考文本时，先运行：

```powershell
python scripts/controller_artifact.py extract-boundaries `
  --source <参考文本> `
  --output <chapter-boundaries.json>
```

边界 map 保存源文件哈希、原标签、标题行、正文行和字符范围、首尾锚点、本章最后不可越过文本、下一章禁止提前出现文本、区段哈希与边界签名。不得正规化原标签，不得自动补齐缺号。

大纲生成和分章编译只读取该 map 机械切出的当前源区段。进入执行包编译前运行：

```powershell
python scripts/controller_artifact.py validate-boundaries `
  --source <参考文本> `
  --boundaries <chapter-boundaries.json> `
  --blueprint <blueprint.md>
```

源哈希、范围或蓝图章节顺序任一不一致即失败。需要给大纲端提供单段原文时使用 `slice-source`，不得让模型凭语义自行决定边界。

## 二、控制结果信封

执行包模型只输出：

```text
<<<ZH-SALT-MARKDOWN>>>
# 人读 Markdown
...
```

packet-only 信封以响应 EOF 结束，不要求语言模型抄写尾标记。接收时使用 `--controller-owned-packet-sidecar`。控制器先验证 Markdown 的标题、必要区块、场景单元、保真 ID、正向有限清单和篇幅格式，再用边界 map 生成 packet sidecar。该选项只允许用于 `operation=packet`，不能替代 audit 或 ledger 的语义判断。

审核与账本模型仍使用下列双产物信封：

自动化控制器的最后消息必须严格使用：

```text
<<<ZH-SALT-MARKDOWN>>>
# 人读 Markdown
...
<<<ZH-SALT-SIDECAR>>>
{
  "schema_version": "1.0",
  "valid": true,
  "operation": "packet | audit | ledger",
  "chapter": {
    "id": "B008",
    "display": "6.",
    "sequence": 8,
    "boundary_signature": "由边界 map 提供"
  },
  "verdict": "按操作 schema",
  "missing_units": [],
  "out_of_bounds_facts": [],
  "repair_scope": {"mode": "none", "targets": []},
  "checks": {}
}
<<<ZH-SALT-END>>>
```

模型不计算 `markdown_sha256`；接收程序按规范化 Markdown 自动写入后再做 schema 校验。信封外不允许出现说明。

## 三、独立 schema

- `schemas/packet-result.schema.json`
- `schemas/audit-result.schema.json`
- `schemas/ledger-result.schema.json`
- `schemas/chapter-boundaries.schema.json`

三个操作不能共用宽松的“通用结果”替代。固定字段都包含：`valid`、`operation`、`chapter`、`verdict`、`missing_units`、`out_of_bounds_facts`、`repair_scope` 和操作专属 `checks`。

## 四、Fail-closed 门槛

使用 `accept-result` 拆分并验收信封。它会检查：

1. 信封完整且没有尾随说明；
2. JSON 通过对应 schema；
3. `operation` 与调用目标一致；
4. 章节 ID、展示标签、顺序和边界签名与 map 一致；
5. Markdown 标题、必要结构和 JSON verdict 一致；
6. `valid` 为真，且操作专属检查成立；
7. 新版正文 packet 的每个单元都含结构化授权容量载体，目标下限不超过安全承载值，目标上限不超过授权绝对上限；
8. ledger 额外要求同章 audit sidecar 已经 `pass`。

任一失败时退出码为 2，且不写正式 Markdown/sidecar。原始输出应保存在失败证据目录，不能覆盖上一个通过产物。

新版正文 packet 使用 `schema_version: 1.1`。`capacity_budget` 由控制器从 Markdown 确定性复算，记录每单元的对白轮次、动作反馈闭环、认知或感知转折、事后反应、原始容量、安全下限上界和授权绝对上限；模型不得自行拼写或修改该 sidecar。旧版含私有硬事实表的 packet 可以按 `1.0` 留作历史证据，但不能绕过新版正文生产的容量门。

```powershell
python scripts/controller_artifact.py accept-result `
  --raw <模型最后消息> `
  --operation packet `
  --boundaries <chapter-boundaries.json> `
  --chapter-id B008 `
  --controller-owned-packet-sidecar `
  --markdown-out <packets/6dot.md> `
  --sidecar-out <packets/6dot.json>
```

审核准备进入账本时加 `--require-pass`。账本操作必须再提供 `--approved-audit <audit.json>`。

审核模型只提交语义判断时，先由控制器补齐不可交给语言模型计算的运输字段：

```powershell
python scripts/controller_artifact.py accept-draft-audit-semantics `
  --draft <draft.md> `
  --raw <audit-semantics.json> `
  --packet-sidecar <packet.json> `
  --output <draft-audit-evidence.json>
```

语义 JSON 必须覆盖全部正文段落，并对场景闭环、直接写出和疑似新增事实引用正文真实子串。控制器会补入并复算章节身份、正文哈希、段落哈希和汉字数；引用不存在、段落漏覆盖、单元证据不完整或 schema 错误时退出码为 2。

闭环字段描述的是功能角色，不要求四条不同句子。一个已经发生并直接建立新状态的公开动作，可以用同一条精确引文同时承担回应与新状态，审核器不得要求补写重复解释。相反，“只给 / 最短 / 到此为止”是排他边界，指定反应后的追加比喻或解释必须单独核验。

编译器发布 packet 前应检查同一内容是否同时被要求写出和禁止写出。兼容旧 packet 时，审计按“硬事实及必须保留/直接写出 > 指定压力或声音载体 > 一般留白 > 自由创造”裁决；留白可阻止把角色自评升级为客观结论，但不能抹掉明确要求保留的自评句。

“直接写出”通常是语义存在性要求，只有带引号的对白、固定硬事实句或明确逐字标记才做字面匹配。语义审计若已在 `direct_writes` 中给出有效证据，就不能又以同一项未逐字出现为由判所属单元缺失。

若通过身份、哈希和证据校验后只剩唯一定位的 `delete` 授权项，可用 `apply-audit-deletions` 让控制器直接做精确删除和标点接缝收拢。被标为待修的段落必须能由段内精确删除引文完全解释；整段删除只有在段落内容与唯一删除引文完全相等时才允许。

审核前可运行 `build-audit-view --draft <draft.md> --output <audit-view.json>`。它输出控制器复算的正文哈希、段落总数及逐段 `index/text`，审核模型必须按该清单逐项返回段落归属，避免自行分段漏记。
