package com.camscan.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * قالب اولیه پلاگین CamScan.
 * پیاده‌سازی واقعی دسترسی به دوربین و اسکن را با نسخه اصلی جایگزین کنید.
 */
@CapacitorPlugin(name = "CamScan")
public class CamScanPlugin extends Plugin {

    @PluginMethod
    public void ping(PluginCall call) {
        JSObject result = new JSObject();
        result.put("status", "ready");
        call.resolve(result);
    }
}
