import { io, Socket } from 'socket.io-client';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mime from 'mime-types';

// ====== 配置 ======
const RELAY_URL = process.env.RELAY_URL || 'http://localhost:3000';
const RELAY_SECRET = process.env.RELAY_SECRET;
const TARGET_DIR = process.argv[2] || process.cwd();

if (!RELAY_SECRET) {
  console.error('❌ 缺少 RELAY_SECRET 环境变量');
  console.error('   RELAY_SECRET=你的密钥 RELAY_URL=https://relay.example.com imgview ./文件夹');
  process.exit(1);
}

// 支持的图片格式
const IMG_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.heic', '.heif',
]);

function isImage(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return IMG_EXTS.has(ext);
}

function scanImages(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => {
        const full = path.join(dir, f);
        return fs.statSync(full).isFile() && isImage(f);
      })
      .sort();
  } catch {
    return [];
  }
}

// ====== 主逻辑 ======
async function main() {
  const absDir = path.resolve(TARGET_DIR);
  const folderName = path.basename(absDir);
  const roomId = `img_${crypto.randomBytes(4).toString('hex')}_${Date.now()}`;

  console.log(`\n📂 目录: ${absDir}`);
  console.log(`🔗 中继: ${RELAY_URL}`);
  console.log(`🏠 房间: ${roomId}\n`);

  const images = scanImages(absDir);
  console.log(`🖼️  发现 ${images.length} 张图片\n`);

  // 连接中继
  const socket: Socket = io(RELAY_URL);

  socket.on('connect', () => {
    console.log('✅ 已连接中继服务器');

    // 注册房间 — 发送密钥
    socket.emit('host:register', roomId, RELAY_SECRET, (res: any) => {
      if (!res.ok) {
        console.error(`❌ 创建房间失败: ${res.error}`);
        process.exit(1);
      }

      const roomPassword = res.password;

      // 生成二维码
      const qrUrl = `${RELAY_URL}?room=${roomId}&password=${roomPassword}`;

      QRCode.toString(qrUrl, { type: 'terminal', small: true }).then((qrStr) => {
        console.log(qrStr);
      });

      console.log(`🔑 房间密码: ${roomPassword}`);
      console.log(`📱 扫码或访问: ${qrUrl}\n`);
      console.log('👀 等待手机连接... (Ctrl+C 退出)\n');
    });
  });

  socket.on('connect_error', (err) => {
    console.error(`❌ 连接中继失败: ${err.message}`);
    process.exit(1);
  });

  // 收到手机端的列表请求
  socket.on('cmd:list', () => {
    const files = scanImages(absDir);
    socket.emit('res:list', roomId, files);
    console.log(`📋 发送文件列表: ${files.length} 张`);
  });

  // 收到手机端的图片请求
  socket.on('cmd:image', (filename: string, viewerId: string) => {
    const filePath = path.join(absDir, filename);

    // 安全检查：防止目录遍历
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(absDir)) {
      console.log(`⛔ 拒绝访问: ${filename}`);
      return;
    }

    try {
      const data = fs.readFileSync(filePath);
      const b64 = data.toString('base64');
      const mimeType = mime.lookup(filePath) || 'image/jpeg';

      socket.emit('res:image', roomId, {
        filename,
        data: b64,
        mime: mimeType,
      });
      console.log(`📤 发送图片: ${filename} (${(data.length / 1024).toFixed(1)}KB)`);
    } catch (err) {
      console.log(`❌ 读取失败: ${filename}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`❌ 与中继断开: ${reason}`);
  });

  // 文件变化监听
  const chokidar = await import('chokidar');
  const watcher = chokidar.watch(absDir, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
  });

  watcher.on('add', (fp: string) => {
    if (isImage(fp)) console.log(`➕ 新增: ${path.basename(fp)}`);
  });
  watcher.on('unlink', (fp: string) => {
    if (isImage(fp)) console.log(`➖ 删除: ${path.basename(fp)}`);
  });

  // 优雅退出
  const cleanup = () => {
    console.log('\n👋 退出...');
    watcher.close();
    socket.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(console.error);
