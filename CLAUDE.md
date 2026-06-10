# 问答匹配项目 — AI Coding Context

> 这份文档让 AI 编程助手（Cursor / Claude Code / GitHub Copilot 等）
> 了解项目背景。**请在每次新会话开始时阅读本文档。**

---

## 一句话定位

"AI 帮你把你自己用 AI 做出来的东西，重新装进你的脑子。"
个人知识记忆助手，帮你在重要会议中快速召回自己项目与资料的真实细节。

## 目标用户

需要在高密度会议（项目评审 / 技术讨论 / 向上汇报 / 客户沟通）中临场召回大量项目细节的知识工作者。

**痛点**：你做过的项目、准备过的资料都是真的，但会议高压下记不住细节、来不及翻文档，被追问时答不上来。

## 产品形态

- Desktop App（Mac + Windows）via **Electron**
- **本地优先**（用户数据 100% 在本地 SQLite）
- **BYOK（Bring Your Own Key）**：用户自带 LLM API key（Claude / GPT / Qwen / DeepSeek）
- Phase 1 = 12-13 周 MVP（pre-game：项目素材整理 + 卡片提取 + 导出）
- Phase 2 = iOS in-game（12 月后）

## 核心技术栈

**桌面端 (apps/desktop)**：
- Electron + React 18 + TypeScript + Tailwind CSS
- Vite 构建；electron-vite 模板
- Zustand（客户端 state）+ TanStack Query（服务端数据）
- Drizzle ORM + better-sqlite3（本地 SQLite；注：SQLCipher 全库加密尚未落地，敏感字段改用 safeStorage 加密——见下）
- Puppeteer（PDF 生成，复用 Electron Chromium）
- nodejieba 中文分词 + SQLite FTS5（搜索）
- Electron safeStorage（OS 派生密钥加密 LLM API key 后存本地 DB；非 keytar）
- shadcn/ui（copy-paste 组件，不引入完整库）

**后端 (apps/backend)**：
- Hono on Node.js（~5 endpoint，~200 行代码）
- Drizzle ORM + PostgreSQL（Fly.io managed）
- JWT auth（jose 库）
- Argon2id 密码 hash（新哈希；bcryptjs 仅用于校验历史 $2 哈希并在登录时透明升级）
- Zod schema validation
- 部署到 Fly.io 新加坡区域（单区起步）

**共享 (packages/shared)**：
- Zod schemas（API 输入输出）
- 共享 types
- 常量

## ⭐ 必读规范（按优先级）

> ⚠️ **文档现状**：早期 PRD 曾规划 `docs/02-Definition`、`docs/03-Architecture`、`docs/04-Implementation` 三套文档，**目前尚未落地**。当前**实际生效的规范以本文件（CLAUDE.md）+ 根目录 `CONTRIBUTING.md` 为准**。下表只列真实存在、可直接打开的文档。

| 优先级 | 文档 | 何时读 |
|---|---|---|
| 🔴 **P0** | `CLAUDE.md`（本文件「编码约定」「反模式」「工程纪律」三节） | **每次写新代码前** |
| 🔴 **P0** | `CONTRIBUTING.md`（根目录） | 必读 10 条规则速查 |
| 🟠 P1 | `docs/agents/domain.md` | 领域语言 / 决策入口 |
| 🟠 P1 | `docs/agents/issue-tracker.md` | 用 GitHub Issues 管 backlog 时 |
| 🟡 P2 | `docs/05-Decisions/` | 回溯历史决策时 |

**写代码前先读本文件「编码约定」+「反模式」两节，不要从零构造架构假设。**

<details>
<summary>📋 早期规划但尚未创建的文档（roadmap，勿作为引用）</summary>

