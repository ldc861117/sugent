# Sugent 方向 B 形象工坊、桌面浮动伴侣与主窗口体验收口方案

**Goal:** 围绕「方向 B：Modular Visor Toy（磨砂面罩小搭档）」统一 Sugent 的形象、动画、桌面浮动伴侣与 One-Jarvis 主界面，并打通「素体白模 → Gemini 图像模型生成 → 纯 Node 自动抠图拆层 → 8 格动态表情包」的端到端自定义链路。

**Architecture:** 素体与默认旗舰皮肤由 [`scripts/build-avatar-blank.mjs`](../../scripts/build-avatar-blank.mjs) 生成；自动抠图、护目镜腔体标定与 8 格精灵切分封装在 [`src/sugent/avatar-rig.ts`](../../src/sugent/avatar-rig.ts)；Gemini 图像模型生成与本地持久化归口于 [`src/sugent/avatar-studio.ts`](../../src/sugent/avatar-studio.ts)；桌面透明置顶浮窗由 [`electron/sugent-companion.ts`](../../electron/sugent-companion.ts) 与 `ui/companion.*` 驱动；主窗口收口与无内联样式重构落入 `ui/css/sugent.css`（`@layer app`）、`ui/components/avatar-studio.js` 与重构后的 `ui/components/jarvis-workbench.js`。

## 0. 商业策略自省四问（AGENTS.md 强制门禁）

| 自省维度 | 核心拷问 | 本方案的架构落位与守线做法 |
| :--- | :--- | :--- |
| 1. 付费锚点 | 哪些属开源引流基座，哪些属商业增值？ | **开源基座**：方向 B 素体白模、纯 Node 自动拆层管线、本地图片导入自定义、桌面透明浮动伴侣、One-Jarvis 收口界面与防社死冷静撤回条全部开源。**商业增值**：Pro/Team 订阅承接跨端 E2EE 形象包与五维记忆漫游、企业团队统一品牌/组织徽标皮肤包、以及移动端远程伴行拍板中继。对比大厂办公全家桶，它把抽象「AI 工具」化为真正陪在主人桌面上的专属数字幕僚，且 100% 尊重 BYOK 与本地数据主权。 |
| 2. 合规与分发 | 能否顺利通过 macOS 公证 / Windows 签名与平台风控？ | 自动抠图与 8 格 PNG 拆层全部采用纯 Node 像素管线（`node:zlib` + 自主 PNG 编解码），零原生 C++ 扩展、零外部二进制强依赖、零硬编码密钥；Gemini 图像模型仅通过用户自配 BYOK 网关或官方 `generativelanguage.googleapis.com` 密钥调用，不依赖任何逆向网页会话。Electron 浮窗仅使用官方 `BrowserWindow`、`globalShortcut` 与安全 `contextBridge` preload（`sandbox: true`）。 |
| 3. 离线退路 | 剥离云端账号进入 `mode: "none"` 后，核心能力是否完整可用？ | 完全可用。无网或 `mode: "none"` 时，内置 `sugent-core` 与 6 套经典形象、眼型/瞳色/动效性格微调、本地 PNG 上传自动拆层导入、桌面浮动伴侣、热键唤起、文件拖拽投递（Dropzone）与防社死撤回窗口 100% 在本机离线运行；Gemini 自定义生成明确作为可选增强项，未配模型时优雅引导使用本地导入或切换预设。 |
| 4. 一人公司运维杠杆 | 是否符合「无状态边缘 + 端侧重逻辑」低运维原则？ | 全部图像预处理、护目镜识别、8 格切分与状态机动画均在用户端侧与浏览器 GPU 合成层完成，云端零新增服务、零 GPU 渲染集群、零资产托管存储成本。 |

## 1. 素体白模与 8 格骨架契约（Direction B）

- **素体资产**：[`ui/design/bots/blank-visor-toy.png`](../../ui/design/bots/blank-visor-toy.png)（1024×1024 无损 RGBA，纯棚拍浅灰底 `#F4F5F7`）。
- **结构定义**：
  1. 哑光浅灰陶瓷感圆角方头（Squircle `x: 24%..76%, y: 31%..84%`）；
  2. 对称独立耳罩组件（`earL` / `earR`，`y: 48%..70%`）；
  3. 居中顶部短柱与球形信标（`top` / `tip`）；
  4. 中央深凹纯黑高反光护目镜面罩（`x: 31%..69%, y: 47%..69%`，**画面内零眼珠/零文字**，留给前端 SVG 矢量双目层实时驱动）。
- **旗舰默认皮肤 `sugent-core`**：[`ui/design/bots/sugent-core.png`](../../ui/design/bots/sugent-core.png)（8 格 `3584×448`），深邃阳极氧化钛黑外壳 + 护目镜双胶囊青柠绿瞳孔（`#d7ff00`）+ 翡翠青辉光（`#00f5a0`），与桌面 App 主图标视觉一脉相承。

## 2. Gemini 自定义生成与自动装配管线

1. **双协议图像生成适配（[`src/sugent/avatar-studio.ts`](../../src/sugent/avatar-studio.ts)）**：
   - 自动按优先级解析可用的 Gemini 图像网关与密钥（`ProviderRegistry` > `.env` / 环境变量 `SUGENT_GATEWAY_URL` + `SUGENT_GATEWAY_KEY` > 官方 `GEMINI_API_KEY`）。
   - 携带素体白模图 + 用户风格描述 + 双向结构钳位 Prompt，首选 Gemini 原生 `:generateContent`（`inlineData`），若网关仅兼容 OpenAI 路由则自动回退 `/chat/completions` 多模态接口。
2. **纯 Node 自动拆层与标定（[`src/sugent/avatar-rig.ts`](../../src/sugent/avatar-rig.ts)）**：
   - 四角中位数采样 + Sobel 梯度边界防渗 BFS 抠除背景并羽化去白边；
   - 统一归一化缩放至 `448×448` 标准画幅，自动侦测护目镜黑色腔体坐标并清洗腔体内误画的杂点；
   - 按向内留茎重叠法（`ext = 3.5%`）切分为 8 格（`head / earL / earR / top / glowHead / glowEarL / glowEarR / glowTop`）输出 `sprite.png` + `manifest.json`。

## 3. Codex 式桌面浮动伴侣与主窗口收口

- **独立透明浮窗**（[`electron/sugent-companion.ts`](../../electron/sugent-companion.ts) + [`ui/companion.html`](../../ui/companion.html) / [`ui/companion.js`](../../ui/companion.js) / [`ui/css/companion.css`](../../ui/css/companion.css)）：
  - 常驻轻浮态（`112×116`）：实时映射 `idle / listening / thinking / replying / working / waiting / sleep` 七态、全局视线追踪、防社死 30s 冷静窗撤回倒计时、文件/文本磁吸拖放投递；
  - 全局快捷键 `⌥Space`（备选 `⌘⇧Space`）或点击展开为紧凑指令与快速拍板胶囊（`420×340`）。
- **主窗口收口（One Jarvis）**：
  - 统一标题与侧栏品牌为 **Sugent**；
  - 将原先内联样式漂浮的管家看板与冷静撤回条全部迁移至符合 `test/design-system.unit.test.ts` 守卫规范的 [`ui/css/sugent.css`](../../ui/css/sugent.css)（`@layer app`）；
  - 主侧栏聚焦于「专属幕僚 · 对话 / 管家总览 / 形象工坊 / 需要你」，将多机器人列表收拢进可展开的「专项分身」区块，完整保留原有全部功能与多端测试兼容性。
