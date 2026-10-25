package io.piphone;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.os.RemoteException;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * The assistant's speech recognition service (PP-146). Android lists an app as a digital assistant only with one of
 * its own, and makes it the phone's default recognizer while pi-phone is the assistant: so it hears nothing itself and
 * passes each request on to the phone's real recognizer (`Recognizers.real`, never this one), and what it hears back.
 * Apps that dictate with "the default recognizer" (a keyboard's mic) keep working that way.
 */
public final class PiRecognition extends RecognitionService {
    private SpeechRecognizer inner;

    @Override
    protected void onStartListening(Intent request, Callback callback) {
        release();
        ComponentName real = Recognizers.real(this);
        if (real == null) {
            tell(() -> callback.error(SpeechRecognizer.ERROR_CLIENT));
            return;
        }
        inner = SpeechRecognizer.createSpeechRecognizer(this, real);
        inner.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                tell(() -> callback.readyForSpeech(params));
            }

            @Override
            public void onBeginningOfSpeech() {
                tell(callback::beginningOfSpeech);
            }

            @Override
            public void onRmsChanged(float rmsdB) {
                tell(() -> callback.rmsChanged(rmsdB));
            }

            @Override
            public void onBufferReceived(byte[] buffer) {
                tell(() -> callback.bufferReceived(buffer));
            }

            @Override
            public void onEndOfSpeech() {
                tell(callback::endOfSpeech);
            }

            @Override
            public void onError(int error) {
                release();
                tell(() -> callback.error(error));
            }

            @Override
            public void onResults(Bundle results) {
                release();
                tell(() -> callback.results(results));
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                tell(() -> callback.partialResults(partialResults));
            }

            @Override
            public void onEvent(int eventType, Bundle params) {}
        });
        inner.startListening(request);
    }

    @Override
    protected void onStopListening(Callback callback) {
        if (inner != null) inner.stopListening();
    }

    @Override
    protected void onCancel(Callback callback) {
        release();
    }

    @Override
    public void onDestroy() {
        release();
        super.onDestroy();
    }

    private void release() {
        if (inner == null) return;
        inner.setRecognitionListener(null);
        inner.cancel();
        inner.destroy();
        inner = null;
    }

    private interface Call {
        void run() throws RemoteException;
    }

    /** One callback to the app that asked; one that has gone away hears nothing more. */
    private static void tell(Call call) {
        try {
            call.run();
        } catch (RemoteException gone) {
            // The caller is gone: nothing to tell.
        }
    }
}
