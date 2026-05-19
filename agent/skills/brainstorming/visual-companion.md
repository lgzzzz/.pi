# 视觉伴侣 (Visual Companion) 使用指南

一个基于浏览器的视觉头脑风暴辅助，用于展示模型、图表和选项。

## 何时使用

针对每个问题进行决定，而不是针对整个会话。测试标准是：**用户通过观看是否比通过阅读能更好地理解这一点？**

**在以下内容本身是视觉性质时使用浏览器：**

- **UI 模型** —— 线框图、布局、导航结构、组件设计
- **架构图** —— 系统组件、数据流、关系映射图
- **并排视觉对比** —— 对比两种布局、两种配色方案、两个设计方向
- **设计细节** —— 当问题涉及外观和感觉、间距、视觉层次时
- **空间关系** —— 状态机、流程图、渲染为图表的实体关系

**在以下内容是文本或表格性质时使用终端：**

- **需求和范围问题** —— “X 是什么意思？”、“哪些功能在范围内？”
- **概念性 A/B/C 选择** —— 在用文字描述的方案之间进行选择
- **权衡列表** —— 优缺点对比、对比表
- **技术决策** —— API 设计、数据建模、架构方案选择
- **澄清问题** —— 任何答案是文字而非视觉偏好的情况

关于 UI 话题的问题并不自动就是视觉问题。“你想要哪种向导？”是概念性的 —— 使用终端。“这些向导布局中哪一个感觉是对的？”是视觉的 —— 使用浏览器。

## 工作原理

服务器会监视一个目录中的 HTML 文件，并将最新的文件提供给浏览器。你将 HTML 内容写入 `screen_dir`，用户在浏览器中查看它并可以点击选择选项。选择结果会记录在 `state_dir/events` 中，供你在下一轮对话中读取。

**内容片段 vs. 完整文档：** 如果你的 HTML 文件以 `<!DOCTYPE` 或 `<html` 开头，服务器将按原样提供（仅注入助手脚本）。否则，服务器会自动将你的内容包装在框架模板中 —— 添加页眉、CSS 主题、选择指示器和所有交互式基础设施。**默认情况下请编写内容片段。** 只有在需要对页面进行完全控制时才编写完整文档。

## 开始会话

```bash
# 启动具有持久性的服务器（模型保存在项目中）
scripts/start-server.sh --project-dir /path/to/project

# 返回：{"type":"server-started","port":52341,"url":"http://localhost:52341",
#           "screen_dir":"/path/to/project/.pi/brainstorm/12345-1706000000/content",
#           "state_dir":"/path/to/project/.pi/brainstorm/12345-1706000000/state"}
```

从响应中保存 `screen_dir` 和 `state_dir`。告诉用户打开该 URL。

**查找连接信息：** 服务器会将其启动 JSON 写入 `$STATE_DIR/server-info`。如果你在后台启动了服务器且没有捕获 stdout，请读取该文件以获取 URL 和端口。使用 `--project-dir` 时，请检查 `<project>/.pi/brainstorm/` 下的会话目录。

**注意：** 请将项目根目录作为 `--project-dir` 传入，以便模型持久保存在 `.pi/brainstorm/` 中，并在服务器重启后依然存在。如果不传，文件将进入 `/tmp` 并在清理时丢失。如果 `.gitignore` 中还没有 `.superpowers/`，请提醒用户将其添加。

**启动服务器：**

服务器必须在对话轮次间在后台持续运行,你需要告知用户用于启动服务器的命令,由用户自行启动服务器。

如果无法从浏览器访问该 URL（常见于远程/容器化设置），请绑定非回环地址：

```bash
scripts/start-server.sh \
  --project-dir /path/to/project \
  --host 0.0.0.0 \
  --url-host localhost
```

使用 `--url-host` 来控制返回的 URL JSON 中打印的主机名。

## 循环流程

1. **用户自行启动服务器后**，将 HTML **写入** `screen_dir` 中的新文件：
   - 在每次写入之前，检查 `$STATE_DIR/server-info` 是否存在。如果不存在（或 `$STATE_DIR/server-stopped` 存在），则服务器已关闭 —— 在继续之前使用告知用户如何执行 `start-server.sh` 进行重启。服务器在闲置 30 分钟后会自动退出。
   - 使用语义化的文件名：`platform.html`、`visual-style.html`、`layout.html`
   - **绝不重复使用文件名** —— 每个屏幕都对应一个新文件
   - 使用写入工具 —— **不要使用 cat/heredoc**（这会将垃圾信息打印到终端）
   - 服务器会自动提供最新的文件

2. **告诉用户预期的内容并结束本轮对话：**
   - 提醒他们 URL（每一步都要提醒，不仅是第一步）
   - 对屏幕上的内容给出一个简短的文本摘要（例如，“展示主页的 3 种布局选项”）
   - 请他们在终端中回复：“请查看一下，告诉我的你的想法。如果愿意，可以点击选择一个选项。”

3. **在下一轮对话中** —— 在用户于终端回复后：
   - 如果 `$STATE_DIR/events` 存在，请读取它 —— 包含用户在浏览器中的交互（点击、选择），格式为 JSON 行
   - 将其与用户的终端文本合并以获取全貌
   - 终端消息是主要的反馈；`state_dir/events` 提供结构化的交互数据

4. **迭代或推进** —— 如果反馈要求更改当前屏幕，请编写一个新文件（例如 `layout-v2.html`）。只有在当前步骤经过验证后，才移动到下一个问题。

