const err = m => { const e = document.getElementById('st'); if (e) e.textContent = 'خطا: ' + m; };
window.onerror = (m, s, l) => err(m + ' (خط ' + l + ')');
window.addEventListener('unhandledrejection', e => err(e.reason?.message || e.reason));

const CamScan = Capacitor.Plugins.CamScan;
const $ = s => document.querySelector(s);
const xml = t => new DOMParser().parseFromString(t, 'text/xml');
const tx = (d, tag) => d.getElementsByTagNameNS('*', tag)[0]?.textContent || '';
const MEDIA = 'http://www.onvif.org/ver10/media/wsdl';
const cred = () => ({ user: $('#u').value, pass: $('#p').value });

// ---------- ذخیره‌سازی ----------
const KEY = 'camscan_saved';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } };
const storeSaved = () => localStorage.setItem(KEY, JSON.stringify(saved));
let saved = loadSaved(), found = [];
const find = (id, isSaved) => (isSaved ? saved : found).find(c => c.id === id);

// ---------- برند ----------
const BRANDS = [[/hikvision|dvrdvs|app-webs|\bds-/i,'Hikvision'],[/dahua|\bdh-|ipc-h/i,'Dahua'],[/herospeed|hero\s*speed/i,'HeroSpeed'],
 [/axis/i,'Axis'],[/uniview|unv/i,'Uniview'],[/tp-?link|tapo/i,'TP-Link'],[/reolink/i,'Reolink'],
 [/foscam/i,'Foscam'],[/hanwha|samsung|wisenet/i,'Hanwha'],[/bosch/i,'Bosch'],[/vivotek/i,'Vivotek'],
 [/d-?link/i,'D-Link'],[/ezviz/i,'EZVIZ'],[/xiaomi/i,'Xiaomi'],[/sony/i,'Sony'],
 [/panasonic/i,'Panasonic'],[/geovision/i,'GeoVision'],[/xiongmai|xmeye/i,'Xiongmai']];
const PORT_HINT = { 37777: 'Dahua', 8000: 'Hikvision', 34567: 'Xiongmai' };
const guessBrand = t => (BRANDS.find(([r]) => r.test(t || '')) || [])[1];

// ---------- ONVIF: اول بدون رمز، اگر رد شد با رمز ----------
const authFail = r => r.status === 401 || /NotAuthorized|Not Authorized|Sender not|ter:NotAuthorized/i.test(r.text || '');
const credentialsFor = c => ({
  user: (c && c.user) || cred().user || '',
  pass: (c && c.pass) || cred().pass || ''
});
async function soap(url, body, camera) {
  let r = await CamScan.soap({ url, body, user: '', pass: '' });
  if (authFail(r)) {
    const a = credentialsFor(camera);
    if (a.user) r = await CamScan.soap({ url, body, ...a });
  }
  return r;
}

// ---------- جستجو ----------
async function scan() {
  if (!CamScan) return err('پلاگین CamScan ثبت نشده');
  $('#st').textContent = 'در حال جستجو (حدود ۱۵ ثانیه)...';
  const [d, s] = await Promise.all([CamScan.discover(), CamScan.scanPorts()]);
  const map = new Map();
  for (const dev of d.devices) {
    const doc = xml(dev.xml);
    const xaddr = tx(doc, 'XAddrs').split(/\s+/).find(u => u.startsWith('http'));
    map.set(dev.ip, { ip: dev.ip, id: dev.ip, uuid: tx(doc, 'Address'), onvif: true, xaddr,
      scopes: tx(doc, 'Scopes'), types: tx(doc, 'Types'), ports: [] });
  }
  for (const h of s.hosts) {
    const c = map.get(h.ip);
    if (c) c.ports = h.ports;
    else if (h.ports.some(p => [554, 8554, 10554, 8000, 8899, 34567, 37777].includes(p)))
      map.set(h.ip, { ip: h.ip, id: h.ip, onvif: false, ports: h.ports, scopes: '', types: '' });
  }
  found = [...map.values()];
  $('#st').textContent = `${found.length} دستگاه پیدا شد؛ در حال دریافت جزئیات...`;
  await Promise.all(found.map(enrich));

  // اگر IP دوربین ذخیره‌شده عوض شده باشد، با شناسه یکتای ONVIF پیدا می‌شود
  saved.forEach(sv => {
    let f = found.find(c => c.ip === sv.ip);
    if (!f && sv.uuid) {
      const m = found.filter(c => c.uuid === sv.uuid);
      if (m.length === 1) f = m[0];
    }
    if (f) { sv.ip = f.ip; sv.id = f.ip; if (f.rtsp) sv.rtsp = f.rtsp; if (f.snapshot) sv.snapshot = f.snapshot; sv.status = f.status; }
  });
  storeSaved(); render();
  $('#st').textContent = `${found.length} دوربین/دستگاه`;
}

