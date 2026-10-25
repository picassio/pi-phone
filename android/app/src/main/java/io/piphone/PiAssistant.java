package io.piphone;

import android.app.role.RoleManager;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;
import android.service.voice.VoiceInteractionService;

/**
 * pi-phone as the phone's digital assistant (PP-146): with pi-phone chosen in Settings › Default apps › Digital
 * assistant app, the side key (or the corner swipe) asks this service for a session, and `PiAssistantSessionService`
 * makes one: the sheet over the app in front (`PiAssistantSession`). Android lists an app for that role only with a
 * session service and a recognition service of its own (`res/xml/assistant.xml`; `PiRecognition`).
 */
public final class PiAssistant extends VoiceInteractionService {

    /** Whether pi-phone holds the assistant role now. */
    static boolean held(Context context) {
        if (Build.VERSION.SDK_INT >= 29) {
            RoleManager roles = context.getSystemService(RoleManager.class);
            return roles != null && roles.isRoleHeld(RoleManager.ROLE_ASSISTANT);
        }
        // Before Android 10, the assistant is the voice interaction service Android names (hidden setting).
        String service = Settings.Secure.getString(context.getContentResolver(), "voice_interaction_service");
        return service != null && service.startsWith(context.getPackageName() + "/");
    }
}
