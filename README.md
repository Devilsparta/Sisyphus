# Sisyphus

> 西西弗斯每天推着石头上山，第二天石头滚下来，他再推一遍。  
> AI 工具大概也是这样——六个月后这个项目可能就过时了。  
> 但在它还有用的这段时间，我们用它来做点有意义的事。

**Sisyphus** 是一个面向非技术同学的 AI 辅助创作工具，目前面向设计师，后续可以扩展到产品经理。它提供一个简单的聊天界面，让你用自然语言描述想法，AI 实时生成可以预览的界面原型。

核心理念是：**降低门槛，快速验证。** 不需要会写代码，描述你的想法就够了。

---

## 它能做什么

- 用对话的方式生成界面组件
- 实时预览生成结果，所见即所得
- 支持连续对话，迭代修改
- 设计师友好，零代码门槛

---

## 本地运行

**1. 安装依赖**

```bash
npm install
```

**2. 配置环境变量**

复制示例文件并填入你的 API 信息：

```bash
cp .env.example .env.local
```

编辑 `.env.local`：

```
OPENAI_BASE_URL=https://your-api-endpoint/v1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model-name
```

> 支持任意 OpenAI 兼容接口，包括方舟、Kimi 等。

**3. 启动**

```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 开始使用。

---

## 技术栈

- [Next.js](https://nextjs.org) — App Router
- [shadcn/ui](https://ui.shadcn.com) — 组件库
- [Sandpack](https://sandpack.codesandbox.io) — 实时代码预览
- OpenAI 兼容接口 — 模型调用

---

## 安装桌面 app（unsigned 内测版）

下载 `Sisyphus_<version>_x64.dmg`（Intel）或 `_arm64.dmg`（Apple Silicon），双击挂载后把 `Sisyphus.app` 拖进 `/Applications`。

**第一次打开会被 Gatekeeper 拦截**（"Sisyphus.app" 无法打开，开发者无法验证）——这是因为 dmg 没有用 Apple Developer 证书签名，等正式分发再补。临时绕过方式二选一：

```bash
# 一次性清掉 quarantine 标记，之后双击正常打开
xattr -dr com.apple.quarantine /Applications/Sisyphus.app
```

或在 Finder 里 **右键 `Sisyphus.app` → 打开 → 在弹窗里点"打开"**（macOS 13+ 可能要"系统设置 → 隐私与安全性 → 仍要打开"）。

应用启动后会自动拉起内嵌的 daemon（端口 `8787`），webview 加载本地 UI，无需后台另开终端。

---

## 写在最后

这个项目的名字来自古希腊神话里那个永远推石头的西西弗斯。  
AI 工具迭代太快，今天有用的东西明天可能被替代。  
但这不是悲剧——加缪说，我们应该想象西西弗斯是幸福的。  
推石头本身就是意义。
