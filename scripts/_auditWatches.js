const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { prisma } = require('../utils/db');
const DELETE = process.argv.includes('--delete');
const probe = async (u) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const opts of [{ method: 'HEAD' }, { method: 'GET', headers: { Range: 'bytes=0-1023' } }]) {
      try {
        const r = await fetch(u, { ...opts, redirect: 'follow', signal: AbortSignal.timeout(20000) });
        try { r.body?.cancel(); } catch {}
        if (r.ok || r.status === 206) return 'ok';
        if (r.status >= 400 && r.status < 500 && opts.method === 'GET') return 'broken:' + r.status;
      } catch (e) { /* network/timeout -> try next */ }
    }
  }
  return 'unreachable';
};
(async () => {
  const all = await prisma.watch.findMany({ select: { id: true, videoUrl: true } });
  const list = all.filter(w => /^https?:/i.test((w.videoUrl || '').trim()));
  console.log('total', all.length, 'with http link', list.length);
  const broken = [], unreachable = []; let i = 0, done = 0;
  const worker = async () => { while (i < list.length) { const w = list[i++]; const res = await probe(w.videoUrl.trim());
    if (res.startsWith('broken')) broken.push({ id: w.id, u: w.videoUrl, res }); else if (res === 'unreachable') unreachable.push({ id: w.id, u: w.videoUrl });
    if (++done % 50 === 0) console.log('checked', done); } };
  await Promise.all(Array.from({ length: 12 }, worker));
  fs.writeFileSync(path.join(__dirname, '_watchAudit.json'), JSON.stringify({ broken, unreachable }, null, 1));
  console.log('broken', broken.length, 'unreachable', unreachable.length);
  console.log(broken.slice(0, 5));
  if (DELETE && broken.length) {
    const ids = broken.map(b => b.id);
    const c = await prisma.comment.deleteMany({ where: { watch: { in: ids } } });
    const w = await prisma.watch.deleteMany({ where: { id: { in: ids } } });
    console.log('deleted comments', c.count, 'watches', w.count);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
