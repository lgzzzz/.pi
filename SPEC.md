# 规范文档：Pi Subagent 扩展

**类型：** 新功能
**日期：** 2026-06-11
**状态：** 草案

---

## 1. 问题陈述

为 pi 实现一个 subagent 扩展，让主代理能将任务委托给子代理执行。核心理念是**任务分工**——主代理负责任务编排与决策，子代理负责具体子任务的执行。子代理拥有独立上下文，通过预设方案定义不同的能力边界（工具集、模型等）。

当前已内置三个技能（spec-clarify / plan-from-spec / execute-plan）定义工作流，它们的产出物（SPEC.md / PLAN.md / 执行）需要对应三个专用子代理来审查和执行。

## 2. 范围

### 本次迭代包含

- 一个统一入口的 `delegate` 工具，通过 `agent` 参数选择预设子代理
- 三个预设子代理方案：
  - `spec-reviewer` — 审查 SPEC.md，纯推理（无工具），基于 `pi.exec()` 启动子会话
  - `plan-reviewer` — 审查 PLAN.md，纯推理（无工具），基于 `pi.exec()` 启动子会话
  - `plan-executor` — 执行 PLAN.md 中的任务，具备 read/edit/write/bash/grep/find/ls 工具
- 工具白名单权限控制（每个预设定义允许的工具列表）
- 结构化结果返回：`{ agent, task, summary, fullOutput, exitCode }`
- 可配置超时时间
- 异常时返回错误信息，由主代理决策下一步

### 本次迭代不包含

- 动态创建自定义预设方案
- 路径沙箱限制
- 危险操作确认门控
- 多子代理并发执行
- 子代理结果自动回写主会话

## 3. 详细需求

### 3.1 功能性需求

- **F1:** 注册 `delegate` 工具，参数包含 `agent`（预设名称）和 `task`（任务描述）
- **F2:** 支持三个预设：`spec-reviewer`、`plan-reviewer`、`plan-executor`
- **F3:** `spec-reviewer` 和 `plan-reviewer` 无工具（纯推理模式）
- **F4:** `plan-executor` 拥有 read / edit / write / bash / grep / find / ls 工具
- **F5:** 子代理通过 `pi.exec()` 启动完整 pi 子会话（`pi --model <model> --tools <tools> -p "task"`）
- **F6:** 子代理可配置使用与主代理相同或不同的 model
- **F7:** 返回结构化结果，包含代理名、原始任务、摘要、完整输出、退出码
- **F8:** 支持按预设或按调用配置超时时间
- **F9:** 子代理崩溃/超时时，返回包含错误信息的结构化结果

### 3.2 非功能性需求

- **性能：** 子代理启动应尽量快（复用当前 provider/model 配置）
- **安全：** 工具白名单严格执行，子代理无法越权调用未授权工具

## 4. 实现方案

采用 **工具式子代理** 模式（方案 1），核心思路：

- 注册一个 `delegate` 自定义工具
- 工具被调用时，根据 `agent` 参数选择预设，通过 `pi.exec()` 启动子 pi 进程
- 子进程以 print 模式或非交互模式运行，完成后返回结构化结果

### 预设配置定义

```typescript
const AGENT_PRESETS = {
  "spec-reviewer": {
    description: "审查 SPEC.md 规范文档的完整性和清晰度",
    tools: [],  // 纯推理，无工具
    model: undefined,  // 默认使用主代理模型
    timeout: 300_000,  // 5 分钟
  },
  "plan-reviewer": {
    description: "审查 PLAN.md 执行计划的可行性和完整性",
    tools: [],
    model: undefined,
    timeout: 300_000,
  },
  "plan-executor": {
    description: "按照 PLAN.md 逐任务执行代码修改",
    tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
    model: undefined,
    timeout: 600_000,  // 10 分钟
  },
};
```

## 5. 数据与接口

### 5.1 工具 Schema

```typescript
const delegateSchema = Type.Object({
  agent: Type.String({
    description: "要调用的子代理名称: spec-reviewer | plan-reviewer | plan-executor",
  }),
  task: Type.String({
    description: "委派给子代理的具体任务描述",
  }),
  timeout: Type.Optional(Type.Number({
    description: "超时时间（毫秒），覆盖预设默认值",
  })),
});
```

### 5.2 返回结构

