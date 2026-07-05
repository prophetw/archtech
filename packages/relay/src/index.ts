import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';
import cors from 'cors';
import path from 'path';

// ====== 配置 ======
const PORT = parseInt(process.env.PORT || '4190', 10);
const RELAY_SECRET = process.env.RELAY_SECRET;

if (!RELAY_SECRET) {
  console.error('❌ 缺少 RELAY_SECRET 环境变量，请设置后启动');
  console.error('   RELAY_SECRET=你的密钥 npm start');
  process.exit(1);
}

console.log(`🔐 RELAY_SECRET: ${'*'.repeat(RELAY_SECRET.length)}`);

const app = express();
app.use(cors());

// 内置 viewer 静态页面
const viewerPath = process.env.VIEWER_PATH || path.resolve(__dirname, '../../viewer/dist');
app.use(express.static(viewerPath));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB
  pingInterval: 30_000,
  pingTimeout: 10_000,
});

// ====== 房间管理 ======
const MAX_FAILED_ATTEMPTS = 10;
const ROOM_TTL_MS = 3600_000; // 1 小时

interface Room {
  id: string;
  password: string;
  hostSocketId: string;
  createdAt: Date;
  failedAttempts: number;
  locked: boolean;
}

const rooms = new Map<string, Room>();

function generatePassword(): string {
  return crypto.randomBytes(3).toString('hex'); // 6 位 hex
}

// ====== 简易 IP 速率限制 ======
const ipConnections = new Map<string, { count: number; resetAt: number }>();
const MAX_CONN_PER_IP = 30; // 每分钟每个 IP 最多 30 个连接

function checkIpRate(ip: string): boolean {
  const now = Date.now();
  const entry = ipConnections.get(ip);
  if (!entry || now > entry.resetAt) {
    ipConnections.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= MAX_CONN_PER_IP) return false;
  entry.count++;
  return true;
}

// ====== Socket.IO ======
io.on('connection', (socket) => {
  const clientIp =
    (socket.handshake.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    socket.handshake.address;

  // IP 速率检查
  if (!checkIpRate(clientIp)) {
    console.log(`⛔ IP ${clientIp} 连接过于频繁，拒绝`);
    socket.disconnect(true);
    return;
  }

  console.log(`[连接] ${socket.id} (${clientIp})`);

  // ====== CLI 端：创建房间 ======
  socket.on('host:register', (roomId: string, secret: string, callback) => {
    // 1. 验证 RELAY_SECRET
    if (secret !== RELAY_SECRET) {
      console.log(`⛔ ${socket.id} 尝试创建房间但密钥错误`);
      callback({ ok: false, error: '密钥错误，无权创建房间' });
      return;
    }

    // 2. 创建房间
    const password = generatePassword();
    rooms.set(roomId, {
      id: roomId,
      password,
      hostSocketId: socket.id,
      createdAt: new Date(),
      failedAttempts: 0,
      locked: false,
    });

    socket.join(roomId);
    console.log(`[房间] ${roomId} 已创建，密码 ${password}`);
    callback({ ok: true, roomId, password });
  });

  // ====== 手机端：加入房间 ======
  socket.on('viewer:join', (roomId: string, password: string, callback) => {
    const room = rooms.get(roomId);

    // 不存在
    if (!room) {
      callback({ ok: false, error: '房间不存在或已过期' });
      return;
    }

    // 已锁定
    if (room.locked) {
      callback({ ok: false, error: '房间因尝试次数过多已锁定' });
      return;
    }

    // 密码错误
    if (password !== room.password) {
      room.failedAttempts++;
      console.log(`[认证] ${roomId} 密码错误 (${room.failedAttempts}/${MAX_FAILED_ATTEMPTS})`);

      if (room.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        room.locked = true;
        console.log(`[锁定] ${roomId} 超过最大尝试次数，已锁定`);
        callback({ ok: false, error: '尝试次数过多，房间已锁定' });
        return;
      }

      callback({ ok: false, error: '房间密码错误' });
      return;
    }

    // 成功
    room.failedAttempts = 0; // 重置
    socket.join(roomId);
    console.log(`[加入] viewer ${socket.id} 进入 ${roomId}`);
    callback({ ok: true });
  });

  // ====== 消息转发 ======

  // 手机端 -> CLI：请求图片列表
  socket.on('cmd:list', (roomId: string) => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.to(roomId).emit('cmd:list', socket.id);
  });

  // CLI -> 手机端：返回图片列表
  socket.on('res:list', (roomId: string, files: string[]) => {
    socket.to(roomId).emit('res:list', files);
  });

  // 手机端 -> CLI：请求单张图片
  socket.on('cmd:image', (roomId: string, filename: string) => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.to(roomId).emit('cmd:image', filename, socket.id);
  });

  // CLI -> 手机端：返回图片数据
  socket.on('res:image', (roomId: string, data: { filename: string; data: string; mime: string }) => {
    socket.to(roomId).emit('res:image', data);
  });

  // ====== 断开 ======
  socket.on('disconnect', () => {
    // 如果是 host 断开，销毁房间
    for (const [id, room] of rooms) {
      if (room.hostSocketId === socket.id) {
        rooms.delete(id);
        console.log(`[销毁] 房间 ${id} (host 断开)`);
        break;
      }
    }
    console.log(`[断开] ${socket.id}`);
  });
});

// ====== 过期房间清理 ======
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt.getTime() > ROOM_TTL_MS) {
      rooms.delete(id);
      console.log(`[清理] 房间 ${id} 已过期`);
    }
  }
}, 60_000);

// ====== 健康检查 ======
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    uptime: process.uptime(),
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🔗 中继服务器运行在 http://0.0.0.0:${PORT}`);
  console.log(`📱 手机端: http://<ip>:${PORT}`);
  console.log(`🩺 健康检查: http://<ip>:${PORT}/health\n`);
});
