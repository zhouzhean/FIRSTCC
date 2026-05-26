#!/bin/bash
# Mosaic Cloud Deployment Script
# Run this on the Alibaba Cloud ECS server as root

set -e

echo "======================================"
echo " Mosaic 云端部署脚本"
echo "======================================"

# ---- Step 1: Update system ----
echo "[1/6] 更新系统..."
apt update && apt upgrade -y

# ---- Step 2: Install Node.js 20.x ----
echo "[2/6] 安装 Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
node -v
echo "Node.js 安装完成"

# ---- Step 3: Clone repo ----
echo "[3/6] 克隆代码..."
cd /root
if [ -d "FIRSTCC" ]; then
  cd FIRSTCC && git pull
else
  git clone https://github.com/zhouzhean/FIRSTCC.git
fi

cd "FIRSTCC/Francis Investment"

# ---- Step 4: Patch server to bind 0.0.0.0 ----
echo "[4/6] 修改绑定地址..."
sed -i "s/server\.listen(PORT, '[^']*'/server.listen(PORT, '0.0.0.0'/" mosaic_server.js
echo "已改为 0.0.0.0"

# ---- Step 5: Create systemd service ----
echo "[5/6] 注册 24/7 系统服务..."
cat > /etc/systemd/system/mosaic.service << 'SERVICEOF'
[Unit]
Description=Mosaic Quantitative Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/FIRSTCC/Francis Investment
ExecStart=/usr/bin/node /root/FIRSTCC/Francis Investment/mosaic_server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICEOF

systemctl daemon-reload
systemctl enable mosaic
systemctl start mosaic
sleep 2
systemctl status mosaic --no-pager

# ---- Step 6: Open local firewall (if ufw is active) ----
echo "[6/6] 检查防火墙..."
if ufw status | grep -q active; then
  ufw allow 8765/tcp
  echo "ufw 已开放 8765 端口"
else
  echo "ufw 未启用，跳过"
fi

echo ""
echo "======================================"
echo " 部署完成！"
echo " 浏览器打开: http://8.153.101.112:8765"
echo "======================================"