5. **返回终端时卸载内容** —— 当下一步不需要浏览器时（例如，澄清问题、权衡讨论），推送一个等待屏幕以清除陈旧内容：

   ```html
   <!-- 文件名: waiting.html (或 waiting-2.html 等) -->
   <div style="display:flex;align-items:center;justify-content:center;min-height:60vh">
     <p class="subtitle">正在终端中继续...</p>
   </div>
   ```

   这可以防止用户在对话已经继续时仍然盯着一个已解决的选择。当下一个视觉问题出现时，像往常一样推送一个新的内容文件。

6. 重复直至完成。

## 编写内容片段

只需编写页面内部的内容。服务器会自动将其包装在框架模板中（包含页眉、主题 CSS、选择指示器和所有交互式基础设施）。

**极简示例：**

```html
<h2>哪种布局效果更好？</h2>
<p class="subtitle">请考虑可读性和视觉层次感</p>

<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>单列布局</h3>
      <p>整洁、专注的阅读体验</p>
    </div>
  </div>
  <div class="option" data-choice="b" onclick="toggleSelect(this)">
    <div class="letter">B</div>
    <div class="content">
      <h3>双列布局</h3>
      <p>侧边栏导航配主内容区</p>
    </div>
  </div>
</div>
```

就是这样。不需要 `<html>`，不需要 CSS，也不需要 `<script>` 标签。服务器提供所有这些。

## 可用的 CSS 类

框架模板为你的内容提供了这些 CSS 类：

### 选项 (A/B/C 选择)

```html
<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>标题</h3>
      <p>描述</p>
    </div>
  </div>
</div>
```

**多选：** 为容器添加 `data-multiselect` 属性，允许用户选择多个选项。每次点击都会切换选中状态。指示栏会显示计数。

```html
<div class="options" data-multiselect>
  <!-- 相同的选项标记 —— 用户可以多选/取消多选 -->
</div>
```

### 卡片 (视觉设计)

```html
<div class="cards">
  <div class="card" data-choice="design1" onclick="toggleSelect(this)">
    <div class="card-image"><!-- 模型内容 --></div>
    <div class="card-body">
      <h3>名称</h3>
      <p>描述</p>
    </div>
  </div>
</div>
```

### 模型容器

```html
<div class="mockup">
  <div class="mockup-header">预览：仪表盘布局</div>
  <div class="mockup-body"><!-- 你的模型 HTML --></div>
</div>
```

### 拆分视图 (并排对比)

```html
<div class="split">
  <div class="mockup"><!-- 左侧 --></div>
  <div class="mockup"><!-- 右侧 --></div>
</div>
```

### 优缺点

```html
<div class="pros-cons">
  <div class="pros"><h4>优点</h4><ul><li>好处</li></ul></div>
  <div class="cons"><h4>缺点</h4><ul><li>不足</li></ul></div>
</div>
```

### 模拟元素 (线框图构建块)

```html
<div class="mock-nav">Logo | 首页 | 关于 | 联系我们</div>
<div style="display: flex;">
  <div class="mock-sidebar">导航栏</div>
  <div class="mock-content">主要内容区</div>
</div>
<button class="mock-button">操作按钮</button>
<input class="mock-input" placeholder="输入框">
<div class="placeholder">占位区域</div>
```

### 排版与章节

- `h2` —— 页面标题
- `h3` —— 章节标题
- `.subtitle` —— 标题下方的辅助文本
- `.section` —— 带下边距的内容块
- `.label` —— 小型大写标签文本

## 浏览器事件格式

当用户在浏览器中点击选项时，他们的交互会被记录到 `$STATE_DIR/events`（每行一个 JSON 对象）。当你推送新屏幕时，文件会自动清空。

```jsonl
{"type":"click","choice":"a","text":"选项 A - 简单布局","timestamp":1706000101}
{"type":"click","choice":"c","text":"选项 C - 复杂网格","timestamp":1706000108}
{"type":"click","choice":"b","text":"选项 B - 混合布局","timestamp":1706000115}
```

完整的事件流展示了用户的探索路径 —— 他们可能会在最终决定前点击多个选项。最后一个 `choice` 事件通常是最终选择，但点击模式可以揭示犹豫或值得询问的偏好。

如果 `$STATE_DIR/events` 不存在，说明用户没有与浏览器交互 —— 仅使用他们的终端文本。

## 设计建议

- **根据问题调整逼真度** —— 布局问题用线框图，细节问题用精修图
- **在每个页面解释问题** —— 使用“哪种布局感觉更专业？”而不是简单的“选一个”
- **先迭代再推进** —— 如果反馈改变了当前屏幕，请编写一个新版本
- **每个屏幕最多 2-4 个选项**
- **在关键处使用真实内容** —— 对于摄影作品集，使用真实的图片（如 Unsplash）。占位内容会掩盖设计问题。
- **保持模型简单** —— 专注于布局和结构，而不是像素级完美的设计

## 文件命名

- 使用语义化名称：`platform.html`、`visual-style.html`、`layout.html`
- 绝不重复使用文件名 —— 每个屏幕必须是一个新文件
- 迭代时：附加版本后缀，如 `layout-v2.html`、`layout-v3.html`
- 服务器按修改时间提供最新文件

## 清理

```bash
scripts/stop-server.sh $SESSION_DIR
```

如果会话使用了 `--project-dir`，模型文件会持久保存在 `.pi/brainstorm/` 中供以后参考。只有 `/tmp` 会话会在停止时删除。

## 参考资料

- 框架模板 (CSS 参考): `scripts/frame-template.html`
- 助手脚本 (客户端): `scripts/helper.js`