async function enrich(c) {
  c.status = 'offline'; c.brand = ''; c.model = ''; c.kind = 'دوربین IP';
  c.mainPort = c.ports.find(p => [80, 8080].includes(p)) || c.ports[0] || 80;
  if (c.xaddr) {
    try {
      const r = await soap(c.xaddr, '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>', c);
      if (r.status === 200) {
        const d = xml(r.text);
        c.brand = tx(d, 'Manufacturer'); c.model = tx(d, 'Model'); c.fw = tx(d, 'FirmwareVersion');
        c.status = 'online';
        await onvifMedia(c);
      } else if (authFail(r)) c.status = 'auth';
      else c.status = 'online';
    } catch (e) {}
  }
  if (c.ports.some(p => [80, 8080].includes(p))) {
    try {
      const r = await CamScan.http({ url: `http://${c.ip}:${c.mainPort}/` });
      if (c.status === 'offline') c.status = r.status === 401 ? 'auth' : 'online';
      const title = (r.text || '').match(/<title>(.*?)<\/title>/i)?.[1] || '';
      c.hint = [r.server, r.auth, title].join(' ');
    } catch (e) {}
  }
  if (c.status === 'offline' && c.ports.length) c.status = 'online';
  if (!c.brand || /^onvif/i.test(c.brand)) c.brand = guessBrand(c.scopes) || guessBrand(c.hint)
    || c.ports.map(p => PORT_HINT[p]).find(Boolean) || c.brand || 'نامشخص';
  if (/NetworkVideoRecorder/i.test(c.types) || /\b(nvr|dvr)\b|dvrdvs/i.test(c.model + c.hint)) c.kind = 'NVR/DVR';
  else if (c.ptz) c.kind = 'PTZ / گردان';
  else if (/dome/i.test(c.model + c.scopes)) c.kind = 'دوربین دام';
}

async function onvifMedia(c) {
  try {
    let r = await soap(c.xaddr, '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>', c);
    const d = xml(r.text);
    const media = [...d.getElementsByTagNameNS('*', 'XAddr')].map(e => e.textContent).find(u => /media/i.test(u)) || c.xaddr;
    c.ptz = d.getElementsByTagNameNS('*', 'PTZ').length > 0;
    r = await soap(media, `<GetProfiles xmlns="${MEDIA}"/>`, c);
    const pd = xml(r.text);
    const tok = pd.getElementsByTagNameNS('*', 'Profiles')[0]?.getAttribute('token');
    if (!tok) return;
    c.ptz = c.ptz && pd.getElementsByTagNameNS('*', 'PTZConfiguration').length > 0;

    // دریافت آدرس تصویر ثابت از سرویس استاندارد ONVIF
    try {
      const sr = await soap(media, `<GetSnapshotUri xmlns="${MEDIA}"><ProfileToken>${tok}</ProfileToken></GetSnapshotUri>`, c);
      const snapshot = tx(xml(sr.text), 'Uri');
      if (sr.status === 200 && snapshot) {
        const u = new URL(snapshot);
        u.hostname = c.ip;
        c.snapshot = u.toString();
      }
    } catch (e) { c.snapshot = ''; }

    r = await soap(media, `<GetStreamUri xmlns="${MEDIA}"><StreamSetup>
      <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
      <Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>
      </StreamSetup><ProfileToken>${tok}</ProfileToken></GetStreamUri>`, c);
    c.rtsp = tx(xml(r.text), 'Uri');
  } catch (e) {}
}

