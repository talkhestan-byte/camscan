// نمایش خطا روی صفحه
const showErr = m => { const e = document.getElementById('st'); if (e) e.textContent = 'خطا: ' + m; };
window.onerror = (m, s, l) => showErr(m + ' (خط ' + l + ')');
window.addEventListener('unhandledrejection', e => showErr(e.reason?.message || e.reason));
const CamScan = Capacitor.Plugins.CamScan;
if (!CamScan) {
  const e = document.getElementById('st');
  if (e) e.textContent = 'خطا: پلاگین CamScan ثبت نشده (MainActivity.java را چک کنید)';
}
const $ = s => document.querySelector(s);
const cams = new Map();
const cred = () => ({ user: $('#u').value, pass: $('#p').value });
const xml = t => new DOMParser().parseFromString(t, 'text/xml');
const tx = (d, tag) => d.getElementsByTagNameNS('*', tag)[0]?.textContent || '';
const MEDIA = 'http://www.onvif.org/ver10/media/wsdl';

const BRANDS = [[/hikvision|dvrdvs|app-webs|\bds-/i,'Hikvision'],[/dahua|\bdh-|ipc-h/i,'Dahua'],
 [/axis/i,'Axis'],[/uniview|unv/i,'Uniview'],[/tp-?link|tapo/i,'TP-Link'],[/reolink/i,'Reolink'],
 [/foscam/i,'Foscam'],[/hanwha|samsung|wisenet/i,'Hanwha'],[/bosch/i,'Bosch'],[/vivotek/i,'Vivotek'],
 [/d-?link/i,'D-Link'],[/ezviz/i,'EZVIZ'],[/xiaomi/i,'Xiaomi'],[/sony/i,'Sony'],
 [/panasonic/i,'Panasonic'],[/geovision/i,'GeoVision'],[/xiongmai|xmeye/i,'Xiongmai']];
const PORT_HINT = { 37777: 'Dahua', 8000: 'Hikvision', 34567: 'Xiongmai' };
const guessBrand = t => (BRANDS.find(([r]) => r.test(t || '')) || [])[1];

async function soap(url, body) {
  return CamScan.soap({ url, body, ...cred() });
}
const authFail = r => r.status === 401 || /NotAuthorized|Sender not/i.test(r.text || '');

async function scan() {
  $('#st').textContent = 'در حال جستجو (حدود ۱۵ ثانیه)...';
  cams.clear(); $('#list').innerHTML = '';
  const [d, s] = await Promise.all([CamScan.discover(), CamScan.scanPorts()]);

  for (const dev of d.devices) {
    const doc = xml(dev.xml);
    const xaddr = tx(doc, 'XAddrs').split(/\s+/).find(u => u.startsWith('http'));
    cams.set(dev.ip, { ip: dev.ip, onvif: true, xaddr, scopes: tx(doc, 'Scopes'),
      types: tx(doc, 'Types'), ports: [] });
  }
  for (const h of s.hosts) {
    const c = cams.get(h.ip);
    if (c) c.ports = h.ports;
    else if (h.ports.some(p => [554, 8000, 8899, 34567, 37777].includes(p)))
      cams.set(h.ip, { ip: h.ip, onvif: false, ports: h.ports, scopes: '', types: '' });
  }
  $('#st').textContent = `${cams.size} دستگاه پیدا شد؛ در حال دریافت جزئیات...`;
  await Promise.all([...cams.values()].map(enrich));
  render();
  $('#st').textContent = `${cams.size} دوربین/دستگاه`;
}

async function enrich(c) {
  c.status = 'offline'; c.brand = ''; c.model = ''; c.kind = 'دوربین IP';
  c.mainPort = c.ports.find(p => [80, 8080].includes(p)) || c.ports[0] || 80;

  // ۱) ONVIF
  if (c.xaddr) {
    try {
      let r = await soap(c.xaddr, '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>');
      if (r.status === 200) {
        const d = xml(r.text);
        c.brand = tx(d, 'Manufacturer'); c.model = tx(d, 'Model'); c.fw = tx(d, 'FirmwareVersion');
        c.status = 'online';
        await onvifMedia(c);
      } else if (authFail(r)) c.status = 'auth';
      else c.status = 'online';
    } catch (e) {}
  }
  // ۲) ردپای HTTP (برای برند)
  if (c.ports.some(p => [80, 8080].includes(p))) {
    try {
      const r = await CamScan.http({ url: `http://${c.ip}:${c.mainPort}/` });
      if (c.status === 'offline') c.status = r.status === 401 ? 'auth' : 'online';
      const title = (r.text || '').match(/<title>(.*?)<\/title>/i)?.[1] || '';
      c.hint = [r.server, r.auth, title].join(' ');
    } catch (e) {}
  }
  if (c.status === 'offline' && c.ports.length) c.status = 'online';

  // ۳) برند از منابع مختلف
  if (!c.brand) c.brand = guessBrand(c.scopes) || guessBrand(c.hint)
    || c.ports.map(p => PORT_HINT[p]).find(Boolean) || 'نامشخص';
  // ۴) نوع
  if (/NetworkVideoRecorder/i.test(c.types) || /\b(nvr|dvr)\b|dvrdvs/i.test(c.model + c.hint)) c.kind = 'NVR/DVR';
  else if (c.ptz) c.kind = 'PTZ / گردان';
  else if (/dome/i.test(c.model + c.scopes)) c.kind = 'دوربین دام';
}

