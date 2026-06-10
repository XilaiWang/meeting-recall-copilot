# 贡献指南 / Contributing

> 这份文档放在仓库**根目录**作为高可见性 reminder。
> 完整开发规范见根目录 `CLAUDE.md`（编码约定 / 反模式 / 工程纪律三节）。

---

## 🚨 必读规则（10 条）

1. **TypeScript strict 全开**——`any` 是红线
2. **所有 LLM API key 进 OS Keychain，不进数据库/日志/commit**
3. **AI 写的关键函数必须有 "Why:" 注释**（不是"做什么"）
4. **Conventional Commits 格式**：`type(scope): desc`
5. **Solo 阶段直接 main**——不搞 feature branch
6. **每 commit 跑 `pnpm preflight`**（含 typecheck + lint + 相关测试）
7. **AI 写代码必须同时写测试**——不允许"先写代码后补测试"
8. **F-MVP-4 卡片提取测试覆盖率 ≥ 90%**——产品最易回归的部分
9. **写新 dep 前过依赖 5 问**（必要性 / 维护活跃度 / 体积 / 安全 / 能否自写）——见 `CLAUDE.md` 反模式「用 npm/yarn；用 pnpm」与「依赖锁定」
10. **每周日晚 30 分钟 deep review**——这是必做不是建议

## 🤖 给 AI 编程助手的指引

**每次新会话开始时，请阅读** `CLAUDE.md`（本仓完整规范）。

写新代码前请确认你已读：
- 编码约定与反模式（`CLAUDE.md` 对应章节）
- 现有实现参考：API/schema 见 `packages/shared` 与 `apps/backend/src/routes`，数据模型见各 `db/schema.ts`
- 历史决策（`docs/05-Decisions/`）

> PRD / API spec / 数据模型的独立文档（`docs/02-Definition`、`docs/03-Architecture`）仍在规划中，暂以代码与本指南为准。不要从零构造架构假设。

## 📋 提交前 Quick Check（5 分钟）

跑这一个命令，等价于过完 9 项 checklist：

```bash
pnpm preflight
```

它会执行：
- `pnpm typecheck` （TypeScript 严格检查）
- `pnpm lint` （ESLint）
- `pnpm test:unit` （相关单元测试）

如果你跳过 `preflight` 直接 `git commit`，**husky pre-commit hook 也会拦截你**（见 `.husky/pre-commit`）。

## 📝 Commit Message 格式

```
type(scope): brief description
```

**Type**：`feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `perf` / `style` / `build`

**Scope**：`backend` / `desktop-main` / `desktop-renderer` / `db` / `auth` / `license` / `extract` / `parser` / `pdf` / `ipc` / `ci` / `docs` / `deps`

**示例**：
- ✅ `feat(auth): add POST /v1/auth/signup endpoint`
- ✅ `fix(extract): handle empty material array`
- ✅ `test(license): cover device-limit-exceeded path`

如果违规，commitlint 会拒绝你的 commit。

## 🚀 第一次 Setup（一次性）

```bash
pnpm install
pnpm exec husky init
cp .husky/pre-commit.template .husky/pre-commit
cp .husky/commit-msg.template .husky/commit-msg
chmod +x .husky/*
```

setup 后所有 hook 永久生效。

## 🧰 推荐斜杠命令（每天都用）

我们集成 [mattpocock/skills](https://github.com/mattpocock/skills) 作为主动作战工具：

- `/grill-with-docs` — 每个新功能开工前，让 AI 质问你的计划
- `/tdd` — 核心模块写测试驱动开发
- `/diagnose` — bug 时用结构化诊断流程，不要 "Cursor 帮我改一下"
- `/zoom-out` — 改不熟悉代码前先了解 context
- `/improve-codebase-architecture` — 每 2 周跑一次防代码烂泥
- `/handoff` — 收工前留好下次接续的笔记

（斜杠命令的完整映射文档仍在规划中；上面列表即当前实际常用命令。）

## 🔗 规范文档

**现存（可直接打开）：**
- [`CLAUDE.md`](CLAUDE.md) — AI 工具上下文 + 完整编码约定 / 反模式 / 工程纪律
- [`docs/agents/`](docs/agents/) — 领域语言、Issue tracker、triage label 约定
- [`docs/05-Decisions/`](docs/05-Decisions/) — 每周决定日志

**规划中（尚未创建，勿作引用）：** `docs/02-Definition`（PRD / IA）、`docs/03-Architecture`（数据模型 / API / 安全）、`docs/04-Implementation`（开发规范 / 斜杠命令 / Sprint setup）。
