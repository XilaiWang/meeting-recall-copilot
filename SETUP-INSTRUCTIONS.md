# 启动包使用说明

这个文件夹包含了 Week 1 Day 1-2 所需的**全部初始文件**。

## 使用步骤

### 1. 创建 GitHub repo（5 分钟）

```bash
# 在 GitHub 创建 private repo: qa-matching
# 本地 clone
cd ~/Documents/Code  # 或你常用的代码目录
git clone git@github.com:你的用户名/qa-matching.git
cd qa-matching
```

### 2. 复制启动包到 repo 根

```bash
# 假设你在 qa-matching/ 目录里
cp -r /Users/xilaiwang/Documents/Claude/Projects/问答匹配项目/04-Implementation/starter/* .
cp /Users/xilaiwang/Documents/Claude/Projects/问答匹配项目/04-Implementation/starter/.gitignore .

# 把 SETUP-INSTRUCTIONS.md 删掉（你已经看完了）
rm SETUP-INSTRUCTIONS.md

# 软链接（或定期同步）docs/
ln -s ~/Documents/Claude/Projects/问答匹配项目 docs
# Windows: 用 mklink /D docs "..."
```

### 3. 安装 pnpm + 依赖

```bash
# 安装 pnpm（如果还没装）
npm install -g pnpm@9

# 在仓库根
pnpm install
```

### 3.5 激活 Husky Git Hooks（**关键，一次性**）

这一步把"开发规范"从文档变成强制执行：

```bash
# 安装 husky 并初始化
pnpm exec husky init

# 拷贝我们的 hook 模板
cp husky-templates/pre-commit .husky/pre-commit
cp husky-templates/commit-msg .husky/commit-msg
chmod +x .husky/pre-commit .husky/commit-msg

# 验证：尝试一个违规 commit
echo "test" > scratch.txt
git add scratch.txt
git commit -m "wip"
# 应该看到 ❌ commitlint 拒绝（"wip" 不符合 conventional commits）
rm scratch.txt
git reset
```

激活后**所有违规 commit 自动挡住**：
- TypeScript 错误
- ESLint 错误
- `.env` 文件
- 包含 `sk-`、`AKIA` 等 secret prefix 的代码
- Console.log 含 password / token
- 非 conventional 格式的 commit message

### 4. 启动本地 PostgreSQL（用 Docker）

```bash
cd apps/backend
cp .env.example .env

# 生成 JWT secrets 并写入 .env
echo "JWT_ACCESS_SECRET=$(openssl rand -base64 32)" >> .env
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 32)" >> .env

# 启动 PostgreSQL
docker compose up -d
```

### 5. 跑 migration

```bash
# 仍在 apps/backend/
pnpm db:generate  # 生成 SQL migration 文件
pnpm db:migrate   # 应用到 DB
```

### 6. 启动后端 dev server

```bash
pnpm dev
```

打开浏览器访问 `http://localhost:3000/health`，看到 `{"ok":true,"version":"0.0.1"}` 即成功 ✅

### 7. 测试注册端点

```bash
curl -X POST http://localhost:3000/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test1234"}'
```

应该返回类似：

```json
{
  "ok": true,
  "data": {
    "user": { "id": "...", "email": "test@example.com", ... },
    "accessToken": "eyJ..."
  },
  "error": null
}
```

🎉 **Day 1 + Day 2 任务完成**——后端骨架跑起来了。

### 7.5 安装 mattpocock/skills 斜杠命令工具集

在仓库根（任何时候都可以做）：

```bash
# 一次性安装
npx skills@latest add mattpocock/skills

# 必选：grill-with-docs, tdd, diagnose, zoom-out, improve-codebase-architecture,
#       handoff, setup-matt-pocock-skills
# 可选：to-issues, triage, caveman
# 跳过：to-prd, setup-pre-commit, git-guardrails-claude-code

# 在 Claude Code 中初始化
# /setup-matt-pocock-skills
# 选项：GitHub Issues + 标签 bug/feature/chore/tech-debt/security + docs/ 路径
```

完整何时用哪个见 `CLAUDE.md`「推荐的斜杠命令」一节。

**最常用 3 个**：
- `/grill-with-docs` — 每个新功能开工前
- `/tdd` — 写 F-MVP-4 / auth / license 等核心模块
- `/diagnose` — 任何 non-trivial bug

### 8. 提交第一个 commit

```bash
git add .
git commit -m "feat: initial setup with auth signup endpoint"
git push
```

## 接下来

- **Day 3**：实现 POST /v1/auth/login + JWT refresh（用 CLAUDE.md 的 prompt 模板让 Cursor 写）
- **Day 4**：添加 licenses + devices 表
- **Day 5**：完整 license activate / status / unbind 流程

（Sprint 0 setup 详档规划中；当前进度见 `CLAUDE.md`「当前 Sprint」一节与 `docs/05-Decisions/`）

## 如果遇到问题

常见坑：
- **`bcrypt` 安装失败**：macOS 上需 `xcode-select --install`；Linux 需要 `python3 build-essential`
- **PostgreSQL 连不上**：检查 `docker ps`，确认 5432 端口没被占
- **`pnpm: command not found`**：`brew install pnpm` 或 `npm install -g pnpm@9`

来回找我即可。
