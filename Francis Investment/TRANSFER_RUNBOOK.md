# Transfer Runbook · Francis Investment v3.4.9.9

新电脑完整迁移指南。A-stock 量化系统零外部依赖 Node.js，阿里云 ECS `8.153.101.112:8765`。

## 前置条件

- [ ] Windows 10/11 或 macOS/Linux
- [ ] Node.js >= 16 (推荐 18 LTS)
- [ ] Git + GitHub CLI (`gh auth login`)
- [ ] SSH 客户端 (Windows: Git Bash 自带)
- [ ] 浏览器 (Chrome/Edge 推荐)

## 1. Clone 仓库

```bash
git clone https://github.com/zhouzhean/FIRSTCC.git
cd FIRSTCC
```

## 2. 本地启动

```bash
cd "Francis Investment"
# 验证语法
node --check mosaic_server.js

# 本地运行 (前台)
node mosaic_server.js
# → http://localhost:8765
```

### 本地快捷启动

- **桌面快捷方式**: `open.vbs` — 双击在 Chrome `--app` 模式下打开云端 URL
  - 如需改为本地: 编辑 `open.vbs`，将 `http://8.153.101.112:8765` 改为 `http://localhost:8765`

## 3. 云端部署

| Item | Detail |
|------|--------|
| IP | `8.153.101.112` |
| Port | `8765` |
| OS | Ubuntu 22.04, 2 vCPU/2 GiB |
| 进程管理 | systemd `mosaic.service` (Restart=always) |
| 服务器路径 | `/root/FIRSTCC/Francis Investment/` |

### SCP 部署单文件

```bash
scp "<local_path>" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/<remote_path>"
```

### 部署后重启

```bash
ssh root@8.153.101.112 "systemctl restart mosaic"
```

### 确认运行

```bash
curl -s http://8.153.101.112:8765/api/status | head -c 500
```

### SSH Key 配置（免密登录）

```bash
# 第一步: 生成密钥 (如果新电脑没有)
ssh-keygen -t ed25519 -C "your-email@example.com"

# 第二步: 复制公钥到云端
ssh-copy-id root@8.153.101.112
# 或手动:
cat ~/.ssh/id_ed25519.pub | ssh root@8.153.101.112 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

## 4. 必须迁移的数据目录

**整个目录必须完整复制**（不能被 `.gitignore` 排除的运行时数据）:

```
report-engine/data/
├── research/
│   ├── snapshots/              # 654 个 JSONL 历史快照 (核心资产)
│   ├── model_artifacts/        # H1/H2 模型产物 + smoke summaries
│   ├── oos_evaluation_results/ # OOS 滚动评估
│   ├── trade_simulation/       # 交易模拟结果
│   └── candidate_registry.json # H1/H2 拒绝记录 + H3 锁定假设
├── simfolio/                   # Simfolio 持仓和预测
│   ├── simfolio_positions.json
│   ├── simfolio_capital.json
│   ├── simfolio_ledger.json
│   ├── prediction_ledger.json
│   └── pipeline_results_for_kernel.json
├── evolution/                  # Model registry + shadow tracking
│   ├── model_registry.json
│   ├── rejected_models.json
│   └── demotion_log.json
├── deploy_manifest.json        # 部署身份 (git 无法获取时回退)
└── daily_research_manifest_*.json  # 每日 canonical manifest
```

### .gitignore 确认

关键排除了这些目录（查看 `Francis Investment/.gitignore`）:

```
report-engine/data/simfolio/
report-engine/data/research/snapshots/
report-engine/data/research/model_artifacts/
report-engine/data/research/oos_evaluation_results/
report-engine/data/research/trade_simulation/
report-engine/data/evolution/
report-engine/data/deploy_manifest.json
```

### 迁移方式

**选项 A: 从旧电脑直接复制** (推荐 — 最快)
- 用 U盘 / 移动硬盘 / 局域网共享直接复制整个 `Francis Investment/` 目录
- 确保 `.git/` 目录也复制 (保留 git 历史)

**选项 B: 从云端下载**
```bash
scp -r root@8.153.101.112:/root/FIRSTCC/Francis\\ Investment/report-engine/data ./
```

**选项 C: 重新生成** (如果上述不可行)
- Clone 仓库后，检查 `report-engine/data/research/snapshots/` 是否为空
- 如果为空，需要运行 `node mosaic/research/historical_snapshot.js --regenerate`
- **注意**: 654 个快照生成需 2-4 小时，云端 2GB 内存可能 OOM

## 5. .env 处理

**当前项目无 `.env`** — 所有配置在 `mosaic/config.js` 中。

如果后续需要密钥（SMTP 等）:
- 创建 `.env.example` (不含真实密钥)
- 新电脑复制 `.env.example` → `.env`，手动填入密钥
- `.env` 必须在 `.gitignore` 中

## 6. K-line 数据源

阿里云 ECS 上 Eastmoney 被封锁，使用腾讯 `ifzq` 源。
配置在 `mosaic/config.js` 或 `mosaic/collectors/` 中。

## 7. 新电脑验收步骤

### Step 1: Git 状态
```bash
cd FIRSTCC
git status
git log --oneline -5
```

### Step 2: 语法验证
```bash
cd "Francis Investment"
node --check mosaic_server.js
node --check mosaic/simfolio.js
node --check mosaic/research/candidate_runner.js
```

### Step 3: 本地启动
```bash
node mosaic_server.js &
# 等待启动 (≈2秒)
```

### Step 4: API 健康检查
```bash
# 或使用一键脚本
powershell -File scripts/fi_health_check.ps1
```

### Step 5: 前端验证
- 浏览器打开 `http://localhost:8765`
- Cockpit → Research Lab → 确认 H1 REJECTED_RESEARCH + H2 REJECTED_RESEARCH 可见
- Cockpit → Canonical Cohort → 确认最新 canonical 日期

### Step 6: 云端部署验证
```bash
scp "mosaic_server.js" "root@8.153.101.112:/root/FIRSTCC/Francis Investment/mosaic_server.js"
ssh root@8.153.101.112 "systemctl restart mosaic"
sleep 3
curl -s http://8.153.101.112:8765/api/status
```

### Step 7: 确认 5 个 API 全部通过
- [ ] `/api/status` — version, buildCommit, uptime
- [ ] `/api/cockpit` — Research Lab 数据完整
- [ ] `/api/prediction-settlement` — prediction ledger
- [ ] `/api/cohort-integrity` — canonical cohort
- [ ] `/api/think-tank/decision-status` — Think Tank

## 8. 常见问题

| 问题 | 解决 |
|------|------|
| `gh auth login` 失败 | 浏览器登录 GitHub → Settings → Developer settings → Personal access tokens → 生成 token |
| `scp: Permission denied` | 检查 `~/.ssh/id_ed25519.pub` 是否已添加到云端 |
| 本地启动后浏览器空白 | 检查 `node --check mosaic_server.js` 是否通过 |
| snapshots 目录为空 | 从旧电脑/云端复制，或重新生成 |
| Cloud OOM on walk-forward | 云端仅 2GB，full walk-forward 需本地执行或 `--max-old-space-size=1536` |
| Eastmoney 无法访问 | 确认使用腾讯 ifzq 源 (ECS 特定问题) |