以下路径在早期 PRD 中规划，目前文件系统中并不存在；保留此清单仅作未来补全的索引：
- `docs/02-Definition/`：2.1-PRD、2.3、2.4-Information-Architecture
- `docs/03-Architecture/`：3.2-Tech-Stack-ADRs、3.3-Data-Model、3.4-API-Design、3.5-Security-Privacy
- `docs/04-Implementation/`：4.1-Sprint-0-Setup、4.2-Development-Standards、4.3-Slash-Commands
</details>

## 🛡️ 4 层规范执行（强提醒）

1. **CLAUDE.md（本文档）** + **CONTRIBUTING.md** —— 你正在读
2. **Husky pre-commit hook** —— 违规直接挡住 `git commit`
3. **GitHub Actions CI** —— main 分支只接受通过测试 + 覆盖率达标的代码
4. **每周日 60 分钟 deep review** —— 必做不是建议

如果上面任一层失效（hook 被跳过、CI 标红、review 没做）—— 那就是工程纪律失败。

---

## Agent skills

### Issue tracker

GitHub Issues on [XilaiWang/qa-matching](https://github.com/XilaiWang/qa-matching). See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: 每周决定日志在 `docs/05-Decisions/`；领域说明见 `docs/agents/domain.md`。（独立的架构 / PRD 文档仍在规划中——见上文「必读规范」的 roadmap）

---

## 🧰 推荐的斜杠命令（基于 [mattpocock/skills](https://github.com/mattpocock/skills)）

我们采用 [mattpocock/skills](https://github.com/mattpocock/skills)（MIT 协议）作为**主动作战工具集**。这些 skill 与 4.2 规范是**互补关系**：
- 4.2 规范 = 被动防守（hook + CI 挡违规）
- mattpocock skills = 主动作战（每个动作前做对的事）

**一次性安装**（在 repo 根跑）：

```bash
npx skills@latest add mattpocock/skills
# 选择全部 engineering skills + /setup-matt-pocock-skills
# 然后在 Claude Code 里跑：
/setup-matt-pocock-skills
```

### 项目语境下的"何时用哪个 skill"

| Skill | 触发时机 | 与 4.2 规范对应 |
|---|---|---|
| **`/grill-with-docs`** | **启动每个新 F-MVP-X 之前**（即使有 PRD）| 补 PRD/IA 没覆盖的边角；自动维护 docs |
| **`/tdd`** | 写 F-MVP-4 提取管道 / auth-service / license-service | 直接实现 4.2 §2 测试策略 |
| **`/diagnose`** | 任何 non-trivial bug | 替代 "让 Cursor 修一下" 的反射动作 |
| **`/zoom-out`** | 改 AI 写过 / 7+ 天前的代码时 | 防 "AI 写的代码我看不懂" 反讽 |
| **`/improve-codebase-architecture`** | 每 2 周 sprint review 时跑一次 | 抗代码熵；补 4.2 §12.3 sprint cadence |
| **`/handoff`** | 长 session 结束 / 收工前 | 跨日 session 连续性；类似本周决定日志的强化版 |
| **`/to-issues`** | Tier 完成时拆下个 Tier | 用 GitHub Issues 管 backlog |
| **`/triage`** | 周日 review 时 bug ≥ 10 个 | 4.2 §12.2 weekly cadence 补充 |
| **`/caveman`** | AI 啰嗦 / token 紧张时 | 工具优化 |

### 不需要的 skill（已有更好方案）

| Skill | 跳过理由 |
|---|---|
| `/to-prd` | 已有 PRD 内容（`README.md` + 根目录 `INTERVIEW-MODE-PRD.md`）；独立 PRD 文档待整理 |
| `/setup-pre-commit` | 我们的 husky + commitlint + ESLint 配置更全（4.2 §3.5）|
| `/git-guardrails-claude-code` | 我们的 pre-commit hook 已覆盖 secrets / .env 拦截 |
| `/write-a-skill` | 创建新 skill 用，不是工作流 |

### 关键原则

- **每个新功能开工 → 先 `/grill-with-docs`** —— 哪怕已有 PRD。让 AI challenge 你的计划
- **测试驱动核心模块 → `/tdd`** —— F-MVP-4 提取管道必须走 red-green-refactor
- **遇 bug 不 panic → `/diagnose`** —— 不要让 AI 直接改代码救火
- **每 2 周 → `/improve-codebase-architecture`** —— 在变烂泥之前重构

（斜杠命令完整映射文档仍在规划中；当前实际可用的映射以本节表格为准。）

## 13 个 MVP 功能（按 Tier 1-3 排序）

**Tier 1（骨架，~6.5 周 AI coding）**：
- F-MVP-1 Auth（邮箱+密码+License+设备绑定）
- F-MVP-2 项目创建
- F-MVP-3 素材上传（URL + ZIP + 文件 + 文本）
- F-MVP-4 卡片提取（混合式 AI 流程）
- F-MVP-5 卡片库浏览

**Tier 2（可用，~3 周）**：
- F-MVP-7 卡片编辑
- F-MVP-12 上传引导清单（KM1）
- F-MVP-6 卡片搜索（中英文 FTS5）
- F-MVP-8 Cheat Sheet 导出（基础）

**Tier 3（差异化，~3 周）**：
- F-MVP-11 PDF 专业模板（KM3）
- F-MVP-10 项目克隆（KM5，二次激活）
- F-MVP-9 赛后回访问卷（KM4，主北星 B 数据）

加上 F-MVP-13 BYOK 配置流程贯穿全程。

## 编码约定

### TypeScript

- `strict: true` + `noUncheckedIndexedAccess: true`
- 所有 API 输入输出走 **Zod schema** 验证
- 不用 `any`；用 `unknown` + type guard
- 不用 enum；用 `as const` 数组：
  ```ts
  const cardTypes = ['tech_principle', 'domain_fact', ...] as const;
  type CardType = typeof cardTypes[number];
  ```
- 文件用 ESM（`.js` 后缀 import）

### React

- 函数式组件 only，**无 class**
- shadcn/ui copy-paste，**不引入完整 component 库**
- 不用 `useEffect` 做数据获取——用 **TanStack Query**
- 组件文件每个 ≤ 200 行，超过就拆

### Electron

- 主进程做 IO 和 DB；renderer 只做 UI
- IPC 用 `ipcMain.handle('channel', ...)` + `ipcRenderer.invoke(...)`，**不用 `send`**
- 任何 fs/db/keychain/网络操作**绝不**在 renderer 写
- `contextIsolation: true` + `nodeIntegration: false`

### 命名约定

- 文件：kebab-case（`card-library.tsx`）
- 组件：PascalCase（`CardLibrary`）
- 函数/变量：camelCase
- 常量：SCREAMING_SNAKE_CASE
- DB 表：snake_case；TS 字段：camelCase（Drizzle 自动转换）

### 错误处理

- 不抛 string；抛 Error 实例或自定义 typed error
- API 错误用 `{ ok, data, error }` envelope（实现见 `packages/shared` 与 `apps/backend/src/routes`）
- 客户端**永远先 check `ok`**

### 注释（强制）

**每个 AI 生成的关键函数 / 模块必须加 1-2 行注释说明"为什么"**。
这是产品策略要求（避免反讽风险：用 AI 写出自己看不懂的代码）。

格式示例：

```ts
// Why: Argon2id (memoryCost 64MB) resists GPU brute force far better than
// bcrypt at comparable latency; bcryptjs stays only to verify legacy $2 hashes.
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536 };
```

## 反模式（不要做）

❌ 在 renderer 进程直接 `import 'fs'` / `'better-sqlite3'` / `'electron'`（safeStorage 等只在主进程）
❌ 用 enum；用 `as const` 数组
❌ 用 `any` 跳过类型
❌ 在客户端 hardcode API key（**所有 LLM key 走 OS Keychain**）
❌ `console.log` 任何包含 password / token / API key 的对象
❌ 用 `useEffect` 做 fetch；用 TanStack Query
❌ 在 git commit 中包含 secrets（用 `.env` + `.gitignore`）
❌ 写 raw SQL；用 **Drizzle 查询**
❌ 写 CSS-in-JS；用 **Tailwind**
❌ 用 npm/yarn；用 **pnpm**

## 工程纪律

1. **代码意图注释** — 每个 AI 写的关键函数加"为什么"注释
2. **本周决定日志** — 每周末 5 分钟写"本周做了什么 / 为什么"
3. **ADR 人工写** — 架构决策由人手写、不交 AI 起草（`docs/03-Architecture/` 规划中；现阶段记录在 `docs/05-Decisions/`）
4. **单元测试** — F-MVP-4 卡片提取管道必须有测试
5. **依赖锁定** — package.json 严格锁版本；不让 AI 引入新版本
6. **Weekly self-review** — 每周抽 1h 回读 7 天前的代码

## 当前 Sprint

> **每周开始时更新这里**，让 AI 知道焦点

### Week 1（2026-05-17 至 2026-05-23）

**任务**：Sprint 0 仓库 setup + Backend skeleton + 第一个 endpoint

**焦点模块**：
- `apps/backend/src/db/schema.ts`（users + refresh_tokens）
- `apps/backend/src/routes/auth.ts`（POST /v1/auth/signup）
- `apps/backend/src/services/auth-service.ts`（bcrypt + JWT）

**完成定义**：
- [x] 仓库结构 + monorepo 配置
- [x] CLAUDE.md 写完
- [x] Hono server 跑通 + `/health` 返回 200
- [x] POST /v1/auth/signup 实现完毕（Zod validation + envelope + refresh token + 竞态修复）
- [x] PostgreSQL 实测 signup（本地 pg@16 容器）
- [x] POST /v1/auth/login 实现完毕（bcrypt + JWT + 防用户枚举）
- [x] Fly.io staging 部署成功
- [x] 本周决定日志写好（docs/05-Decisions/week-01-2026-05-17.md）

### Day 1-3 额外完成

- [x] ESLint 9 flat config + commitlint + Husky v9 pre-commit hook
- [x] `packages/shared` 共享 Zod schemas（signup/login）
- [x] Bug 修复：Zod validation → 标准 `{ok, data, error}` envelope
- [x] Bug 修复：signup 竞态条件（PG unique violation 23505 捕获）
- [x] Bug 修复：signup 签发 refresh token（30d TTL）
- [x] mattpocock/skills 14 个工程 skills 集成 + docs/agents/ 配置
- [x] Login 实现（bcrypt verify + JWT issue + 防用户枚举）
- [x] Bug 修复：refresh token 列宽 varchar(64) → varchar(128)（双 UUID 73 字符）
- [ ] GitHub token `workflow` scope 待修复（ci.yml 未推送）

（Sprint 0 setup 文档规划中；实际安装步骤见根目录 `SETUP-INSTRUCTIONS.md`）

### Week 2（2026-05-18 开始）

**任务**：桌面端骨架 + F-MVP-1 Auth UI

**完成定义**：
- [x] `apps/desktop` electron-vite 骨架（package.json + tsconfigs + tailwind + drizzle.config）
- [x] better-sqlite3 重建对接 Electron Node.js
- [x] 本地 SQLite schema（users_local + app_settings）+ migration 实测写入
- [x] 主进程 IPC 层（auth:login / auth:signup / auth:logout / auth:session）
- [x] contextBridge preload + window.api 类型声明
- [x] Renderer 登录/注册页 + HashRouter + Zustand auth store
- [x] `pnpm --filter @qa-matching/desktop dev` 能启动，typecheck 零错
- [x] 实测登录页接通本地后端 API（注册成功跳首页，密码错误有提示）
- [x] F-MVP-2 项目创建（空状态/项目列表/创建 Modal/跳转项目页，实测通过）
