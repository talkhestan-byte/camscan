package com.camscan.app;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle b) {
    registerPlugin(CamScanPlugin.class);
    super.onCreate(b);
  }
}
