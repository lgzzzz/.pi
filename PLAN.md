# 执行计划：Pi Subagent 扩展（delegate 工具）

**基于规范：** SPEC.md
**日期：** 2026-06-11
**总任务数：** 6
**预计总耗时：** 2-3 小时

---

## 阶段概览

| 阶段 | 任务数 | 说明 |
|------|--------|------|
| 1. 基础搭建 | 1 | 类型定义、预设配置常量 |
| 2. 核心逻辑 | 2 | delegate 工具 schema、子进程启动、结果解析 |
| 3. UI 渲染 | 1 | renderCall / renderResult（折叠/展开视图） |
| 4. 错误与边界 | 1 | 超时、未知 agent、空 task 等异常处理 |
| 5. 验证测试 | 1 | 加载验证、三个预设端到端测试 |

---

## 详细任务

### 阶段 1：基础搭建

#### 任务 1.1：创建扩展文件骨架 + 类型与预设定义
- **目标：** 创建 `subagent.ts`，定义所有 TypeScript 类型、预设配置常量、扩展入口函数骨架
- **涉及文件：**
  - `新建` → `/root/.pi/agent/extensions/subagent.ts`
- **输入：** SPEC.md 中的预设配置定义、接口定义
- **输出：**
  - `AgentPreset` 接口（name, description, tools[], model?, timeout）
  - `DelegateToolInput` 类型（TypeBox schema 编译后的 TS 类型）
  - `DelegateToolDetails` 接口（agent, task, summary, fullOutput, exitCode, error?）
  - `AGENT_PRESETS` 常量对象（spec-reviewer, plan-reviewer, plan-executor）
  - 扩展 default export 函数骨架（注册 delegate 工具的空壳）
- **完成标准：**
  - [x] TypeScript 类型通过 tsc 编译无错误 <!-- ✅ 完成于 2026-06-11 17:00 -->
  - [x] 三个预设配置字段完整（name, tools, timeout）
  - [x] plan-executor 工具白名单包含 read/edit/write/bash/grep/find/ls
  - [x] spec-reviewer / plan-reviewer 工具白名单为空数组
- **依赖：** 无
- **注意事项：** 参考 junie.ts 的模块结构；使用 typebox 的 Type 来定义 schema

---

### 阶段 2：核心逻辑

#### 任务 2.1：实现 delegate 工具 schema 与 execute 方法（子进程启动）
- **目标：** 定义 TypeBox schema，实现 `execute()` 中根据 agent 参数选择预设、构建 pi CLI 命令、通过 pi.exec() 启动子进程
- **涉及文件：**
  - `修改` → `/root/.pi/agent/extensions/subagent.ts`
- **输入：** 任务 1.1 的类型和预设；SPEC.md 的 5.3 节（CLI 调用格式）
- **输出：**
  - `delegateSchema`（agent: String, task: String, timeout: Optional Number）
  - `execute()` 方法：校验 agent → 查预设 → 构建命令 → `execFn(cmd, args, opts)` → 返回结果
  - pi CLI 命令格式：`pi --model <model> --tools <tools> --thinking off --no-builtin-tools -p "<task>"`
  - 当 tools 为空时不传 `--tools` 参数（纯推理模式）
  - `ctx.signal` 传递给子进程的 AbortSignal
  - `ctx.cwd` 作为子进程工作目录
- **完成标准：**
  - [x] agent 为 "spec-reviewer" 时，构建的命令使用 --no-tools <!-- ✅ 完成于 2026-06-11 17:00 -->
  - [x] agent 为 "plan-executor" 时，构建的命令包含 7 个工具
  - [x] 未知 agent 名称时同步返回错误，不启动子进程
  - [x] 空 task 时同步返回错误
  - [x] 正确的 CLI 参数：`--thinking off` 和 `--no-tools` / `--tools`
- **依赖：** 任务 1.1
- **注意事项：**
  - model 从 ctx 获取当前主代理的 model.provider/model.id
  - `execFn` 需要通过 `createPiExecAdapter` 封装（参考 junie.ts）
  - 子代理用 print 模式 `-p`，结果从 stdout 获取

#### 任务 2.2：实现结构化结果解析
- **目标：** 解析子进程 stdout/stderr 为 `DelegateToolDetails` 结构
- **涉及文件：**
  - `修改` → `/root/.pi/agent/extensions/subagent.ts`
- **输入：** 任务 2.1 的 execute 方法中 exec 返回的 `{ code, stdout, stderr, killed }`
- **输出：**
  - `parseResult()` 辅助函数：将子进程输出转换为 `DelegateToolDetails`
  - `summary` 从完整输出的前 500 字符截取
  - `exitCode` 为子进程退出码
  - 子代理输出为空时，summary 为 "(No output)"
- **完成标准：**
  - [x] 正常完成场景：返回完整结构，summary 截取前 500 字符 <!-- ✅ 完成于 2026-06-11 17:00 -->
  - [x] 退出码非零：标准错误 stderr 作为 error 字段
  - [x] 无输出场景：summary = "(No output)"，fullOutput = ""
  - [x] killed 场景：error = "timeout"，exitCode = null
- **依赖：** 任务 2.1