// ---------- پخش ----------
function guessRtsp(c) {
  const b = (c.brand || '').toLowerCase();
  let path = '/stream1';
  if (/hikvision/.test(b)) path = '/Streaming/Channels/101';
  else if (/dahua/.test(b)) path = '/cam/realmonitor?channel=1&subtype=0';
  else if (/uniview/.test(b)) path = '/media/video1';
  else if (/reolink/.test(b)) path = '/h264Preview_01_main';
  else if (/herospeed|hero\s*speed/i.test(b + ' ' + (c.model || '') + ' ' + (c.hint || '') + ' ' + (c.scopes || ''))) path = '/0';
  return `rtsp://${c.ip}:554${path}`;
}
function buildUrl(url, c, user, pass) {
  try {
    const u = new URL(url);
    // فقط میزبان را با IP کشف‌شده هماهنگ می‌کنیم؛ پورت، مسیر و query دوربین دست‌نخورده می‌ماند.
    u.hostname = c.ip;
    // اگر خود URI اطلاعات ورود دارد، آن را حفظ می‌کنیم؛ در غیر این صورت از اطلاعات دوربین استفاده می‌کنیم.
    if (!u.username && user) {
      u.username = user;
      u.password = pass || '';
    }
    return u.toString();
  } catch (e) {
    return url;
  }
}
function rtspCandidates(c, user, pass) {
  const b = ((c.brand || '') + ' ' + (c.model || '') + ' ' + (c.hint || '') + ' ' + (c.scopes || '')).toLowerCase();
  const paths = [];
  if (c.rtsp) paths.push(c.rtsp);
  if (/hikvision|hiwatch/.test(b)) paths.push(
    '/Streaming/Channels/101','/Streaming/Channels/102','/h264/ch1/main/av_stream'
  );
  if (/dahua|imou/.test(b)) paths.push(
    '/cam/realmonitor?channel=1&subtype=0','/cam/realmonitor?channel=1&subtype=1'
  );
  if (/herospeed|hero\s*speed/.test(b)) paths.push('/0','/live/ch00_0');
  if (/uniview|\bunv\b/.test(b)) paths.push('/media/video1','/unicast/c1/s0/live');
  if (/reolink/.test(b)) paths.push('/h264Preview_01_main','/h264Preview_01_sub');
  if (/axis/.test(b)) paths.push('/axis-media/media.amp');
  if (/foscam/.test(b)) paths.push('/videoMain','/videoSub');
  if (/tp-?link|tapo/.test(b)) paths.push('/stream1','/stream2');
  paths.push('/stream1','/live','/live/ch00_0','/Streaming/Channels/101');
  const urls = [];
  const add = value => {
    if (!value) return;
    if (value.startsWith('/')) {
      const ports = [554, ...new Set((c.ports || []).filter(p => [8554, 10554].includes(p)))];
      ports.forEach(port => {
        const u = buildUrl('rtsp://' + c.ip + ':' + port + value, c, user, pass);
        if (!urls.includes(u)) urls.push(u);
      });
      return;
    }
    const u = buildUrl(value, c, user, pass);
    if (!urls.includes(u)) urls.push(u);
  };
  paths.forEach(add);
  return urls.slice(0, 10);
}
async function snapshotCam(id, isSaved) {
  const c = find(id, isSaved);
  if (!c) return err('دوربین پیدا نشد');
  if (!c.snapshot) return err('آدرس Snapshot از دوربین دریافت نشد؛ رمز را وارد کنید و دوباره جستجو کنید. برای تصویر زنده از RTSP استفاده کنید.');
  const auth = credentialsFor(isSaved ? c : null);
  const user = auth.user;
  const pass = auth.pass;
  try {
    const r = await CamScan.http({ url: c.snapshot, user: user || '', pass: pass || '', binary: true });
    if (r.status !== 200 || !r.b64) throw new Error('دوربین تصویر ثابت ارسال نکرد');
    const shot = $('#shot');
    const image = $('#shotImage');
    if (!shot || !image) throw new Error('بخش نمایش تصویر در index.html وجود ندارد؛ فایل‌های برنامه هم‌نسخه نیستند.');
    image.src = 'data:image/jpeg;base64,' + r.b64;
    shot.style.display = 'flex';
    const status = $('#st');
    if (status) status.textContent = 'تصویر Snapshot دریافت شد';
  } catch (e) { err(e.message || 'دریافت تصویر Snapshot ناموفق بود'); }
}
function closeSnapshot() {
  const shot = $('#shot');
  const image = $('#shotImage');
  if (shot) shot.style.display = 'none';
  if (image) image.removeAttribute('src');
}
function togglePassword() {
  const p = $('#p');
  if (p) p.type = p.type === 'password' ? 'text' : 'password';
}
async function copyPassword() {
  const value = $('#p')?.value || '';
  if (!value) return err('رمزی برای کپی وجود ندارد');
  try {
    await navigator.clipboard.writeText(value);
    $('#st').textContent = 'رمز کپی شد';
  } catch (e) {
    $('#p').focus(); $('#p').select();
    try { document.execCommand('copy'); $('#st').textContent = 'رمز کپی شد'; }
    catch (_) { err('کپی خودکار ممکن نشد؛ رمز را انتخاب و کپی کنید'); }
  }
}
function loadCredentials(id) {
  const c = find(id, true);
  if (!c) return err('دوربین ذخیره‌شده پیدا نشد');
  $('#u').value = c.user || '';
  $('#p').value = c.pass || '';
  $('#p').type = 'text';
  $('#st').textContent = c.user || c.pass
    ? 'نام کاربری و رمز این دوربین در ورودی‌های بالای برنامه قرار گرفت.'
    : 'برای این دوربین نام کاربری و رمز ذخیره نشده است؛ آن‌ها را دستی وارد و دوباره ذخیره کنید.';
}
function playCam(id, isSaved) {
  const c = find(id, isSaved);
  if (!c) return err('دوربین پیدا نشد');
  if (isSaved) loadCredentials(id);
  const auth = credentialsFor(isSaved ? c : null);
  const urls = rtspCandidates(c, auth.user, auth.pass);
  if (!urls.length) return err('هیچ مسیر RTSP برای این دوربین پیدا نشد');
  $('#st').textContent = 'در حال آزمایش مسیرهای تصویر دوربین...';
  CamScan.play({ urls, url: urls[0], name: c.name || c.model || c.ip });
}

