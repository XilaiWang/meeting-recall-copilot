# Husky Hook 模板

由于沙盒限制，hook 模板放在这里，**首次 setup 时拷贝到 `.husky/`**：

```bash
# 在仓库根
pnpm exec husky init

cp husky-templates/pre-commit .husky/pre-commit
cp husky-templates/commit-msg .husky/commit-msg
chmod +x .husky/pre-commit .husky/commit-msg

# 验证
echo "test" > scratch.txt
git add scratch.txt
git commit -m "wip"  # 应该被 commitlint 挡住
rm scratch.txt
git reset
```

激活后 `.husky/` 下的 hook 永久生效，**违规 commit 提交不上来**。

## 临时跳过（紧急情况）

```bash
git commit --no-verify -m "..."
```

⚠️ 慎用——绕过 hook = 让违规进 main。仅用于：
- 紧急 hotfix 已知 lint pass 时间不够
- 引入大批 vendor 代码（如 shadcn 复制粘贴）

跳过后必须在下一个 commit 修复违规。
