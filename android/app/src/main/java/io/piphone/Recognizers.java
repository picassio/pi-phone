package io.piphone;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.speech.RecognitionService;

import java.util.ArrayList;
import java.util.List;

/**
 * The phone's own speech recognizer, never pi-phone's (PP-146). Once pi-phone is the phone's assistant, Android makes
 * the assistant's recognition service (`PiRecognition`) the phone's default one, and `PiRecognition` passes speech on
 * to a recognizer: if dictation or `PiRecognition` asked for "the default", they would ask themselves. So both name the
 * one they use: the phone's chosen recognizer when it is not pi-phone's, else Google's, else Samsung's, else the first.
 */
final class Recognizers {
    /** By preference, after the phone's own choice: Google's speech services, then Samsung's. */
    private static final String[] PREFERRED = {
        "com.google.android.tts",
        "com.google.android.googlequicksearchbox",
        "com.google.android.as",
        "com.samsung.android.bixby.agent",
    };

    private Recognizers() {}

    /** The recognizer to use, or null when the phone has none besides pi-phone's. */
    static ComponentName real(Context context) {
        List<ResolveInfo> found = context.getPackageManager().queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0);
        List<ComponentName> others = new ArrayList<>();
        for (ResolveInfo each : found) {
            if (each.serviceInfo == null || each.serviceInfo.packageName.equals(context.getPackageName())) continue;
            others.add(new ComponentName(each.serviceInfo.packageName, each.serviceInfo.name));
        }
        if (others.isEmpty()) return null;

        // The phone's choice (Settings.Secure.VOICE_RECOGNITION_SERVICE, hidden): pi-phone's once it is the assistant.
        String chosen = Settings.Secure.getString(context.getContentResolver(), "voice_recognition_service");
        ComponentName named = chosen == null ? null : ComponentName.unflattenFromString(chosen);
        if (named != null && others.contains(named)) return named;

        for (String pkg : PREFERRED) {
            for (ComponentName each : others) {
                if (each.getPackageName().equals(pkg)) return each;
            }
        }
        return others.get(0);
    }
}