// ---------- نام‌گذاری و ذخیره ----------
function saveCam(id) {
  const c = find(id, false);
  const name = prompt('نام دوربین:', c.model || c.ip);
  if (!name) return;
  const old = saved.findIndex(s => s.id === id);
  const item = { id, uuid: c.uuid || '', name, ip: c.ip, rtsp: c.rtsp || '', snapshot: c.snapshot || '', brand: c.brand,
    model: c.model, kind: c.kind, user: cred().user, pass: cred().pass, status: c.status };
  if (old >= 0) saved[old] = item; else saved.push(item);
  storeSaved(); render();
}
function renameCam(id) {
  const c = find(id, true);
  const name = prompt('نام جدید:', c.name);
  if (name) { c.name = name; storeSaved(); render(); }
}
function delCam(id) {
  if (!confirm('این دوربین از لیست من حذف شود؟')) return;
  saved = saved.filter(c => c.id !== id); storeSaved(); render();
}

// ---------- نمایش ----------
function card(c, isSaved) {
  return `<div class="card">
    <b><span class="dot ${c.status || ''}" data-ip="${c.ip}"></span>${isSaved ? c.name : c.ip}</b>
    <div>${c.brand || ''} ${c.model || ''} ${c.kind ? '— ' + c.kind : ''}</div>
    <small>${c.ip}</small>
    <div class="row">
      ${c.snapshot ? `<button class="g" onclick="snapshotCam('${c.id}',${isSaved})">▣ تصویر</button>` : ''}
      <button onclick="playCam('${c.id}',${isSaved})">▶ پخش زنده</button>
      ${isSaved
        ? `<button class="g" onclick="loadCredentials('${c.id}')">نمایش رمز و اطلاعات</button><button class="g" onclick="renameCam('${c.id}')">✎ نام</button><button class="r" onclick="delCam('${c.id}')">🗑</button>`
        : `<button class="g" onclick="saveCam('${c.id}')">★ ذخیره</button>`}
    </div></div>`;
}
function render() {
  $('#mine').innerHTML = saved.length ? saved.map(c => card(c, true)).join('')
    : '<small style="margin:12px">هنوز دوربینی ذخیره نشده</small>';
  $('#list').innerHTML = found.map(c => card(c, false)).join('');
}

// ---------- وضعیت زنده ----------
async function refresh() {
  if (!CamScan) return;
  await Promise.all([...saved, ...found].map(async c => {
    try {
      const { open } = await CamScan.tcp({ ip: c.ip, port: c.mainPort || 554 });
      c.status = open ? (c.status === 'auth' ? 'auth' : 'online') : 'offline';
      document.querySelectorAll(`.dot[data-ip="${c.ip}"]`).forEach(e => e.className = 'dot ' + c.status);
    } catch (e) {}
  }));
}

render(); refresh(); setInterval(refresh, 15000);
$('#st').textContent = CamScan ? 'نسخه ۳ ✓' : 'خطا: پلاگین CamScan ثبت نشده';
