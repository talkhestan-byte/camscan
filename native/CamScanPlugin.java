package com.camscan.app;

import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.security.*;
import java.text.SimpleDateFormat;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.*;
import java.util.concurrent.*;

@CapacitorPlugin(name = "CamScan")
public class CamScanPlugin extends Plugin {
  static final int[] PORTS = {80, 443, 554, 8000, 8080, 8899, 34567, 37777};

  static boolean open(String ip, int port, int ms) {
    try (Socket s = new Socket()) {
      s.connect(new InetSocketAddress(ip, port), ms);
      return true;
    } catch (Exception e) { return false; }
  }

  static byte[] readAll(InputStream in, int max) throws IOException {
    if (in == null) return new byte[0];
    ByteArrayOutputStream o = new ByteArrayOutputStream();
    byte[] b = new byte[8192]; int n;
    while ((n = in.read(b)) > 0 && o.size() < max) o.write(b, 0, n);
    return o.toByteArray();
  }

  @PluginMethod
  public void play(PluginCall call) {
    try {
      ArrayList<String> urls = new ArrayList<>();
      JSArray candidates = call.getArray("urls");
      if (candidates != null) {
        for (int n = 0; n < candidates.length(); n++) {
          String value = candidates.getString(n);
          if (value != null && !value.trim().isEmpty() && !urls.contains(value)) urls.add(value);
        }
      }
      String single = call.getString("url");
      if (urls.isEmpty() && single != null && !single.trim().isEmpty()) urls.add(single);
      if (urls.isEmpty()) { call.reject("آدرس RTSP برای پخش ارسال نشده است"); return; }
      Intent i = new Intent(getActivity(), PlayerActivity.class);
      i.putStringArrayListExtra("urls", urls);
      i.putExtra("url", urls.get(0));
      i.putExtra("name", call.getString("name", ""));
      getActivity().startActivity(i);
      call.resolve();
    } catch (Exception e) { call.reject("خطا در آماده‌سازی پخش: " + e.getMessage()); }
  }

  @PluginMethod
  public void discover(PluginCall call) {
    new Thread(() -> {
      WifiManager wm = (WifiManager) getContext().getApplicationContext()
          .getSystemService(Context.WIFI_SERVICE);
      WifiManager.MulticastLock lock = wm.createMulticastLock("camscan");
      lock.acquire();
      JSArray out = new JSArray();
      Set<String> seen = new HashSet<>();
      try (DatagramSocket s = new DatagramSocket()) {
        String probe = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
          + "<e:Envelope xmlns:e=\"http://www.w3.org/2003/05/soap-envelope\" "
          + "xmlns:w=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\" "
          + "xmlns:d=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\" "
          + "xmlns:dn=\"http://www.onvif.org/ver10/network/wsdl\"><e:Header>"
          + "<w:MessageID>uuid:" + UUID.randomUUID() + "</w:MessageID>"
          + "<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"
          + "<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>"
          + "</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types>"
          + "</d:Probe></e:Body></e:Envelope>";
        byte[] b = probe.getBytes("UTF-8");
        s.send(new DatagramPacket(b, b.length, InetAddress.getByName("239.255.255.250"), 3702));
        s.setSoTimeout(1000);
        long end = System.currentTimeMillis() + 4000;
        byte[] buf = new byte[16384];
        while (System.currentTimeMillis() < end) {
          try {
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            s.receive(p);
            String ip = p.getAddress().getHostAddress();
            if (seen.add(ip)) {
              JSObject o = new JSObject();
              o.put("ip", ip);
              o.put("xml", new String(p.getData(), 0, p.getLength(), "UTF-8"));
              out.put(o);
            }
          } catch (SocketTimeoutException ignored) {}
        }
      } catch (Exception ignored) {
      } finally { lock.release(); }
      JSObject r = new JSObject(); r.put("devices", out); call.resolve(r);
    }).start();
  }

