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
const BRANDS = [[/hikvision|dvrdvs|app-webs|\bds-/i,'Hikvision'],[/dahua|\bdh-|ipc-h/i,'Dahua'],
 [/axis/i,'Axis'],[/uniview|unv/i,'Uniview'],[/tp-?link|tapo/i,'TP-Link'],[/reolink/i,'Reolink'],
 [/foscam/i,'Foscam'],[/hanwha|samsung|wisenet/i,'Hanwha'],[/bosch/i,'Bosch'],[/vivotek/i,'Vivotek'],
 [/d-?link/i,'D-Link'],[/ezviz/i,'EZVIZ'],[/xiaomi/i,'Xiaomi'],[/sony/i,'Sony'],
 [/panasonic/i,'Panasonic'],[/geovision/i,'GeoVision'],[/xiongmai|xmeye/i,'Xiongmai']];
const PORT_HINT = { 37777: 'Dahua', 8000: 'Hikvision', 34567: 'Xiongmai' };
const guessBrand = t => (BRANDS.find(([r]) => r.test(t || '')) || [])[1];

const soap = (url, body) => CamScan.soap({ url, body, ...cred() });
const authFail = r => r.status === 401 || /NotAuthorized|Sender not/i.test(r.text || '');

// ---------- جستجو ----------
async function scan() {
  if (!CamScan) return err('پلاگین CamScan ثبت نشده');
  $('#st').textContent = 'در حال جستجو (حدود ۱۵ ثانیه)...';
  const [d, s] = await Promise.all([CamScan.discover(), CamScan.scanPorts()]);
  const map = new Map();
  for (const dev of d.devices) {
    const doc = xml(dev.xml);
    const xaddr = tx(doc, 'XAddrs').split(/\s+/).find(u => u.startsWith('http'));
    map.set(dev.ip, { ip: dev.ip, id: tx(doc, 'Address') || dev.ip, onvif: true, xaddr,
      scopes: tx(doc, 'Scopes'), types: tx(doc, 'Types'), ports: [] });
  }
  for (const h of s.hosts) {
    const c = map.get(h.ip);
    if (c) c.ports = h.ports;
    else if (h.ports.some(p => [554, 8000, 8899, 34567, 37777].includes(p)))
      map.set(h.ip, { ip: h.ip, id: h.ip, onvif: false, ports: h.ports, scopes: '', types: '' });
  }
  found = [...map.values()];
  $('#st').textContent = `${found.length} دستگاه پیدا شد؛ در حال دریافت جزئیات...`;
  await Promise.all(found.map(enrich));

  // به‌روزرسانی IP دوربین‌های ذخیره‌شده (اگر IP عوض شده باشد)
  saved.forEach(sv => {
    const f = found.find(c => c.id === sv.id);
    if (f) { sv.ip = f.ip; if (f.rtsp) sv.rtsp = f.rtsp; sv.status = f.status; }
  });
  storeSaved(); render();
  $('#st').textContent = `${found.length} دوربین/دستگاه`;
}

async function enrich(c) {
  c.status = 'offline'; c.brand = ''; c.model = ''; c.kind = 'دوربین IP';
  c.mainPort = c.ports.find(p => [80, 8080].includes(p)) || c.ports[0] || 80;
  if (c.xaddr) {
    try {
      const r = await soap(c.xaddr, '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>');
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
    let r = await soap(c.xaddr, '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>');
    const d = xml(r.text);
    const media = [...d.getElementsByTagNameNS('*', 'XAddr')].map(e => e.textContent).find(u => /media/i.test(u)) || c.xaddr;
    c.ptz = d.getElementsByTagNameNS('*', 'PTZ').length > 0;
    r = await soap(media, `<GetProfiles xmlns="${MEDIA}"/>`);
    const pd = xml(r.text);
    const tok = pd.getElementsByTagNameNS('*', 'Profiles')[0]?.getAttribute('token');
    if (!tok) return;
    c.ptz = c.ptz && pd.getElementsByTagNameNS('*', 'PTZConfiguration').length > 0;
    r = await soap(media, `<GetStreamUri xmlns="${MEDIA}"><StreamSetup>
      <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
      <Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>
      </StreamSetup><ProfileToken>${tok}</ProfileToken></GetStreamUri>`);
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
  return `rtsp://${c.ip}:554${path}`;
}
function buildUrl(c, user, pass) {
  let url = c.rtsp || guessRtsp(c);
  url = url.replace(/(rtsp:\/\/(?:[^@\/]*@)?)[^:\/]+/, '$1' + c.ip); // IP جدید
  if (user && !/rtsp:\/\/[^\/]*@/.test(url))
    url = url.replace('rtsp://', `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@`);
  return url;
}
function playCam(id, isSaved) {
  const c = find(id, isSaved);
  const u = isSaved ? c.user : cred().user, p = isSaved ? c.pass : cred().pass;
  CamScan.play({ url: buildUrl(c, u, p), name: c.name || c.model || c.ip });
}

// ---------- نام‌گذاری و ذخیره ----------
function saveCam(id) {
  const c = find(id, false);
  const name = prompt('نام دوربین:', c.model || c.ip);
  if (!name) return;
  const old = saved.findIndex(s => s.id === id);
  const item = { id, name, ip: c.ip, rtsp: c.rtsp || '', brand: c.brand, model: c.model,
    kind: c.kind, user: cred().user, pass: cred().pass, status: c.status };
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
      <button onclick="playCam('${c.id}',${isSaved})">▶ پخش</button>
      ${isSaved
        ? `<button class="g" onclick="renameCam('${c.id}')">✎ نام</button><button class="r" onclick="delCam('${c.id}')">🗑</button>`
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
if (!CamScan) err('پلاگین CamScan ثبت نشده (MainActivity.java را چک کنید)');
