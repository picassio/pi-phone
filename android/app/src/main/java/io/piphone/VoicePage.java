package io.piphone;

import android.content.Context;
import android.net.Uri;
import android.webkit.PermissionRequest;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the app's window and the assistant's sheet share for a voice call (PP-191): which page may have the microphone,
 * and the page's word about its call to `VoiceCallService`. The page's side is `web/voice-call.js` (`PiPhoneApp.voiceCall`
 * and `globalThis.__piVoiceAction`).
 */
final class VoicePage {
    /** The app's own page: the only one that gets the microphone. */
    static final String ORIGIN = "http://127.0.0.1:" + PiService.PORT;

    private VoicePage() {}

    /** The page asks for the microphone alone, from the app's own address: never the camera, never another page. */
    static boolean ownAudio(PermissionRequest request) {
        Uri origin = request.getOrigin();
        if (origin == null || !ORIGIN.equals(origin.getScheme() + "://" + origin.getAuthority())) return false;
        String[] resources = request.getResources();
        if (resources == null || resources.length == 0) return false;
        for (String resource : resources) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return false;
        }
        return true;
    }

    /**
     * The page's call changed: `{"state": "start" | "update" | "end", "session", "title", "muted", "handOver"}`. Returns
     * the state. A call handed over to the app's window (`handOver`) keeps its notification: the window's call takes it.
     */
    static String tell(Context context, String json) throws JSONException {
        JSONObject call = new JSONObject(json);
        String state = call.getString("state");
        if ("end".equals(state)) {
            if (!call.optBoolean("handOver", false)) VoiceCallService.tell(context, VoiceCallService.ACTION_STOP, "", -1, false);
            return state;
        }
        if (!"start".equals(state) && !"update".equals(state)) throw new JSONException("no call state " + state);
        VoiceCallService.tell(context, "start".equals(state) ? VoiceCallService.ACTION_START : VoiceCallService.ACTION_UPDATE,
                call.optString("title", ""), call.optInt("session", -1), call.optBoolean("muted", false));
        return state;
    }

    /** The script that gives the page a notification button's word: "mute" or "end". */
    static String action(String action) {
        return "globalThis.__piVoiceAction && globalThis.__piVoiceAction(" + JSONObject.quote(action) + ")";
    }

    /** The script that starts a call in a session (`start`), or shows the one going on (`show`), in the app's window. */
    static String fromShell(int session, String what) {
        return "import('/voice-call.js').then((voice) => voice.voiceFromShell(" + session + ", " + JSONObject.quote(what) + "))";
    }
}
