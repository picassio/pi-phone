package io.piphone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;

/**
 * Android's own speech recognizer for the web app's dictation (DESIGN.md section 4): WebView has no Web Speech API, so
 * `web/android-speech.js` stands one in that calls here. One listening at a time; each start is one utterance, which
 * the web side restarts while it dictates continuously. What is heard goes back as events to
 * `window.__piPhoneSpeech({type, ...})`: start, partial (text), final (text), error (a Web Speech error name), end.
 * Everything here runs on the main thread, as SpeechRecognizer requires.
 */
final class Dictation implements RecognitionListener {

    static final int PERMISSION_REQUEST = 7;

    private final Activity activity;
    private final WebView web;
    private SpeechRecognizer recognizer;
    /** The language asked for while Android asks the person for the microphone. */
    private String waiting;

    Dictation(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    boolean available() {
        return SpeechRecognizer.isRecognitionAvailable(activity);
    }

    /** Listen for one utterance in `language` (a BCP 47 tag), asking for the microphone the first time. */
    void start(String language) {
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            waiting = language;
            activity.requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, PERMISSION_REQUEST);
            return;
        }
        release();
        recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
        recognizer.setRecognitionListener(this);
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.getPackageName());
        recognizer.startListening(intent);
    }

    /** Android answered the microphone request. */
    void permitted(boolean granted) {
        String language = waiting;
        waiting = null;
        if (language == null) return;
        if (granted) {
            start(language);
        } else {
            emit("error", "error", "not-allowed");
            emit("end", null, null);
        }
    }

    /** Stop listening, and still say what was heard. */
    void stop() {
        if (recognizer != null) {
            recognizer.stopListening();
        } else if (waiting != null) {
            waiting = null;
            emit("end", null, null);
        }
    }

    /** Stop at once, dropping what was not settled. */
    void abort() {
        boolean listening = waiting != null || recognizer != null;
        waiting = null;
        release();
        if (listening) emit("end", null, null);
    }

    void release() {
        if (recognizer == null) return;
        recognizer.setRecognitionListener(null);
        recognizer.cancel();
        recognizer.destroy();
        recognizer = null;
    }

    private void emit(String type, String key, String value) {
        try {
            JSONObject event = new JSONObject().put("type", type);
            if (key != null) event.put(key, value);
            String script = "window.__piPhoneSpeech && window.__piPhoneSpeech(" + event + ")";
            web.post(() -> web.evaluateJavascript(script, null));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String text(Bundle results) {
        ArrayList<String> heard = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return heard == null || heard.isEmpty() ? "" : heard.get(0);
    }

    /** Android's errors as the Web Speech API names them, which `web/voice.js` explains to the person. */
    private static String errorName(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
            case 11: // ERROR_SERVER_DISCONNECTED (API 31)
                return "network";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            case SpeechRecognizer.ERROR_CLIENT:
                return "aborted";
            case 12: // ERROR_LANGUAGE_NOT_SUPPORTED (API 31)
            case 13: // ERROR_LANGUAGE_UNAVAILABLE (API 31)
                return "language-not-supported";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
            case 10: // ERROR_TOO_MANY_REQUESTS (API 31)
                return "service-not-allowed";
            default:
                return "error " + code;
        }
    }

    @Override
    public void onReadyForSpeech(Bundle params) {
        emit("start", null, null);
    }

    @Override
    public void onBeginningOfSpeech() {}

    @Override
    public void onRmsChanged(float rmsdB) {}

    @Override
    public void onBufferReceived(byte[] buffer) {}

    @Override
    public void onEndOfSpeech() {}

    @Override
    public void onError(int error) {
        release();
        emit("error", "error", errorName(error));
        emit("end", null, null);
    }

    @Override
    public void onResults(Bundle results) {
        String heard = text(results);
        release();
        emit("final", "text", heard);
        emit("end", null, null);
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        String heard = text(partialResults);
        if (!heard.isEmpty()) emit("partial", "text", heard);
    }

    @Override
    public void onEvent(int eventType, Bundle params) {}
}
