import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { INITIAL_USERS, INITIAL_ITEMS, INITIAL_SURAT } from './src/services/storageService.ts';
import { INITIAL_IKU_ITEMS } from './src/services/ikuData.ts';
import { INITIAL_PERIODE_LIST, INITIAL_TUJUAN_SASARAN_ITEMS } from './src/services/tujuanSasaranData.ts';
import { DEFAULT_SECURITY_CONFIG } from './src/services/securityService.ts';
import { pgService } from './src/services/pgService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Enable proxy trust for Cloudflare Tunnel & reverse proxies
app.set('trust proxy', true);

// Cross-Origin & Custom Domain support
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, CF-Connecting-IP, X-Forwarded-Proto');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Persistent data directory on host / container
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Safe JSON file operations (Fallback & Local Mirror)
function loadJsonFile<T>(filename: string, defaultValue: T): T {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      saveJsonFile(filename, defaultValue);
      return defaultValue;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return defaultValue;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[Server DB] Gagal membaca ${filename}, menggunakan default:`, err);
    return defaultValue;
  }
}

function saveJsonFile<T>(filename: string, data: T): void {
  const filePath = path.join(DATA_DIR, filename);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error(`[Server DB] Gagal menyimpan ${filename}:`, err);
  }
}

// Physical Storage Directory on host / CasaOS disk
const STORAGE_FILES_DIR = path.join(DATA_DIR, 'storage');

// Helper to sanitize folder/user name
function sanitizeFolderName(name: string): string {
  return (name || 'user')
    .toLowerCase()
    .replace(/,\s*[A-Za-z.\s]+$/g, '')
    .replace(/^(Dr\.|Drs\.|Ir\.|H\.|Hj\.)\s+/gi, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '');
}

// Automatically create physical folder structure for every user on CasaOS disk
function ensureUserStorageFolders(userList: any[]) {
  try {
    const baseFolders = [
      path.join(STORAGE_FILES_DIR, 'Folder_Publik'),
      path.join(STORAGE_FILES_DIR, 'Menu_Bidang'),
      path.join(STORAGE_FILES_DIR, 'File_Saya'),
    ];
    for (const folder of baseFolders) {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
    }

    // Create a dedicated folder for each registered user
    for (const u of userList) {
      const folderName = sanitizeFolderName(u.username || u.name);
      const userFolder = path.join(STORAGE_FILES_DIR, 'File_Saya', folderName);
      if (!fs.existsSync(userFolder)) {
        fs.mkdirSync(userFolder, { recursive: true });
      }
    }
  } catch (err) {
    console.warn('[Server Storage] Warning creating user folders:', err);
  }
}

// Save uploaded item file to disk in user's dedicated folder
function saveItemFileToDisk(item: any, usersList: any[]) {
  if (item.type !== 'file' || !item.dataUrl || !item.name) return;
  try {
    let targetDir = path.join(STORAGE_FILES_DIR, 'Folder_Publik');
    if (item.scope === 'bidang') {
      const bCat = sanitizeFolderName(item.bidangCategory || 'Bidang PME');
      targetDir = path.join(STORAGE_FILES_DIR, 'Menu_Bidang', bCat);
    } else if (item.scope === 'private') {
      const owner = usersList.find((u: any) => u.id === item.ownerId || u.email === item.ownerEmail);
      const uname = sanitizeFolderName(owner?.username || owner?.name || item.ownerName || 'user');
      targetDir = path.join(STORAGE_FILES_DIR, 'File_Saya', uname);
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const cleanFileName = item.name.replace(/[/\\?%*:|"<>]/g, '_');
    const destPath = path.join(targetDir, cleanFileName);

    if (item.dataUrl.startsWith('data:')) {
      const base64Data = item.dataUrl.split(';base64,').pop();
      if (base64Data) {
        fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
      }
    }
  } catch (err) {
    console.warn('[Disk Storage] Gagal menyimpan berkas ke disk fisik:', err);
  }
}

// Initialize seed data on disk if not present
const initialUsersOnBoot = loadJsonFile('users.json', INITIAL_USERS);
loadJsonFile('storage_items.json', INITIAL_ITEMS);
loadJsonFile('surat.json', INITIAL_SURAT);
loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);

// Ensure folders exist on startup
ensureUserStorageFolders(initialUsersOnBoot);

// Auto-seed into PostgreSQL if connected and database is fresh
async function autoSeedPostgresIfFresh() {
  if (!pgService.getStatus().connected) return;
  try {
    const existingUsers = await pgService.getUsers();
    if (!existingUsers || existingUsers.length === 0) {
      console.log('🌱 Database PostgreSQL masih kosong, melakukan auto-seeding data awal instansi...');
      const users = loadJsonFile('users.json', INITIAL_USERS);
      const items = loadJsonFile('storage_items.json', INITIAL_ITEMS);
      const suratList = loadJsonFile('surat.json', INITIAL_SURAT);
      const ikuList = loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
      const periodeList = loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
      const tujuanSasaranList = loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
      const securityConfig = loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);

      await pgService.saveUsers(users);
      await pgService.saveStorageItems(items);
      await pgService.saveSuratList(suratList);
      await pgService.saveIKUList(ikuList);
      await pgService.savePeriodeList(periodeList);
      await pgService.saveTujuanSasaranList(tujuanSasaranList);
      await pgService.saveSetting('security_config', securityConfig);
      console.log('✅ Auto-seeding PostgreSQL berhasil diselesaikan!');
    }
  } catch (err) {
    console.warn('[PostgreSQL AutoSeed Error]:', err);
  }
}

// =========================================================================
//                   DATABASE API ENDPOINTS (POSTGRESQL + FALLBACK)
// =========================================================================

// 0. Database Status & Engine Health
app.get('/api/db/status', async (_req: Request, res: Response) => {
  const status = pgService.getStatus();
  const counts = await pgService.getTableCounts();
  res.json({
    success: true,
    status: {
      ...status,
      tableCounts: counts,
      storageFilesDir: STORAGE_FILES_DIR,
    },
  });
});

// 1. Unified Sync Endpoint - Bootstraps all data for any device in one round-trip
app.get('/api/db/sync-all', async (_req: Request, res: Response) => {
  let users: any[] | null = null;
  let items: any[] | null = null;
  let suratList: any[] | null = null;
  let ikuList: any[] | null = null;
  let periodeList: any[] | null = null;
  let tujuanSasaranList: any[] | null = null;
  let securityConfig: any = null;

  if (pgService.getStatus().connected) {
    users = await pgService.getUsers();
    items = await pgService.getStorageItems();
    suratList = await pgService.getSuratList();
    ikuList = await pgService.getIKUList();
    periodeList = await pgService.getPeriodeList();
    tujuanSasaranList = await pgService.getTujuanSasaranList();
    securityConfig = await pgService.getSetting('security_config');
  }

  // Fallback to local JSON files if null or pg disconnected
  users = users && users.length > 0 ? users : loadJsonFile('users.json', INITIAL_USERS);
  items = items !== null ? items : loadJsonFile('storage_items.json', INITIAL_ITEMS);
  suratList = suratList !== null ? suratList : loadJsonFile('surat.json', INITIAL_SURAT);
  ikuList = ikuList !== null ? ikuList : loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
  periodeList = periodeList && periodeList.length > 0 ? periodeList : loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
  tujuanSasaranList = tujuanSasaranList !== null ? tujuanSasaranList : loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
  securityConfig = securityConfig || loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);
  const customLogo = loadJsonFile('custom_logo.json', { url: null });

  res.json({
    success: true,
    engine: pgService.getStatus().connected ? 'postgresql' : 'file-json',
    users,
    items,
    suratList,
    ikuList,
    periodeList,
    tujuanSasaranList,
    securityConfig,
    customLogo: customLogo.url,
  });
});

// 2. Users Database
app.get('/api/db/users', async (_req: Request, res: Response) => {
  let users: any[] | null = null;
  if (pgService.getStatus().connected) {
    users = await pgService.getUsers();
  }
  if (!users) {
    users = loadJsonFile('users.json', INITIAL_USERS);
  }
  res.json({ success: true, users });
});

app.post('/api/db/users', async (req: Request, res: Response) => {
  const { users, user } = req.body;
  let currentUsers = loadJsonFile('users.json', INITIAL_USERS);

  if (Array.isArray(users)) {
    currentUsers = users;
  } else if (user && user.id) {
    const idx = currentUsers.findIndex((u: any) => u.id === user.id);
    if (idx >= 0) {
      currentUsers[idx] = { ...currentUsers[idx], ...user };
    } else {
      currentUsers.push(user);
    }
  }

  // Ensure default admin always exists
  const hasAdmin = currentUsers.some((u: any) => u.role === 'admin' || u.username === 'admin' || u.id === 'user_admin');
  if (!hasAdmin) {
    currentUsers.unshift(INITIAL_USERS[0]);
  }

  // 1. Mirror to JSON file
  saveJsonFile('users.json', currentUsers);

  // 2. Save to PostgreSQL if connected
  if (pgService.getStatus().connected) {
    await pgService.saveUsers(currentUsers);
  }

  // 3. Automatically create personal folders on CasaOS disk
  ensureUserStorageFolders(currentUsers);

  res.json({ success: true, users: currentUsers });
});

// 3. Storage Items Persistence
app.post('/api/db/storage-items', async (req: Request, res: Response) => {
  const { items } = req.body;
  if (Array.isArray(items)) {
    // 1. Mirror to JSON
    saveJsonFile('storage_items.json', items);

    // 2. Save to PostgreSQL
    if (pgService.getStatus().connected) {
      await pgService.saveStorageItems(items);
    }

    // 3. Save actual uploaded files to their respective user folders on disk
    const currentUsers = loadJsonFile('users.json', INITIAL_USERS);
    for (const item of items) {
      saveItemFileToDisk(item, currentUsers);
    }

    res.json({ success: true, count: items.length });
  } else {
    res.status(400).json({ success: false, message: 'Data items harus berupa array.' });
  }
});

// 4. Surat Persistence
app.post('/api/db/surat', async (req: Request, res: Response) => {
  const { suratList } = req.body;
  if (Array.isArray(suratList)) {
    saveJsonFile('surat.json', suratList);
    if (pgService.getStatus().connected) {
      await pgService.saveSuratList(suratList);
    }
    res.json({ success: true, count: suratList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data suratList harus berupa array.' });
  }
});

// 5. IKU Persistence
app.post('/api/db/iku', async (req: Request, res: Response) => {
  const { ikuList } = req.body;
  if (Array.isArray(ikuList)) {
    saveJsonFile('iku.json', ikuList);
    if (pgService.getStatus().connected) {
      await pgService.saveIKUList(ikuList);
    }
    res.json({ success: true, count: ikuList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data ikuList harus berupa array.' });
  }
});

// 6. Periode RPJMD Persistence
app.post('/api/db/periode-rpjmd', async (req: Request, res: Response) => {
  const { periodeList } = req.body;
  if (Array.isArray(periodeList)) {
    saveJsonFile('periode_rpjmd.json', periodeList);
    if (pgService.getStatus().connected) {
      await pgService.savePeriodeList(periodeList);
    }
    res.json({ success: true, count: periodeList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data periodeList harus berupa array.' });
  }
});

// 7. Tujuan & Sasaran Persistence
app.post('/api/db/tujuan-sasaran', async (req: Request, res: Response) => {
  const { tujuanSasaranList } = req.body;
  if (Array.isArray(tujuanSasaranList)) {
    saveJsonFile('tujuan_sasaran.json', tujuanSasaranList);
    if (pgService.getStatus().connected) {
      await pgService.saveTujuanSasaranList(tujuanSasaranList);
    }
    res.json({ success: true, count: tujuanSasaranList.length });
  } else {
    res.status(400).json({ success: false, message: 'Data tujuanSasaranList harus berupa array.' });
  }
});

// 8. Custom Logo Persistence
app.post('/api/db/custom-logo', async (req: Request, res: Response) => {
  const { url } = req.body;
  saveJsonFile('custom_logo.json', { url: url || null });
  if (pgService.getStatus().connected) {
    await pgService.saveSetting('custom_logo', { url: url || null });
  }
  res.json({ success: true, url });
});

// 9. Security Config Persistence
app.post('/api/db/security-config', async (req: Request, res: Response) => {
  const { config } = req.body;
  if (config) {
    saveJsonFile('security_config.json', config);
    if (pgService.getStatus().connected) {
      await pgService.saveSetting('security_config', config);
    }
    res.json({ success: true, config });
  } else {
    res.status(400).json({ success: false, message: 'Config tidak valid.' });
  }
});

// 10. Manual Migration Trigger (JSON -> PostgreSQL)
app.post('/api/db/migrate-to-postgres', async (_req: Request, res: Response) => {
  if (!pgService.getStatus().connected) {
    return res.status(400).json({
      success: false,
      message: 'PostgreSQL belum terhubung. Periksa konfigurasi DATABASE_URL di environment.',
    });
  }

  try {
    const users = loadJsonFile('users.json', INITIAL_USERS);
    const items = loadJsonFile('storage_items.json', INITIAL_ITEMS);
    const suratList = loadJsonFile('surat.json', INITIAL_SURAT);
    const ikuList = loadJsonFile('iku.json', INITIAL_IKU_ITEMS);
    const periodeList = loadJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
    const tujuanSasaranList = loadJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
    const securityConfig = loadJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);

    await pgService.saveUsers(users);
    await pgService.saveStorageItems(items);
    await pgService.saveSuratList(suratList);
    await pgService.saveIKUList(ikuList);
    await pgService.savePeriodeList(periodeList);
    await pgService.saveTujuanSasaranList(tujuanSasaranList);
    await pgService.saveSetting('security_config', securityConfig);

    const counts = await pgService.getTableCounts();

    res.json({
      success: true,
      message: 'Seluruh data JSON berhasil dimigrasikan ke PostgreSQL!',
      counts,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: `Migrasi gagal: ${err?.message}` });
  }
});

// 11. Reset Database
app.post('/api/db/reset', async (_req: Request, res: Response) => {
  saveJsonFile('users.json', INITIAL_USERS);
  saveJsonFile('storage_items.json', INITIAL_ITEMS);
  saveJsonFile('surat.json', INITIAL_SURAT);
  saveJsonFile('iku.json', INITIAL_IKU_ITEMS);
  saveJsonFile('periode_rpjmd.json', INITIAL_PERIODE_LIST);
  saveJsonFile('tujuan_sasaran.json', INITIAL_TUJUAN_SASARAN_ITEMS);
  saveJsonFile('security_config.json', DEFAULT_SECURITY_CONFIG);
  saveJsonFile('custom_logo.json', { url: null });

  if (pgService.getStatus().connected) {
    await pgService.saveUsers(INITIAL_USERS);
    await pgService.saveStorageItems(INITIAL_ITEMS);
    await pgService.saveSuratList(INITIAL_SURAT);
    await pgService.saveIKUList(INITIAL_IKU_ITEMS);
    await pgService.savePeriodeList(INITIAL_PERIODE_LIST);
    await pgService.saveTujuanSasaranList(INITIAL_TUJUAN_SASARAN_ITEMS);
    await pgService.saveSetting('security_config', DEFAULT_SECURITY_CONFIG);
  }

  res.json({ success: true, message: 'Seluruh database aplikasi berhasil direset ke pengaturan awal.' });
});

// =========================================================================
//                   SECURITY & AUDIT LOG API ENDPOINTS
// =========================================================================

const serverAuditLogs: any[] = loadJsonFile<any[]>('audit_logs.json', []);

// 1. Client IP & Device Info endpoint
app.get('/api/security/client-info', (req: Request, res: Response) => {
  const cfIp = req.headers['cf-connecting-ip'] as string | undefined;
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp = cfIp || (Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.socket.remoteAddress);
  const ip = rawIp && rawIp !== '::1' && rawIp !== '127.0.0.1' ? rawIp.replace(/^.*:/, '') : '127.0.0.1';
  res.json({
    ip,
    userAgent: req.headers['user-agent'] || '',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    domain: req.hostname || 'pme.cloudpme.my.id',
    cfCountry: (req.headers['cf-ipcountry'] as string) || undefined,
    timestamp: new Date().toISOString(),
  });
});

// 2. Receive and record audit log on server
app.post('/api/security/audit-log', async (req: Request, res: Response) => {
  try {
    const entry = req.body;
    if (entry && entry.id) {
      serverAuditLogs.unshift({
        ...entry,
        serverReceivedAt: new Date().toISOString(),
      });
      if (serverAuditLogs.length > 1000) {
        serverAuditLogs.pop();
      }
      saveJsonFile('audit_logs.json', serverAuditLogs);

      if (pgService.getStatus().connected) {
        await pgService.insertAuditLog(entry);
      }
    }
    res.json({ success: true, count: serverAuditLogs.length });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message });
  }
});

// 3. Get server audit logs
app.get('/api/security/audit-logs', async (_req: Request, res: Response) => {
  let logs: any[] | null = null;
  if (pgService.getStatus().connected) {
    logs = await pgService.getAuditLogs();
  }
  if (!logs) {
    logs = serverAuditLogs;
  }
  res.json({ success: true, logs });
});

// 4. Clear server audit logs
app.post('/api/security/clear-logs', async (_req: Request, res: Response) => {
  serverAuditLogs.length = 0;
  saveJsonFile('audit_logs.json', []);
  if (pgService.getStatus().connected) {
    await pgService.clearAuditLogs();
  }
  res.json({ success: true, message: 'Server audit logs cleared.' });
});

// 5. Download complete update ZIP file for CasaOS deployment
app.get('/api/download-zip', (_req: Request, res: Response) => {
  const zipPath = path.resolve(__dirname, 'epmped-terbaru-lengkap.zip');
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, 'epmped-terbaru-lengkap.zip');
  } else {
    res.status(404).send('File zip belum dibuat.');
  }
});

// Setup Vite or Static File Serving
async function startServer() {
  // Connect and initialize PostgreSQL if DATABASE_URL is configured
  await pgService.checkAndInit();
  await autoSeedPostgresIfFresh();

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`ArsipCloud server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
