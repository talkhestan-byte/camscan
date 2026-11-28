package com.camscan.app;

import android.app.Activity;
import android.content.ContentValues;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.MediaStore;
import android.view.*;
import android.widget.*;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;
import java.io.*;
import java.util.ArrayList;

public class PlayerActivity extends Activity {
  LibVLC vlc; MediaPlayer mp; boolean rec = false;
  Button recBtn; TextView info; File dir;
  ArrayList<String> urls = new ArrayList<>();
  int attemptIndex = 0;
  boolean playingStarted = false;
  final Handler handler = new Handler(Looper.getMainLooper());
  Runnable attemptTimeout;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    String url = getIntent().getStringExtra("url");
    ArrayList<String> supplied = getIntent().getStringArrayListExtra("urls");
    if (supplied != null) for (String value : supplied)
      if (value != null && !value.trim().isEmpty() && !urls.contains(value)) urls.add(value);
    if (urls.isEmpty() && url != null && !url.trim().isEmpty()) urls.add(url);
    final String name = getIntent().getStringExtra("name");
    dir = new File(getExternalFilesDir(Environment.DIRECTORY_MOVIES), "CamScan");
    dir.mkdirs();

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    VLCVideoLayout video = new VLCVideoLayout(this);
    root.addView(video, new FrameLayout.LayoutParams(-1, -1));

    LinearLayout bar = new LinearLayout(this);
    bar.setBackgroundColor(0xAA000000);
    bar.setPadding(24, 24, 24, 24);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    info = new TextView(this);
    info.setTextColor(Color.WHITE);
    info.setText(name + " ...");
    recBtn = new Button(this); recBtn.setText("● ضبط");
    Button close = new Button(this); close.setText("بستن");
    bar.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
    bar.addView(recBtn); bar.addView(close);
    root.addView(bar, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
    setContentView(root);

    ArrayList<String> opts = new ArrayList<>();
    opts.add("--rtsp-tcp");
    opts.add("--network-caching=900");
    opts.add("--live-caching=900");
    vlc = new LibVLC(this, opts);
    mp = new MediaPlayer(vlc);
    mp.attachViews(video, null, false, false);
    mp.setEventListener(ev -> runOnUiThread(() -> handleVlcEvent(ev.type)));

    recBtn.setEnabled(false);
    recBtn.setOnClickListener(v -> toggleRecord());
    close.setOnClickListener(v -> finish());
    if (urls.isEmpty()) {
      info.setText("آدرس تصویر دوربین دریافت نشد");
      recBtn.setEnabled(false);
    } else {
      startNextStream();
    }
  }

  void startNextStream() {
    if (attemptTimeout != null) handler.removeCallbacks(attemptTimeout);
    if (attemptIndex >= urls.size()) {
      playingStarted = false;
      info.setText("اتصال ناموفق؛ مسیرهای تصویر دوربین پاسخ ندادند");
      recBtn.setEnabled(false);
      return;
    }
    playingStarted = false;
    String current = urls.get(attemptIndex);
    info.setText("آزمایش مسیر " + (attemptIndex + 1) + " از " + urls.size() + " ...");
    try { mp.stop(); } catch (Exception ignored) {}
    try {
      Media media = new Media(vlc, Uri.parse(current));
      media.setHWDecoderEnabled(true, false);
      mp.setMedia(media);
      media.release();
      final int thisAttempt = attemptIndex;
      attemptTimeout = () -> {
        if (!isFinishing() && !playingStarted && attemptIndex == thisAttempt) {
          info.setText("مهلت اتصال تمام شد؛ مسیر بعدی...");
          attemptIndex++;
          startNextStream();
        }
      };
      handler.postDelayed(attemptTimeout, 8000);
      mp.play();
    } catch (Exception e) {
      attemptIndex++;
      startNextStream();
    }
  }

  void handleVlcEvent(int type) {
    if (type == MediaPlayer.Event.Playing) {
      playingStarted = true;
      handler.removeCallbacks(attemptTimeout == null ? () -> {} : attemptTimeout);
      info.setText(getIntent().getStringExtra("name") + "  ● متصل");
      recBtn.setEnabled(true);
    } else if (type == MediaPlayer.Event.Buffering && !playingStarted) {
      info.setText("دریافت تصویر...");
    } else if (type == MediaPlayer.Event.EncounteredError && !playingStarted) {
      handler.removeCallbacks(attemptTimeout == null ? () -> {} : attemptTimeout);
      final int failedAttempt = attemptIndex;
      handler.postDelayed(() -> {
        if (!isFinishing() && !playingStarted && attemptIndex == failedAttempt) {
          attemptIndex++;
          startNextStream();
        }
      }, 500);
    } else if (type == MediaPlayer.Event.Stopped && playingStarted) {
      info.setText("پخش متوقف شد");
    }
  }

  void toggleRecord() {
    if (!rec) {
      rec = mp.record(dir.getAbsolutePath());
      recBtn.setText(rec ? "■ توقف ضبط" : "ضبط ناموفق");
    } else {
      mp.record(null); rec = false;
      recBtn.setText("● ضبط");
      exportLatest();
    }
  }

  // کپی آخرین ضبط به گالری (پوشه Movies/CamScan)
  void exportLatest() {
    new Thread(() -> {
      try {
        Thread.sleep(1500);
        File[] fs = dir.listFiles();
        if (fs == null || fs.length == 0) return;
        File f = fs[0];
        for (File x : fs) if (x.lastModified() > f.lastModified()) f = x;
        if (Build.VERSION.SDK_INT < 29) { toast("فایل: " + f.getAbsolutePath()); return; }
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Video.Media.DISPLAY_NAME, f.getName());
        cv.put(MediaStore.Video.Media.MIME_TYPE, f.getName().endsWith(".ts") ? "video/mp2t" : "video/mp4");
        cv.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/CamScan");
        Uri u = getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, cv);
        try (InputStream in = new FileInputStream(f);
             OutputStream out = getContentResolver().openOutputStream(u)) {
          byte[] buf = new byte[65536]; int n;
          while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        toast("ضبط شد: Movies/CamScan");
      } catch (Exception e) { toast("خطا در ذخیره: " + e.getMessage()); }
    }).start();
  }

  void toast(String s) { runOnUiThread(() -> Toast.makeText(this, s, Toast.LENGTH_LONG).show()); }

  @Override protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    super.onDestroy();
    try {
      if (mp != null) {
        if (rec) mp.record(null);
        mp.stop(); mp.detachViews(); mp.release();
      }
      if (vlc != null) vlc.release();
    } catch (Exception ignored) {}
  }
                                    }