  @PluginMethod
  public void scanPorts(PluginCall call) {
    new Thread(() -> {
      try {
        WifiManager wm = (WifiManager) getContext().getApplicationContext()
            .getSystemService(Context.WIFI_SERVICE);
        int ip = wm.getConnectionInfo().getIpAddress();
        String base = (ip & 0xff) + "." + ((ip >> 8) & 0xff) + "." + ((ip >> 16) & 0xff) + ".";
        ExecutorService ex = Executors.newFixedThreadPool(64);
        List<Future<JSObject>> fs = new ArrayList<>();
        for (int i = 1; i < 255; i++) {
          final String host = base + i;
          fs.add(ex.submit(() -> {
            JSArray ports = new JSArray();
            for (int p : PORTS) if (open(host, p, 400)) ports.put(p);
            if (ports.length() == 0) return null;
            JSObject o = new JSObject(); o.put("ip", host); o.put("ports", ports);
            return o;
          }));
        }
        JSArray hosts = new JSArray();
        for (Future<JSObject> f : fs) { JSObject o = f.get(); if (o != null) hosts.put(o); }
        ex.shutdown();
        JSObject r = new JSObject(); r.put("hosts", hosts); call.resolve(r);
      } catch (Exception e) { call.reject(e.getMessage()); }
    }).start();
  }

  @PluginMethod
  public void tcp(PluginCall call) {
    new Thread(() -> {
      JSObject r = new JSObject();
      r.put("open", open(call.getString("ip"), call.getInt("port", 80), 1500));
      call.resolve(r);
    }).start();
  }

  static class HttpResult {
    int status; byte[] data; String server; String auth;
    HttpResult(int status, byte[] data, String server, String auth) {
      this.status = status; this.data = data; this.server = server; this.auth = auth;
    }
  }