```typescript
interface DelegateResult {
  agent: string;          // 使用的子代理名称
  task: string;           // 原始任务描述
  summary: string;        // 子代理输出的摘要（前 N 行）
  fullOutput: string;     // 完整输出
  exitCode: number | null;// 退出码
  error?: string;         // 如有异常，错误信息
}
```

### 5.3 pi.exec 调用

```bash
pi --model <model> --tools <tools> --thinking off -p "<task>"
```

- `--tools`：根据预设的工具白名单
- `--model`：默认继承主代理当前 model，可通过预设配置覆盖
- `--thinking off`：子代理关闭 thinking 以节省成本

## 6. 交互流程

```
主代理 LLM 决定委派任务
  │
  ├─► 调用 delegate 工具
  │     agent: "plan-executor"
  │     task: "执行 PLAN.md 中的 Task 1：实现 login 函数"
  │
  ├─► 扩展处理 delegate 调用
  │     ├─ 查找预设配置 (plan-executor)
  │     ├─ 构建子 pi 命令
  │     ├─ 通过 pi.exec() 启动子进程
  │     └─ 等待子进程完成（或超时）
  │
  ├─► 子代理执行（独立 pi 会话）
  │     ├─ 读取文件
  │     ├─ 执行修改
  │     └─ 输出结果
  │
  └─► 返回结构化结果给主代理
        {
          agent: "plan-executor",
          task: "...",
          summary: "成功实现 login 函数...",
          fullOutput: "...",
          exitCode: 0
        }
        └─► 主代理继续决策
```

## 7. 边界情况与错误处理

| 场景 | 处理方式 |
|------|---------|
| 子代理超时 | 子进程被 kill，返回 `{ exitCode: null, error: "timeout" }` |
| 子代理崩溃 | 返回 `{ exitCode: non-zero, error: stderr }` |
| 子代理无输出 | 返回 `{ summary: "(No output)", fullOutput: "" }` |
| 未知 agent 名称 | 同步返回错误，不启动子进程 |
| 空 task | 同步返回错误 |
| 子代理 stdout 过大 | 保留 `fullOutput`（完整），`summary` 截取前 500 字符 |
| 主代理 context 被 abort | `ctx.signal` 传递给子进程 |

## 8. 迁移方案

无需迁移，新功能以扩展形式添加。

## 9. 测试策略

- **单元测试：** 预设配置有效性、工具白名单正确性
- **集成测试：** 使用 `pi -e` 加载扩展，手动调用三个预设验证
- **场景测试：**
  - `spec-reviewer` 能正确审查一个 SPEC.md 并返回分析
  - `plan-executor` 能读取文件、执行简单修改并返回结果
  - 超时场景：设置 1ms 超时验证超时处理
  - 错误场景：调用不存在的 agent 名称

## 10. 待解决问题

- 子代理是否需要访问主代理的 session context（如已读取的文件内容）？—— 当前设计：不需要，子代理通过 `--cwd` 继承工作目录即可
- 是否需要子代理结果自动 append 到主会话？—— 当前设计：通过 tool result 返回即可，不额外 append

---

## 决策记录

| # | 问题 | 选择 | 理由 |
|---|------|------|------|
| 1 | 任务类别 | 新功能 | 创建 subagent 扩展 |
| 2 | 实现方案 | 工具式子代理（方案 1） | 简单可落地，参考 junie_ai 模式 |
| 3 | 核心动机 | 任务分工 | 主代理编排，子代理执行 |
| 4 | 范围 | 最小可用 + 权限控制 | 快速落地，安全可控 |
| 5 | 模型/工具配置 | 预设方案（C） | 三个预设匹配现有技能工作流 |
| 6 | 预设定义 | spec-reviewer / plan-reviewer / plan-executor | 对应三个已有技能 |
| 7 | 调用方式 | 统一入口 delegate 工具（A） | 简洁，可扩展 |
| 8 | 执行机制 | pi.exec() 完整会话（B） | 支持工具调用，灵活性高 |
| 9 | 权限控制 | 工具白名单（A） | 按预设限制可用工具 |
| 10 | 结果格式 | 结构化返回（B） | 利于主代理解析决策 |
| 11 | 异常处理 | 可配置超时 + 返回错误让主代理决定 | 灵活且安全 |
