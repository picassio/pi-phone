package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.IOException;

/**
 * Prints a WebView's page (its print adapter) to a PDF file, as Android's "Save as PDF" would, without the print dialog:
 * for Pi's browser (io.piphone.PiBrowser), whose DevTools has no Page.printToPDF. In this package because the layout and
 * write callbacks' constructors are hidden from apps outside it (the SDK's stubs make them package-private).
 */
public final class PiPdf {

    /** How printing ended: null when the file is written, or what went wrong. */
    public interface Done {
        void finished(String error);
    }

    private PiPdf() {
    }

    /** Lay the page out on A4 with small margins and write every page to `file` (main thread); `done` says how it ended. */
    public static void write(PrintDocumentAdapter adapter, File file, Done done) {
        PrintAttributes attributes = new PrintAttributes.Builder()
                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 300, 300))
                .setMinMargins(new PrintAttributes.Margins(400, 400, 400, 400))
                .build();
        adapter.onStart();
        adapter.onLayout(null, attributes, new CancellationSignal(), new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                ParcelFileDescriptor out;
                try {
                    out = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE
                            | ParcelFileDescriptor.MODE_READ_WRITE);
                } catch (IOException e) {
                    finish(adapter, null, done, e.toString());
                    return;
                }
                adapter.onWrite(new PageRange[] {PageRange.ALL_PAGES}, out, new CancellationSignal(), new PrintDocumentAdapter.WriteResultCallback() {
                    @Override
                    public void onWriteFinished(PageRange[] pages) {
                        finish(adapter, out, done, null);
                    }

                    @Override
                    public void onWriteFailed(CharSequence error) {
                        finish(adapter, out, done, error == null ? "it could not be written" : error.toString());
                    }

                    @Override
                    public void onWriteCancelled() {
                        finish(adapter, out, done, "it was cancelled");
                    }
                });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                finish(adapter, null, done, error == null ? "it could not be laid out" : error.toString());
            }

            @Override
            public void onLayoutCancelled() {
                finish(adapter, null, done, "it was cancelled");
            }
        }, null);
    }

    private static void finish(PrintDocumentAdapter adapter, ParcelFileDescriptor out, Done done, String error) {
        if (out != null) {
            try {
                out.close();
            } catch (IOException ignored) {
                // The file is written or the error says what failed.
            }
        }
        adapter.onFinish();
        done.finished(error);
    }
}