async function onvifMedia(c) {
  try {
    let r = await soap(c.xaddr, '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>');
    const d = xml(r.text);
    const media = d.querySelector('Media XAddr, Media > XAddr')?.textContent
      || [...d.getElementsByTagNameNS('*', 'XAddr')].map(e => e.textContent).find(u => /media/i.test(u)) || c.xaddr;
    c.ptz = d.getElementsByTagNameNS('*', 'PTZ').length > 0;
    r = await soap(media, `<GetProfiles xmlns="${MEDIA}"/>`);
    const pd = xml(r.text);
    const tok = pd.getElementsByTagNameNS('*', 'Profiles')[0]?.getAttribute('token');
    if (!tok) return;
    c.ptz = c.ptz && pd.getElementsByTagNameNS('*', 'PTZConfiguration').length > 0;
    r = await soap(media, `<GetSnapshotUri xmlns="${MEDIA}"><ProfileToken>${tok}</ProfileToken></GetSnapshotUri>`);
    c.snapshot = tx(xml(r.text), 'Uri');
    r = await soap(media, `<GetStreamUri xmlns="${MEDIA}"><StreamSetup>
      <Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>
      <Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>
      </StreamSetup><ProfileToken>${tok}</ProfileToken></GetStreamUri>`);
    c.rtsp = tx(xml(r.text), 'Uri');
  } catch (e) {}
}

function render() {
  const label = { online: 'آنلاین', offline: 'آفلاین', auth: 'نیاز به رمز' };
  $('#list').innerHTML = [...cams.values()].map(c => `
    <div class="card" onclick="openView('${c.ip}')">
      <b><span class="dot ${c.status}" id="d-${c.ip.replace(/\./g,'_')}"></span>${c.ip}</b> — ${label[c.status]}
      <div>برند: ${c.brand} ${c.model || ''}</div>
      <div>نوع: ${c.kind} ${c.onvif ? '(ONVIF)' : ''}</div>
      <small>پورت‌ها: ${c.ports.join(', ')}</small>
      ${c.rtsp ? `<small>${c.rtsp}</small>` : ''}
    </div>`).join('');
}

// نمایش تصویر (اسنپ‌شات با رفرش ۱ ثانیه‌ای)
let timer;
function openView(ip) {
  const c = cams.get(ip);
  if (!c.snapshot) { alert('آدرس اسنپ‌شات پیدا نشد. اگر رمز لازم است وارد کنید و دوباره جستجو کنید. برای ویدیوی زنده از RTSP استفاده کنید.'); return; }
  $('#viewer').style.display = 'block'; $('#vt').textContent = `${c.brand} ${c.ip}`;
  const tick = async () => {
    try {
      const r = await CamScan.http({ url: c.snapshot, binary: true, ...cred() });
      if (r.status === 200) $('#vi').src = 'data:image/jpeg;base64,' + r.b64;
    } catch (e) {}
  };
  tick(); timer = setInterval(tick, 1000);
}
function closeView() { clearInterval(timer); $('#viewer').style.display = 'none'; }

// وضعیت زنده هر ۱۵ ثانیه
setInterval(() => cams.forEach(async c => {
  if (!c.ports.length) return;
  const { open } = await CamScan.tcp({ ip: c.ip, port: c.mainPort });
  c.status = open ? (c.status === 'auth' ? 'auth' : 'online') : 'offline';
  const el = document.getElementById('d-' + c.ip.replace(/\./g, '_'));
  if (el) el.className = 'dot ' + c.status;
}), 15000);
document.getElementById('st').textContent =
  'پلاگین: ' + (window.Capacitor?.Plugins?.CamScan ? 'OK' : 'NO');
