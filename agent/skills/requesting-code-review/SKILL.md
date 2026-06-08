---
name: requesting-code-review
description: 在完成任务、实施重大功能时使用，以验证工作是否符合要求
---

# 请求代码审查 (Requesting Code Review)

执行代码评审，以便在问题产生连锁反应之前发现它们。评审应基于专门制定的评估上下文 —— 绝不要提供当前会话的历史记录。这能让评审专注于工作产出，而不是思考过程，并为你继续工作保留上下文。

**核心原则：** 及早评审，经常评审。

## 何时请求评审

**强制性：**
- 在每个开发任务完成后
- 完成重大功能后
- 完成任务后

**可选但有价值：**
- 当卡住时（寻求新视角）
- 重构之前（基线检查）
- 修复复杂 bug 之后

## 如何请求

**1. 获取 git SHAs：**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # 或 origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**2. 代码评审：**

参考`code-reviewer.md`执行代码评审。

**占位符：**
- `{DESCRIPTION}` —— 你构建内容的简要摘要
- `{PLAN_OR_REQUIREMENTS}` —— 应该实现的功能
- `{BASE_SHA}` —— 起始提交
- `{HEAD_SHA}` —— 结束提交

**3. 根据反馈采取行动：**
- 立即修复“严重 (Critical)”问题
- 在继续之前修复“重要 (Important)”问题
- 记录“次要 (Minor)”问题以供稍后处理
- 如果评审结论有误，予以推辞（并说明理由）

## 示例

```
[刚刚完成任务 2：添加验证函数]

你：在继续之前，让我请求代码评审。

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[执行代码评审]
  DESCRIPTION: 添加了包含 4 种错误类型的 verifyIndex() 和 repairIndex()
  PLAN_OR_REQUIREMENTS: 来自 docs/plans/deployment-plan.md 的任务 2
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661

[评审结果]:
  优点：架构整洁，有真实测试
  问题：
    重要：缺失进度指示器
    次要：报告间隔使用了幻数 (100)
  评估：可以继续

你：[修复进度指示器]
[继续任务 3]
```

## 与工作流集成

**分步开发：**
- 每个步骤完成后进行评审
- 在问题复合之前发现它们
- 修复后再移动到下一个步骤

**执行计划：**
- 在每个任务后或自然的检查点进行评审
- 获取反馈、应用并继续

**即兴开发：**
- 合并前评审
- 卡住时评审

## 红线（绝对禁止）

**绝不：**
- 因为“很简单”而跳过评审
- 忽略“严重 (Critical)”问题
- 在“重要 (Important)”问题未修复的情况下继续
- 争辩有效的技术反馈

**如果评审结论有误：**
- 以技术理由予以推辞
- 展示证明其有效的代码/测试
- 请求澄清

参见：`requesting-code-review/code-reviewer.md`