  static String md5(String value) throws Exception {
    byte[] bytes = MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8));
    StringBuilder out = new StringBuilder();
    for (byte b : bytes) out.append(String.format(Locale.US, "%02x", b & 0xff));
    return out.toString();
  }

  static Map<String, String> authParams(String header) {
    Map<String, String> values = new HashMap<>();
    Matcher m = Pattern.compile("([A-Za-z0-9_-]+)=(?:\\\"([^\\\"]*)\\\"|([^,\\s]+))").matcher(header);
    while (m.find()) values.put(m.group(1).toLowerCase(Locale.US), m.group(2) != null ? m.group(2) : m.group(3));
    return values;
  }

  static String digestHeader(String challenge, String method, String uri, String user, String pass) throws Exception {
    Map<String, String> p = authParams(challenge);
    String realm = p.get("realm"), nonce = p.get("nonce");
    if (realm == null || nonce == null) return null;
    String algorithm = p.getOrDefault("algorithm", "MD5");
    String qopList = p.getOrDefault("qop", "");
    boolean supportsAuth = false;
    for (String item : qopList.split(",")) if ("auth".equals(item.trim())) supportsAuth = true;
    if (!qopList.isEmpty() && !supportsAuth) return null;
    String qop = supportsAuth ? "auth" : "";
    String cnonce = UUID.randomUUID().toString().replace("-", "");
    String nc = "00000001";
    String ha1 = md5(user + ":" + realm + ":" + pass);
    if ("MD5-sess".equalsIgnoreCase(algorithm)) ha1 = md5(ha1 + ":" + nonce + ":" + cnonce);
    else if (!"MD5".equalsIgnoreCase(algorithm)) return null;
    String ha2 = md5(method + ":" + uri);
    String response = qop.isEmpty() ? md5(ha1 + ":" + nonce + ":" + ha2)
        : md5(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2);
    StringBuilder h = new StringBuilder("Digest username=\"").append(user.replace("\\", "\\\\").replace("\"", "\\\""))
        .append("\", realm=\"").append(realm).append("\", nonce=\"").append(nonce)
        .append("\", uri=\"").append(uri).append("\", response=\"").append(response).append("\"");
    if (qop.length() > 0) h.append(", qop=").append(qop).append(", nc=").append(nc).append(", cnonce=\"").append(cnonce).append("\"");
    if (p.containsKey("opaque")) h.append(", opaque=\"").append(p.get("opaque")).append("\"");
    h.append(", algorithm=").append(algorithm);
    return h.toString();
  }

  static HttpResult requestOnce(String address, String method, byte[] body, String contentType,
                                String authorization, int timeout) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
    c.setConnectTimeout(timeout); c.setReadTimeout(timeout + 1500);
    c.setRequestMethod(method);
    if (contentType != null) c.setRequestProperty("Content-Type", contentType);
    if (authorization != null) c.setRequestProperty("Authorization", authorization);
    if (body != null) {
      c.setDoOutput(true);
      try (OutputStream out = c.getOutputStream()) { out.write(body); }
    }
    int code = c.getResponseCode();
    byte[] data = readAll(code < 400 ? c.getInputStream() : c.getErrorStream(), 3_000_000);
    HttpResult result = new HttpResult(code, data, c.getHeaderField("Server"), c.getHeaderField("WWW-Authenticate"));
    c.disconnect();
    return result;
  }

  static HttpResult request(String address, String method, byte[] body, String contentType,
                            String user, String pass, int timeout) throws Exception {
    HttpResult first = requestOnce(address, method, body, contentType, null, timeout);
    if (first.status != 401 || user == null || user.isEmpty() || first.auth == null) return first;
    URL u = new URL(address);
    String authorization = null;
    if (first.auth.regionMatches(true, 0, "Digest ", 0, 7))
      authorization = digestHeader(first.auth.substring(7), method, u.getFile().isEmpty() ? "/" : u.getFile(), user, pass == null ? "" : pass);
    if (authorization == null && first.auth.regionMatches(true, 0, "Basic", 0, 5))
      authorization = "Basic " + Base64.encodeToString((user + ":" + (pass == null ? "" : pass)).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    if (authorization == null) return first;
    return requestOnce(address, method, body, contentType, authorization, timeout);
  }

  @PluginMethod
  public void http(PluginCall call) {
    new Thread(() -> {
      try {
        HttpResult result = request(call.getString("url"), "GET", null, null,
            call.getString("user", ""), call.getString("pass", ""), 2500);
        JSObject r = new JSObject();
        r.put("status", result.status); r.put("server", result.server); r.put("auth", result.auth);
        if (call.getBoolean("binary", false)) r.put("b64", Base64.encodeToString(result.data, Base64.NO_WRAP));
        else r.put("text", new String(result.data, StandardCharsets.UTF_8));
        call.resolve(r);
      } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }).start();
  }

  static String xmlEscape(String value) {
    if (value == null) return "";
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&apos;");
  }

  @PluginMethod
  public void soap(PluginCall call) {
    new Thread(() -> {
      try {
        String user = call.getString("user", ""), pass = call.getString("pass", "");
        String hdr = "";
        if (!user.isEmpty()) {
          byte[] nonce = new byte[16]; new SecureRandom().nextBytes(nonce);
          SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
          f.setTimeZone(TimeZone.getTimeZone("UTC"));
          String created = f.format(new Date());
          MessageDigest md = MessageDigest.getInstance("SHA-1");
          md.update(nonce); md.update(created.getBytes(StandardCharsets.UTF_8)); md.update(pass.getBytes(StandardCharsets.UTF_8));
          String dig = Base64.encodeToString(md.digest(), Base64.NO_WRAP);
          hdr = "<s:Header><wsse:Security s:mustUnderstand=\\"1\\" xmlns:wsse=\\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd\\" xmlns:wsu=\\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\\">"
              + "<wsse:UsernameToken><wsse:Username>" + xmlEscape(user) + "</wsse:Username>"
              + "<wsse:Password Type=\\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest\\">" + dig + "</wsse:Password>"
              + "<wsse:Nonce EncodingType=\\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary\\">" + Base64.encodeToString(nonce, Base64.NO_WRAP) + "</wsse:Nonce>"
              + "<wsu:Created>" + created + "</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>";
        }
        String env = "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><s:Envelope xmlns:s=\\"http://www.w3.org/2003/05/soap-envelope\\">"
            + hdr + "<s:Body>" + call.getString("body") + "</s:Body></s:Envelope>";
        byte[] body = env.getBytes(StandardCharsets.UTF_8);
        HttpResult result = request(call.getString("url"), "POST", body, "application/soap+xml; charset=utf-8",
            user, pass, 3000);
        JSObject r = new JSObject();
        r.put("status", result.status); r.put("text", new String(result.data, StandardCharsets.UTF_8));
        r.put("auth", result.auth);
        call.resolve(r);
      } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }).start();
  }
}
