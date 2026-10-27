package io.piphone;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

/**
 * The device's own voice for a voice call's "Pi thinks" (PP-193, `web/voice-call.js`'s reader "device"): Android's
 * text-to-speech, the phone's engine as the person set it up (pi-phone runs no model of its own for it). It reads Pi's
 * words as a call's audio (voice communication), one after another, and says how each went to
 * `window.__piPhoneSpoken({id, state: "start" | "done" | "error"})`. Talking over it stops it (`stop`).
 */
final class Speech {
    private final WebView web;
    private final TextToSpeech tts;
    private volatile boolean ready;
    private volatile boolean failed;

    Speech(Context context, WebView web) {
        this.web = web;
        tts = new TextToSpeech(context, (status) -> {
            ready = status == TextToSpeech.SUCCESS;
            failed = !ready;
        });
        tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) {
                emit(id, "start");
            }

            @Override
            public void onDone(String id) {
                emit(id, "done");
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String id) {
                emit(id, "error");
            }

            @Override
            public void onError(String id, int code) {
                emit(id, "error");
            }

            @Override
            public void onStop(String id, boolean interrupted) {
                emit(id, "done");
            }
        });
    }

    /** Whether the phone has a voice to read with (its engine started; while it starts, yes). */
    boolean available() {
        return !failed;
    }

    /** Read `text` after what is being read, in `language` (a language code; "" for the phone's own). */
    void speak(String id, String text, String language) {
        if (!ready) {
            emit(id, "error");
            return;
        }
        if (language != null && !language.isEmpty()) tts.setLanguage(Locale.forLanguageTag(language));
        tts.speak(text, TextToSpeech.QUEUE_ADD, new Bundle(), id);
    }

    /** Stop reading now, and drop what waits. */
    void stop() {
        tts.stop();
    }

    void release() {
        tts.shutdown();
    }

    private void emit(String id, String state) {
        try {
            String script = "window.__piPhoneSpoken && window.__piPhoneSpoken(" + new JSONObject().put("id", id).put("state", state) + ")";
            web.post(() -> web.evaluateJavascript(script, null));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}
