package io.piphone;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * The failure screen's Share log (MainActivity.shareLog, PP-198): one file, a copy of server.log's end in the cache,
 * read-only, to the app the person shares it with (it gets a read grant on the share's intent; the provider is not
 * exported). Nothing else is served.
 */
public final class LogProvider extends ContentProvider {

    private static final String NAME = "server.log";

    static File file(Context context) { return new File(context.getCacheDir(), "shared/" + NAME); }

    static Uri uri(Context context) { return Uri.parse("content://" + context.getPackageName() + ".logs/" + NAME); }

    @Override
    public boolean onCreate() { return true; }

    private File served(Uri uri) throws FileNotFoundException {
        if (!("/" + NAME).equals(uri.getPath())) throw new FileNotFoundException(uri.toString());
        File file = file(getContext());
        if (!file.isFile()) throw new FileNotFoundException(file.toString());
        return file;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("read-only: " + uri);
        return ParcelFileDescriptor.open(served(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) { return "text/plain"; }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = served(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] columns = projection == null ? new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = NAME;
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
        }
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("read-only"); }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("read-only"); }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("read-only"); }
}
