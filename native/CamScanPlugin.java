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
    Intent i = new Intent(getActivity(), PlayerActivity.class);
    i.putExtra("url", call.getString("url"));
    i.putExtra("name", call.getString("name", ""));
    getActivity().startActivity(i);
    call.resolve();
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

  @PluginMethod
  public void http(PluginCall call) {
    new Thread(() -> {
      try {
        HttpURLConnection c = (HttpURLConnection) new URL(call.getString("url")).openConnection();
        c.setConnectTimeout(2000); c.setReadTimeout(3000);
        String u = call.getString("user", "");
        if (!u.isEmpty())
          c.setRequestProperty("Authorization", "Basic " + Base64.encodeToString(
              (u + ":" + call.getString("pass", "")).getBytes(), Base64.NO_WRAP));
        int code = c.getResponseCode();
        byte[] data = readAll(code < 400 ? c.getInputStream() : c.getErrorStream(), 3_000_000);
        JSObject r = new JSObject();
        r.put("status", code);
        r.put("server", c.getHeaderField("Server"));
        r.put("auth", c.getHeaderField("WWW-Authenticate"));
        if (call.getBoolean("binary", false)) r.put("b64", Base64.encodeToString(data, Base64.NO_WRAP));
        else r.put("text", new String(data, "UTF-8"));
        call.resolve(r);
      } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }).start();
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
          md.update(nonce); md.update(created.getBytes()); md.update(pass.getBytes());
          String dig = Base64.encodeToString(md.digest(), Base64.NO_WRAP);
          hdr = "<s:Header><Security xmlns=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd\">"
              + "<UsernameToken><Username>" + user.replace("&", "&amp;").replace("<", "&lt;") + "</Username>"
              + "<Password Type=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest\">" + dig + "</Password>"
              + "<Nonce>" + Base64.encodeToString(nonce, Base64.NO_WRAP) + "</Nonce>"
              + "<Created xmlns=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\">" + created + "</Created>"
              + "</UsernameToken></Security></s:Header>";
        }
        String env = "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\">"
            + hdr + "<s:Body>" + call.getString("body") + "</s:Body></s:Envelope>";
        HttpURLConnection c = (HttpURLConnection) new URL(call.getString("url")).openConnection();
        c.setConnectTimeout(2500); c.setReadTimeout(4000);
        c.setRequestMethod("POST"); c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/soap+xml; charset=utf-8");
        c.getOutputStream().write(env.getBytes("UTF-8"));
        int code = c.getResponseCode();
        byte[] data = readAll(code < 400 ? c.getInputStream() : c.getErrorStream(), 1_000_000);
        JSObject r = new JSObject();
        r.put("status", code); r.put("text", new String(data, "UTF-8"));
        call.resolve(r);
      } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }).start();
  }
}