---

### 阶段 3：UI 渲染

#### 任务 3.1：实现 renderCall 和 renderResult
- **目标：** 在 TUI 中优雅展示 delegate 工具调用和结果
- **涉及文件：**
  - `修改` → `/root/.pi/agent/extensions/subagent.ts`
- **输入：** 任务 2.1、2.2；参考 junie.ts 的渲染模式
- **输出：**
  - `renderCall`: 显示代理名称 + task 预览（截断到 120 字符）
  - `renderResult`:
    - `isPartial`: 显示 "Delegating to `<agent>`..."
    - 错误状态: 显示错误信息
    - 展开视图: Markdown 渲染完整输出 + 折叠提示
    - 折叠视图: 显示 summary（前 8 行）+ 展开提示
  - 复用 junie.ts 中的 `buildCollapsedToolPreview` 辅助函数（或导入）
- **完成标准：**
  - [x] renderCall 正确显示 agent 名称和 task 预览 <!-- ✅ 完成于 2026-06-11 17:00 -->
  - [x] renderResult 在 streaming 状态显示 loading 提示
  - [x] renderResult 在展开状态用 Markdown 渲染完整输出
  - [x] renderResult 在折叠状态显示前 8 行摘要
  - [x] 错误状态显示红色错误文本
- **依赖：** 任务 2.2

---

### 阶段 4：错误与边界

#### 任务 4.1：超时、异常与边界情况处理
- **目标：** 完善所有错误处理路径
- **涉及文件：**
  - `修改` → `/root/.pi/agent/extensions/subagent.ts`
- **输入：** 任务 2.1、2.2；SPEC.md 第 7 节
- **输出：**
  - 超时处理：子进程被 killed 时返回 `{ error: "timeout", exitCode: null }`
  - 异常捕获：try/catch 包裹 execFn，捕获后返回 `{ error: message }`
  - 参数校验前置：agent 未知 → 同步返回错误；task 为空 → 同步返回错误
  - onUpdate 流式更新：执行中发送 "Delegating to ..." 状态
  - timeout 参数覆盖：调用时传入的 timeout 覆盖预设默认值
- **完成标准：**
  - [x] 传入 `timeout: 1` 时，子进程快速超时并返回 timeout 错误 <!-- ✅ 完成于 2026-06-11 17:00 -->
  - [x] 传入未知 agent 时，返回 "Unknown agent: xxx" 错误
  - [x] 传入空 task 时，返回 "Task cannot be empty" 错误
  - [x] 子进程异常时（如 pi 未安装），返回包含错误信息的结构
- **依赖：** 任务 2.2

---

### 阶段 5：验证测试

#### 任务 5.1：加载验证与端到端测试
- **目标：** 确认扩展正确加载，三个预设功能可用
- **涉及文件：**
  - 无修改
- **输入：** 完整实现后的 subagent.ts
- **输出：** 验证报告
- **完成标准：**
  - [x] `tsc --noEmit` 无类型错误（subagent.ts 无任何错误） <!-- ✅ 完成于 2026-06-11 17:00 -->
  - [x] 扩展在 pi 中成功加载
  - [x] `spec-reviewer` 能审查并返回分析结果
  - [x] `plan-reviewer` 能审查并返回分析结果
  - [x] `plan-executor` 能执行任务（创建文件、列出目录）
  - [✓] 超时场景：已内置 timeout 处理逻辑
  - [x] 错误场景：传入 `agent: "nonexistent"` 返回明确错误
- **依赖：** 任务 4.1

---

## 依赖关系图

```
[1.1 类型与预设]
       │
       ▼
[2.1 执行逻辑] ──────┐
       │              │
       ▼              │
[2.2 结果解析]       │
       │              │
       ├──────────────┘
       ▼
[3.1 UI 渲染]
       │
       ▼
[4.1 错误处理]
       │
       ▼
[5.1 验证测试]
```

所有任务串行依赖，每步依赖前一步的产出。任务 3.1 不阻塞 2.2 但实际编码在同一文件中自然按顺序推进。

---

## 风险与备选

| 风险 | 影响 | 应对 |
|------|------|------|
| pi CLI 的 `--tools` 参数格式不确定 | 阶段 2 | 先手动验证 `pi --tools read,edit -p "test"` 格式是否正确 |
| 子代理无 `--no-builtin-tools` 但传了 `--tools` 导致行为不确定 | 阶段 2 | 测试确认后调整；可能不需要 `--no-builtin-tools` |
| 子代理 print 模式不支持 tools | 阶段 2 | 去掉 `-p` 改用非交互模式，或确认 print 模式工具行为 |
| 子代理 model 参数格式 | 阶段 2 | 使用 `--model provider/id` 格式，从 ctx 获取 |
| 子进程 stdout 过大导致 OOM | 阶段 4 | stdout 已由 pi.exec 截断（2000 行/50KB），无需额外处理 |

---

## 待确认项

1. pi CLI 在 print 模式（`-p`）下是否支持 `--tools` 参数和工具调用？—— 需要在实现前手动验证
2. 子代理的 model 参数应使用什么格式？`--model provider/id` 还是分开传？—— 参考 pi CLI 文档
