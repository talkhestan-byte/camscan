package com.camscan.app;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;
import java.util.ArrayList;

public class MultiViewActivity extends Activity {
  final ArrayList<LibVLC> vlcs = new ArrayList<>();
  final ArrayList<MediaPlayer> players = new ArrayList<>();

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    ArrayList<String> urls = getIntent().getStringArrayListExtra("urls");
    ArrayList<String> names = getIntent().getStringArrayListExtra("names");
    if (urls == null || urls.isEmpty() || urls.size() > 4) { finish(); return; }

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.BLACK);

    LinearLayout top = new LinearLayout(this);
    top.setGravity(Gravity.CENTER_VERTICAL);
    top.setPadding(10, 5, 10, 5);
    top.setBackgroundColor(0xFF202020);
    TextView title = new TextView(this);
    title.setTextColor(Color.WHITE);
    title.setTextSize(15);
    title.setText("پخش هم‌زمان " + urls.size() + " دوربین");
    top.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    Button close = new Button(this);
    close.setText("بستن");
    top.addView(close, new LinearLayout.LayoutParams(-2, -2));
    root.addView(top, new LinearLayout.LayoutParams(-1, -2));
    close.setOnClickListener(v -> finish());

    GridLayout grid = new GridLayout(this);
    int columns = urls.size() == 1 ? 1 : 2;
    grid.setColumnCount(columns);
    grid.setRowCount((urls.size() + columns - 1) / columns);
    root.addView(grid, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(root);

    for (int n = 0; n < urls.size(); n++) {
      final int index = n;
      String cameraName = names != null && n < names.size() ? names.get(n) : "دوربین " + (n + 1);

      FrameLayout tile = new FrameLayout(this);
      tile.setBackgroundColor(0xFF080808);
      GridLayout.LayoutParams cell = new GridLayout.LayoutParams(
          GridLayout.spec(n / columns, 1, 1f),
          GridLayout.spec(n % columns, 1, 1f));
      cell.width = 0;
      cell.height = 0;
      cell.setMargins(2, 2, 2, 2);
      grid.addView(tile, cell);

      VLCVideoLayout video = new VLCVideoLayout(this);
      tile.addView(video, new FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

      TextView status = new TextView(this);
      status.setTextColor(Color.WHITE);
      status.setTextSize(12);
      status.setPadding(7, 5, 7, 5);
      status.setBackgroundColor(0xAA000000);
      status.setText(cameraName + " • در حال اتصال");
      FrameLayout.LayoutParams labelParams = new FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
      tile.addView(status, labelParams);

      ArrayList<String> options = new ArrayList<>();
      options.add("--rtsp-tcp");
      options.add("--network-caching=1200");
      options.add("--live-caching=1200");
      LibVLC vlc = new LibVLC(this, options);
      MediaPlayer player = new MediaPlayer(vlc);
      player.attachViews(video, null, false, false);
      player.setEventListener(event -> runOnUiThread(() -> {
        if (event.type == MediaPlayer.Event.Playing) status.setText(cameraName + " • زنده");
        else if (event.type == MediaPlayer.Event.Buffering) status.setText(cameraName + " • دریافت تصویر...");
        else if (event.type == MediaPlayer.Event.EncounteredError) status.setText(cameraName + " • خطای اتصال");
      }));

      Media media = new Media(vlc, Uri.parse(urls.get(index)));
      media.setHWDecoderEnabled(true, false);
      player.setMedia(media);
      media.release();
      vlcs.add(vlc);
      players.add(player);
      player.play();
    }
  }

  @Override protected void onDestroy() {
    for (MediaPlayer player : players) {
      try { player.stop(); player.detachViews(); player.release(); } catch (Exception ignored) {}
    }
    for (LibVLC vlc : vlcs) {
      try { vlc.release(); } catch (Exception ignored) {}
    }
    players.clear();
    vlcs.clear();
    super.onDestroy();
  }
}
